import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 实色材质（solid）/ 性能模式（perf）/ 系统减少透明度 / 高对比度 / 强制颜色下全站零模糊且有清晰实底：
 *   1. `main.tsx` 导入顺序严格为 tokens.css → canvas.css → materials.css → styles.css → perf-noblur.css → a11y-modes.css；
 *   2. `perf-noblur.css` 用 `:not(#chisabot-no-blur)` 借 ID 特异度统一压过所有表面规则，0 `!important`；
 *   3. `*, *::before, *::after` 一律 `--surface-blur: none; backdrop-filter: none;`；
 *   4. 全仓无内联 `backdropFilter`、无 Tailwind important 模糊类、无 `-webkit-backdrop-filter`、无 `backdrop-filter: ... !important`；
 *   5. `materials.css` 与 `styles.css` 中每一条会模糊的规则，在 `perf-noblur.css` 中均落到不透明 `--surface-bg-solid` / `--glass-bg-opaque`。
 */
const src = path.join(import.meta.dir, "../src");
const read = (file: string) => readFileSync(path.join(src, file), "utf8");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

const noblur = strip(read("perf-noblur.css"));
const materials = strip(read("styles/materials.css"));
const styles = strip(read("styles.css"));

interface Rule {
  selector: string;
  body: string;
}

function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({
      selector: (m[1] ?? "").trim().replace(/\s+/g, " "),
      body: m[2] ?? "",
    });
  }
  return out;
}

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

const SOLID_OR_PERF =
  'html:is([data-material="solid"], [data-perf="on"]):not(#chisabot-no-blur)';
const RT = "html:not(#chisabot-no-blur)";

function extractMediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return css.slice(open + 1, i);
    }
  }
  return "";
}

const rtBlock = extractMediaBlock(
  noblur,
  "(prefers-reduced-transparency: reduce), (prefers-contrast: more),\n  (forced-colors: active)",
) ||
  extractMediaBlock(
    noblur.replace(/\s+/g, " "),
    "(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)",
  );

const outsideMedia = noblur.replace(
  /@media\s+\(prefers-reduced-transparency[\s\S]*?\n\}/,
  "",
);
const solidPerfRules = rules(outsideMedia).filter((r) =>
  r.selector.startsWith(SOLID_OR_PERF),
);
const rtRules = rules(rtBlock).filter((r) => r.selector.startsWith(RT));

test("main.tsx 按 5 层单通道顺序导入 CSS（perf-noblur.css 紧跟 styles.css 之后）", () => {
  const main = read("main.tsx");
  const order = [
    'import "./styles/tokens.css";',
    'import "./styles/canvas.css";',
    'import "./styles/materials.css";',
    'import "./styles.css";',
    'import "./perf-noblur.css";',
    'import "./a11y-modes.css";',
  ].map((line) => main.indexOf(line));
  for (const idx of order) expect(idx).toBeGreaterThan(-1);
  for (let i = 1; i < order.length; i++) {
    expect(order[i]).toBeGreaterThan(order[i - 1] ?? -1);
  }
});

test("solid / perf 与系统减少透明度/高对比度/强制颜色均在全局 *, *::before, *::after 关掉模糊", () => {
  expect(rtBlock.length).toBeGreaterThan(0);
  for (const [prefix, list] of [
    [SOLID_OR_PERF, solidPerfRules],
    [RT, rtRules],
  ] as const) {
    const star = list.find(
      (r) =>
        r.selector === `${prefix} *, ${prefix} *::before, ${prefix} *::after`,
    );
    expect(star).toBeDefined();
    expect(star?.body).toMatch(/(^|[;\s])backdrop-filter:\s*none;/);
    expect(star?.body).toMatch(/--surface-blur:\s*none;/);
  }
});

test("perf-noblur.css 靠 :not(#chisabot-no-blur) 胜出，0 !important，且页面绝不存在该 id", () => {
  expect(noblur).not.toContain("!important");
  for (const r of [...solidPerfRules, ...rtRules]) {
    expect(r.selector).toContain(":not(#chisabot-no-blur)");
  }
  const ids: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        /\.(tsx?|html)$/.test(name) &&
        readFileSync(p, "utf8").includes("chisabot-no-blur")
      ) {
        ids.push(p);
      }
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

test("全仓无内联 backdropFilter、无 Tailwind important 模糊类、无 backdrop-filter !important 或 -webkit-backdrop-filter", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const text = strip(readFileSync(file, "utf8"));
    const rel = path.relative(src, file);
    if (/\b(?:[Ww]ebkitB|b)ackdropFilter\b/.test(text)) {
      offenders.push(`${rel}: inline backdropFilter`);
    }
    if (
      /(?:^|[\s"'`:])!backdrop-|backdrop-(?:blur|filter)[\w\-[\]().%/]*!(?=[\s"'`]|$)/m.test(
        text,
      )
    ) {
      offenders.push(`${rel}: important backdrop utility`);
    }
    if (/-webkit-backdrop-filter\s*:/.test(text)) {
      offenders.push(`${rel}: -webkit-backdrop-filter`);
    }
    for (const m of text.matchAll(/backdrop-filter:\s*([^;}\n]*)!important/g)) {
      offenders.push(`${rel}: backdrop-filter: ${(m[1] ?? "").trim()} !important`);
    }
  }
  expect(offenders).toEqual([]);
});

/** perf-noblur.css 里换了不透明实底（--surface-bg-solid 或 --glass-bg-opaque）的选择器。 */
function opaqueTargets(list: Rule[], prefix: string): string[] {
  return list
    .filter((r) =>
      /background:\s*var\(--(?:surface-bg-solid|glass-bg-opaque)\)/.test(r.body),
    )
    .flatMap((r) => {
      const rest = r.selector.slice(prefix.length).trim();
      const inner = rest.startsWith(":is(") ? rest.slice(4, -1) : rest;
      return splitTop(inner);
    });
}

test("solid/perf 与系统无障碍开关将完全相同的一批表面切到不透明实底", () => {
  const solidTargets = opaqueTargets(solidPerfRules, SOLID_OR_PERF);
  expect(solidTargets.length).toBeGreaterThan(20);
  expect(opaqueTargets(rtRules, RT)).toEqual(solidTargets);
  for (const surface of [
    '[data-surface="panel"]',
    '[data-surface="elevated"]',
    '[data-surface="bubble"]',
    '[data-surface="inset"]',
    '[data-surface="control"]',
  ]) {
    expect(solidTargets).toContain(surface);
  }
});

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

function mentions(compound: string, simple: string): boolean {
  const esc = bare(simple).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}(?![\\w-])`).test(compound);
}

test("materials.css 与 styles.css 里每一条会模糊的选择器都在 perf-noblur.css 里落到不透明实底", () => {
  const targets = opaqueTargets(solidPerfRules, SOLID_OR_PERF);
  const blurring = [...rules(materials), ...rules(styles)]
    .filter((r) => /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body))
    .flatMap((r) => splitTop(r.selector))
    .filter((s) => !s.startsWith("@"));

  expect(blurring.length).toBeGreaterThanOrEqual(4);

  const missing: string[] = [];
  for (const part of blurring) {
    const last = bare(subject(part));
    const ok =
      targets.includes(part) ||
      targets.some((t) =>
        /[\s>]/.test(bare(t)) ? part.endsWith(t) : mentions(last, t),
      ) ||
      (last.startsWith(":is(") &&
        splitTop(last.slice(4, -1)).every((x) =>
          targets.some((t) => mentions(x, t)),
        ));
    if (!ok) missing.push(part);
  }
  expect(missing).toEqual([]);
});
