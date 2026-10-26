import type { Screenshot } from "./screen";

/**
 * 一次截图轮询结果怎么落到画面上（DOG-05 / 0.1.40）。
 *
 * 失败时必须清掉上一帧：留着旧图 + 脚上写「机器人在用浏览器」= 把陈旧截图当成直播。
 * 成功时清掉错误，换上新帧。
 */
export function applyScreenshotPollResult(result: {
  frame?: Screenshot;
  error?: string;
}): { shot: Screenshot | null; problem: string | null } {
  if (!result.frame) {
    return {
      shot: null,
      problem: result.error?.trim() || "暂时看不到屏幕。",
    };
  }
  return { shot: result.frame, problem: null };
}

/**
 * 连续失败时放慢轮询，避免电脑 503 时每秒打一次；成功后调用方把 streak 归零。
 *
 * `liveCast`：大屏正在出图，agent-computer 会拒绝 HTTP 截图（captureBusy + liveCast）。这是**暂时的**，
 * 所以是固定慢速探，而不是停 —— 停下来等用户点「重试」，就会出现「大屏早就关了、卡片还写着暂时看不到」
 * 这种自己回不来的卡死状态（线上见过）。
 */
export const LIVE_CAST_PROBE_MS = 10_000;

/** 放慢的上限。再慢也是在探，不是停：停了就再也自己回不来。 */
export const SCREENSHOT_POLL_MAX_DELAY_MS = 30_000;

export function nextScreenshotPollDelay(
  failStreak: number,
  baseMs: number,
  options: { liveCast?: boolean } = {},
): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1000;
  if (options.liveCast) return LIVE_CAST_PROBE_MS;
  if (failStreak <= 0) return base;
  const exp = Math.min(failStreak - 1, 5);
  return Math.min(base * 2 ** exp, SCREENSHOT_POLL_MAX_DELAY_MS);
}

/**
 * CB-103：这一刻卡片该不该去拉 HTTP 截图。
 *
 * 大屏展开（LiveScreen 在出图）或有人接管着（画面在直播里，agent-computer 一定让路），HTTP 截图
 * 都只会被拒绝、在控制台留一条红字，所以干脆不发。返回值说明为什么不发，卡片据此显示占位。
 */
export function screenshotPollBlocked(state: {
  expanded: boolean;
  driving: boolean;
  /**
   * CB-103：GET /control 读到的状态。卡片在用 control 轮询时（controlEnabled），先拿到状态再取图：
   * 还没读到（null）就等，接管中不取，连不上也不取（只会再失败一次）。
   */
  controlState?: "none" | "live" | "user_control" | "unreachable" | null;
  controlEnabled?: boolean;
}): "expanded" | "user_control" | "pending" | "unreachable" | null {
  if (state.expanded) return "expanded";
  if (state.driving || state.controlState === "user_control")
    return "user_control";
  if (state.controlEnabled) {
    if (state.controlState === "unreachable") return "unreachable";
    if (state.controlState === null || state.controlState === undefined)
      return "pending";
  }
  return null;
}
