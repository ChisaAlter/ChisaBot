import type { Screenshot } from "./screen";

/**
 * 一次截图轮询结果怎么落到画面上（DOG-05）。
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
 * 上限 8s，不慢到「好了还要等很久」。
 */
export function nextScreenshotPollDelay(failStreak: number, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1000;
  if (failStreak <= 0) return base;
  const exp = Math.min(failStreak - 1, 3);
  return Math.min(base * 2 ** exp, 8_000);
}
