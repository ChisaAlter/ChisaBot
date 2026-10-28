import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./biome-new-issues";

/** scripts/biome-new-issues.ts：Biome 自己出错必须失败；临时目录总会清理。 */
const biome = join(
  import.meta.dir,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.exe" : "biome",
);
const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** 一个最小仓库：基线提交里有干净的 a.ts 和 biome.json。 */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "biome-gate-repo-"));
  const tmpRoot = mkdtempSync(join(tmpdir(), "biome-gate-tmp-"));
  cleanups.push(root, tmpRoot);
  writeFileSync(
    join(root, "biome.json"),
    JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }),
  );
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  const lines: string[] = [];
  const gate = (extra: { biome?: string } = {}) =>
    run({
      root,
      baseRef: "main",
      biome: extra.biome ?? biome,
      tmpRoot,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
  return {
    root,
    tmpRoot,
    lines,
    gate,
    leftovers: () =>
      readdirSync(tmpRoot).filter((n) => n.startsWith("biome-base-")),
  };
}

describe("biome-new-issues", () => {
  test("正常改动、没有新增问题 → 0，临时目录已清理", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    expect(r.gate()).toBe(0);
    expect(r.leftovers()).toEqual([]);
  });

  test("新增问题（debugger）→ 1，临时目录已清理", () => {
    const r = repo();
    writeFileSync(
      join(r.root, "a.ts"),
      "export function a() {\n  debugger;\n  return 1;\n}\n",
    );
    expect(r.gate()).toBe(1);
    expect(r.lines.join("\n")).toContain("noDebugger");
    expect(r.leftovers()).toEqual([]);
  });

  test("biome.json 写坏 → 失败（非 0），不当成没问题", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(r.root, "biome.json"), "{ this is not json");
    expect(r.gate()).not.toBe(0);
    expect(r.leftovers()).toEqual([]);
  });

  test("Biome 退出码非 0 且没有 JSON 输出 → 2", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    const fake = join(
      r.tmpRoot,
      process.platform === "win32" ? "fake-biome.cmd" : "fake-biome.sh",
    );
    writeFileSync(
      fake,
      process.platform === "win32"
        ? "@echo off\r\necho boom 1>&2\r\nexit /b 3\r\n"
        : "#!/bin/sh\necho boom >&2\nexit 3\n",
      { mode: 0o755 },
    );
    expect(r.gate({ biome: fake })).toBe(2);
    expect(r.lines.join("\n")).toContain("没给出可解析的结果");
    expect(r.leftovers()).toEqual([]);
  });

  test("Biome 二进制不存在 → 失败，临时目录已清理", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    mkdirSync(join(r.tmpRoot, "nothing"));
    expect(() =>
      r.gate({ biome: join(r.tmpRoot, "nothing", "biome") }),
    ).toThrow();
    expect(r.leftovers()).toEqual([]);
  });
});
