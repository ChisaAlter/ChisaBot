import { useEffect } from "react";
import { stashedAttachmentCount } from "@/lib/chat/ui-memory";

/**
 * 「现在不适合刷新页面」的登记处（docs/online-update.md）。
 *
 * 刷新提示从不自动刷新；用户点了「刷新」时，如果机器人还在回复、输入框里还挂着没发出去的附件，
 * 或页面上有**刷新会丢**的没发出去的字，先确认一次。
 *
 * 三件事分开登记，因为丢的东西不一样：
 * - 正在回复由聊天自己登记（`channel-chat.tsx` 的 `useReportBusy`）。
 * - 没发出去的附件由聊天输入框登记（`composer.tsx` 的 `useReportPendingAttachments`）；离开对话时收起来的那几个
 *   由草稿里的 `draftFiles` 一起算（`stashedAttachmentCount`）。两种都只在内存里，刷新就没了。
 * - 「没发出去的字」只认显式标了 `data-unsent-watch` 的输入：编辑中的消息、还没提交的审批回答。
 *   不扫整个页面——卡片里的表单、面板里的文本框、搜索框都被当成过聊天草稿，明明输入框是空的也弹
 *   「输入框里还有没发送的内容」。聊天输入框自己也不参与：草稿记在 localStorage 里
 *   （`lib/chat/ui-memory.ts`，DESIGN.md §88），刷新回来还在，刷新并不丢它。
 */
const busy = new Set<string>();
const pendingAttachments = new Map<string, number>();

/** 标在「刷新会丢」的输入上（`textarea` / `input` / contenteditable 都行）。 */
export const UNSENT_ATTR = "data-unsent-watch";

export function setBusy(key: string, value: boolean) {
  if (value) busy.add(key);
  else busy.delete(key);
}

/** 组件挂着且 `value` 为真时登记为忙；卸载时自动撤销。 */
export function useReportBusy(key: string, value: boolean) {
  useEffect(() => {
    setBusy(key, value);
    return () => setBusy(key, false);
  }, [key, value]);
}

/** 登记「这个输入框上还挂着几个没发出去的附件」；卸载或清零时撤销。 */
export function setPendingAttachments(key: string, count: number) {
  if (!key) return;
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (n === 0) pendingAttachments.delete(key);
  else pendingAttachments.set(key, n);
}

export function useReportPendingAttachments(
  key: string | undefined,
  count: number,
) {
  useEffect(() => {
    if (!key) return;
    setPendingAttachments(key, count);
    return () => setPendingAttachments(key, 0);
  }, [key, count]);
}

/** 还挂在输入框上 / 收在草稿里、刷新就会丢的附件总数。 */
export function pendingAttachmentCount(): number {
  // 两部分：正挂在输入框上的（组件登记的），和离开对话时收起来的（`ui-memory` 的 `draftFiles`）。
  let total = stashedAttachmentCount();
  for (const count of pendingAttachments.values()) total += count;
  return total;
}

/** 藏起来（关掉的弹窗、折叠的面板）的字，刷新本来就不会「丢」给人看。 */
function isShown(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const view = element.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return true;
  try {
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch {
    // 没有布局能力的 DOM 测试环境：当它看得见。
    return true;
  }
}

function textOf(element: HTMLElement): string {
  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
    return (element as HTMLTextAreaElement | HTMLInputElement).value;
  }
  return element.textContent ?? "";
}

/** 刷新会丢掉、还没发出去的字。 */
export function hasUnsentText(root?: ParentNode): boolean {
  if (!root && typeof document === "undefined") return false;
  const scope = root ?? document;
  for (const element of scope.querySelectorAll<HTMLElement>(
    `[${UNSENT_ATTR}]`,
  )) {
    if (isShown(element) && textOf(element).trim()) return true;
  }
  return false;
}

/** 刷新会打断 / 丢掉什么。 */
export type RefreshBlocker = {
  /** 机器人还在回复。 */
  running: boolean;
  /** 还挂在实际框上 / 离开对话时收在草稿里、刷新就会丢的附件数。 */
  attachments: number;
  /** 编辑中的消息 / 没提交的回答。 */
  unsent: boolean;
};

/** 刷新会打断什么：null = 可以直接刷新。 */
export function refreshWouldInterrupt(): RefreshBlocker | null {
  const running = busy.size > 0;
  const attachments = pendingAttachmentCount();
  const unsent = hasUnsentText();
  if (!running && attachments === 0 && !unsent) return null;
  return { running, attachments, unsent };
}
