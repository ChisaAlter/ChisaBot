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

/**
 * Trailing blank that fills (or exceeds) the viewport is not "padding under the last row"
 * — it is a wall of empty space the reader can sit inside. A wholesale message swap (the
 * connect snapshot replacing the whole list) collapses the mounted rows while the elastic
 * floor still pins the old total height; the slack then flexes up to tens of thousands of
 * pixels (seen: 44k), the pinned-bottom viewport lands entirely inside it, and §93.3's
 * bounded release would need minutes to drain it (the "everything vanished" report).
 * The blank's only legitimate job is filling the viewport below a pinned row — anything
 * taller always means "covering the content", so callers drop it at once.
 */
export function blankCoversViewport(blankPx: number, viewportPx: number): boolean {
  return (
    Number.isFinite(blankPx) &&
    Number.isFinite(viewportPx) &&
    viewportPx > 0 &&
    blankPx >= viewportPx
  );
}

/**
 * How far the reader is from the end of the real content: the trailing blank items (the
 * scroller's own spacer and the app's slack) do not count as distance. A turn aligned a
 * third of the viewport down always keeps a spacer underneath — count it in the gap and
 * "still at the bottom" can never be true, so the release that removes the blank never
 * runs (§93.3).
 */
export function contentGap(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  blank: number,
): number {
  return scrollHeight - scrollTop - clientHeight - Math.max(0, blank);
}
