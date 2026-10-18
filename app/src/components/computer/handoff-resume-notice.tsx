import { useEffect, useRef, useState } from "react";
import { useKeptVisible } from "@/lib/kept-visible";
import { readControl } from "@/lib/computers/control";
import {
  forgetHandoff,
  hasActiveHandoff,
  pendingHandoff,
  rememberHandoff,
  type PendingHandoff,
} from "@/lib/computers/handoff";
import {
  findPendingTool,
  type HandoffAgent,
  resumeHandoffTask,
} from "@/lib/copilot/handoff-resume";

/** SDK reconnect replays human-in-the-loop tools only; ordinary frontend handlers need this action. */
export function HandoffResumeNotice({
  botId,
  agent,
  ready,
  run,
}: {
  botId: string;
  agent: HandoffAgent;
  ready: boolean;
  run: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<PendingHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // 聊天被外壳藏着时（DESIGN.md §98.3）不每秒问控制权；回来时马上再查一次。
  const onScreen = useKeptVisible();
  useEffect(() => {
    if (!ready || !onScreen) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let stored = pendingHandoff(botId);
      const state = await readControl(botId).catch(() => null);
      if (!stored) {
        const request = state?.request;
        if (request?.toolCallId && request.status === "waiting") {
          const candidate = {
            requestId: request.id,
            toolCallId: request.toolCallId,
          };
          if (findPendingTool(agent.messages, candidate)) {
            rememberHandoff(botId, candidate.requestId, candidate.toolCallId);
            stored = candidate;
          }
        }
      }
      if (!live) return;
      // FIX-06：控制权已回到机器人或请求已中断时，清掉本地「请点交还」残留，不假装当前还在等。
      if (
        stored &&
        state &&
        (state.request?.status === "interrupted" ||
          state.request?.status === "completed" ||
          state.request?.status === "cancelled" ||
          state.request?.status === "expired" ||
          (state.holder === "bot" && !state.requested))
      ) {
        forgetHandoff(botId, stored.requestId);
        stored = null;
      }
      if (stored && !findPendingTool(agent.messages, stored)) {
        const toolCallId = stored.toolCallId;
        const answered = agent.messages.some(
          (m) => m.role === "tool" && m.toolCallId === toolCallId,
        );
        if (answered) forgetHandoff(botId, stored.requestId);
        stored = null;
      }
      setPending(
        stored && !hasActiveHandoff(botId, stored.requestId) ? stored : null,
      );
      timer = setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [botId, agent, ready, onScreen]);
  // 正在继续的任务只在换了机器人 / 对话或卸载时放弃——藏起来不算。
  useEffect(
    () => () => {
      controller.current?.abort("detached");
    },
    [botId, agent],
  );

  const resume = async () => {
    if (!pending || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setProblem(null);
    try {
      await resumeHandoffTask(botId, pending, agent, run, abort.signal);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "任务无法继续。",
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };
  if (!pending && !busy && !problem) return null;
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-amber-500/10 p-3 text-sm"
      role="status"
    >
      <span>
        {problem ??
          (busy ? "等待此浏览器切换完成。" : "此会话中浏览器任务已暂停。")}
      </span>
      {busy ? (
        <button
          type="button"
          className="underline"
          onClick={() => controller.current?.abort()}
        >
          {"停止等待"}
        </button>
      ) : (
        <button
          type="button"
          className="underline"
          disabled={!pending || agent.isRunning}
          onClick={() => void resume()}
        >
          {"恢复任务"}
        </button>
      )}
    </div>
  );
}
