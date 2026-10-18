import type { AbstractAgent } from "@copilotkit/react-core/v2";
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

type Connect = (options: { agent: AbstractAgent }) => Promise<unknown>;

/**
 * 本机自己截断（重新生成 / 编辑后重发，DESIGN.md §67）后服务器回的对话版本。本机已经截好了，同步看到这个
 * 版本时不再重建；别的版本（别的设备截的）才重建。
 */
const ownRevisions = new Map<string, string>();
export function noteOwnRevision(threadId: string, revision: string) {
  ownRevisions.set(threadId, revision);
}

/**
 * 版本变化要不要重建：第一次看到（还没有基线）不算；和基线一样不算；是本机自己截出来的那个版本不算。
 */
export function revisionNeedsRebuild(known: string | null, seen: string | undefined, own: string | undefined): boolean {
  if (seen === undefined || known === null) return false;
  if (seen === known) return false;
  return seen !== own;
}

/**
 * 合并式接入时哪些消息算「这台已经有了」（回放里它们的事件跳过）。
 *
 * `liveTail`（频道聊天，DESIGN.md §64）：服务器正在回答时，最后一条用户消息之后的那几条（正在写的回答、
 * 思考、工具调用）不算——这台手里的只是刷新 / 切后台前收到的半截，跳过它们的事件就会一直停在半截上。
 * 不跳过时由 `tailReplayPatch` 在「开始」事件里先清空这条（SDK 自己不清，§90.3），再按回放重建，然后接着实时往下写。
 */
export function knownForMerge(
  messages: readonly { id: string; role: string; toolCalls?: { id: string }[] }[],
  liveTail = false,
): { messages: Set<string>; toolCalls: Set<string> } {
  let keep = messages.length;
  if (liveTail) {
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    keep = lastUser + 1;
  }
  const kept = messages.slice(0, keep);
  return {
    messages: new Set(kept.map((message) => message.id)),
    toolCalls: new Set(kept.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id))),
  };
}

/**
 * `liveTail` 接入时「这台手里只有半截」的那几条（最后一条用户消息之后）：回放从头重建它们。
 *
 * 以前以为 SDK 在 TEXT_MESSAGE_START 时会清空已有的同 id 消息——它不会（@ag-ui/client：已有就不新建，
 * 正文照样往后追加），于是回放把整段又接了一遍：「刚才安装调用中断了…刚才安装调用中断了…」（DESIGN.md §90.3）。
 * 工具调用同理（参数追加成两份 JSON），工具结果会多插一条同 id 的消息。这里在回放到它们时：
 *  - 文字 / 思考的「开始」：先把这条的正文清空（每次接入每条只清一次），后面的正文按回放重新写；
 *  - 工具调用的「开始」：参数清空；
 *  - 工具结果：已经有同 id / 同一个调用的结果就原地换内容，不再插第二条。
 */
export type TailReplay = { messages: Set<string>; toolCalls: Set<string>; reset: Set<string> };

export function liveTailOf(messages: readonly { id: string; role: string; toolCalls?: { id: string }[] }[]): TailReplay {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  const tail = messages.slice(lastUser + 1);
  return {
    messages: new Set(tail.map((message) => message.id)),
    toolCalls: new Set(tail.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id))),
    reset: new Set(),
  };
}

type TailMsg = { id: string; role: string; content?: unknown; toolCallId?: string; toolCalls?: { id: string; function: { name: string; arguments: string } }[] };

export function tailReplayPatch<T extends TailMsg>(
  event: { type: string; messageId?: string; toolCallId?: string; content?: unknown },
  messages: readonly T[],
  tail: TailReplay,
): { messages?: T[]; stopPropagation?: true } | undefined {
  if ((event.type === "TEXT_MESSAGE_START" || event.type === "REASONING_MESSAGE_START") && event.messageId) {
    const id = event.messageId;
    if (!tail.messages.has(id) || tail.reset.has(id)) return;
    tail.reset.add(id);
    if (!messages.some((message) => message.id === id)) return;
    return { messages: messages.map((message) => (message.id === id ? { ...message, content: "" } : message)) };
  }
  if (event.type === "TOOL_CALL_START" && event.toolCallId) {
    const id = event.toolCallId;
    const key = `tool:${id}`;
    if (!tail.toolCalls.has(id) || tail.reset.has(key)) return;
    tail.reset.add(key);
    if (!messages.some((message) => message.toolCalls?.some((call) => call.id === id))) return;
    return {
      messages: messages.map((message) =>
        message.toolCalls?.some((call) => call.id === id)
          ? { ...message, toolCalls: message.toolCalls.map((call) => (call.id === id ? { ...call, function: { ...call.function, arguments: "" } } : call)) }
          : message,
      ),
    };
  }
  if (event.type === "TOOL_CALL_RESULT") {
    const at = messages.findIndex(
      (message) =>
        (event.messageId !== undefined && message.id === event.messageId) ||
        (message.role === "tool" && event.toolCallId !== undefined && message.toolCallId === event.toolCallId),
    );
    if (at === -1) return;
    const next = [...messages];
    next[at] = { ...next[at]!, content: event.content };
    return { messages: next, stopPropagation: true };
  }
  return;
}

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
  options: {
    liveTail?: boolean;
    /**
     * 本机正在发消息 / 等回答：不要再开一次 connect。
     * `agent.isRunning` 只在 run/connect 真正开始后才为 true；`say` 里还有 joinGate /
     * panelAuthoring 等空档，这段空档里 sync 若重接，会和即将发出的 `/run` 抢同一条 agent
     *（CopilotKit `runAgent` 会先 `detachActiveRun`，超大回放时主线程卡住，/run 迟迟发不出）。
     */
    suppressConnect?: () => boolean;
  } = {},
) {
  const liveTail = options.liveTail === true;
  const suppressConnect = options.suppressConnect;
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
    /** liveTail 接入时要按回放重建的那几条（§90.3）。 */
    let tail: TailReplay | null = null;
    /** 对话版本基线（§67）；版本变了（别的设备截断过）就按服务器回放重建，本机在跑时等它结束再重建。 */
    let knownRevision: string | null = null;
    let rebuildPending = false;
    /**
     * mode "merge"（平时）：不清空列表，只把新的接上——见下面的 onEvent。
     * mode "rebuild"（顺序和服务器不一致时）：照 SDK 原样，先清空再按服务器回放重建。
     */
    const join = (mode: "merge" | "rebuild" = "merge", running = false) => {
      if (connecting || agent.isRunning || suppressConnect?.()) return;
      connecting = true;
      merge = mode === "merge" ? knownForMerge(agent.messages as never, liveTail && running) : null;
      tail = mode === "merge" && liveTail && running ? liveTailOf(agent.messages as never) : null;
      void connect({ agent })
        .catch(() => {})
        .finally(() => {
          connecting = false;
          merge = null;
          tail = null;
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
        if (tail) return tailReplayPatch(e, messages as never, tail) as never;
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
      if (revisionNeedsRebuild(knownRevision, activity.revision, ownRevisions.get(threadId))) rebuildPending = true;
      if (activity.revision !== undefined) knownRevision = activity.revision;
      if (rebuildPending && !agent.isRunning && !connecting) {
        // 别的设备重新生成 / 编辑重发截断了这段对话：清空，按服务器回放重建（截掉的气泡、卡片一起消失）。
        rebuildPending = false;
        last = activity;
        rebase = false;
        join("rebuild");
        return;
      }
      if (agent.isRunning || connecting || suppressConnect?.()) {
        // 本机在跑 / 正在接 / 本机刚点了发送：它收到的就是最新的，等它结束再记基线。
        rebase = true;
        return;
      }
      const previous = last;
      last = activity;
      if (rebase || !previous) {
        rebase = false;
        // 服务器在回答、这台却没在跟（刚回到前台、刚打开时那一轮还没开始）：接上。
        if (activity.running) join("merge", true);
        return;
      }
      if (activity.workers !== previous.workers)
        void queryClient.invalidateQueries({ queryKey: workerKeys.thread(threadId) });
      if (activity.inbox !== previous.inbox) void restoreQueue(threadId);
      if (activity.seq !== previous.seq || activity.running) join("merge", activity.running);
    });
    return () => {
      alive = false;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      off();
      subscription.unsubscribe();
    };
  }, [threadId, agent, connect, onActivity, queryClient, liveTail, suppressConnect]);
}
