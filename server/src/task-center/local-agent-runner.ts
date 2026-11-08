/**
 * 任务中心 → 本地 agent 的委派适配器。
 *
 * executor=local-agent（或 local-agent:codex / local-agent:claude … 指定 agent）时，
 * 任务经 local-agents 子系统派给一台在线电脑上的 agent 跑：设备挑选、权限档位、
 * 隔离方式、逐条/整包审批、每设备每用户并发上限全部沿用那套已验证的闸门，
 * 这里只做「提交 → 等终态 → 映射回任务结果」。等待期间任务侧照常心跳续租约；
 * 用户取消任务时 signal 触发 abort，顺手让设备上的 agent 也停下。
 */
import type { LocalAgentKind } from "../../../shared/local-agents";
import { LOCAL_AGENT_KINDS } from "../../../shared/local-agents";
import type { LocalAgentDiff } from "../../../shared/local-agents";
import type {
  TaskCenterTask,
  TaskExecutionContext,
  TaskExecutionResult,
} from "../../../shared/task-center";
import type { Database } from "../db/client";
import type { LocalAgentService } from "../local-agents/service";
import { TaskCenterError } from "./service";
import { BackgroundTurnNeedsReview } from "../turns/durable-outcome";
import { TaskResultNeedsReview } from "./outcome";
import { setTimeout as delay } from "node:timers/promises";
import { reportCapacityState } from "../conversations/capacity";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const POLL_MS = 3000;

const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}…` : text;

/** executor=local-agent 或 local-agent:<kind> 都走本地 agent 委派。 */
export const isLocalAgentExecutor = (executor: string) =>
  executor === "local-agent" || executor.startsWith("local-agent:");

/** Stored by the existing device task service, so a recovered attempt observes the same execution. */
export const localAgentThreadId = (task: Pick<TaskCenterTask, "id" | "version" | "attempts">) =>
  `task-center:${task.id}:local:v${task.version}:${task.attempts}`;

/** executor 后缀指定 agent：local-agent → 设备默认；local-agent:codex → 指定。 */
export function localAgentKindOf(executor: string): LocalAgentKind | undefined {
  const wanted = executor.split(":")[1]?.trim().toLowerCase();
  return wanted && (LOCAL_AGENT_KINDS as readonly string[]).includes(wanted)
    ? (wanted as LocalAgentKind)
    : undefined;
}

export function createLocalAgentRun(options: {
  database: Database;
  localAgents: Pick<LocalAgentService, "start" | "stop">;
  botNameFor: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<string | null>;
}) {
  const sql = options.database.$client;

  async function awaitTerminal(
    taskId: string,
    ownerUserId: string,
    signal: AbortSignal,
    requireAppliedChanges: boolean,
  ): Promise<TaskExecutionResult> {
    for (;;) {
      if (signal.aborted)
        throw new TaskCenterError("任务已取消。", 409);
      const [row] = await sql.unsafe<
        {
          status: string;
          summary: string | null;
          error: string | null;
          diff: LocalAgentDiff | null;
          device_id: string;
          capacity_active: boolean;
        }[]
      >(
        "SELECT status, summary, error, diff, device_id, capacity_active FROM chisabot_local_agent_tasks WHERE id=$1 AND owner_user_id=$2",
        [taskId, ownerUserId],
      );
      if (!row) throw new Error("本地 agent 任务记录不见了。");
      if (!TERMINAL.has(row.status)) reportCapacityState(row.capacity_active ? "admitted" : "waiting");
      if (TERMINAL.has(row.status)) {
        if (row.status === "done") {
          if (requireAppliedChanges && row.diff?.discarded) throw new TaskResultNeedsReview("设备上的改动已放弃，任务没有交付原定成果。");
          if (requireAppliedChanges && row.diff?.pending) throw new TaskResultNeedsReview(`设备已生成副本改动，但尚未应用到原目录。请先在本地 Agent 任务 ${taskId} 中检查并处理改动，再重试核对；不会自动再执行。`);
          const changes = row.diff?.pending ? "\n设备生成的副本改动尚未应用到原目录。" : row.diff?.discarded ? "\n设备生成的副本改动已放弃。" : "";
          return {
            summary: clip(
              (row.summary?.trim() || "本地 agent 已完成（没有留下摘要）。") + changes,
              60_000,
            ),
            artifacts: (row.diff?.files ?? [])
              .slice(0, 50)
              .map((file) => ({ name: clip(file.path, 200) })),
            evidence: changes ? [] : [{ kind: "device", reference: taskId, detail: `设备执行已完成${row.diff?.applied ? "，改动已应用" : ""}` }],
          };
        }
        if (row.status === "cancelled")
          throw new TaskCenterError(
            row.error?.trim() || "本地 agent 任务被取消。",
            409,
          );
        throw new BackgroundTurnNeedsReview(row.error?.trim() || "本地 agent 没有完成任务，请核对设备结果后继续。");
      }
      await delay(POLL_MS, undefined, { signal });
    }
  }

  return async function localAgentRun(
    task: TaskCenterTask,
    agentId: string,
    context: TaskExecutionContext,
  ): Promise<TaskExecutionResult> {
    const agent = localAgentKindOf(task.executor);
    context.signal.throwIfAborted();
    const threadId = localAgentThreadId(task);
    const [existing] = await sql.unsafe<{ id: string }[]>(
      "SELECT id FROM chisabot_local_agent_tasks WHERE owner_user_id=$1 AND thread_id=$2 ORDER BY created_at DESC LIMIT 1",
      [task.ownerUserId, threadId],
    );
    const view = existing ?? await options.localAgents.start({
      ownerUserId: task.ownerUserId,
      botId: agentId,
      botName: await options.botNameFor(task.ownerUserId, agentId),
      threadId,
      ...(agent ? { agent } : {}),
      title: task.title,
      task: clip(
        `任务中心委派的任务：${task.title}\n\n${task.description}`,
        8000,
      ),
    });
    const stop = () => void options.localAgents.stop(task.ownerUserId, view.id).catch(() => {});
    context.signal.addEventListener("abort", stop, { once: true });
    if (context.signal.aborted) { stop(); context.signal.throwIfAborted(); }
    try {
      await context.onEvent({ type: "progress", message: existing ? "正在核对原设备执行。" : "已交给设备执行。", data: { localAgentTaskId: view.id } });
      const result = await awaitTerminal(view.id, task.ownerUserId, context.signal, task.completion?.required.includes("device") ?? false);
      context.signal.throwIfAborted();
      return { ...result, usage: undefined };
    } finally { context.signal.removeEventListener("abort", stop); }
  };
}
