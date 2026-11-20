import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §37 / §37.2 / §147：弹窗与抽屉在打开动画期间由 glass-hold 暂停模糊、关闭（ending-style）时立刻剥离模糊以防卡顿；
 * 静止后统一走全站 `--lg-surface` + `--lg-blur` 材质通道，严格跟随用户的玻璃效果与深浅色设置。
 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

test("§37.2 glass-hold still covers dialog / sheet open", () => {
  expect(css).toMatch(/@keyframes glass-hold\s*\{\s*from,\s*to\s*\{\s*--lg-blur:\s*none;\s*backdrop-filter:\s*none/);
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-overlay"\],\s*\[data-slot="sheet-overlay"\]\)\[data-open\]:not\(\[data-ending-style\]\)\s*\{\s*animation:\s*glass-hold/,
  );
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-content"\],\s*\[data-slot="sheet-content"\]\)\[data-open\]:not\(\[data-ending-style\]\)\s*\{\s*animation:\s*glass-hold/,
  );
});

test("§147 dialog / sheet / menu / popover follow unified --lg-surface & --lg-blur at rest", () => {
  const mainSurface = css.match(
    /:is\(([^{}]*)\)\s*\{\s*background: var\(--pal-tint-layer,\) var\(--lg-surface\) !important;\s*backdrop-filter: var\(--lg-blur\) !important;/,
  );
  expect(mainSurface).toBeTruthy();
  for (const slot of [
    '[data-slot="dialog-content"]:not(.bg-transparent)',
    '[data-slot="sheet-content"]',
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="popover-content"]',
    '[data-slot="select-content"]',
  ]) {
    expect(mainSurface![1]).toContain(slot);
  }
});

test("ending-style still strips blur (§37 close path)", () => {
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-overlay"\],\s*\[data-slot="sheet-overlay"\],\s*\[data-slot="dialog-content"\],\s*\[data-slot="sheet-content"\]\)\[data-ending-style\]\s*\{\s*--lg-blur:\s*none;\s*backdrop-filter:\s*none/,
  );
});
