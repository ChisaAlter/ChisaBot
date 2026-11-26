import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { COMPUTER_TOOLS } from "../src/computer/schema";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const KNOWN_TOOL_PREFIXES = [
  "computer",
  "device",
  "memory",
  "skill",
  "schedule",
  "history",
  "session",
] as const;

const BACKTICK_TOOL_RE = new RegExp(
  `\`((?:${KNOWN_TOOL_PREFIXES.join("|")})_[a-z0-9_]+)\``,
  "g",
);

const TOOL_DEFINITION_LITERAL_RE = new RegExp(
  `["']((?:${KNOWN_TOOL_PREFIXES.join("|")})_[a-z0-9_]+)["']`,
  "g",
);

const GUIDANCE_TARGETS = [
  "shared/bot-prompt.ts",
  "shared/prompt-workbench.ts",
  "server/src/memory-notes",
  "server/src/skills-chisa",
] as const;

const TOOL_REGISTRY_FILES = [
  "server/src/computer/schema.ts",
  "server/src/computer/headless-tools.ts",
  "server/src/computer/desktop-browser-bridge.ts",
  "server/src/conversations/surface-tools.ts",
  "server/src/conversations/session-search.ts",
  "server/src/devices/tools.ts",
  "server/src/local-agents/service.ts",
  "server/src/memory-notes/service.ts",
  "server/src/skills-chisa/tools.ts",
  "server/src/schedules/service.ts",
  "server/src/agents/wake-up.ts",
  "server/src/agents/history-budget.ts",
  "server/src/agents/history-recover.ts",
] as const;

function expandTargets(targets: readonly string[]): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const abs = resolve(REPO_ROOT, target);
    const stat = statSync(abs);
    if (stat.isFile()) {
      files.push(abs);
      continue;
    }
    for (const entry of readdirSync(abs)) {
      const child = resolve(abs, entry);
      if (statSync(child).isDirectory()) {
        files.push(...expandTargets([relative(REPO_ROOT, child)]));
      } else if (child.endsWith(".ts")) {
        files.push(child);
      }
    }
  }
  return files;
}

function collectRegisteredToolNames(): Set<string> {
  const registered = new Set<string>([...COMPUTER_TOOLS]);

  for (const relPath of TOOL_REGISTRY_FILES) {
    const abs = resolve(REPO_ROOT, relPath);
    const content = readFileSync(abs, "utf8");
    for (const match of content.matchAll(TOOL_DEFINITION_LITERAL_RE)) {
      const name = match[1];
      if (!name) continue;
      // 排除表名、索引名等非工具标识符（如 *_id / *_idx），保留真实工具名。
      if (name.endsWith("_id") || name.endsWith("_idx")) continue;
      registered.add(name);
    }
  }

  return registered;
}

describe("tool names referenced in guidance texts", () => {
  test("引导文案中反引号引用的已知前缀工具名必须真实存在于工具注册表", () => {
    const registered = collectRegisteredToolNames();
    const guidanceFiles = expandTargets(GUIDANCE_TARGETS);
    const references: Array<{ file: string; toolName: string }> = [];
    const missing: Array<{ file: string; toolName: string }> = [];

    for (const file of guidanceFiles) {
      const content = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      for (const match of content.matchAll(BACKTICK_TOOL_RE)) {
        const toolName = match[1];
        if (!toolName) continue;
        references.push({ file: rel, toolName });
        if (!registered.has(toolName)) {
          missing.push({ file: rel, toolName });
        }
      }
    }

    expect(references.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
