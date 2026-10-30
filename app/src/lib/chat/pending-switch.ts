import { useSyncExternalStore } from "react";

/**
 * 切会话的即时反馈（FIX-PLAN F0 / P1-1）。
 *
 * 左栏点一个机器人时先把「正在切过去的机器人」记在这里：左栏只重画自己那几行，点下去的那一帧高亮就到位；
 * 整段对话的挂载在 `ChatStage` 里延后（`useDeferredValue`），不再跟高亮挤在同一次提交里。
 * 路由跟上（地址变了）就清掉，之后高亮照常按路由算。
 */
let pendingBot: string | null = null;
/** 切走之前的那段对话（地址栏里的频道）；只有它的输入框在切换中要拦发送。 */
let pendingFrom: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function routeChannelOf(pathname: string): string | null {
  const match = /^\/channel\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1] ?? "");
  return id === "new" ? null : id;
}
const listeners = new Set<() => void>();

/** 地址一直没跟上（导航被拦下、出错）时最多挂多久，免得高亮停在错的那一行。 */
export const PENDING_SWITCH_MAX_MS = 5000;

function emit() {
  for (const listener of listeners) listener();
}

export function markPendingBot(
  botId: string,
  fromChannel: string | null = routeChannelOf(
    typeof location === "undefined" ? "" : location.pathname,
  ),
) {
  // 连点时记的是最早切走的那段（真正还挂着输入框的旧对话）。
  if (pendingBot === null) pendingFrom = fromChannel;
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = setTimeout(clearPendingBot, PENDING_SWITCH_MAX_MS);
  if (pendingBot === botId) return;
  pendingBot = botId;
  emit();
}

export function clearPendingBot() {
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = undefined;
  pendingFrom = null;
  if (pendingBot === null) return;
  pendingBot = null;
  emit();
}

export function getPendingBot() {
  return pendingBot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 正在切过去的机器人（没有则 null）。 */
export function usePendingBot(): string | null {
  return useSyncExternalStore(subscribe, getPendingBot, () => null);
}

/** 普通左键点击（不带修饰键、不是中键）才算「在这一页切过去」；新标签页打开不改高亮。 */
export function isPlainClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * 点下去先只提交左栏高亮，等这一帧画出来再导航（rAF 后再排一个宏任务 ≈ 下一帧开头之后）。
 * 路由一变，订阅路由的组件（右栏、顶栏等）都要同步重画，跟高亮挤在一帧里就又慢了。
 *
 * 只留最新的一次：新请求（或 `cancelAfterNextPaint`）会撤掉还没跑的那次，
 * 免得「点会话、马上点设置」时排在后面的旧导航又把页面拉回去。
 * 排队期间用户又点了别处 / 按了 Enter（例如点设置），也撤掉，并熄掉左栏的「正在切过去」。
 */
let queued: { raf?: number; timer?: ReturnType<typeof setTimeout> } | null =
  null;

function onLaterInput(event: Event) {
  if (event instanceof KeyboardEvent) {
    if (event.key !== "Enter") return;
    // 输入法选词的 Enter 不算（isComposing；部分浏览器只给 keyCode 229）。
    if (event.isComposing || event.keyCode === 229) return;
  }
  cancelAfterNextPaint();
  clearPendingBot();
}

function watchLaterInput(on: boolean) {
  if (typeof document === "undefined") return;
  const method = on ? "addEventListener" : "removeEventListener";
  document[method]("click", onLaterInput, true);
  document[method]("keydown", onLaterInput, true);
}

export function cancelAfterNextPaint() {
  if (!queued) return;
  if (queued.raf !== undefined && typeof cancelAnimationFrame === "function")
    cancelAnimationFrame(queued.raf);
  if (queued.timer !== undefined) clearTimeout(queued.timer);
  queued = null;
  watchLaterInput(false);
}

export function afterNextPaint(run: () => void) {
  cancelAfterNextPaint();
  if (typeof requestAnimationFrame !== "function") {
    run();
    return;
  }
  const job: { raf?: number; timer?: ReturnType<typeof setTimeout> } = {};
  queued = job;
  // 触发这次的点击已经过了捕获阶段，这里只会接到之后的点击 / Enter。
  watchLaterInput(true);
  job.raf = requestAnimationFrame(() => {
    job.raf = undefined;
    job.timer = setTimeout(() => {
      if (queued !== job) return;
      queued = null;
      watchLaterInput(false);
      run();
    }, 0);
  });
}

/**
 * 发送前核对：输入框所属的会话不是当前地址栏的会话（正在切走），或左栏正在切到别的机器人，就不发，
 * 草稿原样留着（FIX-PLAN F0 的风险项：切换中焦点还在旧输入框里按 Enter）。
 */
export function sendTargetsStaleChannel(
  channelId: string | undefined,
  pathname: string = typeof location === "undefined" ? "" : location.pathname,
): boolean {
  if (!channelId) return false;
  // 只拦切走的那段旧对话：导航被拦下 / 失败时，别的输入框不该陪着发不出去。
  if (pendingBot !== null && pendingFrom === channelId) return true;
  const routeChannel = routeChannelOf(pathname);
  return routeChannel !== null && routeChannel !== channelId;
}
