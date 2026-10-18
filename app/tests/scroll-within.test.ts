import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { targetScrollTop } from "@/lib/scroll-within";

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
    expect(src).toContain("scrollIntoViewWithin(");
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
