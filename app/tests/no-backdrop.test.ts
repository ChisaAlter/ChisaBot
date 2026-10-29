import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 性能模式 / 减少透明度下全局不模糊（DESIGN.md §10.3.1，src/perf-noblur.css）。
 *
 * 浏览器审计（PR 里的数字）数的是「computed backdrop-filter 不是 none 的可见元素」，这里不跑浏览器，
 * 只守住让那个数字保持 0 的几条前提：
 *   1. perf-noblur.css 在 styles.css 之后引入，*、::before、::after 一律 backdrop-filter: none，
 *      --lg-blur 也是 none，两种情况（data-perf="on" 和 prefers-reduced-transparency）都在；
 *      后一条 @media 同时覆盖 prefers-contrast: more 和 forced-colors: active（模块 11 第 7 条）；
 *   2. 选择器带 :not(#chisabot-no-blur)，靠 id 优先级压过所有类 / 属性规则，不靠 !important；
 *   3. 能绕过全局规则的写法都不许出现：内联 style 的 backdropFilter、Tailwind 的 important 模糊类、
 *      新的 backdrop-filter …!important（旧玻璃层的 var(--lg-blur) !important 和 none !important 除外）；
 *   4. styles.css 里每一条会模糊的规则，在 perf-noblur.css 里都换了不透明底色，或者在下面的豁免名单里写了原因。
 */
const src = path.join(import.meta.dir, "../src");
const read = (file: string) => readFileSync(path.join(src, file), "utf8");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

const noblur = strip(read("perf-noblur.css"));
const styles = strip(read("styles.css"));

interface Rule {
  selector: string;
  body: string;
}

/** 很粗的 CSS 规则切分（和 render-budget.test.ts 一样）：@media 里面的规则也能切出来。 */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

/** 按顶层逗号切选择器（:is() / :not() 里的逗号不切）。 */
function splitTop(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selector) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const PERF = 'html[data-perf="on"]:not(#chisabot-no-blur)';
const RT = "html:not(#chisabot-no-blur)";
const rtBlock =
  noblur.match(
    /@media \(prefers-reduced-transparency: reduce\),\s*\(prefers-contrast: more\),\s*\(forced-colors: active\) \{([\s\S]*?\})\s*\}/,
  )?.[1] ?? "";
const perfRules = rules(noblur.replace(rtBlock, "")).filter((r) =>
  r.selector.startsWith(PERF),
);
const rtRules = rules(rtBlock).filter((r) => r.selector.startsWith(RT));

test("perf-noblur.css is imported right after styles.css", () => {
  const main = read("main.tsx");
  const a = main.indexOf('import "./styles.css";');
  const b = main.indexOf('import "./perf-noblur.css";');
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
});

test("both switches turn backdrop-filter off on every element and pseudo-element", () => {
  for (const [prefix, list] of [
    [PERF, perfRules],
    [RT, rtRules],
  ] as const) {
    const star = list.find(
      (r) =>
        r.selector === `${prefix} *, ${prefix} *::before, ${prefix} *::after`,
    );
    expect(star).toBeDefined();
    expect(star?.body).toMatch(/(^|[;\s])backdrop-filter:\s*none;/);
    expect(star?.body).toMatch(/--lg-blur:\s*none;/);
  }
  expect(rtBlock.length).toBeGreaterThan(0);
});

test("the global rule wins by specificity, not by !important", () => {
  expect(noblur).not.toContain("!important");
  for (const r of [...perfRules, ...rtRules])
    expect(r.selector).toContain(":not(#chisabot-no-blur)");
  // 页面上不能真的有这个 id，否则规则就失效了。
  const ids: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        /\.(tsx?|html)$/.test(name) &&
        readFileSync(p, "utf8").includes("chisabot-no-blur")
      )
        ids.push(p);
    }
  };
  walk(src);
  expect(ids).toEqual([]);
});

const sourceFiles: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(name)) sourceFiles.push(p);
  }
})(src);

test("nothing can sneak a blur past the global rule", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    // 注释里提到这些写法不算。
    const text = strip(readFileSync(file, "utf8"));
    const rel = path.relative(src, file);
    // 内联样式压得过任何选择器。
    if (/\b(?:[Ww]ebkitB|b)ackdropFilter\b/.test(text))
      offenders.push(`${rel}: inline backdropFilter`);
    // Tailwind v4 的 important 写法（backdrop-blur-sm! / !backdrop-blur-sm）。
    if (
      /(?:^|[\s"'`:])!backdrop-|backdrop-(?:blur|filter)[\w\-[\]().%/]*!(?=[\s"'`]|$)/m.test(
        text,
      )
    )
      offenders.push(`${rel}: important backdrop utility`);
    for (const m of text.matchAll(/backdrop-filter:\s*([^;}\n]*)!important/g)) {
      const value = m[1].trim();
      if (value !== "var(--lg-blur)" && value !== "none")
        offenders.push(`${rel}: backdrop-filter: ${value} !important`);
    }
  }
  expect(offenders).toEqual([]);
});

/** perf-noblur.css 里换了不透明底色（或 --lg-surface）的选择器。 */
function opaqueTargets(list: Rule[], prefix: string): string[] {
  return list
    .filter((r) => /(^|[;\s])(background|--lg-surface):/.test(r.body))
    .flatMap((r) => {
      const rest = r.selector.slice(prefix.length).trim();
      const inner = rest.startsWith(":is(") ? rest.slice(4, -1) : rest;
      return splitTop(inner);
    });
}

test("both switches paint the same elements opaque", () => {
  const perf = opaqueTargets(perfRules, PERF);
  expect(perf.length).toBeGreaterThan(10);
  expect(opaqueTargets(rtRules, RT)).toEqual(perf);
});

/**
 * styles.css 里会模糊、但在性能模式下不需要（或不应该）换成不透明底色的规则，写明原因。
 * 全局规则照样把它们的模糊关掉。
 */
const EXEMPT: Record<string, string> = {
  // 桌面左栏外层：.glass-shell 里已经是透明、不模糊，玻璃在里面的 .glass-side-card 上。
  '[data-slot="sidebar-inner"]': "shell 里本来透明，玻璃在里面的卡片上",
  // 小按钮 / 胶囊：本地 --lg-blur: none，平常也不模糊，底色是按钮自己的。
  ".glass-pill": "小按钮，平常也不模糊",
  ".glass-newchat": "小按钮，平常也不模糊",
  ".glass-icon-btn": "小按钮，平常也不模糊",
  ".glass-mini-new": "小按钮，平常也不模糊",
  // 气泡、对话里的卡片、设置页卡片：本地 --lg-blur: none（render-budget.test.ts），平常也不模糊。
  '[data-slot="bubble-content"]': "气泡，平常也不模糊",
  ".jr-card": "对话里的卡片，平常也不模糊",
  ".page-rows": "设置页卡片，平常也不模糊",
  ".sg-card": "设置页卡片，平常也不模糊",
  form: "设置页卡片（.page-section > form），平常也不模糊",
  ".border": "设置页卡片（.page .rounded-*.border），平常也不模糊",
};

/** 选择器最后一段（真正被设置样式的那个元素）；括号里的空格不算分隔。 */
function subject(part: string): string {
  const segments: string[] = [""];
  let depth = 0;
  for (const ch of part) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) segments.push("");
    else segments[segments.length - 1] += ch;
  }
  return segments.filter(Boolean).pop() ?? part;
}

const bare = (simple: string) => simple.replace(/:not\([^)]*\)/g, "");

/** 选择器里的类 / 属性在 subject 里出现（整词匹配）。 */
function mentions(compound: string, simple: string): boolean {
  const esc = bare(simple).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}(?![\\w-])`).test(compound);
}

test("every rule that blurs in styles.css gets an opaque background, or is exempt for a reason", () => {
  const targets = opaqueTargets(perfRules, PERF);
  const blurring = rules(styles)
    .filter((r) => /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body))
    .flatMap((r) => splitTop(r.selector))
    // perf / 减少透明度自己的规则、@keyframes 之类不算
    .filter((s) => !s.startsWith("html[data-perf") && !s.startsWith("@"));
  expect(blurring.length).toBeGreaterThan(20);

  const missing: string[] = [];
  for (const part of blurring) {
    const last = bare(subject(part));
    const ok =
      targets.includes(part) ||
      targets.some((t) =>
        /[\s>]/.test(bare(t)) ? part.endsWith(t) : mentions(last, t),
      ) ||
      // :is(a, b) 形式的旧玻璃层：每一项都要有着落
      (last.startsWith(":is(") &&
        splitTop(last.slice(4, -1)).every(
          (x) => targets.some((t) => mentions(x, t)) || x in EXEMPT,
        )) ||
      Object.keys(EXEMPT).some((e) => mentions(last, e));
    if (!ok) missing.push(part);
  }
  expect(missing).toEqual([]);
});
