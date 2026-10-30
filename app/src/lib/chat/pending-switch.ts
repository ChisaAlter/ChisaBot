import { useSyncExternalStore } from "react";

/**
 * 切会话的即时反馈（FIX-PLAN F0 / P1-1）。
 *
 * 左栏点一个机器人时先把「正在切过去的机器人」记在这里：左栏只重画自己那几行，点下去的那一帧高亮就到位；
 * 整段对话的挂载在 `ChatStage` 里延后（`useDeferredValue`），不再跟高亮挤在同一次提交里。
 * 路由跟上（地址变了）就清掉，之后高亮照常按路由算。
 */
let pendingBot: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** 地址一直没跟上（导航被拦下、出错）时最多挂多久，免得高亮停在错的那一行。 */
export const PENDING_SWITCH_MAX_MS = 5000;

function emit() {
  for (const listener of listeners) listener();
}

export function markPendingBot(botId: string) {
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = setTimeout(clearPendingBot, PENDING_SWITCH_MAX_MS);
  if (pendingBot === botId) return;
  pendingBot = botId;
  emit();
}

export function clearPendingBot() {
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = undefined;
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
 * 点下去先只提交左栏高亮，等这一帧画出来再导航（双 rAF ≈ 下一帧开头之后）。
 * 路由一变，订阅路由的组件（右栏、顶栏等）都要同步重画，跟高亮挤在一帧里就又慢了。
 */
export function afterNextPaint(run: () => void) {
  if (typeof requestAnimationFrame !== "function") {
    run();
    return;
  }
  requestAnimationFrame(() => setTimeout(run, 0));
}
