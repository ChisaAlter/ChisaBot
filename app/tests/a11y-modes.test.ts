import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 模块 11 第 7 条：强制颜色（forced-colors: active）和增加对比度（prefers-contrast: more）。
 *
 * 浏览器审计（PR 里的数字）数的是「computed backdrop-filter 不是 none 的可见元素」：设置页强制颜色下原来 17 层。
 * 这里不跑浏览器，只守住让它变成 0、并且边框 / 焦点看得见的前提：
 *   1. perf-noblur.css 关模糊、换不透明底色的那条 @media 同时匹配 prefers-contrast: more 和 forced-colors: active；
 *   2. a11y-modes.css 在 perf-noblur.css 之后引入，强制颜色下面板有 CanvasText 边框、焦点环用 Highlight 的 outline，
 *      天空 / 壁纸装饰层不画；增加对比度下二级 / 三级文字、分隔线和焦点环加强，面板加实线边；
 *   3. 和 perf-noblur.css 一样靠 :not(#chisabot-no-blur) 的优先级，不用 !important，也不写模糊。
 */
const src = path.join(import.meta.dir, "../src");
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
const noblur = strip(readFileSync(path.join(src, "perf-noblur.css"), "utf8"));
const modes = strip(readFileSync(path.join(src, "a11y-modes.css"), "utf8"));

/** `@media (<query>) { … }` 的内容（按大括号配对）。 */
function media(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0)
      return css.slice(css.indexOf("{", start) + 1, i);
  }
  return "";
}

test("a11y-modes.css is imported right after perf-noblur.css", () => {
  const main = readFileSync(path.join(src, "main.tsx"), "utf8");
  const a = main.indexOf('import "./perf-noblur.css";');
  const b = main.indexOf('import "./a11y-modes.css";');
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
});

test("forced colors and more contrast turn every blur off and paint glass opaque", () => {
  const block = media(
    noblur,
    "(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)",
  );
  expect(block).toMatch(
    /html:not\(#chisabot-no-blur\) \*,\s*html:not\(#chisabot-no-blur\) \*::before,\s*html:not\(#chisabot-no-blur\) \*::after \{[^}]*--lg-blur: none;[^}]*backdrop-filter: none;/,
  );
  expect(block).toContain("--lg-surface: var(--glass-bg-opaque);");
  expect(block).toContain("background: var(--glass-bg-opaque);");
});

test("forced colors: system-color edges, Highlight focus and selection, no decorative sky", () => {
  const fc = media(modes, "(forced-colors: active)");
  expect(fc.length).toBeGreaterThan(0);
  expect(fc).toMatch(
    /\.glass-side-card,[\s\S]*?\{\s*outline: 1px solid CanvasText;/,
  );
  expect(fc).toMatch(/:focus-visible \{\s*outline: 2px solid Highlight;/);
  expect(fc).toMatch(
    /\.glass-bot-row\.is-on,[^{]*\{\s*outline: 2px solid Highlight;/,
  );
  expect(fc).toMatch(
    /#sky-root, \.chisabot-wallpaper, \.chisabot-ambient-orbs\) \{\s*visibility: hidden;/,
  );
  expect(fc).toMatch(
    /\.glass-avatar \{\s*background: Canvas;\s*color: CanvasText;/,
  );
  // 焦点环规则放在最后，压过同优先级的面板 / 选中描边。
  expect(fc.lastIndexOf(":focus-visible")).toBeGreaterThan(
    fc.lastIndexOf("outline: 1px solid CanvasText"),
  );
});

test("more contrast: stronger secondary text, lines, focus and panel edges", () => {
  const more = media(modes, "(prefers-contrast: more)");
  expect(more.length).toBeGreaterThan(0);
  for (const token of [
    "--text-secondary-alpha",
    "--glass-ink-3",
    "--glass-ink-4",
    "--muted-foreground",
    "--line",
    "--border",
    "--input",
    "--focus-line",
  ])
    expect(more).toContain(`${token}:`);
  expect(more).toMatch(/html\.dark:not\(#chisabot-no-blur\) \{/);
  expect(more).toMatch(/\{\s*outline: 1px solid var\(--a11y-edge\);/);
  expect(more).toMatch(
    /:focus-visible \{\s*outline: 2px solid var\(--focus-line\);/,
  );
});

test("no !important, no blur, and every rule carries the id-specificity prefix", () => {
  expect(modes).not.toContain("!important");
  expect(modes).not.toMatch(/backdrop-filter:\s*(?!none)/);
  expect(modes).not.toMatch(/blur\(/);
  for (const m of modes.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith("@media")) continue;
    expect(selector.replace(/^@media[^{]*\{/, "").trim()).toMatch(
      /^html(\.dark)?:not\(#chisabot-no-blur\)/,
    );
  }
});
