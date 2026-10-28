import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Hark 性能预算（docs/rfc/hark-redesign.md「性能预算」）的静态检查。
 *
 * 同屏可见的 backdrop-filter 层数是运行时的量（要看页面上实际挂了哪些元素），这里不跑浏览器，
 * 而是把它拆成样式表上能检查的三条：
 *   1. 任何 blur() 都不超过 30px，玻璃令牌在 16–24px、弹层 12px；
 *   2. 小元素（气泡、按钮、胶囊、小卡片）的规则里不再出现模糊；
 *   3. 常驻的模糊层只有 Hark 层列出的几种：左栏、右栏、输入框（顶栏胶囊是 is-flat，不模糊）。
 * 加上「当前打开的弹层」最多一层，同屏合计 ≤ 6 层。实际页面的数目由 Playwright 审计记在 perf.md。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);

interface Rule {
  selector: string;
  body: string;
}

/** 很粗的 CSS 规则切分：够用来读选择器和声明，不处理字符串里的花括号。 */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const all = rules(css);
const blurring = all.filter((r) =>
  /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body),
);

test("no blur radius above 30px anywhere in the stylesheet", () => {
  const radii = [...css.matchAll(/blur\((\d+(?:\.\d+)?)px\)/g)].map((m) =>
    Number(m[1]),
  );
  expect(radii.length).toBeGreaterThan(0);
  expect(Math.max(...radii)).toBeLessThanOrEqual(30);
});

test("glass tokens stay inside the budget", () => {
  const blur = [...css.matchAll(/--glass-blur:\s*(\d+)px/g)].map((m) =>
    Number(m[1]),
  );
  const pop = [...css.matchAll(/--glass-pop-blur:\s*(\d+)px/g)].map((m) =>
    Number(m[1]),
  );
  expect(blur.length).toBeGreaterThan(0);
  for (const v of blur) {
    expect(v).toBeGreaterThanOrEqual(16);
    expect(v).toBeLessThanOrEqual(24);
  }
  for (const v of pop) expect(v).toBe(12);
});

test("bubbles, buttons, pills and small cards never carry a backdrop-filter", () => {
  const small =
    /bubble-content|\.glass-(pill|chip|seg|search|newchat|icon-btn|mini-new)\b|\.hk-(search|circle|home|avatar-btn)\b|\.jr-card\b|\.sg-card\b|\.queued-bubble|\.worker-card|\.rp-link|\.rail-tab\b|\.chat-doc-card\b/;
  const offenders = blurring
    .filter((r) => small.test(r.selector))
    .map((r) => r.selector);
  expect(offenders).toEqual([]);
});

test("the Hark layer blurs only the rails, the composer and popovers", () => {
  const start = css.indexOf("Hark 左栏 / 右栏（第 3 步）");
  expect(start).toBeGreaterThan(0);
  const hark = rules(css.slice(start));
  const selectors = hark
    .filter(
      (r) =>
        /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body) ||
        /--lg-blur:\s*(?!\s|none)/.test(r.body),
    )
    .map((r) => r.selector.replace(/\s+/g, " "));
  expect(selectors).toEqual([
    ".glass-shell .hk-rail.glass::before, .glass-shell .hk-panel.glass::before",
    ".glass-composer.glass",
  ]);
});

test("a blurred rail never nests another blurred rail (mobile drawer)", () => {
  expect(css).toMatch(
    /\[data-mobile="true"\] \.hk-rail\.glass::before \{ content: none; \}/,
  );
  expect(css).toMatch(/\.glass\.is-flat \{\s*backdrop-filter: none;/);
});
