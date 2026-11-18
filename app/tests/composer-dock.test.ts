import { describe, expect, test } from "bun:test";
import {
  applyDockDrag,
  clampDockRect,
  DOCK_MIN_H,
  DOCK_MIN_W,
} from "../src/components/channels/composer/dock-geometry";

const PANE = { w: 1200, h: 800 };
const CONTENT_H = 96;

describe("applyDockDrag 横向", () => {
  const rect = { x: 100, b: 16, w: 600, h: null };

  test("拖右边：右边缘跟指针，左边缘不动", () => {
    expect(applyDockDrag(rect, "e", 40, 0, PANE, CONTENT_H)).toEqual({
      ...rect,
      w: 640,
    });
  });

  test("拖左边：左边缘跟指针，右边缘不动", () => {
    expect(applyDockDrag(rect, "w", 40, 0, PANE, CONTENT_H)).toEqual({
      ...rect,
      x: 140,
      w: 560,
    });
  });

  test("宽度被最小值和面板右边界夹住", () => {
    expect(applyDockDrag(rect, "w", -1000, 0, PANE, CONTENT_H)).toEqual({
      ...rect,
      x: 0,
      w: 700,
    });
    expect(applyDockDrag(rect, "w", 1000, 0, PANE, CONTENT_H)).toEqual({
      ...rect,
      x: 100 + 600 - DOCK_MIN_W,
      w: DOCK_MIN_W,
    });
    expect(applyDockDrag(rect, "e", 1000, 0, PANE, CONTENT_H).w).toBe(1100);
  });
});

describe("applyDockDrag 竖向", () => {
  test("定高框拖顶边：顶边跟指针，底边不动", () => {
    const rect = { x: 100, b: 16, w: 600, h: 300 };
    expect(applyDockDrag(rect, "n", 0, -80, PANE, CONTENT_H)).toEqual({
      ...rect,
      h: 380,
    });
    // 拖过面板顶就停在面板顶（底边不动 → h 上限 = pane.h - b）
    expect(applyDockDrag(rect, "n", 0, -10000, PANE, CONTENT_H).h).toBe(
      800 - 16,
    );
  });

  test("定高框拖下边：底边跟指针，顶边不动（h + b 不变）", () => {
    const rect = { x: 100, b: 16, w: 600, h: 300 };
    const down = applyDockDrag(rect, "s", 0, 10, PANE, CONTENT_H);
    expect(down).toEqual({ ...rect, h: 310, b: 6 });
    // 底边最低贴面板底（b = 0），再高也不出界
    const wayDown = applyDockDrag(rect, "s", 0, 1000, PANE, CONTENT_H);
    expect(wayDown.b).toBe(0);
    expect(wayDown.h).toBe(316);
    // 拖到最小高为止
    const wayUp = applyDockDrag(rect, "s", 0, -1000, PANE, CONTENT_H);
    expect(wayUp.h).toBe(DOCK_MIN_H);
    expect(wayUp.b).toBe(300 + 16 - DOCK_MIN_H);
  });

  test("自然高框（h=null）拖下边是「搬」：底边跟指针，高度不变", () => {
    const rect = { x: 100, b: 16, w: 600, h: null };
    // 上拖离开面板底：b 变大；下拖贴向面板底：b 变小。
    expect(applyDockDrag(rect, "s", 0, -40, PANE, CONTENT_H)).toEqual({
      ...rect,
      b: 56,
    });
    expect(applyDockDrag(rect, "s", 0, 40, PANE, CONTENT_H).b).toBe(0);
    expect(applyDockDrag(rect, "s", 0, 10000, PANE, CONTENT_H).b).toBe(0);
    expect(applyDockDrag(rect, "s", 0, -10000, PANE, CONTENT_H).b).toBe(
      PANE.h - CONTENT_H,
    );
  });

  test("自然高框拖顶边是空操作：内容自动长高，顶边没有自己的位置", () => {
    const rect = { x: 100, b: 16, w: 600, h: null };
    expect(applyDockDrag(rect, "n", 0, 200, PANE, CONTENT_H)).toEqual(rect);
  });
});

describe("applyDockDrag 角", () => {
  test("se 角同时改宽和高，顶边、左边不动；底边拖到面板底就停", () => {
    const rect = { x: 100, b: 16, w: 600, h: 300 };
    expect(applyDockDrag(rect, "se", 20, -30, PANE, CONTENT_H)).toEqual({
      x: 100,
      b: 46,
      w: 620,
      h: 270,
    });
    expect(applyDockDrag(rect, "se", 20, 30, PANE, CONTENT_H)).toEqual({
      x: 100,
      b: 0,
      w: 620,
      h: 316,
    });
  });
});

describe("clampDockRect", () => {
  test("窗口缩小后框被夹回面板内", () => {
    const small = { w: 500, h: 400 };
    const r = clampDockRect({ x: 400, b: 300, w: 800, h: 500 }, small);
    expect(r.w).toBe(500);
    expect(r.x).toBe(0);
    expect(r.b).toBe(280);
    expect(r.h).toBe(120);
  });

  test("合法矩形原样通过；h=null 保持自然高", () => {
    const r = { x: 10, b: 10, w: 400, h: null };
    expect(clampDockRect(r, PANE)).toEqual(r);
  });
});
