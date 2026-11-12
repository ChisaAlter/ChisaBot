/**
 * 同步重接的退避（2026-11-09 重连循环事故）。
 *
 * 以前 sync 每一次判断「要重接」都立刻 connect，没有任何节流：只要判断条件一直成立（当时是 reconcile
 * 拿整份历史去比 400 条的接入快照，永远「缺消息」），就每 0.8~3 秒 connect 一次、每次拉几百 KB，
 * 页面藏到后台也照样转。
 *
 * 规则：
 * - 第一次重接不等；
 * - 上一次重接没带来任何变化（消息条数、末尾那条都没变）又要重接：等 1s、2s、4s……最多 30s；
 * - 重接带来了新东西（别的设备真说了话、正在跟一轮实时回答）就清零；
 * - 安静一分钟以上也清零。
 */
export const JOIN_BACKOFF_BASE_MS = 1_000;
export const JOIN_BACKOFF_MAX_MS = 30_000;
export const JOIN_BACKOFF_RESET_MS = 60_000;

export type JoinBackoff = {
  /** 现在开始下一次重接之前还要等多少毫秒（0 = 马上可以）。 */
  wait(now?: number): number;
  /** 一次重接开始了。 */
  started(now?: number): void;
  /** 这次重接带来了新东西：下一次不再等。 */
  progressed(): void;
  /** 连续没有进展的重接次数（测试和日志用）。 */
  streak(): number;
};

export function createJoinBackoff(
  limits: { baseMs?: number; maxMs?: number; resetMs?: number } = {},
): JoinBackoff {
  const base = limits.baseMs ?? JOIN_BACKOFF_BASE_MS;
  const max = limits.maxMs ?? JOIN_BACKOFF_MAX_MS;
  const reset = limits.resetMs ?? JOIN_BACKOFF_RESET_MS;
  let streak = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  const settle = (now: number) => {
    if (now - lastStart > reset) streak = 0;
  };
  return {
    wait(now = Date.now()) {
      settle(now);
      if (streak === 0) return 0;
      const due = lastStart + Math.min(max, base * 2 ** (streak - 1));
      return Math.max(0, due - now);
    },
    started(now = Date.now()) {
      settle(now);
      streak += 1;
      lastStart = now;
    },
    progressed() {
      streak = 0;
    },
    streak: () => streak,
  };
}
