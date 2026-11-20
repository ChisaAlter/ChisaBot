import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 渲染预算的静态检查（styles.css 末尾「渲染预算」一节）。
 *
 * 同屏可见的毛玻璃层数要看页面上实际挂了哪些元素，这里不跑浏览器，拆成样式表上能检查的几条：
 *   1. 任何 blur() 都不超过 30px；Hark 玻璃令牌 --glass-blur 20px、--glass-pop-blur 12px，饱和度 160–180%；
 *   2. 会模糊的规则只有下面列出的这些：左栏、右栏、输入框、顶栏、聊天气泡、顶层对话卡片、弹层 / 抽屉 / 对话框（外观设置页自己的预览除外）；
 *   3. 裸代码块气泡、按钮、胶囊、嵌套对话卡片、设置页卡片不模糊（旧的 !important 玻璃层靠本地 --lg-blur: none 关掉）；
 *   4. 无限循环的动画只动 transform / opacity；滚动区不再挂渐隐遮罩。
 * 左右栏 + 输入框 + 顶栏 + 一个弹层，同屏合计 ≤ 6 层。实际页面的数目由浏览器审计记在 PR 里。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);
const source = css.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

/** 很粗的 CSS 规则切分：够用来读选择器和声明，不处理字符串里的花括号。 */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

const all = rules(source);
const blurs = (r: Rule) =>
  /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body);

test("no blur radius above 30px anywhere in the stylesheet", () => {
  const radii = [...source.matchAll(/blur\((\d+(?:\.\d+)?)px\)/g)].map((m) =>
    Number(m[1]),
  );
  expect(radii.length).toBeGreaterThan(0);
  expect(Math.max(...radii)).toBeLessThanOrEqual(30);
  for (const m of source.matchAll(/--blur-\d:\s*(\d+)px/g))
    expect(Number(m[1])).toBeLessThanOrEqual(30);
});

test("Hark glass tokens: panel 20px, popover 12px, saturate 160–180%", () => {
  const radius = (name: string) =>
    [...source.matchAll(new RegExp(`${name}:\\s*(\\d+)px;`, "g"))].map((m) =>
      Number(m[1]),
    );
  const panel = radius("--glass-blur");
  const pop = radius("--glass-pop-blur");
  expect(panel.length).toBeGreaterThan(0);
  expect(pop.length).toBeGreaterThan(0);
  for (const v of panel) expect(v).toBe(20);
  for (const v of pop) expect(v).toBe(12);
  const saturate = [...source.matchAll(/--glass-saturate:\s*(\d+)%;/g)].map(
    (m) => Number(m[1]),
  );
  expect(saturate.length).toBeGreaterThan(0);
  for (const v of saturate) {
    expect(v).toBeGreaterThanOrEqual(160);
    expect(v).toBeLessThanOrEqual(180);
  }
  // 滤镜只由令牌拼出来，不再写死半径。
  expect(source).toMatch(
    /--glass-filter:\s*saturate\(var\(--glass-saturate\)\) blur\(var\(--glass-blur\)\);/,
  );
  expect(source).toMatch(
    /--glass-pop-filter:\s*saturate\(var\(--glass-saturate\)\) blur\(var\(--glass-pop-blur\)\);/,
  );
  // 旧名字的滤镜写法不再出现：backdrop-filter 只读 --glass-filter / --glass-pop-filter。
  expect(source).not.toMatch(/backdrop-filter:\s*var\(--glass-blur\b/);
});

test("Hark text tiers: secondary .5, tertiary .3", () => {
  expect(source).toMatch(/--text-secondary-alpha:\s*0\.5;/);
  expect(source).toMatch(/--text-tertiary-alpha:\s*0\.3;/);
});

test("only the rails, the composer, the top bar and popups blur", () => {
  const selectors = all
    .filter(blurs)
    .map((r) => r.selector)
    .filter((s) => !s.includes(".appearance-"));
  expect(selectors).toEqual([
    '[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="combobox-content"]',
    '[data-slot="dialog-content"], [data-slot="sheet-content"]',
    '[data-slot="sidebar-inner"]',
    ".glass-seg",
    ".glass-search",
    ".glass-card",
    ".glass-composer",
    ".page-loader-card",
    ".glass-toast",
    ".sg-savebar",
    ".auth-card",
    ".topbar-search[data-open] .glass-search",
    '.rail-sheet[data-slot="sheet-content"]',
    ".update-banner",
    ".context-popover",
    ".install-hint",
    ".live-panel-src-pop",
    ".chat-spotlight-panel",
    // 主工作台大板块（左栏 / 账号卡 / 右栏）与全站弹窗/抽屉/菜单/浮层（§147）：统一跟随设置里的材质、雾度与深浅色。
    ":is(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card)",
    ':is( [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="context-menu-content"], [data-slot="context-menu-sub-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="combobox-content"], [data-slot="dialog-content"]:not(.bg-transparent), [data-slot="sheet-content"], .model-popover, .perm-popover, .context-popover, .chat-spotlight-panel, .live-panel-src-pop, .rail-lib, .bm-menu, .bm-manager, .glass-toast, .page-loader-card, .sg-savebar, .auth-card, .update-banner, .install-hint )',
    ":is(.glass-seg, .glass-search, .glass-pill, .glass-newchat, .glass-icon-btn, .glass-mini-new, .rail-tab)",
    "html.dark :is(.glass-seg, .glass-search, .glass-pill, .glass-newchat, .glass-icon-btn, .glass-mini-new, .rail-tab)",
    ".glass-composer, .dark .glass-composer, .glass-composer:focus-within, .dark .glass-composer:focus-within",
    '.glass-main [data-slot="message"][data-align="start"] [data-slot="bubble"][data-variant="ghost"] > [data-slot="bubble-content"], .jr-card',
    '.glass-main [data-slot="bubble"][data-align="end"] > [data-slot="bubble-content"]',
    // 聊天区浮在壁纸上的卡（确认/提问/核对/历史/交接/窗口按钮条）：和气泡同档釉面，带持续动画的胶囊走下面不带模糊的那条。
    ":is(.cf-card, .gh-card, .page-card, .schedule-card, .bot-exchange-card, .chat-question, .chat-work-steps, .chat-draft-card, .chat-history-notice, .chat-history-more, .to-card, .hr-card)",
    ".page-rows, .sg-card, .page-section > form, .page :is(.rounded-lg, .rounded-xl, .rounded-md).border:not([data-slot]):not(.border-dashed):not(.page-rows)",
    // Hark 唯一玻璃材质（第 1 步只定义，组件在第 2–4 步换上）。
    ".glass",
    ".glass.is-pop",
  ]);
});

test("bare code bubbles, buttons, pills and settings cards switch the old glass layer off", () => {
  const off = all.filter(
    (r) =>
      /--lg-blur:\s*none/.test(r.body) &&
      !r.selector.startsWith("html[data-perf") &&
      !r.selector.startsWith("html:root"),
  );
  const covered = off.map((r) => r.selector).join(", ");
  for (const s of [
    ".glass-pill",
    ".glass-newchat",
    ".glass-icon-btn",
    ".glass-mini-new",
    '.chat-bubble-bare > [data-slot="bubble-content"]',
    ".page-rows",
    ".sg-card",
    ".page-section > form",
  ]) {
    expect(covered).toContain(s);
  }
});

test("performance mode and reduced transparency turn every glass token off", () => {
  expect(source).toMatch(
    /html\[data-perf="on"\] \{\s*--glass-filter: none;\s*--glass-pop-filter: none;/,
  );
  expect(source).toMatch(
    /@media \(prefers-reduced-transparency: reduce\) \{\s*html:root \{\s*--glass-filter: none;/,
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

test("infinite animations only move transform or opacity", () => {
  const names = new Set(
    [...source.matchAll(/animation:\s*([^;]*\binfinite\b[^;]*);/g)].flatMap(
      (m) =>
        m[1]
          .split(",")
          .flatMap((part) => part.trim().split(/\s+/))
          .filter((word) => /^[a-z][\w-]*$/i.test(word) && !KEYWORDS.has(word)),
    ),
  );
  expect(names.size).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const name of names) {
    const block = source.match(
      new RegExp(`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`),
    );
    if (!block) continue;
    for (const p of block[1].matchAll(/([a-z-]+)\s*:/g)) {
      if (!["transform", "opacity"].includes(p[1]))
        offenders.push(`${name}: ${p[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("scroll areas have no fade masks", () => {
  for (const r of all) {
    if (
      /scroll|carousel-track|btabs-track/.test(r.selector) &&
      /mask-image:\s*(?!\s|none)/.test(r.body)
    ) {
      throw new Error(`scroll mask on ${r.selector}`);
    }
  }
});
