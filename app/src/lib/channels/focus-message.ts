/**
 * DOG-04：Ctrl+K 正文命中深链到消息 — 滚进可视区并短暂高亮（对齐设置搜索 SettingsFind）。
 * 只用 scrollIntoViewWithin（§98.5），避免原生 scrollIntoView 拖动 keep-alive 聊天。
 */
import { scrollIntoViewWithin, scrollParentOf } from "@/lib/scroll-within";

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

/** 定位到消息后挂在滚动容器上的标记：在它存在期间，聊天不自动贴底（chat-transcript 读它）。 */
export const MESSAGE_HOLD_ATTR = "data-message-hold";
/** 发消息时派发（或任何「我要回到底部」的意图）：放开定位，交回贴底。 */
export const MESSAGE_HOLD_RELEASE_EVENT = "chisabot:message-hold-release";

const HOLD_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * CB-106 r2：定位到 ?message= 那条之后，把它钉在视野里，直到人自己滚动或发消息。
 *
 * 以前是 350 / 800 / 1400 / 2200ms 几次复查，图片晚到（QA：4.5–5 秒）时贴底照样把目标拉走。现在：
 *  - 滚动容器上挂 `data-message-hold`，chat-transcript 的贴底 / 打开时的落点逻辑看到它就不动；
 *  - ResizeObserver 盯着内容和目标：上面的图片撑高、目标自己变高，都在绘制前把目标放回原来离顶部的距离；
 *  - 滚动事件里也校正一次：滚动容器（第三方 message-scroller）自己的「跟着底部」不经过我们，
 *    不是人滚的滚动一律放回去；
 *  - 滚轮 / 手指 / 拖滚动条 / 方向键翻页 / 发消息 → 放开。
 * 返回放开函数（卸载 / 换消息时调用）。
 */
export function holdMessageInView(
  target: HTMLElement,
  scroller: HTMLElement | null = target.closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]',
  ) ?? scrollParentOf(target),
): () => void {
  if (!scroller) return () => undefined;
  const offsetOf = () =>
    target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  let want = offsetOf();
  let done = false;
  let userAt = Number.NEGATIVE_INFINITY;
  const restore = () => {
    if (done || !target.isConnected) return;
    const off = offsetOf() - want;
    if (Math.abs(off) <= 1) return;
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop += off;
    scroller.style.scrollBehavior = "";
  };
  const user = () => {
    userAt = performance.now();
    release();
  };
  const onKey = (event: KeyboardEvent) => {
    if (HOLD_KEYS.has(event.key)) user();
  };
  const onPointer = (event: PointerEvent) => {
    // 按在滚动条上（视口本身）= 要拖着翻。
    if (event.target === scroller) user();
  };
  const onScroll = () => {
    if (performance.now() - userAt < 400) return;
    restore();
  };
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => restore())
      : null;
  const content =
    scroller.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    ) ?? (scroller.firstElementChild as HTMLElement | null);
  if (content) observer?.observe(content);
  observer?.observe(target);
  scroller.setAttribute(MESSAGE_HOLD_ATTR, "true");
  scroller.addEventListener("wheel", user, { passive: true });
  scroller.addEventListener("touchstart", user, { passive: true });
  scroller.addEventListener("pointerdown", onPointer);
  scroller.addEventListener("keydown", onKey);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener(MESSAGE_HOLD_RELEASE_EVENT, release);
  // 发消息：表单提交或在输入框里回车（不带 Shift、不在组字）。
  const onSubmit = () => release();
  const onEnter = (event: KeyboardEvent) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      event.target instanceof HTMLElement &&
      (event.target.tagName === "TEXTAREA" || event.target.isContentEditable)
    )
      release();
  };
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onEnter, true);
  function release() {
    if (done) return;
    done = true;
    observer?.disconnect();
    scroller?.removeAttribute(MESSAGE_HOLD_ATTR);
    scroller?.removeEventListener("wheel", user);
    scroller?.removeEventListener("touchstart", user);
    scroller?.removeEventListener("pointerdown", onPointer);
    scroller?.removeEventListener("keydown", onKey);
    scroller?.removeEventListener("scroll", onScroll);
    window.removeEventListener(MESSAGE_HOLD_RELEASE_EVENT, release);
    document.removeEventListener("submit", onSubmit, true);
    document.removeEventListener("keydown", onEnter, true);
  }
  return Object.assign(release, {
    /** 测试 / 平滑滚动结束后重新记下目标位置。 */
    remember: () => {
      want = offsetOf();
    },
  });
}

/** 滚动容器此刻是否被「定位到消息」钉住（chat-transcript 用）。 */
export function isMessageHeld(
  scroller: HTMLElement | null | undefined,
): boolean {
  return scroller?.getAttribute(MESSAGE_HOLD_ATTR) === "true";
}

/** 行是否落在视口里（滚动容器都在视口内，粗判够用）。 */
export function isRowInView(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  return r.bottom > 0 && r.top < vh;
}
