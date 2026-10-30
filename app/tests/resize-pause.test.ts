import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src");
const raw = readFileSync(join(dir, "resize-pause.css"), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("resize pause (html[data-resizing])", () => {
  test("big panels drop blur and shadow and get an opaque background", () => {
    expect(css).toContain("html[data-resizing]:not(#chisabot-no-blur)");
    for (const sel of [
      ".glass-side-card",
      ".rail-card",
      ".glass-composer",
      ".glass:not(.is-flat)",
      '[data-slot="popover-content"]',
    ]) {
      expect(css).toContain(sel);
    }
    expect(css).toContain("--lg-blur: none;");
    expect(css).toContain("--lg-shadow: none;");
    expect(css).toContain("--lg-surface: var(--glass-bg-opaque);");
    expect(css).toContain("backdrop-filter: none;");
    expect(css).toContain("-webkit-backdrop-filter: none;");
    expect(css).toContain("background: var(--glass-bg-opaque);");
    expect(css).toContain("transition: none;");
  });
  test("no :has(), no wildcard, no blur, no !important, no animation", () => {
    expect(css).not.toContain(":has(");
    expect(css).not.toMatch(/(^|[\s,(])\*/);
    expect(css).not.toMatch(/blur\(/);
    expect(css).not.toContain("!important");
    expect(css).not.toMatch(/animation|@keyframes/);
  });
  test("imported after perf-noblur.css", () => {
    const main = readFileSync(join(dir, "main.tsx"), "utf8");
    const a = main.indexOf('import "./perf-noblur.css"');
    const b = main.indexOf('import "./resize-pause.css"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
});
