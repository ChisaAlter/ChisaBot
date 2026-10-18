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
 * 上限 30s：大屏走 LiveScreen 时 HTTP 轮询会停，卡片侧失败也不要刷爆控制台。
 */
export function nextScreenshotPollDelay(failStreak: number, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1000;
  if (failStreak <= 0) return base;
  const exp = Math.min(failStreak - 1, 5);
  return Math.min(base * 2 ** exp, 30_000);
}

/** 连续失败到此次数后停止自动轮询，等「重试」或展开/收起再开（避免 503 刷屏）。 */
export const SCREENSHOT_POLL_PAUSE_AFTER = 5;

export function shouldPauseScreenshotPoll(failStreak: number): boolean {
  return failStreak >= SCREENSHOT_POLL_PAUSE_AFTER;
}
