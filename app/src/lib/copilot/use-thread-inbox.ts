import type { Message } from "@ag-ui/core";
import type { AbstractAgent } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { tryClient } from "../client";
import { applyInboxState, inboxState, markRead, queuedFor, restoreQueue, takeQueued } from "./thread-inbox";
import { ACTIVE_WORKER, type WorkerView, workerKeys } from "./workers";

type RunAgent = (options: { agent: AbstractAgent }) => Promise<unknown>;

/**
 * 机器人聊天页面里收件箱和后台任务的「对账」（DESIGN.md §38）：
 *
 * 1. 排队的消息一出现在对话记录里（服务器推的快照），就从排队里拿掉，挂「已读取」。
 * 2. 整轮成功结束时还有没被读到的（入队和结束撞上了），按普通消息发出去；失败 / 停止时保留排队。
 * 3. 打开对话时把服务器上还在排队的接回来。
 * 4. 服务器自己起的一轮（后台任务把结果交回来、浏览器没在跑）：这个页面不在那一轮的流里，
 *    所以它在跑的时候每 1.2 秒把服务器存的对话记录同步过来，结果和总结就会出现，不用刷新。
 */
export function useThreadInbox(
  threadId: string | null | undefined,
  agent: AbstractAgent,
  runAgent: RunAgent,
  /**
   * 第 4 点（服务器自己起的一轮时每 1.2 秒拉一次存下的对话）要不要做。频道聊天传 false：它有 §64 的
   * `useConversationSync({ liveTail })`，服务器在回答时直接接上实时流，再整段拉一次会和流打架。
   */
  options: {
    pullServerTurns?: boolean;
    /** Whole browser turn, including frontend tools and the gaps between wire runs. */
    turnRunning?: boolean;
    /** Read refs at flush time: a timer can fire before React commits the next render. */
    canFlush?: () => boolean;
  } = {},
) {
  const pullServerTurns = options.pullServerTurns !== false;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const flushRef = useRef<(() => void) | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const reconcile = () => {
      const ids = new Set(agent.messages.map((message) => message.id));
      for (const item of queuedFor(threadId)) if (item.status !== "paused" && ids.has(item.id)) markRead(threadId, item.id);
    };
    let flushing = false;
    let failed = false;
    const idle = () => alive && !agent.isRunning && !optionsRef.current.turnRunning &&
      optionsRef.current.canFlush?.() !== false && !failed;
    const flush = async () => {
      if (!idle() || flushing) return;
      reconcile();
      if (!queuedFor(threadId).some((item) => item.status === "queued" && !item.remote)) return;
      flushing = true;
      try {
        // Wire finalization is not the end of a frontend turn. Verify the server's relay
        // state too, and reconcile claims whose snapshot has not reached this tab yet.
        const state = await inboxState(threadId);
        if (!state || !idle()) return;
        applyInboxState(threadId, state);
        reconcile();
        if (state.running || state.paused) return;
        const left = takeQueued(threadId);
        if (!left.length) return;
        for (const item of left) agent.addMessage({ id: item.id, role: "user", content: item.text } as Message);
        await runAgent({ agent }).catch(() => {});
      } finally {
        flushing = false;
      }
    };
    const scheduleFlush = () => { setTimeout(() => void flush(), 250); };
    flushRef.current = scheduleFlush;
    const subscription = agent.subscribe({
      onMessagesChanged: () => reconcile(),
      onRunStartedEvent: () => { failed = false; },
      onRunErrorEvent: () => { failed = true; },
      onRunFailed: () => { failed = true; },
      onRunFinishedEvent: ({ event }) => { if (event.outcome?.type === "cancelled") failed = true; },
      onRunFinalized: scheduleFlush,
    });
    void restoreQueue(threadId).then((state) => {
      reconcile();
      if (state && !state.running && !state.paused) scheduleFlush();
    });
    return () => {
      alive = false;
      if (flushRef.current === scheduleFlush) flushRef.current = null;
      subscription.unsubscribe();
    };
  }, [threadId, agent, runAgent]);

  // The final wire callback fires before CopilotKit resolves frontend tool follow-ups.
  // A whole-turn transition to idle must schedule the fallback that callback deferred.
  useEffect(() => {
    if (!options.turnRunning) flushRef.current?.();
  }, [options.turnRunning]);

  useEffect(() => {
    if (!threadId || !pullServerTurns) return;
    let alive = true;
    let serverRunning = false;
    let busy = false;
    /** 有任务交回来的那条消息（结果，或用户在卡片上停掉后的「已停止」）还没出现在这边。 */
    const resultMissing = () => {
      const workers = queryClient.getQueryData<WorkerView[]>(workerKeys.thread(threadId)) ?? [];
      const have = new Set(agent.messages.map((message) => message.id));
      return workers.some(
        (worker) =>
          Boolean(worker.resultMessageId) && !have.has(worker.resultMessageId!) &&
          Date.now() - Date.parse(worker.finishedAt ?? worker.createdAt) < 10 * 60_000,
      );
    };
    const workersNeedSync = () => {
      const workers = queryClient.getQueryData<WorkerView[]>(workerKeys.thread(threadId)) ?? [];
      const have = new Set(agent.messages.map((message) => message.id));
      return workers.some(
        (worker) =>
          ACTIVE_WORKER.includes(worker.status) ||
          // 停掉的任务：只有用户在卡片上停的才有交回的「已停止」消息（有 resultMessageId），要等它出现。
          (Date.now() - Date.parse(worker.finishedAt ?? worker.createdAt) < 10 * 60_000 &&
            (worker.status === "cancelled"
              ? Boolean(worker.resultMessageId) && !have.has(worker.resultMessageId!)
              : !worker.resultMessageId || !have.has(worker.resultMessageId))),
      );
    };
    const pull = async () => {
      try {
        const response = await tryClient(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages`);
        if (!response.ok || !alive || agent.isRunning) return;
        const body = await response.json() as { messages?: Message[] } | null;
        const messages = body?.messages;
        if (!Array.isArray(messages) || !messages.every((message) => message && typeof message.id === "string" && typeof message.role === "string") || !alive || agent.isRunning) return;
        const current = JSON.stringify(agent.messages.map((message) => [message.id, (message as { content?: unknown }).content]));
        const next = JSON.stringify(messages.map((message) => [message.id, (message as { content?: unknown }).content]));
        if (current !== next) agent.setMessages(messages);
      } catch {
        // A timed-out or malformed snapshot cannot erase the readable local conversation.
      }
    };
    const tick = async () => {
      if (busy || !alive || agent.isRunning) return;
      if (!serverRunning && !workersNeedSync()) return;
      busy = true;
      try {
        const state = await inboxState(threadId);
        const wasRunning = serverRunning;
        serverRunning = Boolean(state?.running);
        // 交付那一轮很短时可能两次轮询之间就跑完了：交回的消息还没到，也拉一次。
        if (serverRunning || wasRunning || resultMissing()) await pull();
      } catch {
        // Preserve the current transcript and let the next polling opportunity reconcile.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [threadId, agent, queryClient, pullServerTurns]);
}
