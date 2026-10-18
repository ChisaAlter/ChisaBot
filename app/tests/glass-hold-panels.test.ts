import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * CB-029 / DESIGN.md §37.3：弹窗・抽屉・菜单静止后不再带大面积 backdrop-filter。
 * 底色已是 glass-3，毛玻璃几乎看不见却要付打开后首帧的模糊开销；拿掉之后外观不变、INP 更低。
 * 遮罩仍可轻模糊，并由 §37.2 的 glass-hold 按住打开动画。
 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

test("§37.2 glass-hold still covers dialog / sheet open", () => {
  expect(css).toMatch(/@keyframes glass-hold\s*\{\s*from,\s*to\s*\{\s*backdrop-filter:\s*none/);
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-overlay"\],\s*\[data-slot="sheet-overlay"\]\)\[data-open\]:not\(\[data-ending-style\]\)\s*\{\s*animation:\s*glass-hold/,
  );
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-content"\],\s*\[data-slot="sheet-content"\]\)\[data-open\]:not\(\[data-ending-style\]\)\s*\{\s*animation:\s*glass-hold/,
  );
});

test("§37.3 dialog / sheet / menu content keep backdrop-filter none at rest", () => {
  // The CB-029 block must appear (later rules win); pin the comment so a rewrite cannot drop it silently.
  expect(css).toContain("§37.3 CB-029");
  const idx = css.indexOf("§37.3 CB-029");
  const block = css.slice(idx, idx + 1200);
  for (const slot of [
    "dialog-content",
    "sheet-content",
    "dropdown-menu-content",
    "popover-content",
    "select-content",
  ]) {
    expect(block).toContain(`[data-slot="${slot}"]`);
  }
  expect(block).toMatch(/backdrop-filter:\s*none/);
});

test("ending-style still strips blur (§37 close path)", () => {
  expect(css).toMatch(
    /:is\(\[data-slot="dialog-overlay"\],\s*\[data-slot="sheet-overlay"\],\s*\[data-slot="dialog-content"\],\s*\[data-slot="sheet-content"\]\)\[data-ending-style\]\s*\{\s*backdrop-filter:\s*none/,
  );
});
