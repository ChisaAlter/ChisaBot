/**
 * Remove trailing blank space without catching up after a delayed animation frame.
 * A wall-clock ease can remove hundreds of pixels after Markdown/layout blocks a frame; the
 * browser clamps scrollTop by that entire amount and moves the history back into view at once.
 * Integrate a bounded frame interval instead. Small remainders slow down naturally, and a new
 * reply or user input can stop at the current height without snapping the remaining space away.
 */
export function nextBlankHeight(height: number, elapsedMs: number): number {
  const remaining = Math.max(0, height);
  if (remaining <= 1) return 0;
  const elapsed = Math.max(0, Math.min(32, elapsedMs));
  const movement = Math.min(
    (remaining * elapsed) / 120,
    (480 * elapsed) / 1000,
  );
  return Math.max(0, remaining - movement);
}
