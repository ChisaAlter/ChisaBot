import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const srcDir = path.join(import.meta.dir, "..", "src");

function collectCssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...collectCssFiles(full));
    } else if (name.endsWith(".css")) {
      files.push(full);
    }
  }
  return files;
}

describe("window resize preserves frosted glass (no data-resizing opaque black fallback)", () => {
  test("resize-pause.css is removed and main.tsx only wires initResizeState()", () => {
    expect(existsSync(path.join(srcDir, "resize-pause.css"))).toBe(false);
    const main = readFileSync(path.join(srcDir, "main.tsx"), "utf8");
    expect(main).not.toContain("resize-pause.css");
    expect(main).toContain("initResizeState()");
  });

  test("no stylesheet uses data-resizing to turn off blur or paint glass surfaces opaque", () => {
    const cssFiles = collectCssFiles(srcDir);
    const names = cssFiles.map((f) => path.relative(srcDir, f));
    expect(names).toContain("styles.css");
    expect(names).toContain("perf-noblur.css");
    expect(names).toContain("a11y-modes.css");

    const offenders: string[] = [];
    for (const file of cssFiles) {
      const stripped = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const rel = path.relative(srcDir, file);
      for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim();
        const body = match[2];
        if (!selector.includes("data-resizing")) continue;
        if (
          /backdrop-filter|--lg-blur|--glass-bg-opaque/.test(body)
        ) {
          offenders.push(`${rel}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
