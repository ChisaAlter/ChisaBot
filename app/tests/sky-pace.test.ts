import { describe, expect, test } from "bun:test";
import {
  noteSkyFrameCost,
  SKY_INPUT_HOLD_MS,
  skyFrameDelay,
  skyFrameGap,
  skyInputHolding,
} from "../src/lib/sky-pace";

/** 模块 11 审计必修 1：慢机上天空帧不把主线程排满，按下之后那一帧让给输入。 */
describe("天空出帧节奏", () => {
  test("快的帧照旧 15fps（66ms 一拍）", () => {
    expect(skyFrameGap(8)).toBe(66);
    expect(skyFrameGap(40)).toBe(66);
  });

  test("一帧超过 40ms：两帧之间空出 4 倍帧耗时", () => {
    expect(skyFrameGap(50)).toBe(200);
    expect(skyFrameGap(200)).toBe(800);
  });

  test("耗时平滑：第一帧直接记，之后新旧各一半", () => {
    const c = { last: 0, cost: 0, inputAt: Number.NEGATIVE_INFINITY };
    noteSkyFrameCost(c, 200);
    expect(c.cost).toBe(200);
    noteSkyFrameCost(c, 10);
    expect(c.cost).toBe(105);
  });

  test("按下之后保护期内不出帧，下一帧排到保护期之后", () => {
    const c = { last: 1000, cost: 10, inputAt: 1050 };
    expect(skyInputHolding(c, 1100)).toBe(true);
    expect(skyInputHolding(c, 1050 + SKY_INPUT_HOLD_MS)).toBe(false);
    expect(skyFrameDelay(c, 1100)).toBe(1050 + SKY_INPUT_HOLD_MS - 1100 - 4);
  });

  test("没有输入：按帧间隔排，已经过了就立刻排", () => {
    const c = { last: 1000, cost: 200, inputAt: Number.NEGATIVE_INFINITY };
    expect(skyFrameDelay(c, 1100)).toBe(1000 + 800 - 1100 - 4);
    expect(skyFrameDelay(c, 5000)).toBe(0);
  });
});
