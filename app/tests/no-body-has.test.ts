import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * DESIGN.md §41 ③（2026-10-29 设置面板卡顿）：`body:has(…)` / `html:has(…)` 让 body 下任何 DOM 变化都要重算 :has，
 * 只要还有一条「:has(…) … *」，整棵树（含藏着的聊天）每次都重算样式（4× 降速每次 50–110ms）。
 * 要看「页面上有没有某个元素」用 presenceRef（lib/presence-flag.ts）+ `body[data-has-…]`。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

test("styles.css has no body:has() / html:has() rules", () => {
  const offenders = css
    .split("\n")
    .filter((line) =>
      /(^|[\s,(>~+}])(body|html)(\[[^\]]*\])*:has\(/.test(line),
    );
  expect(offenders).toEqual([]);
});

test("the hidden kept chat is skipped by content-visibility, not matched with a universal selector", () => {
  expect(css).not.toMatch(/\.kept-chat\[data-visible="false"\] \*/);
  expect(css).toMatch(
    /\.kept-chat\[data-visible="false"\] \{[^}]*content-visibility: hidden/,
  );
});
