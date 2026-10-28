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

/** 假 Biome：往 stderr 写一行、退出码 3、没有 JSON。 */
function fakeBiome(dir: string): string {
  const fake = join(
    dir,
    process.platform === "win32" ? "fake-biome.cmd" : "fake-biome.sh",
  );
  writeFileSync(
    fake,
    process.platform === "win32"
      ? "@echo off\r\necho boom 1>&2\r\nexit /b 3\r\n"
      : "#!/bin/sh\necho boom >&2\nexit 3\n",
    { mode: 0o755 },
  );
  return fake;
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
    expect(r.gate({ biome: fakeBiome(r.tmpRoot) })).toBe(2);
    expect(r.lines.join("\n")).toContain("没给出可解析的结果");
    expect(r.leftovers()).toEqual([]);
  });

  test("Biome 二进制不存在 → 2，临时目录已清理", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    mkdirSync(join(r.tmpRoot, "nothing"));
    expect(r.gate({ biome: join(r.tmpRoot, "nothing", "biome") })).toBe(2);
    expect(r.lines.join("\n")).toContain("启动不了 Biome");
    expect(r.leftovers()).toEqual([]);
  });
});

/**
 * 不传 log / error 回调，走默认值（CI 里就是这样调用的）：在子进程里跑，带超时，
 * 防止默认回调出问题时卡死或崩掉。TMPDIR / TMP / TEMP 指到一个独立目录，检查系统 tmp 下没有残留。
 */
describe("biome-new-issues（默认输出，子进程）", () => {
  const script = join(import.meta.dir, "biome-new-issues.ts");

  function runDefault(root: string, tmp: string, biomePath: string) {
    const code = `import { run } from ${JSON.stringify(script)};
process.exitCode = run({ root: ${JSON.stringify(root)}, baseRef: "main", biome: ${JSON.stringify(biomePath)} });`;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      cwd: root,
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      leftovers: readdirSync(tmp).filter((n) => n.startsWith("biome-base-")),
    };
  }

  test("有新增问题 → 退出 1，stderr 列出问题", () => {
    const r = repo();
    writeFileSync(
      join(r.root, "a.ts"),
      "export function a() {\n  debugger;\n  return 1;\n}\n",
    );
    const out = runDefault(r.root, r.tmpRoot, biome);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("问题数变多了");
    expect(out.stderr).toContain("a.ts");
    expect(out.stderr).toContain("noDebugger");
    expect(out.stdout).toContain("biome-new-issues: 基线");
    expect(out.leftovers).toEqual([]);
  }, 90_000);

  test("Biome 报错（没有 JSON）→ 退出 2，stderr 说明原因", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    const out = runDefault(r.root, r.tmpRoot, fakeBiome(r.tmpRoot));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("没给出可解析的结果");
    expect(out.stderr).toContain("boom");
    expect(out.leftovers).toEqual([]);
  }, 90_000);

  test("找不到 Biome → 退出 2", () => {
    const r = repo();
    writeFileSync(join(r.root, "a.ts"), "export const a = 2;\n");
    const out = runDefault(r.root, r.tmpRoot, join(r.tmpRoot, "no-biome"));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("启动不了 Biome");
    expect(out.leftovers).toEqual([]);
  }, 90_000);
});
