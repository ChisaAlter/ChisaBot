/**
 * 计算机操作失败时交回给机器人的工具结果（DESIGN.md §100）。
 *
 * 为什么有这个：网页聊天里改动类的计算机工具（点击 / 填写 / 按键…）走 POST /api/approvals/computer/:bot。
 * 那条路由以前把「元素不在页面上了」「下拉框里没有这个选项」这类普通失败当成 500 抛回去；
 * 浏览器里的工具处理函数一抛错，conversation runtime 就不再发起下一轮（`executeSpecificTool` 只在没有 error
 * 时才 follow-up），机器人没机会重新读页面，这一轮就静默结束了——用户 2026-10-17 22:46 截图里的「做了 3 步」。
 *
 * 现在这些失败作为 `{ ok: false, reason, … }` 的正常结果交回去，字段和 /api/computers/:bot/* 的
 * 409 / 403 / 400 在网页那头（app/src/lib/computers/call.ts）翻译出来的一样，机器人照常接着做。
 */
import {
  ActionRefusedError,
  ComputerUnavailableError,
  ElementNotFoundError,
  PageTimeoutError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./gateway";

export type ComputerFailureOutcome = Record<string, unknown> & {
  ok: false;
  reason: string;
};

/** 认得的计算机失败 → 工具结果；不认得的（真正的程序错误）返回 null，照旧抛。 */
export function computerFailureOutcome(
  error: unknown,
): ComputerFailureOutcome | null {
  if (!(error instanceof Error)) return null;
  const reason = error.message || "这一步没有成功。";
  if (error instanceof ActionRefusedError)
    return { ok: false, reason, refused: true, rule: error.rule };
  if (error instanceof NavigationRefusedError || error instanceof WorkspaceRefusedError)
    return { ok: false, reason, refused: true, rule: null };
  if (error instanceof HumanHasControlError)
    return {
      ok: false,
      reason,
      humanHasControl: true,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.handoff ? { handoff: error.handoff } : {}),
    };
  if (error instanceof StaleSnapshotError)
    return {
      ok: false,
      reason,
      staleRefs: true,
      ...(error.snapshotRequired ? { snapshotRequired: true } : {}),
    };
  if (error instanceof ElementNotFoundError)
    return { ok: false, reason, staleRefs: true };
  if (error instanceof PageTimeoutError) return { ok: false, reason, pageTimeout: true };
  if (
    error instanceof WorkspaceRequestError ||
    error instanceof WorkspaceNotFoundError ||
    error instanceof WorkspaceTooLargeError
  )
    return { ok: false, reason };
  if (error instanceof ComputerUnavailableError)
    return { ok: false, reason, unavailable: true };
  return null;
}
