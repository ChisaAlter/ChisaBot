/**
 * PRD-P0-05 residual — CI red-line: console paths must not log raw
 * `error instanceof Error ? error.message : String(error)` (drizzle params leak).
 * Use reasonWithoutStatement from server/src/db/query-failure.ts instead.
 * Wired in .github/workflows/chisabot.yml.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../src");

/** Anti-patterns that skip reasonWithoutStatement on console sinks. */
const FORBIDDEN = [
  /console\.(?:log|warn|error|info)\([^;]*error\s+instanceof\s+Error\s*\?\s*error\.message/,
  /console\.(?:log|warn|error|info)\([^;]*String\(error\.message\)/,
  /console\.(?:log|warn|error|info)\([^;]*reason:\s*error\s+instanceof\s+Error\s*\?\s*error\.message/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.endsWith(".test.ts")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("log-scrub red-line (PRD-P0-05)", () => {
  test("server/src console sinks avoid raw error.message ternary", () => {
    const hits: string[] = [];
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      // Strip block comments so doc examples do not trip the gate.
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const re of FORBIDDEN) {
        if (re.test(stripped)) {
          hits.push(relative(join(root, "..", ".."), file));
          break;
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("reasonWithoutStatement is the scrub helper", () => {
    const helper = readFileSync(
      join(root, "db/query-failure.ts"),
      "utf8",
    );
    expect(helper).toContain("export function reasonWithoutStatement");
    expect(helper).toContain("isQueryFailure");
  });
});
