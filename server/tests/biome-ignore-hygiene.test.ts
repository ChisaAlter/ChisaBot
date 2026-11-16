import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 全仓 biome-ignore 卫生门禁：
 * 1. 每条 biome-ignore / biome-ignore-all 注释必须带冒号并写清 >=10 个非空白字符的技术原因；
 * 2. 禁止 todo / fixme / hack / workaround / temp / temporary 等敷衍占位词；
 * 3. 全仓总量严格封顶在 MAX_BIOME_IGNORES（只减不增）。
 */
export const MAX_BIOME_IGNORES = 154;
const MIN_REASON_NON_SPACE_CHARS = 10;
const FILLER_REASON_RE = /\b(?:todo|fixme|hack|workaround|temp|temporary)\b/i;

const SCAN_ROOTS = [
  "app",
  "server",
  "shared",
  "agent-computer",
  "pc",
  "scripts",
  "deploy",
] as const;

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "coverage",
]);

const EXCLUDED_FILES = new Set(["app/public/wallpaper_core.html"]);
const TARGET_EXTENSIONS = /\.(?:[cm]?[jt]sx?|html|css)$/;
const COMMENT_DIRECTIVE_RE =
  /^\s*(?:\/\/|\/\*|\{\s*\/\*|<!--)\s*biome-ignore(?:-all)?(?:\s+([^\s:]+))?\s*(.*)$/;

export interface BiomeIgnoreViolation {
  file: string;
  line: number;
  rule: string;
  problem: string;
}

export interface BiomeIgnoreEntry {
  file: string;
  line: number;
  rule: string;
  reason: string;
  reasonNonSpaceChars: number;
  hasColon: boolean;
}

export function inspectBiomeIgnoreSource(
  file: string,
  source: string,
): { entries: BiomeIgnoreEntry[]; violations: BiomeIgnoreViolation[] } {
  const entries: BiomeIgnoreEntry[] = [];
  const violations: BiomeIgnoreViolation[] = [];
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(COMMENT_DIRECTIVE_RE);
    if (!match) continue;

    const line = i + 1;
    const rule = match[1] ?? "<missing-rule>";
    const tail = match[2] ?? "";
    const hasColon = tail.startsWith(":");
    const rawReason = hasColon
      ? tail
          .slice(1)
          .replace(/(?:\*\/\}|\*\/|-->)\s*$/, "")
          .trim()
      : "";
    const reasonNonSpaceChars = rawReason.replace(/\s+/g, "").length;

    entries.push({
      file,
      line,
      rule,
      reason: rawReason,
      reasonNonSpaceChars,
      hasColon,
    });

    if (!hasColon) {
      violations.push({
        file,
        line,
        rule,
        problem: "缺少冒号及原因说明（必须写成 `biome-ignore <rule>: <真实技术原因>`）",
      });
      continue;
    }

    if (reasonNonSpaceChars < MIN_REASON_NON_SPACE_CHARS) {
      violations.push({
        file,
        line,
        rule,
        problem: `原因说明过短（当前仅 ${reasonNonSpaceChars} 个非空白字符，至少需要 ${MIN_REASON_NON_SPACE_CHARS} 个）：${rawReason}`,
      });
    }

    if (FILLER_REASON_RE.test(rawReason)) {
      violations.push({
        file,
        line,
        rule,
        problem: `禁止使用敷衍占位词（todo/fixme/hack/workaround/temp）：${rawReason}`,
      });
    }
  }

  return { entries, violations };
}

function collectRepoFiles(repoRoot: string): string[] {
  const results: string[] = [];

  function walk(absDir: string): void {
    for (const entry of readdirSync(absDir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const absPath = path.join(absDir, entry);
      if (statSync(absPath).isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!TARGET_EXTENSIONS.test(entry)) continue;
      const rel = path.relative(repoRoot, absPath).replaceAll("\\", "/");
      if (!EXCLUDED_FILES.has(rel)) {
        results.push(rel);
      }
    }
  }

  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(repoRoot, root);
    if (statSync(absRoot).isDirectory()) {
      walk(absRoot);
    }
  }

  return results.sort();
}

describe("biome-ignore 卫生与总量封顶门禁", () => {
  test("解析器拦截无冒号、理由过短与敷衍占位词，并放行真实技术原因", () => {
    const sample = [
      `// ${"biome-ignore"} lint/suspicious/noExplicitAny`,
      `// ${"biome-ignore"} lint/suspicious/noExplicitAny: 暂时跳过`,
      `{/* ${"biome-ignore"} lint/a11y/useSemanticElements: TODO workaround later */}`,
      `/* ${"biome-ignore"} lint/suspicious/noExplicitAny: 各路由组 Env 类型存在协变边界差异，无法静态合并 */`,
    ].join("\n");

    const { entries, violations } = inspectBiomeIgnoreSource(
      "sample.tsx",
      sample,
    );
    expect(entries).toHaveLength(4);
    expect(violations.map((v) => v.line)).toEqual([1, 2, 3]);
    expect(violations[0]?.problem).toContain("缺少冒号");
    expect(violations[1]?.problem).toContain("原因说明过短");
    expect(violations[2]?.problem).toContain("敷衍占位词");
  });

  test("全仓所有 biome-ignore 均有真实技术原因且总数不突破封顶线", () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const files = collectRepoFiles(repoRoot);
    const allEntries: BiomeIgnoreEntry[] = [];
    const allViolations: BiomeIgnoreViolation[] = [];

    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      const source = readFileSync(abs, "utf8");
      const { entries, violations } = inspectBiomeIgnoreSource(rel, source);
      allEntries.push(...entries);
      allViolations.push(...violations);
    }

    expect(
      allViolations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.problem}`),
    ).toEqual([]);
    expect(allEntries.length).toBeGreaterThan(0);
    expect(allEntries.length).toBeLessThanOrEqual(MAX_BIOME_IGNORES);
  });
});
