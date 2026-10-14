import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/** CB-006：自动更新提示不要正中间（DESIGN.md §22 / §36.5）。 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

test("update-banner anchors top-right on desktop, not centered", () => {
  const block = css.match(/\.update-banner \{[\s\S]*?\n\}/)?.[0] ?? "";
  expect(block).toContain("right: 16px");
  expect(block).not.toContain("left: 50%");
  expect(block).not.toContain("translateX(-50%)");
});

test("update-banner keyframes no longer bake in -50% centering", () => {
  const kf = css.match(/@keyframes update-banner-in \{[\s\S]*?\n\}/)?.[0] ?? "";
  expect(kf).not.toContain("translate(-50%");
  expect(kf).toContain("translateY(-8px)");
});

test("phone / narrow update-banner is a side-inset strip under the topbar", () => {
  expect(css).toMatch(/html\[data-phone\] \.update-banner \{[\s\S]*?left: calc\(12px \+ var\(--safe-l\)\)/);
  expect(css).toMatch(/@media \(max-width: 767px\) \{[\s\S]*?\.update-banner \{[\s\S]*?left: 12px/);
});
