import { useCallback, useEffect, useRef } from "react";
import { readSync, SYNC_INTERVAL_MS, type ThreadActivity } from "./bot-thread";
import { useKeptVisible } from "@/lib/kept-visible";

/**
 * 频道聊天（/channel/:id）的「这条对话有没有新动静」（DESIGN.md §64，CB-041 / CB-043）。
 *
 * `/bot` 的同步（§42）由 `useBotThread` 顺带问服务器；频道聊天的对话 id 固定在频道上（`channel.threadId`），
 * 不需要「当前对话」那一半，只要变化戳：前台每 2 秒一次 `GET /api/bot-threads/<agentId>/sync?threadId=`，
 * 隐藏时不问，回到前台 / 获得焦点 / 网络恢复 / `kick()` 时马上问一次。拿到的戳交给订阅者
 * （`useConversationSync` 接上正在写的回答、拉别的设备发的消息；频道聊天自己在回答结束时重读一次对话）。
 */
/** 藏着的聊天问变化戳的间隔（DESIGN.md §98.3）。 */
export const HIDDEN_SYNC_INTERVAL_MS = 10_000;

export function useThreadActivity(agentId: string, threadId: string | undefined) {
  const listenersRef = useRef(new Set<(activity: ThreadActivity) => void>());
  const kickRef = useRef<() => void>(() => {});
  /**
   * 聊天被外壳藏着（DESIGN.md §98.3）：放慢到 10 秒一次（不停——藏着时别的设备写了什么，藏着的时候就接上，
   * 回来才接会让发送键闪一下「停止」）；回来时马上问一次。
   */
  const onScreen = useKeptVisible();
  const onScreenRef = useRef(onScreen);
  const pauseRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let busy = false;
    /** 服务器没有这个接口（旧版本 / 不是本地会话模式）：不再问。 */
    let unsupported = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer =
        alive && !unsupported && visible()
          ? setTimeout(() => void tick(), onScreenRef.current ? SYNC_INTERVAL_MS : HIDDEN_SYNC_INTERVAL_MS)
          : undefined;
    };
    const tick = async () => {
      if (!alive || busy || unsupported) return;
      busy = true;
      try {
        const reply = await readSync(agentId, threadId);
        if (!alive) return;
        if (reply === "unsupported") {
          unsupported = true;
          return;
        }
        if (reply?.thread && reply.thread.threadId === threadId)
          for (const listener of listenersRef.current) listener(reply.thread);
      } finally {
        busy = false;
        schedule();
      }
    };
    const now = () => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (visible()) void tick();
    };
    kickRef.current = now;
    pauseRef.current = () => {
      if (!busy) schedule();
    };
    const onVisibility = () => (visible() ? now() : timer && clearTimeout(timer));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", now);
    window.addEventListener("online", now);
    window.addEventListener("pageshow", now);
    schedule();
    return () => {
      alive = false;
      kickRef.current = () => {};
      pauseRef.current = () => {};
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", now);
      window.removeEventListener("online", now);
      window.removeEventListener("pageshow", now);
    };
  }, [agentId, threadId]);

  useEffect(() => {
    if (onScreenRef.current === onScreen) return;
    onScreenRef.current = onScreen;
    if (onScreen) kickRef.current();
    else pauseRef.current();
  }, [onScreen]);

  const onActivity = useCallback((listener: (activity: ThreadActivity) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  /** 马上问一次（比如刚打开时的接入到了时限被截断：不等下一个 2 秒）。 */
  const kick = useCallback(() => kickRef.current(), []);

  return { onActivity, kick };
}

type Row = { id: string; role: string; content?: unknown; toolCalls?: readonly { id: string }[] };
/**
 * 回答结束后重读到的对话里，最后一条用户消息之后、这台也有的那几条（回答 / 思考），按服务器存的补齐：
 *  - 正文：这台手里的比服务器存的短（被截断的半截）就换成服务器的。只会变长。
 *  - 工具调用：服务器那条带的调用比这台多（断线正好落在「开场一句写完、工具调用还没开始」之间，
 *    这台的开场一句没有 toolCalls），而且这台已有的都在里面，就换成服务器的。不换的话这一轮没有干活卡可收，
 *    开场一句作为气泡露在结果上面，刷新后却没有（0.1.110 验收「重连后 5 条、刷新后 4 条」的一种）。
 * 别的消息和字段不动；没变化返回原数组。
 */
export function withStoredTail<T extends Row>(local: readonly T[], stored: readonly T[]): T[] {
  const lastUser = local.map((message) => message.role).lastIndexOf("user");
  const byId = new Map(stored.map((message) => [message.id, message]));
  let changed = false;
  const result = local.map((message, at) => {
    if (at <= lastUser) return message;
    const saved = byId.get(message.id);
    if (!saved || saved.role !== message.role) return message;
    let next = message;
    if (
      typeof saved.content === "string" &&
      typeof message.content === "string" &&
      saved.content.length > message.content.length &&
      saved.content.startsWith(message.content.slice(0, 40))
    )
      next = { ...next, content: saved.content };
    const savedCalls = saved.toolCalls ?? [];
    const localCalls = message.toolCalls ?? [];
    if (
      savedCalls.length > localCalls.length &&
      localCalls.every((call) => savedCalls.some((stored) => stored.id === call.id))
    )
      next = { ...next, toolCalls: savedCalls };
    if (next !== message) changed = true;
    return next;
  });
  return changed ? result : (local as T[]);
}
