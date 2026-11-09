import { isDeepStrictEqual } from "node:util";
import type { Message } from "@ag-ui/client";
import { chatFileUrl, filesFromToolResult } from "../../../shared/chat-files";
import { parsePersonalDeliveryEvidence } from "../../../shared/personal-sources";
import type {
  TaskArtifact,
  TaskCenterTask,
  TaskExecutionResult,
  TaskResultEvidence,
} from "../../../shared/task-center";
import type { Database } from "../db/client";
import { REFUSAL_MARKER } from "../plugins/tools";
import { BackgroundTurnNeedsReview } from "../turns/durable-outcome";

type Operation = {
  id: string;
  tool_name: string;
  status: string;
  result: { content?: unknown; error?: string } | null;
  args: Record<string, unknown>;
};

/** Recheck the saved execution on Retry; do not obtain evidence by executing its effects again. */
export class TaskResultNeedsReview extends BackgroundTurnNeedsReview {
  constructor(message: string) {
    super(message);
    this.name = "TaskResultNeedsReview";
  }
}

/** A failed final model response does not undo tool effects already recorded by this run. */
export async function taskTurnFailure(
  database: Database,
  task: TaskCenterTask,
  runId: string,
  message: string,
): Promise<BackgroundTurnNeedsReview> {
  const [table] = await database.$client.unsafe<{ available: boolean }[]>(
    "SELECT to_regclass('public.chisabot_tool_operations') IS NOT NULL AS available",
  );
  const recorded = table?.available
    ? await database.$client.unsafe(
        "SELECT id FROM chisabot_tool_operations WHERE owner_user_id=$1 AND run_id=$2 AND status IN ('completed','dispatching','waiting_approval','outcome_unknown') LIMIT 1",
        [task.ownerUserId, runId],
      )
    : [];
  return recorded.length
    ? new TaskResultNeedsReview(
        `${message} 本次已有工具执行记录；重试只核对原执行，不会重新执行工具。`,
      )
    : new BackgroundTurnNeedsReview(message);
}

/** AG-UI may JSON-encode an already encoded tool result. Decode only the transport layers. */
function contentOf(raw: unknown): unknown {
  for (let depth = 0; depth < 3 && typeof raw === "string"; depth++) {
    try {
      raw = JSON.parse(raw);
    } catch {
      break;
    }
  }
  return raw;
}

function operationFailure(operation: Operation): string | null {
  const value = contentOf(operation.result?.content);
  if (
    operation.status === "failed" ||
    operation.result?.error ||
    (typeof value === "string" && value.trimStart().startsWith(REFUSAL_MARKER))
  )
    return `工具「${operation.tool_name}」未成功完成，请核对任务成果后继续。`;
  if (!operation.tool_name.startsWith("device_")) return null;
  if (typeof value === "string" && value.startsWith("设备操作失败："))
    return "设备操作没有完成，请检查设备回执后继续。";
  const result =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  if (
    result?.timedOut === true ||
    result?.cancelled === true ||
    result?.error ||
    (result?.exitCode != null && result.exitCode !== 0) ||
    result?.status === "timeout" ||
    (result?.status === "killed" && operation.tool_name !== "device_shell_kill")
  ) {
    return "设备回执报告失败、超时或取消，不能将任务记为完成。";
  }
  return null;
}

export function assertTaskEvidence(
  task: Pick<TaskCenterTask, "completion">,
  result: TaskExecutionResult,
): void {
  for (const kind of task.completion?.required ?? []) {
    if (
      result.evidence?.some(
        (item) => item.kind === kind && item.reference.trim(),
      )
    )
      continue;
    const missing = {
      file: "可读取的文件成果",
      delivery: "外发接纳回执",
      device: "设备执行回执",
    }[kind];
    throw new TaskResultNeedsReview(
      `完成条件尚未满足：缺少${missing}。请核对本次结果后继续，不会自动重做。`,
    );
  }
}

/** Reads only this execution's tool records and file IDs. Existing artifacts/services remain authoritative. */
export async function verifyTaskTurn(options: {
  database: Database;
  task: TaskCenterTask;
  runId: string;
  messages: Message[];
  dependencies?: TaskCenterTask[];
}): Promise<{ artifacts: TaskArtifact[]; evidence: TaskResultEvidence[] }> {
  const { database, task, runId, messages } = options;
  const sql = database.$client;
  const [available] = await sql.unsafe<{ available: boolean }[]>(
    "SELECT to_regclass('public.chisabot_tool_operations') IS NOT NULL AS available",
  );
  const operations = available?.available
    ? await sql.unsafe<Operation[]>(
        "SELECT id,tool_name,status,result,args FROM chisabot_tool_operations WHERE owner_user_id=$1 AND run_id=$2 ORDER BY turn_number,step_number,created_at",
        [task.ownerUserId, runId],
      )
    : [];
  const pending = operations.find((op) =>
    ["dispatching", "waiting_approval", "outcome_unknown"].includes(op.status),
  );
  if (pending)
    throw new TaskResultNeedsReview(
      `工具「${pending.tool_name}」的结果尚待核对，任务不能记为完成，也不会自动重做。`,
    );
  for (const [index, operation] of operations.entries()) {
    const failure = operationFailure(operation);
    if (!failure) continue;
    // A later successful call with the same target/arguments resolves a definite failure.
    // Unknown effects are handled above and are never cleared by a second call.
    const recovered = operations
      .slice(index + 1)
      .some(
        (later) =>
          later.status === "completed" &&
          later.tool_name === operation.tool_name &&
          isDeepStrictEqual(later.args, operation.args) &&
          !operationFailure(later),
      );
    if (!recovered) throw new TaskResultNeedsReview(failure);
  }

  const successful = operations.filter(
    (op) => op.status === "completed" && !operationFailure(op),
  );
  const results = operations.length
    ? successful.map((op) => op.result?.content)
    : messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content);
  if (
    !operations.length &&
    results.some(
      (raw) =>
        typeof contentOf(raw) === "string" &&
        String(contentOf(raw)).trimStart().startsWith(REFUSAL_MARKER),
    )
  ) {
    throw new TaskResultNeedsReview(
      "本次执行有工具未获准或未完成，不能仅凭回复将任务记为成功。",
    );
  }
  const artifacts: TaskArtifact[] = [];
  const evidence: TaskResultEvidence[] = [];
  const files = new Map(
    results
      .flatMap((raw) =>
        filesFromToolResult(
          typeof raw === "string" ? raw : JSON.stringify(raw),
        ),
      )
      .map((file) => [file.id, file]),
  );
  const inherited: TaskResultEvidence[] = [];
  for (const dependency of options.dependencies ?? []) {
    if (
      dependency.ownerUserId !== task.ownerUserId ||
      dependency.status !== "succeeded"
    )
      continue;
    const [entry] = await sql.unsafe<
      { data: { evidence?: TaskResultEvidence[] } }[]
    >(
      "SELECT data FROM chisabot_task_center_events WHERE owner_user_id=$1 AND task_id=$2 AND type='delivered' ORDER BY created_at DESC LIMIT 1",
      [task.ownerUserId, dependency.id],
    );
    const delivered = contentOf(entry?.data) as
      | { evidence?: TaskResultEvidence[] }
      | undefined;
    inherited.push(...(delivered?.evidence ?? []));
  }
  for (const item of inherited.filter(
    (item) =>
      item.kind === "file" && item.reference.startsWith("/api/chat-files/"),
  )) {
    const id = item.reference.slice("/api/chat-files/".length);
    if (!files.has(id))
      files.set(id, { id } as ReturnType<typeof filesFromToolResult>[number]);
  }
  for (const id of files.keys()) {
    const [file] = await sql.unsafe<
      {
        id: string;
        name: string;
        mime_type: string;
        size_bytes: number;
        stored_bytes: number | null;
      }[]
    >(
      "SELECT id,name,mime_type,size_bytes,octet_length(bytes) AS stored_bytes FROM chisabot_chat_files WHERE id=$1 AND owner_user_id=$2",
      [id, task.ownerUserId],
    );
    if (
      !file ||
      file.stored_bytes === null ||
      file.stored_bytes !== file.size_bytes
    ) {
      throw new TaskResultNeedsReview(
        "本次引用的文件成果不可读取，请核对文件后继续；不会自动重新执行任务。",
      );
    }
    const uri = chatFileUrl(file.id);
    artifacts.push({ name: file.name, uri, mediaType: file.mime_type });
    evidence.push({
      kind: "file",
      reference: uri,
      detail: `${file.name}（${file.size_bytes} 字节）`,
    });
  }

  for (const operation of successful) {
    const value = contentOf(operation.result?.content);
    if (
      operation.tool_name.startsWith("device_") &&
      operation.tool_name !== "device_list"
    ) {
      const result =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const shell =
        operation.tool_name === "device_run_shell" ||
        operation.tool_name === "device_shell_output";
      // Shell admission, a job listing, or an absent/signal exit code cannot prove successful execution.
      const finished = shell
        ? result?.exitCode === 0 &&
          (!result.status || result.status === "exited")
        : result &&
          Object.keys(result).length > 0 &&
          result.status !== "running";
      if (result && finished) {
        evidence.push({
          kind: "device",
          reference: operation.id,
          detail: `设备操作 ${operation.tool_name} 已返回结果`,
        });
        // An actual read-back is file evidence; the filename in the model's reply or a write request is not.
        if (
          operation.tool_name === "device_read_file" &&
          typeof result.path === "string" &&
          typeof result.content === "string" &&
          typeof result.size === "number"
        ) {
          evidence.push({
            kind: "file",
            reference: operation.id,
            detail: `已读取设备文件 ${result.path}（${result.size} 字节）`,
          });
          artifacts.push({
            name: result.path,
            ...(result.encoding === "utf8" && !result.truncated
              ? { content: result.content, mediaType: "text/plain" }
              : {}),
          });
        }
      }
    }
    const receipt = parsePersonalDeliveryEvidence(value);
    if (!receipt) continue;
    const [delivery] = await sql.unsafe<
      { id: string; state: string; receipt: unknown }[]
    >(
      "SELECT id,state,receipt FROM chisabot_personal_deliveries WHERE id=$1 AND owner_user_id=$2 AND run_id=$3",
      [receipt.id, task.ownerUserId, runId],
    );
    if (!delivery || delivery.state !== "sent" || !delivery.receipt) {
      throw new TaskResultNeedsReview(
        "外发记录尚未确认接纳，任务保持待核对，不会自动重发。",
      );
    }
    evidence.push({
      kind: "delivery",
      reference: delivery.id,
      detail: "发送平台已接纳",
    });
  }
  for (const item of inherited.filter((item) => item.kind === "delivery")) {
    const [delivery] = await sql.unsafe<
      { id: string; state: string; receipt: unknown }[]
    >(
      "SELECT id,state,receipt FROM chisabot_personal_deliveries WHERE id=$1 AND owner_user_id=$2",
      [item.reference, task.ownerUserId],
    );
    if (delivery?.state === "sent" && delivery.receipt) evidence.push(item);
  }
  // Completed dependency evidence is created only by a verified executor and persisted with its success CAS.
  evidence.push(
    ...inherited.filter(
      (item) =>
        item.kind === "device" ||
        (item.kind === "file" &&
          !item.reference.startsWith("/api/chat-files/")),
    ),
  );
  return { artifacts, evidence };
}
