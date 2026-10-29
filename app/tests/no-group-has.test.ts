import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * DESIGN.md §41：Tailwind 的 group-has-* / peer-has-* 会生成「:has(…) *」，Chromium 会因此在任何 data-* 变化时
 * 重算整个应用的样式（每次点击 130–230ms，4× CPU）。改写成 [[祖先]:has(…)_&]:工具类。
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

test("no group-has-* / peer-has-* utilities (whole-app style invalidation)", () => {
  const root = path.join(import.meta.dir, "../src");
  const offenders = files(root).filter((file) => /(^|[\s"'`])(group|peer)-has-/m.test(readFileSync(file, "utf8")));
  expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
});

test("styles.css has no leftover merge-conflict markers (a stray line silently drops the next rule)", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");
  expect(css.split("\n").filter((line) => /^(<{7}|={7}|>{7})( |$)/.test(line))).toEqual([]);
});

/*
 * 同一个坑的手写版：styles.css 里「X:has(…) … *」（:has 后面的选择器里出现通配 *，包括 :is(.a, .a *)）。
 * 2026-10-29 审查 04：一条 `body:has([data-slot="sheet-overlay"]) :is(.glass-topbar, .glass-topbar *, …)`
 * 让输入框每打一个字、每换一行都整页重算约 1000 个元素的样式（4x 下 90–110ms）。
 */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const chunk of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = chunk.lastIndexOf("{");
    if (open < 0) continue;
    const before = chunk.slice(0, open);
    const selector = before.slice(Math.max(before.lastIndexOf("{"), before.lastIndexOf(";")) + 1).trim();
    if (selector && !selector.startsWith("@")) out.push(selector);
  }
  return out;
}
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length;
}

function universalAfterHas(selector: string): boolean {
  const plain = selector.replace(/\[[^\]]*\]/g, "[]");
  for (let at = plain.indexOf(":has("); at >= 0; at = plain.indexOf(":has(", at + 1)) {
    if (plain.slice(closingParen(plain, at + 4) + 1).includes("*")) return true;
  }
  return false;
}

test("styles.css has no :has(…) rule followed by a universal * (whole-app style invalidation)", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");
  expect(selectors(css).filter(universalAfterHas)).toEqual([]);
  // 检查器本身：上面那条旧规则会被拦下，正常的 :has 不会。
  expect(universalAfterHas('html[data-desktop] body:has([data-slot="sheet-overlay"]) :is(.glass-topbar, .glass-topbar *, .desk-strip)')).toBe(true);
  expect(universalAfterHas("[data-slot=\"sidebar\"][data-mobile=\"true\"] *")).toBe(false);
  expect(universalAfterHas('[data-slot="select-trigger"] > [data-slot="select-value"]:not(:has(*))')).toBe(false);
  expect(universalAfterHas("body:has(.glass-topbar) .desk-strip")).toBe(false);
});