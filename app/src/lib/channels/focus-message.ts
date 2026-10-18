/**
 * DOG-04：Ctrl+K 正文命中深链到消息 — 滚进可视区并短暂高亮（对齐设置搜索 SettingsFind）。
 * 只用 scrollIntoViewWithin（§98.5），避免原生 scrollIntoView 拖动 keep-alive 聊天。
 */
import { scrollIntoViewWithin } from "@/lib/scroll-within";

export const MESSAGE_FLASH_CLASS = "message-flash";
export const MESSAGE_FLASH_MS = 2400;
/** 等 transcript 挂上 data-message-id 的最长等待（异步 connect / 快照）。 */
export const MESSAGE_FIND_WAIT_MS = 4000;

/** 路由 ?message= 合法值：非空、去掉首尾空白；太长当无效（防垃圾 URL）。 */
export function normalizeMessageSearchParam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (!id || id.length > 128) return undefined;
  return id;
}

/** 在 root（默认 document）里找带 data-message-id 的那一行。 */
export function findMessageRow(
  messageId: string,
  root: ParentNode = typeof document !== "undefined"
    ? document
    : (null as unknown as ParentNode),
): HTMLElement | null {
  if (!messageId || !root || typeof root.querySelector !== "function")
    return null;
  try {
    return root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  } catch {
    // CSS.escape 对极端 id 仍可能抛；退回属性选择器手工扫。
    const nodes = root.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const el of nodes) if (el.dataset.messageId === messageId) return el;
    return null;
  }
}

export type FocusMessageOptions = {
  /** 限定查找范围（可见聊天的 scroller）；不给则整页查。 */
  root?: ParentNode | null;
  /** 滚哪个容器；不给则 scrollIntoViewWithin 自己找。 */
  container?: HTMLElement | null;
  behavior?: ScrollBehavior;
  flashMs?: number;
};

/**
 * 把命中消息滚到中间并加 message-flash。找不到返回 false（调用方可稍后重试）。
 */
export function focusMessageInChat(
  messageId: string,
  options: FocusMessageOptions = {},
): boolean {
  const id = normalizeMessageSearchParam(messageId);
  if (!id) return false;
  const root =
    options.root ?? (typeof document !== "undefined" ? document : null);
  if (!root) return false;
  const target = findMessageRow(id, root);
  if (!target) return false;

  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const behavior = options.behavior ?? (reduce ? "auto" : "smooth");
  scrollIntoViewWithin(target, {
    container: options.container ?? undefined,
    block: "center",
    behavior,
  });

  target.classList.remove(MESSAGE_FLASH_CLASS);
  // 强制重启动画（同设置搜索）。
  void target.offsetWidth;
  target.classList.add(MESSAGE_FLASH_CLASS);
  target.setAttribute("data-message-found", "");
  const ms = options.flashMs ?? MESSAGE_FLASH_MS;
  window.setTimeout(() => {
    target.classList.remove(MESSAGE_FLASH_CLASS);
    target.removeAttribute("data-message-found");
  }, ms);
  return true;
}
