import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scrollDelta,
  scrollIntoViewWithinAsync,
  targetScrollTop,
} from "@/lib/scroll-within";

/**
 * §98.5：设置左栏把当前那一行滚进来时用原生 scrollIntoView，Chrome 会把藏在下面、留着的聊天挪几十像素
 * （1280 宽第一次去设置 +68px），回聊天滚动位置对不上。现在只滚左栏 / 设置页自己的容器。
 */
const rect = (top: number, height: number) =>
  ({ top, bottom: top + height, height }) as DOMRect;
const box = (scrollTop: number, top = 100, height = 400) => ({
  scrollTop,
  getBoundingClientRect: () => rect(top, height),
});
const row = (top: number, height = 36) => ({
  getBoundingClientRect: () => rect(top, height),
});

test("nearest：在可视区里不滚", () => {
  expect(targetScrollTop(box(50), row(200))).toBeNull();
});

test("nearest：在下面滚到底边对齐，在上面滚到顶边对齐", () => {
  expect(targetScrollTop(box(50), row(480))).toBe(50 + (516 - 500));
  expect(targetScrollTop(box(50), row(80))).toBe(30);
  expect(targetScrollTop(box(10), row(40))).toBe(0);
});

test("center：滚到正中", () => {
  expect(targetScrollTop(box(0), row(500, 40), "center")).toBe(520 - 300);
  expect(targetScrollTop(box(0), row(282, 36), "center")).toBeNull();
});

test("设置左栏和设置搜索不再用原生 scrollIntoView", () => {
  for (const file of [
    "components/layout/section-rail.tsx",
    "components/settings/settings-search.tsx",
  ]) {
    const src = readFileSync(join(import.meta.dir, "../src", file), "utf8");
    expect(src).not.toMatch(/\.scrollIntoView\(/);
    expect(src).toMatch(/scrollIntoViewWithin(Async)?\(/);
  }
});

test("DOG-04 消息深链也不用原生 scrollIntoView", () => {
  const focus = readFileSync(
    join(import.meta.dir, "../src/lib/channels/focus-message.ts"),
    "utf8",
  );
  expect(focus).not.toMatch(/\.scrollIntoView\(/);
  expect(focus).toContain("scrollIntoViewWithin(");
  const find = readFileSync(
    join(import.meta.dir, "../src/components/channels/message-find.tsx"),
    "utf8",
  );
  expect(find).not.toMatch(/\.scrollIntoView\(/);
  expect(find).toContain("focusMessageInChat");
});

test("scrollDelta：和 targetScrollTop 同一套算法，只给差值", () => {
  const b = rect(100, 400);
  expect(scrollDelta(b, rect(200, 36))).toBeNull();
  expect(scrollDelta(b, rect(480, 36))).toBe(16);
  expect(scrollDelta(b, rect(80, 36))).toBe(-20);
  expect(scrollDelta(b, rect(500, 40), "center")).toBe(220);
});

test("scrollIntoViewWithinAsync：等 IntersectionObserver 给矩形，只 scrollBy、不读布局", () => {
  const original = globalThis.IntersectionObserver;
  const io: { fire?: (entries: unknown[]) => void } = {};
  let disconnected = 0;
  class FakeIO {
    constructor(cb: (entries: unknown[]) => void) {
      io.fire = cb;
    }
    observe() {}
    disconnect() {
      disconnected += 1;
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    FakeIO;
  try {
    const scrolls: number[] = [];
    const container = {
      scrollBy: ({ top }: { top: number }) => scrolls.push(top),
      getBoundingClientRect: () => {
        throw new Error("不该当场读布局");
      },
    } as unknown as HTMLElement;
    const el = {
      getBoundingClientRect: () => {
        throw new Error("不该当场读布局");
      },
    } as unknown as HTMLElement;
    const cancel = scrollIntoViewWithinAsync(el, { container });
    expect(scrolls).toEqual([]);
    io.fire?.([
      { rootBounds: rect(100, 400), boundingClientRect: rect(480, 36) },
    ]);
    expect(scrolls).toEqual([16]);
    cancel();
    expect(disconnected).toBe(2);
  } finally {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      original;
  }
});
