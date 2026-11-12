import { expect, test } from "bun:test";
import {
  blankCoversViewport,
  contentGap,
  nextBlankHeight,
} from "@/lib/chat/blank-release";

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

test("contentGap: trailing blank (spacer/slack) is not distance from the end", () => {
  // 对齐到视口 1/3 的那一轮：scrollTop 顶着 anchor，底下全是 spacer——人就在内容的底部。
  expect(contentGap(2000, 600, 800, 600)).toBe(0);
  // 人真的翻上去看中间：扣掉留白之后还差 500。
  expect(contentGap(2000, 100, 800, 600)).toBe(500);
  // 一点没留白的老路径：和普通算法一样。
  expect(contentGap(2000, 1180, 800, 0)).toBe(20);
});

test("blankCoversViewport: a blank that fills the viewport hides all content and is dropped at once", () => {
  // 接入快照把内容列压矮后 floor 撑出来的留白（实测 44k px）：整屏空白，按 480px/s 收要 ~90 秒。
  expect(blankCoversViewport(44029, 686)).toBe(true);
  // 正好一屏：贴底时视口里只有留白。
  expect(blankCoversViewport(686, 686)).toBe(true);
  // 差一像素：最后一行还露着边——留白在干它的本职（§88.1 把行钉在视口顶）。
  expect(blankCoversViewport(685, 686)).toBe(false);
  expect(blankCoversViewport(0, 686)).toBe(false);
  // 视口没量出来（没挂上 / 隐藏）：不判。
  expect(blankCoversViewport(44029, 0)).toBe(false);
  expect(blankCoversViewport(Number.NaN, 686)).toBe(false);
});
