import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 模块 11 第 7 条：强制颜色（forced-colors: active）和增加对比度（prefers-contrast: more）。
 *   1. perf-noblur.css 关模糊、换不透明底色的 @media 同时匹配 reduced-transparency / prefers-contrast: more / forced-colors: active；
 *   2. a11y-modes.css 在 perf-noblur.css 之后引入，强制颜色下所有 [data-surface] 面板有 CanvasText 边框、
 *      焦点环用 Highlight 的 outline，#sky-root 与壁纸装饰层隐藏；增加对比度下墨色、分隔线、焦点环与实线外轮廓加强；
 *   3. 全部靠 :not(#chisabot-no-blur) 的 ID 特异度胜出，0 `!important`，0 模糊。
 */
const src = path.join(import.meta.dir, "../src");
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
const noblur = strip(readFileSync(path.join(src, "perf-noblur.css"), "utf8"));
const modes = strip(readFileSync(path.join(src, "a11y-modes.css"), "utf8"));

function media(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  return "";
}

test("a11y-modes.css 在 main.tsx 中紧跟 perf-noblur.css 之后导入", () => {
  const main = readFileSync(path.join(src, "main.tsx"), "utf8");
  const a = main.indexOf('import "./perf-noblur.css";');
  const b = main.indexOf('import "./a11y-modes.css";');
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
});

test("强制颜色与高对比度在 perf-noblur.css 中同步关闭全部模糊并落到 --surface-bg-solid", () => {
  const block = media(
    noblur,
    "(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)",
  );
  expect(block).toMatch(
    /html:not\(#chisabot-no-blur\) \*,\s*html:not\(#chisabot-no-blur\) \*::before,\s*html:not\(#chisabot-no-blur\) \*::after \{[^}]*--surface-blur: none;[^}]*backdrop-filter: none;/,
  );
  expect(block).toContain("--surface-bg: var(--surface-bg-solid);");
  expect(block).toContain("background: var(--surface-bg-solid);");
});

test("forced-colors: active：全表面 CanvasText 描边、Highlight 焦点与选中态、隐藏装饰画布", () => {
  const fc = media(modes, "(forced-colors: active)");
  expect(fc.length).toBeGreaterThan(0);
  expect(fc).toMatch(
    /\[data-surface="panel"\],[\s\S]*?\.glass-side-card,[\s\S]*?\{\s*outline: 1px solid CanvasText;/,
  );
  expect(fc).toMatch(/:focus-visible \{\s*outline: 2px solid Highlight;/);
  expect(fc).toMatch(
    /\.glass-bot-row\.is-on,[^{]*\{\s*outline: 2px solid Highlight;/,
  );
  expect(fc).toMatch(
    /:is\(#sky-root, \.chisabot-wallpaper\) \{\s*visibility: hidden;/,
  );
  expect(fc).toMatch(
    /\.glass-avatar \{\s*background: Canvas;\s*color: CanvasText;/,
  );
  // 焦点环规则放在最后，压过同优先级的面板 / 选中描边。
  expect(fc.lastIndexOf(":focus-visible")).toBeGreaterThan(
    fc.lastIndexOf("outline: 1px solid CanvasText"),
  );
});

test("prefers-contrast: more：强化四级墨色、侧栏小字、分隔线、焦点环与实线外轮廓", () => {
  const more = media(modes, "(prefers-contrast: more)");
  expect(more.length).toBeGreaterThan(0);
  for (const token of [
    "--text-secondary-alpha",
    "--ink-1",
    "--ink-2",
    "--ink-3",
    "--ink-4",
    "--side-sec-main-ink",
    "--side-sub-ink",
    "--line",
    "--line-strong",
    "--border",
    "--input",
    "--focus-line",
  ]) {
    expect(more).toContain(`${token}:`);
  }
  expect(more).toMatch(/html\.dark:not\(#chisabot-no-blur\) \{/);
  expect(more).toMatch(/\{\s*outline: 1px solid var\(--a11y-edge\);/);
  expect(more).toMatch(
    /:focus-visible \{\s*outline: 2px solid var\(--focus-line\);/,
  );
});

test("a11y-modes.css 全文件 0 !important、0 模糊、每条规则均带 ID 特异度前缀", () => {
  expect(modes).not.toContain("!important");
  expect(modes).not.toMatch(/backdrop-filter:\s*(?!none)/);
  expect(modes).not.toMatch(/blur\(/);
  for (const m of modes.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").trim();
    if (selector.startsWith("@media")) continue;
    expect(selector.replace(/^@media[^{]*\{/, "").trim()).toMatch(
      /^html(\.dark)?:not\(#chisabot-no-blur\)/,
    );
  }
});
