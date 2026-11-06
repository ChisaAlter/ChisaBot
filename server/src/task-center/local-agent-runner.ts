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
import type {
  TaskCenterTask,
  TaskExecutionContext,
  TaskExecutionResult,
} from "../../../shared/task-center";
import type { Database } from "../db/client";
import type { LocalAgentService } from "../local-agents/service";
import { TaskCenterError } from "./service";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const POLL_MS = 3000;

const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}…` : text;

/** executor=local-agent 或 local-agent:<kind> 都走本地 agent 委派。 */
export const isLocalAgentExecutor = (executor: string) =>
  executor === "local-agent" || executor.startsWith("local-agent:");

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
    signal: AbortSignal,
  ): Promise<TaskExecutionResult> {
    for (;;) {
      if (signal.aborted)
        throw new TaskCenterError("任务已取消。", 409);
      const [row] = await sql.unsafe<
        {
          status: string;
          summary: string | null;
          error: string | null;
          diff: { files?: { path: string }[] } | null;
        }[]
      >(
        "SELECT status, summary, error, diff FROM chisabot_local_agent_tasks WHERE id=$1",
        [taskId],
      );
      if (!row) throw new Error("本地 agent 任务记录不见了。");
      if (TERMINAL.has(row.status)) {
        if (row.status === "done")
          return {
            summary: clip(
              row.summary?.trim() || "本地 agent 已完成（没有留下摘要）。",
              60_000,
            ),
            artifacts: (row.diff?.files ?? [])
              .slice(0, 50)
              .map((file) => ({ name: clip(file.path, 200) })),
          };
        if (row.status === "cancelled")
          throw new TaskCenterError(
            row.error?.trim() || "本地 agent 任务被取消。",
            409,
          );
        throw new Error(row.error?.trim() || "本地 agent 没有完成任务。");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  return async function localAgentRun(
    task: TaskCenterTask,
    agentId: string,
    context: TaskExecutionContext,
  ): Promise<TaskExecutionResult> {
    const agent = localAgentKindOf(task.executor);
    const view = await options.localAgents.start({
      ownerUserId: task.ownerUserId,
      botId: agentId,
      botName: await options.botNameFor(task.ownerUserId, agentId),
      threadId: null,
      ...(agent ? { agent } : {}),
      title: task.title,
      task: clip(
        `任务中心委派的任务：${task.title}\n\n${task.description}`,
        8000,
      ),
    });
    context.signal.addEventListener(
      "abort",
      () => void options.localAgents.stop(task.ownerUserId, view.id).catch(() => {}),
      { once: true },
    );
    const result = await awaitTerminal(view.id, context.signal);
    return { ...result, usage: undefined };
  };
}
