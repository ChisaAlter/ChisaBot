import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §37 / §37.2 / §147：弹窗与抽屉在打开动画期间由 glass-hold 暂停模糊、关闭（ending-style / closed / leaving）
 * 时立刻剥离模糊以防卡顿；静止后统一走 materials.css 的 `--surface-bg` + `--surface-blur` 单通道，0 `!important`。
 */
const materialsCss = readFileSync(
  path.join(import.meta.dir, "../src/styles/materials.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const stylesCss = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

test("§37.2 glass-hold 在 materials.css 中暂停 dialog / sheet / popover / drawer / composer 动效期间模糊", () => {
  expect(materialsCss).toMatch(
    /@keyframes glass-hold\s*\{\s*from,\s*to\s*\{\s*--surface-blur:\s*none;\s*backdrop-filter:\s*none;/,
  );
  expect(materialsCss).toMatch(
    /:is\(\[data-slot="dialog-overlay"\],\s*\[data-slot="sheet-overlay"\]\)\[data-open\]:not\(\s*\[data-ending-style\]\s*\)\s*\{\s*animation:\s*glass-hold/,
  );
  expect(materialsCss).toMatch(
    /:is\(\[data-slot="dialog-content"\],\s*\[data-slot="sheet-content"\]\)\[data-open\]:not\(\s*\[data-ending-style\]\s*\)\s*\{\s*animation:\s*glass-hold/,
  );
  expect(materialsCss).toMatch(
    /\[data-slot="sidebar"\]\.hk-drawer\[data-open\]:not\(\[data-ending-style\]\)\s*\{\s*animation:\s*glass-hold/,
  );
  expect(materialsCss).toMatch(
    /\.glass-composer\[data-morphing\]\s*\{\s*animation:\s*glass-hold/,
  );
  // styles.css 不再重复定义旧版 glass-hold
  expect(stylesCss).not.toContain("@keyframes glass-hold");
});

test("§147 全站 dialog / sheet / menu / popover / drawer 静止后统一走 elevated 单通道（无 !important）", () => {
  const drawRules = [
    ...materialsCss.matchAll(
      /html\s+:is\(([^{}]*)\)\s*\{\s*background:\s*var\(--surface-bg\);\s*backdrop-filter:\s*var\(--surface-blur\);/g,
    ),
  ];
  expect(drawRules.length).toBeGreaterThanOrEqual(3);
  const elevatedMatch = drawRules.find((m) =>
    (m[1] ?? "").includes('[data-surface="elevated"]'),
  );
  expect(elevatedMatch).toBeDefined();
  const elevatedList = elevatedMatch?.[1] ?? "";
  for (const slot of [
    '[data-surface="elevated"]',
    '[data-slot="dialog-content"]:not(.bg-transparent)',
    '[data-slot="sheet-content"]',
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="popover-content"]',
    '[data-slot="select-content"]',
    ".hk-drawer",
  ]) {
    expect(elevatedList).toContain(slot);
  }
  expect(materialsCss).not.toContain("!important");
});

test("§37 入退场与关闭态立即剥离模糊（starting-style / ending-style / closed / leaving）", () => {
  expect(materialsCss).toMatch(
    /:is\([\s\S]*?\[data-surface="elevated"\][\s\S]*?\[data-slot="dialog-content"\][\s\S]*?\[data-slot="sheet-content"\][\s\S]*?\):is\(\s*\[data-starting-style\],\s*\[data-ending-style\],\s*\[data-closed\],\s*\[data-state="closed"\],\s*\[data-leaving="true"\]\s*\)[^{]*\{\s*--surface-blur:\s*none;\s*backdrop-filter:\s*none;/,
  );
});
