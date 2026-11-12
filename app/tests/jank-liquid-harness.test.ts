import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

test("the jank harness accepts --glass and CI runs a liquid pass", () => {
  const jank = readFileSync(path.join(root, "perf/jank.mjs"), "utf8");
  expect(jank).toMatch(/glass:\s*\{\s*type:\s*"string"\s*\}/);
  expect(jank).toContain('localStorage.setItem("chisabot-glass-style", g)');
  expect(jank).toContain("liquid");
  const yml = readFileSync(
    path.join(root, ".github/workflows/perf.yml"),
    "utf8",
  );
  expect(yml).toContain("--glass=liquid");
  expect(yml).toContain("perf/out/head-liquid");
  expect(yml).toContain("idle,scroll,stream");
});
