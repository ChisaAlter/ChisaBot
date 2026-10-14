import type { AbstractAgent } from "@ag-ui/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ThreadActivity } from "./bot-thread";
import { restoreQueue } from "./thread-inbox";
import { workerKeys } from "./workers";

/** 合并式接入时，这台已有的消息 / 工具调用的这些回放事件跳过。 */
const KNOWN_MESSAGE_EVENTS = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_END",
]);
const KNOWN_TOOL_EVENTS = new Set(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);

type Msg = { id: string };
/** 把快照里这台没有的消息按快照里的位置插进来（跟在它前面最近一条这台也有的消息后面）；这台已有的不动、不删。 */
export function mergeSnapshot<T extends Msg>(local: readonly T[], snapshot: readonly T[]): T[] {
  const result = [...local];
  const index = new Map(result.map((message, at) => [message.id, at]));
  let changed = false;
  for (let at = 0; at < snapshot.length; at++) {
    const message = snapshot[at]!;
    if (index.has(message.id)) continue;
    let insertAt = 0;
    for (let back = at - 1; back >= 0; back--) {
      const position = index.get(snapshot[back]!.id);
      if (position !== undefined) {
        insertAt = position + 1;
        break;
      }
    }
    result.splice(insertAt, 0, message);
    changed = true;
    index.clear();
    for (const [position, item] of result.entries()) index.set(item.id, position);
  }
  return changed ? result : (local as T[]);
}

/**
 * 本机和服务器的用户消息先后是否不一致（只比两边都有的那些）。
 *
 * 只在一边有的不算：这台发了但服务器没存下来的（这一轮在上游 / 网络上失败了）留在这台，照旧显示，
 * 不为它重建——重建会把它从列表里删掉，整段聊天跟着往回跳一截（DESIGN.md §42.7）；服务器有、这台没有的
 * 由合并式接入补进来，也不用重建。
 */
export function userOrderDiffers(local: readonly string[], server: readonly string[]): boolean {
  const inServer = new Set(server);
  const inLocal = new Set(local);
  const a = local.filter((id) => inServer.has(id));
  const b = server.filter((id) => inLocal.has(id));
  if (a.length !== b.length) return true;
  return a.some((id, at) => id !== b[at]);
}

/**
 * rebase 之后要不要因为「服务器还在回答」立刻 join。
 *
 * 只有第一次观察到活动（还没有 previous）才接：刚打开 / 刚挂上同步时那一轮已经在跑。
 * 本机刚跑完一轮也会把 rebase 设上，这时 previous 还在——服务器 running 位常常晚几十到几百毫秒才落下，
 * 若这里再 join，会无谓重连、消息节点重挂，content-visibility 的高度记忆清掉，视口上方突然变高，
 * 看起来就像对话记录往回跳（CB-005）。之后若真有别的设备在跑，普通分支里的 `activity.running` 仍会 join。
 */
export function shouldCatchRunningOnRebase(previous: unknown, running: boolean): boolean {
  return running && previous == null;
}

type Connect = (options: { agent: AbstractAgent }) => Promise<unknown>;

/**
 * 全端同步（DESIGN.md §42）：同一段对话在别的设备上有了动静，把它拉到这台设备。
 *
 * `useBotThread` 每 2 秒（前台时）问一次服务器这条对话的变化戳（事件序号、是否在回答、后台任务 / 收件箱
 * 最后更新时间），这里比较：
 *
 * - 事件序号变了，或者服务器正在回答而这台没在跟：`connectAgent` 重新接上这条对话——和刷新页面时一样，
 *   服务器先回放已存的事件，正在跑的那一轮接着实时推过来（另一台设备上的回答在这里同样一个字一个字出来，
 *   输入框也进入「回答中」，这时发的消息进收件箱）。不重挂聊天组件，输入框里没发的草稿不丢。
 * - 后台任务戳变了：刷新任务卡片。
 * - 收件箱戳变了：把别的设备排的消息接过来显示（标 remote，结束时不由这台补发）。
 *
 * 这台自己在跑（发消息 / 正在接）时什么都不做；跑完后下一次同步只记下新的基线，不重复回放自己刚收到的东西。
 */
export function useConversationSync(
  threadId: string | undefined,
  agent: AbstractAgent,
  connect: Connect,
  onActivity: (listener: (activity: ThreadActivity) => void) => () => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let last: ThreadActivity | null = null;
    /** 下一次同步只记基线（刚打开 / 本机刚跑完一轮或刚接完）。 */
    let rebase = true;
    let connecting = false;
    /** 合并式接入时，接入前这台已经有的消息 / 工具调用（回放里它们的内容不再追加一遍）。 */
    let merge: { messages: Set<string>; toolCalls: Set<string> } | null = null;
    /**
     * mode "merge"（平时）：不清空列表，只把新的接上——见下面的 onEvent。
     * mode "rebuild"（顺序和服务器不一致时）：照 SDK 原样，先清空再按服务器回放重建。
     */
    const join = (mode: "merge" | "rebuild" = "merge") => {
      if (connecting || agent.isRunning) return;
      connecting = true;
      merge =
        mode === "merge"
          ? {
              messages: new Set(agent.messages.map((message) => message.id)),
              toolCalls: new Set(
                agent.messages.flatMap((message) =>
                  ((message as { toolCalls?: { id: string }[] }).toolCalls ?? []).map((call) => call.id),
                ),
              ),
            }
          : null;
      void connect({ agent })
        .catch(() => {})
        .finally(() => {
          connecting = false;
          merge = null;
          rebase = true;
        });
    };
    /*
     * 本机一轮结束后对一次顺序：两台设备几乎同时发时，服务器只开一轮，后到的那条被读进这一轮的中间
     * （§38.1）；但后到那台本地是把自己的消息先放在末尾的，消息快照只换内容不换顺序，于是两台设备看到的
     * 顺序不一样。比较两边都有的用户消息的先后（userOrderDiffers），和服务器不一样就重新接一次（服务器回放，以它为准）。只读一次消息列表，
     * 平时顺序一致什么都不做。
     */
    const hasResult = (toolCallId: string) =>
      agent.messages.some((message) => message.role === "tool" && (message as { toolCallId?: string }).toolCallId === toolCallId);
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(async () => {
        if (!alive || agent.isRunning || connecting) return;
        const response = await fetch(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages`, { credentials: "include" }).catch(() => null);
        if (!alive || !response?.ok || agent.isRunning || connecting) return;
        const body = (await response.json().catch(() => null)) as { messages?: { id: string; role: string }[] } | null;
        const userIds = (list: readonly { id: string; role: string }[]) => list.filter((message) => message.role === "user").map((message) => message.id);
        const server = userIds(body?.messages ?? []);
        const local = userIds(agent.messages as never);
        if (!server.length) return;
        if (userOrderDiffers(local, server)) join("rebuild");
        // 服务器有、这台还没有的用户消息（别的设备刚发的）：合并式接上，不清空。
        else if (server.some((id) => !local.includes(id))) join();
      }, 800);
    };
    const subscription = agent.subscribe({
      /*
       * 合并式接入（为什么不直接用 SDK 的重连）：HTTP 重连的回放先发一个空的消息快照、再一条条重建，
       * 每一步都是一次同步渲染——列表在几帧里先变短再变回来，滚动位置被浏览器夹到顶上，另一台设备上
       * 一发消息这台就往回跳一大截（实测 1068px）。所以由这里接手：丢掉开头那个空快照；这台已经有的
       * 消息，回放里的正文 / 工具参数 / 工具结果不再追加（否则会重复一遍），新消息照常接上、照常流式。
       */
      onEvent: ({ event, messages }) => {
        if (!merge) return;
        const e = event as { type: string; messages?: unknown[]; messageId?: string; toolCallId?: string };
        if (e.type === "MESSAGES_SNAPSHOT" && Array.isArray(e.messages)) {
          // 空快照（HTTP 重连开头那个）丢掉；回放里的历史快照只用来「补」这台没有的消息、按服务器的位置插进去，
          // 不删这台已有的（历史快照比现在短，照 SDK 原样会把之后的消息全删掉）。顺序不一致由 reconcile 重建。
          if (!e.messages.length) return { stopPropagation: true };
          return { messages: mergeSnapshot(messages as never, e.messages as never) as never, stopPropagation: true };
        }
        // 这台已经有的消息：开始 / 正文 / 结束整组都跳过（SDK 在「开始」时会把已有消息的正文清空，只跳正文会留下空气泡）。
        if (e.messageId && KNOWN_MESSAGE_EVENTS.has(e.type) && merge.messages.has(e.messageId)) return { stopPropagation: true };
        if (e.toolCallId && KNOWN_TOOL_EVENTS.has(e.type) && merge.toolCalls.has(e.toolCallId)) return { stopPropagation: true };
        if (e.type === "TOOL_CALL_RESULT" && ((e.messageId && merge.messages.has(e.messageId)) || (e.toolCallId && merge.toolCalls.has(e.toolCallId) && hasResult(e.toolCallId))))
          return { stopPropagation: true };
        return;
      },
      onRunFinalized: () => {
        rebase = true;
        if (!connecting) reconcile();
      },
      onRunFailed: () => {
        rebase = true;
      },
    });
    const off = onActivity((activity) => {
      if (!alive || activity.threadId !== threadId) return;
      if (agent.isRunning || connecting) {
        // 本机在跑或正在接：它收到的就是最新的，等它结束再记基线。
        rebase = true;
        return;
      }
      const previous = last;
      last = activity;
      if (rebase || !previous) {
        rebase = false;
        // 刚打开时服务器已经在回答：接上。本机刚跑完一轮的 rebase 不要为了 running 再 join（见 shouldCatchRunningOnRebase）。
        if (shouldCatchRunningOnRebase(previous, activity.running)) join();
        return;
      }
      if (activity.workers !== previous.workers)
        void queryClient.invalidateQueries({ queryKey: workerKeys.thread(threadId) });
      if (activity.inbox !== previous.inbox) void restoreQueue(threadId);
      if (activity.seq !== previous.seq || activity.running) join();
    });
    return () => {
      alive = false;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      off();
      subscription.unsubscribe();
    };
  }, [threadId, agent, connect, onActivity, queryClient]);
}
