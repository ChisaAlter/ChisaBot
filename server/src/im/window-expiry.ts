/**
 * IM 平台客服 / 被动回复互动窗口过期判定与统一错误类型（CB-027 根治）。
 *
 * 微信客服 48h（错误码 45015 / 45047）、企业微信/个人微信 context_token 过期、QQ 官方 msg_id 5 分钟
 * 被动回复窗口（304023 / 304024）、飞书消息回复窗口过期以及被用户拒收/拉黑，属于「通道互动窗口关闭」，
 * 并非定时任务脚本或 AI 执行本身的逻辑故障。识别后改为静默归档为站内通知，绝不计入定时任务连续失败停用计数。
 */

export class ImWindowExpiredError extends Error {
  override readonly name = "ImWindowExpiredError";

  constructor(
    message = "当前 IM 会话回复窗口已过期，无法直接推送。",
    readonly platform?: string,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

export function isImWindowExpiredError(
  error: unknown,
): error is ImWindowExpiredError {
  if (!error || typeof error !== "object") return false;
  if (error instanceof ImWindowExpiredError) return true;
  return error instanceof Error && error.name === "ImWindowExpiredError";
}

const WINDOW_EXPIRED_CODES = new Set([
  "40034",
  "45015",
  "45047",
  "304023",
  "304024",
  "304045",
  "50007",
]);

const WINDOW_EXPIRED_TEXT_RE =
  /window[_\s-]?expired|outside(?:\s+the)?\s+(?:24|48)\s*(?:h|hour|hours)|exceeded\s+(?:24|48)\s*(?:h|hour|hours)|context_token.*expir|msg_?id.*expir|passive.*reply.*expir|bot was blocked by the user|cannot send messages to this user|response time out of limit|out of response count limit|回复窗口.*过期|超出.*(?:24|48)\s*小时|被动回复.*过期|会话.*已过期|会话窗口已关闭/i;

export function detectPlatformWindowExpired(
  platform: string,
  status: number,
  codeOrMessage: string,
): boolean {
  const normalized = codeOrMessage.trim();
  if (!normalized && status !== 403) return false;
  for (const code of WINDOW_EXPIRED_CODES) {
    if (
      new RegExp(`(?:^|\\b|["':=\\s])${code}(?:\\b|["',\\s]|$)`).test(
        normalized,
      )
    ) {
      return true;
    }
  }
  if (
    platform === "telegram" &&
    status === 403 &&
    /blocked|deactivated|kicked|forbidden/i.test(normalized)
  ) {
    return true;
  }
  return WINDOW_EXPIRED_TEXT_RE.test(normalized);
}
