/** 活动记录 → 对话：滚到这次工具调用的消息（CB-101）。chat-transcript 监听。 */
export const JUMP_TO_TOOL_CALL = "chisabot:jump-to-tool-call";

/**
 * 对话 → 活动记录（CB-101，和上面对称）：滚到这次工具调用记下的那几步并高亮。
 *
 * 面板可能还没打开、活动记录可能还没加载，所以请求先存起来（{@link PENDING_MS} 内有效）：
 * auto-watch 听到事件就打开「计算机」，面板在移动端切到「活动」，ActivityLog 挂载或数据到了再去找。
 */
export const JUMP_TO_ACTIVITY = "chisabot:jump-to-activity";
export const PENDING_MS = 10_000;

let pending: { toolCallId: string; at: number } | null = null;

export function requestActivityJump(toolCallId: string): void {
  pending = { toolCallId, at: Date.now() };
  window.dispatchEvent(
    new CustomEvent(JUMP_TO_ACTIVITY, { detail: { toolCallId } }),
  );
}

export function pendingActivityJump(): string | null {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_MS) {
    pending = null;
    return null;
  }
  return pending.toolCallId;
}

export function clearActivityJump(toolCallId: string): void {
  if (pending?.toolCallId === toolCallId) pending = null;
}

/** 这个工具会在电脑上留下活动记录（按名字认，认错只是点了找不到）。 */
export function isComputerTool(name: string | undefined): boolean {
  return (
    Boolean(name?.startsWith("computer_")) && name !== "computer_request_help"
  );
}
