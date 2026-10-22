import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * DESIGN.md §82 UI 文字对齐 / 间距的静态护栏。真浏览器里的测量在 tests/ui-align/（每个页面量文字中心、墨迹、
 * 干活卡上下间距）；这里只锁住那几个根因，防止以后改样式时又回来。
 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

test("container rules that style every descendant <span> never reach inside a Button (§82.1)", () => {
  // `.x span { display:block }` 曾经把「生成安装命令」按钮里的 btn-stack / btn-face 也变成块，字被挤出按钮。
  const offenders: string[] = [];
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\{([^{}]*)\}/g)) {
    const selectors = m[2].split(",").map((s) => s.trim());
    const body = m[3];
    if (!/\b(display|font-size|flex|color|margin)\s*:/.test(body)) continue;
    for (const sel of selectors) {
      if (/^(\.(pair-card-row|device-steps|cc-ws-err))\s+span\b/.test(sel) && !sel.includes('[data-slot="button"]')) offenders.push(sel);
    }
  }
  expect(offenders).toEqual([]);
});

test("work card / done row keeps a gap from a card drawn above it in the same row (§82.3)", () => {
  const rule = css.match(/\.chat-work:not\(:first-child\)\s*\{([^}]*)\}/);
  expect(rule).not.toBeNull();
  const px = Number(/margin-top:\s*(\d+)px/.exec(rule?.[1] ?? "")?.[1] ?? 0);
  expect(px).toBeGreaterThanOrEqual(8);
});

test("empty state action never sits flush under its description (§82.3)", () => {
  expect(css).toMatch(/\.sg-empty > p \+ \* \{ margin-top: 16px; \}/);
});

test("settings rail group toggles have symmetric vertical padding (§82.2)", () => {
  const rule = css.match(/\.rail-sec-toggle \{([^}]*)\}/)?.[1] ?? "";
  const top = /padding-top:\s*(\d+)px/.exec(rule)?.[1];
  const bottom = /padding-bottom:\s*(\d+)px/.exec(rule)?.[1];
  expect(top).toBeDefined();
  expect(top).toBe(bottom);
});

test("control labels use half-width CJK punctuation so a trailing 「）」 doesn't push the label off-centre (§82.2)", () => {
  expect(css).toMatch(/\[data-slot="button"\][^{]*\{ font-feature-settings: "halt"; \}/);
});

test("chat composer keeps 16px side gutters and clears the panel handle at narrow widths (§24 / §92)", () => {
  // 以前输入框列是 `max-w-2xl px-0`：主区窄于 42rem 时输入框卡片左右 0px，贴左栏卡和窗口边。
  const view = readFileSync(path.join(import.meta.dir, "../src/components/channels/conversation-view.tsx"), "utf8");
  expect(view).toContain('className="chat-composer-box shrink-0"');
  expect(view).not.toContain("px-0 pb-4");
  const box = css.match(/\n\.chat-composer-box\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(box).toMatch(/max-width:\s*calc\(42rem \+ 2rem\)/);
  expect(box).toMatch(/padding:\s*0 1rem 1rem/);
  const handle = css.match(/body:has\(\.rail-tab\.is-narrow\) \.chat-composer-box\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(handle).toContain("var(--rail-tab-clear)");
  // Claude Code 会话页：左右底至少 16px（以前左边 4px，手机 10px）。
  const cc = [...css.matchAll(/\n\.cc-session\s*\{([^}]*)\}/g)].map((m) => m[1]).pop() ?? "";
  expect(cc).toMatch(/padding:\s*0 16px 16px/);
});

test("Claude Code thinking pill keeps horizontal padding inside its rounded capsule", () => {
  // `.cc-thinking` 挂在 `.chat-thinking` 药丸上；以前 `.cc-thinking { padding: 2px 0; }` 把左右内边距清成 0，
  // 三个圆点和「Claude 正在想」两端直接挤出圆角边框。
  const rules = [...css.matchAll(/\n\.cc-thinking\s*\{([^}]*)\}/g)].map((m) => m[1]);
  expect(rules.length).toBeGreaterThan(0);
  for (const body of rules) {
    expect(body).not.toMatch(/padding:\s*\d+(?:px)?\s+0\b/);
  }
  const last = rules.at(-1) ?? "";
  expect(last).toMatch(/padding:\s*8px 14px 8px 12px/);
});
