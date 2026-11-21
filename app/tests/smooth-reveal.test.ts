import { describe, expect, test } from "bun:test";
import {
  initialReveal,
  MAX_LAG_MS,
  pending,
  receive,
  step,
  TAU_MS,
} from "../src/lib/chat/smooth-reveal";

describe("adaptive smooth-reveal", () => {
  test("uses tighter TAU_MS and MAX_LAG_MS constants", () => {
    expect(TAU_MS).toBe(90);
    expect(MAX_LAG_MS).toBe(220);
  });

  test("catches up smoothly within MAX_LAG_MS on chunky bursts", () => {
    let state = initialReveal("", 0);
    state = receive(
      state,
      "这是一个较长的突发文本块，用来模拟上游模型按批吐字。",
      100,
    );
    expect(pending(state)).toBe(true);

    const early = step(state, 116);
    expect(early.cut).toBeLessThan(early.target.length);

    const bounded = step(early, 100 + MAX_LAG_MS);
    expect(bounded.cut).toBe(bounded.target.length);
    expect(pending(bounded)).toBe(false);
  });

  test("snaps immediately to 0ms lag once continuous small deltas arrive smoothly", () => {
    let state = initialReveal("", 0);
    state = receive(state, "你", 20);
    state = receive(state, "好，", 40);
    // Streak >= 2 with small deltaLen <= 8 and short gap < 80ms snaps to live text directly
    state = receive(state, "这里是", 60);
    expect(state.cut).toBe(state.target.length);
    expect(pending(state)).toBe(false);
  });

  test("preserves smoothStreak across interleaved rAF step() ticks so real streaming reaches 0ms lag", () => {
    let state = initialReveal("", 0);
    state = receive(state, "你好", 25);
    state = step(state, 41);
    state = receive(state, "你好世界", 50);
    state = step(state, 66);
    state = receive(state, "你好世界！", 75);
    expect(state.smoothStreak).toBeGreaterThanOrEqual(2);
    expect(state.cut).toBe(state.target.length);
    expect(pending(state)).toBe(false);
  });
});
