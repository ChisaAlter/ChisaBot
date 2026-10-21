import { expect, test } from "bun:test";
import { nextBlankHeight } from "@/lib/chat/blank-release";

test("a delayed layout frame never catches up by snapping away the trailing blank", () => {
  for (const gap of [16.7, 33, 100, 500, 2000]) {
    const next = nextBlankHeight(320, gap);
    expect(320 - next).toBeLessThanOrEqual(16);
    expect(next).toBeGreaterThan(300);
  }
});

test("blank settles monotonically all the way to zero without leaving a permanent floor", () => {
  let blank = 400;
  for (let frame = 0; frame < 300 && blank > 0; frame++) {
    const next = nextBlankHeight(blank, frame % 8 === 0 ? 120 : 16.7);
    expect(next).toBeLessThan(blank);
    expect(blank - next).toBeLessThanOrEqual(16);
    blank = next;
  }
  expect(blank).toBe(0);
});

test("a paused frame preserves its space, and invalid negative height cannot create more", () => {
  expect(nextBlankHeight(120, 0)).toBe(120);
  expect(nextBlankHeight(120, -20)).toBe(120);
  expect(nextBlankHeight(-1, 10)).toBe(0);
});
