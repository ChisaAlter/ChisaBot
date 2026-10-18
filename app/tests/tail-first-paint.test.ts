import { describe, expect, test } from "bun:test";
import {
  initialMountedCount,
  mountStartIndex,
  nextMountedCount,
  reconcileMountedCount,
  stepsToFullMount,
  TAIL_FIRST_BATCH,
  TAIL_FIRST_INITIAL,
  TAIL_FIRST_THRESHOLD,
} from "@/lib/chat/tail-first-paint";

describe("tail-first-paint (CB-025)", () => {
  test("short transcripts mount in full", () => {
    expect(initialMountedCount(0)).toBe(0);
    expect(initialMountedCount(TAIL_FIRST_THRESHOLD)).toBe(
      TAIL_FIRST_THRESHOLD,
    );
    expect(initialMountedCount(12)).toBe(12);
  });

  test("long transcripts open on a bounded tail window", () => {
    expect(initialMountedCount(200)).toBe(TAIL_FIRST_INITIAL);
    expect(initialMountedCount(400)).toBe(TAIL_FIRST_INITIAL);
    expect(mountStartIndex(200, TAIL_FIRST_INITIAL)).toBe(
      200 - TAIL_FIRST_INITIAL,
    );
  });

  test("batches expand to full without overshoot", () => {
    let m = initialMountedCount(200);
    const seen: number[] = [m];
    while (m < 200) {
      const n = nextMountedCount(m, 200);
      expect(n).toBeGreaterThan(m);
      expect(n).toBeLessThanOrEqual(200);
      m = n;
      seen.push(m);
    }
    expect(m).toBe(200);
    expect(seen.at(-2)).toBeGreaterThanOrEqual(200 - TAIL_FIRST_BATCH);
  });

  test("reconcile keeps window on prepend, stays full when already full", () => {
    // 短→长（快照后历史到位）：保持尾窗，别一次全挂。
    expect(reconcileMountedCount(36, 200, 36)).toBe(TAIL_FIRST_INITIAL);
    expect(reconcileMountedCount(200, 250, 200)).toBe(250);
    expect(reconcileMountedCount(200, 250, 36)).toBe(36);
    expect(reconcileMountedCount(200, 180, 200)).toBe(180);
    expect(reconcileMountedCount(100, 40, 80)).toBe(40);
  });

  test("200-message catch-up stays under a dozen frames", () => {
    expect(stepsToFullMount(200)).toBeLessThanOrEqual(12);
    expect(stepsToFullMount(400)).toBeLessThanOrEqual(20);
  });

  test("micro-bench: window math for 400 items is cheap", () => {
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const total = 400;
      let m = initialMountedCount(total);
      while (m < total) m = nextMountedCount(m, total);
      void mountStartIndex(total, m);
    }
    const ms = performance.now() - started;
    // Pure arithmetic; anything over ~50ms on the box means something else is wrong.
    expect(ms).toBeLessThan(50);
  });
});
