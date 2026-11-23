import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * V2 全站渲染预算静态门禁（覆盖 tokens.css / canvas.css / materials.css / styles.css / perf-noblur.css / a11y-modes.css）：
 *  1. 任意样式表内 blur() 半径严格 <= 20px，0 `-webkit-backdrop-filter`，0 `backdrop-filter ... !important`；
 *  2. 模糊令牌与 3 档材质 × 6 档表面矩阵守住预算（panel <= 20px / elevated <= 12px / bubble <= 8px，inset/control/bare = none）；
 *  3. 只有 panel / elevated / bubble 表面与手机滚动顶栏挂 backdrop-filter，嵌套卡片与气泡内操作条零模糊；
 *  4. 0 大容器 `:has()` / `:has(...) *`，0 `data-resizing` 关模糊或切黑底；
 *  5. solid / perf / reduced-transparency / contrast:more / forced-colors 全部归零模糊；
 *  6. 无限循环动画只动 transform / opacity；滚动区无渐隐遮罩。
 */
const srcDir = path.join(import.meta.dir, "../src");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const readSheet = (rel: string) =>
  strip(readFileSync(path.join(srcDir, rel), "utf8"));

const SHEETS = {
  "styles/tokens.css": readSheet("styles/tokens.css"),
  "styles/canvas.css": readSheet("styles/canvas.css"),
  "styles/materials.css": readSheet("styles/materials.css"),
  "styles.css": readSheet("styles.css"),
  "perf-noblur.css": readSheet("perf-noblur.css"),
  "a11y-modes.css": readSheet("a11y-modes.css"),
} as const;

const allCss = Object.values(SHEETS).join("\n");
const tokensCss = SHEETS["styles/tokens.css"];
const materialsCss = SHEETS["styles/materials.css"];
const stylesCss = SHEETS["styles.css"];
const noblurCss = SHEETS["perf-noblur.css"];

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function rules(file: string, text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({
      file,
      selector: (m[1] ?? "").trim().replace(/\s+/g, " "),
      body: m[2] ?? "",
    });
  }
  return out;
}

const allRules = Object.entries(SHEETS).flatMap(([file, text]) =>
  rules(file, text),
);

const blurs = (r: Rule) =>
  /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body);

test("全仓样式表无任何 blur() 半径超过 20px，0 -webkit-backdrop-filter，0 backdrop-filter !important", () => {
  const radii = [...allCss.matchAll(/blur\((\d+(?:\.\d+)?)px\)/g)].map((m) =>
    Number(m[1]),
  );
  expect(radii.length).toBeGreaterThan(0);
  expect(Math.max(...radii)).toBeLessThanOrEqual(20);

  for (const m of allCss.matchAll(/--blur-\d:\s*(\d+)px/g)) {
    expect(Number(m[1])).toBeLessThanOrEqual(20);
  }
  expect(allCss).not.toContain("-webkit-backdrop-filter");
  expect(allCss).not.toMatch(/backdrop-filter\s*:[^;{}]*!important/);
});

test("模糊刻度与 3 档材质 × 6 档表面预算严格受控（panel ≤ 20px / elevated ≤ 12px / bubble ≤ 8px）", () => {
  expect(tokensCss).toMatch(/--glass-blur:\s*20px;/);
  expect(tokensCss).toMatch(/--glass-pop-blur:\s*12px;/);
  const saturate = [...tokensCss.matchAll(/--glass-saturate:\s*(\d+)%;/g)].map(
    (m) => Number(m[1]),
  );
  expect(saturate.length).toBeGreaterThan(0);
  for (const v of saturate) {
    expect(v).toBeGreaterThanOrEqual(160);
    expect(v).toBeLessThanOrEqual(180);
  }
  expect(tokensCss).toMatch(
    /--glass-filter:\s*saturate\(var\(--glass-saturate\)\) blur\(var\(--glass-blur\)\);/,
  );
  expect(tokensCss).toMatch(
    /--glass-pop-filter:\s*saturate\(var\(--glass-saturate\)\)\s*blur\(var\(--glass-pop-blur\)\);/,
  );

  // materials.css 明确覆盖三档材质
  expect(materialsCss).toContain('html[data-material="glass"]');
  expect(materialsCss).toContain('html[data-material="clear"]');
  expect(materialsCss).toContain('html[data-material="solid"]');
  expect(materialsCss).toContain("--surface-blur: blur(20px) saturate(160%);");
  expect(materialsCss).toContain("--surface-blur: blur(16px) saturate(180%);");
  expect(materialsCss).toContain("--surface-blur: blur(12px) saturate(160%);");
  expect(materialsCss).toContain("--surface-blur: blur(8px) saturate(155%);");
  expect(materialsCss).toContain("--surface-blur: blur(6px) saturate(170%);");
});

test("只有 panel / elevated / bubble 表面与手机滚动顶栏挂 backdrop-filter，其余表面严格零模糊", () => {
  const blurringRules = allRules.filter(blurs);
  expect(blurringRules.length).toBe(4);
  const summary = blurringRules.map((r) => `${r.file} :: ${r.selector}`);
  expect(
    summary.some(
      (s) =>
        s.startsWith("styles/materials.css :: ") &&
        s.includes('[data-surface="panel"]'),
    ),
  ).toBe(true);
  expect(
    summary.some(
      (s) =>
        s.startsWith("styles/materials.css :: ") &&
        s.includes('[data-surface="elevated"]'),
    ),
  ).toBe(true);
  expect(
    summary.some(
      (s) =>
        s.startsWith("styles/materials.css :: ") &&
        s.includes('[data-surface="bubble"]'),
    ),
  ).toBe(true);
  expect(summary).toContain(
    "styles.css :: html[data-phone] body[data-page-scrolled] .glass-topbar",
  );

  // inset / control / bare / 嵌套 .jr-card / 气泡内操作条显式零模糊
  const noneRules = allRules.filter(
    (r) =>
      r.file === "styles/materials.css" &&
      /backdrop-filter:\s*none;/.test(r.body),
  );
  const noneSelectors = noneRules.map((r) => r.selector).join(" ");
  for (const token of [
    '[data-surface="inset"]',
    '[data-surface="control"]',
    '[data-surface="bare"]',
    '.chat-bubble-bare > [data-slot="bubble-content"]',
    ":is(.jr-card, .live-panel-body) .jr-card",
    '[data-streamdown="code-block-actions"]',
  ]) {
    expect(noneSelectors).toContain(token);
  }
});

test("零大容器 :has() / :has(...) *，且 data-resizing 严禁关模糊或切黑底", () => {
  expect(allCss).not.toMatch(/:has\([^)]*\)\s+\*/);
  for (const r of allRules) {
    if (
      /(?:^|[\s,])(?:html|body|\.glass-shell|\.glass-main|\.chat-bubbles)[^,{]*:has\(/.test(
        r.selector,
      )
    ) {
      throw new Error(`forbidden container :has() in ${r.file}: ${r.selector}`);
    }
    if (r.selector.includes("data-resizing")) {
      expect(r.body).not.toMatch(/backdrop-filter\s*:/);
      expect(r.body).not.toMatch(/--surface-blur\s*:/);
      expect(r.body).not.toMatch(/background\s*:[^;]*(?:#000|rgb\(0|opaque)/);
    }
  }
});

test("solid / perf / reduced-transparency / contrast:more / forced-colors 全部将模糊令牌归零", () => {
  expect(noblurCss).toMatch(
    /html:is\(\[data-material="solid"\],\s*\[data-perf="on"\]\):not\(#chisabot-no-blur\)\s*\{\s*--glass-filter:\s*none;\s*--glass-pop-filter:\s*none;/,
  );
  expect(noblurCss).toMatch(
    /@media \(prefers-reduced-transparency: reduce\),\s*\(prefers-contrast: more\),\s*\(forced-colors: active\)\s*\{\s*html:not\(#chisabot-no-blur\)\s*\{\s*--glass-filter:\s*none;\s*--glass-pop-filter:\s*none;/,
  );
});

const KEYWORDS = new Set([
  "infinite",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "alternate",
  "alternate-reverse",
  "reverse",
  "normal",
  "both",
  "forwards",
  "backwards",
  "none",
  "running",
  "paused",
  "step-start",
  "step-end",
]);

test("无限循环动画只动 transform 或 opacity", () => {
  const names = new Set(
    [...allCss.matchAll(/animation:\s*([^;]*\binfinite\b[^;]*);/g)].flatMap(
      (m) =>
        (m[1] ?? "")
          .split(",")
          .flatMap((part) => part.trim().split(/\s+/))
          .filter((word) => /^[a-z][\w-]*$/i.test(word) && !KEYWORDS.has(word)),
    ),
  );
  expect(names.size).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const name of names) {
    const block = allCss.match(
      new RegExp(`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`),
    );
    if (!block?.[1]) continue;
    for (const p of block[1].matchAll(/([a-z-]+)\s*:/g)) {
      if (p[1] && !["transform", "opacity"].includes(p[1])) {
        offenders.push(`${name}: ${p[1]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("滚动区不挂渐隐 mask-image", () => {
  for (const r of allRules) {
    if (
      /scroll|carousel-track|btabs-track/.test(r.selector) &&
      /mask-image:\s*(?!\s|none)/.test(r.body)
    ) {
      throw new Error(`scroll mask in ${r.file} on ${r.selector}`);
    }
  }
});

test("新样式表核心文件（tokens / canvas / materials / perf-noblur / a11y-modes）全部 0 !important", () => {
  for (const file of [
    "styles/tokens.css",
    "styles/canvas.css",
    "styles/materials.css",
    "perf-noblur.css",
    "a11y-modes.css",
  ] as const) {
    expect(SHEETS[file]).not.toContain("!important");
  }
  expect(stylesCss.length).toBeGreaterThan(0);
});
