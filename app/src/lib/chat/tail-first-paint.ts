/**
 * CB-025 / PRD-P2-03：长对话首屏先挂最后一屏，再分批补上面的历史。
 *
 * 不做真正的虚拟列表（§35 不跳版与 message-scroller 按位置找新行），也不再用
 * `content-visibility`（perf/cb-025-cv 实测无收益且引入跳版）。这里只推迟 React 挂载与
 * Markdown 解析：打开时只画尾巴，rAF 分批往前补；`?message=` 深链靠 MessageFind 轮询，
 * 全量挂完通常在一两百毫秒内，落在既有 4s 窗口里。
 */

/** 超过这个条数才启用尾屏优先（短对话全挂更简单）。 */
export const TAIL_FIRST_THRESHOLD = 48;

/** 首屏至少挂多少条（约两屏，含 peek）。 */
export const TAIL_FIRST_INITIAL = 36;

/** 每一帧往前补多少条。 */
export const TAIL_FIRST_BATCH = 28;

export function initialMountedCount(total: number): number {
  const n = Math.max(0, Math.floor(total));
  if (n <= TAIL_FIRST_THRESHOLD) return n;
  return Math.min(n, TAIL_FIRST_INITIAL);
}

export function nextMountedCount(current: number, total: number): number {
  const n = Math.max(0, Math.floor(total));
  const c = Math.max(0, Math.floor(current));
  if (c >= n) return n;
  return Math.min(n, c + TAIL_FIRST_BATCH);
}

/** `items.slice(start)` 的起点：始终贴着末尾。 */
export function mountStartIndex(total: number, mountedCount: number): number {
  const n = Math.max(0, Math.floor(total));
  const m = Math.max(0, Math.floor(mountedCount));
  return Math.max(0, n - Math.min(n, m));
}

/**
 * 列表变长（历史 prepend / 新消息）时怎么调窗口。
 * - 已经全挂：继续全挂。
 * - 还在补：保持窗口大小（新尾巴自动进窗；新历史等下一轮 rAF）。
 * - 变短（截断 / 重生成）：夹到新长度。
 */
export function reconcileMountedCount(
  previousTotal: number,
  nextTotal: number,
  mounted: number,
): number {
  const prev = Math.max(0, Math.floor(previousTotal));
  const next = Math.max(0, Math.floor(nextTotal));
  const m = Math.max(0, Math.floor(mounted));
  if (next <= TAIL_FIRST_THRESHOLD) return next;
  if (next < prev) return Math.min(m, next);
  // 短对话刚涨成长对话（接入快照 → 历史补上）：别一次全挂，保持尾窗。
  if (m >= prev && prev > TAIL_FIRST_THRESHOLD) return next;
  if (m >= prev) return initialMountedCount(next);
  return Math.min(m, next);
}

/** 粗算：从 initial 扩到 full 需要几步（给回归 / 微基准用）。 */
export function stepsToFullMount(total: number): number {
  let m = initialMountedCount(total);
  if (m >= total) return 0;
  let steps = 0;
  while (m < total) {
    m = nextMountedCount(m, total);
    steps += 1;
    if (steps > 10_000) break;
  }
  return steps;
}
