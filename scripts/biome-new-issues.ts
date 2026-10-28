#!/usr/bin/env bun
/**
 * Biome 门禁：只拦「本次改动新增的问题」，不要求一次性清掉全仓的存量问题。
 *
 * 全仓 `biome check .` 目前有上千个存量 error（organizeImports、noNonNullAssertion、noImportantStyles…），
 * 直接在 CI 里跑 `biome ci .` 只会永远红。所以这里拿改动文件做前后对比：
 *
 *   1. 找出相对基线（默认 origin/main 的 merge-base）新增、修改、重命名的文件；
 *   2. 用同一个 Biome 分别检查「基线版本」和「当前版本」的这些文件。基线版本会被取出到临时目录的
 *      同一相对路径下，并带上基线的 biome.json，所以 includes / overrides 按同样的路径生效；
 *   3. 按「文件 × 规则（category）」统计 error 和 warning 的数量，只要有一项变多就失败，并列出这些诊断。
 *
 * 局限：同一文件里修掉一个问题、又引入一个同规则的问题，数量不变，不会被拦下；格式问题每个文件只算一条，
 * 已经没格式化的文件再加格式问题也看不出来。这是基线法的代价，但它能保证存量不再变多。
 *
 * 用法：`bun scripts/biome-new-issues.ts [基线 ref]`（默认 origin/main）。CI（.github/workflows/chisabot.yml 的 biome job）
 * 传的基线：PR 用 `github.event.pull_request.base.sha`，push 用 `github.event.before`；两者都没有（新建分支的 push、
 * 手动触发）才退回 `HEAD^1`。脚本再取它和 HEAD 的 merge-base。
 * 比较对象是工作区，所以本地没提交的改动也算在内。
 *
 * 失败即失败：git 出错、Biome 退出码非 0 却给不出能解析的 JSON（例如 biome.json 写坏、二进制缺失）→ 退出 2，
 * 绝不当成「没有问题」放行。退出码通过 process.exitCode 设置、正常返回，临时目录总会被清理。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Diagnostic = {
  severity: string;
  message: string;
  category?: string;
  location?: {
    path?: string | { file?: string };
    start?: { line: number; column: number };
  };
};

const COUNTED = new Set(["error", "warning", "fatal"]);
const CHUNK = 100;

/** 内部失败（git / Biome 本身出错）：退出 2。 */
class Failure extends Error {}

export type RunOptions = {
  root: string;
  baseRef: string;
  /** Biome 可执行文件；默认 `<root>/node_modules/.bin/biome`。 */
  biome?: string;
  /** 临时目录的父目录；默认系统 tmp。 */
  tmpRoot?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/** 跑一遍门禁，返回退出码：0 = 没有新增，1 = 有新增，2 = 自身出错。 */
export function run(options: RunOptions): number {
  const { root, baseRef } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => error(line));
  try {
    return gate();
  } catch (caught) {
    if (caught instanceof Failure) {
      error(caught.message);
      return 2;
    }
    throw caught;
  }

  function git(args: string[], allowFailure = false): string {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      if (allowFailure) return "";
      throw new Failure(
        `biome-new-issues: git ${args.join(" ")} 失败：\n${result.stderr.toString()}`,
      );
    }
    return result.stdout.toString();
  }

  function gate(): number {
    const base =
      git(["merge-base", baseRef, "HEAD"], true).trim() ||
      git(["rev-parse", baseRef]).trim();

    /** [当前路径, 基线里的路径（新文件为 null）] */
    const changed: Array<[string, string | null]> = [];
    for (const line of git([
      "diff",
      "--name-status",
      "-M",
      "--diff-filter=AMR",
      base,
    ]).split("\n")) {
      if (!line.trim()) continue;
      const [status, first, second] = line.split("\t");
      if (!status || !first) continue;
      if (status.startsWith("R")) changed.push([second ?? first, first]);
      else changed.push([first, status === "A" ? null : first]);
    }

    // 本地还没 git add 的新文件也算（CI 里不会有）。
    for (const line of git([
      "ls-files",
      "--others",
      "--exclude-standard",
    ]).split("\n")) {
      if (line.trim()) changed.push([line.trim(), null]);
    }

    if (changed.length === 0) {
      log(`biome-new-issues: 相对 ${base.slice(0, 10)} 没有改动文件。`);
      return 0;
    }

    const biome =
      options.biome ??
      join(
        root,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "biome.exe" : "biome",
      );

    const normalize = (path: string) =>
      path.replaceAll("\\", "/").replace(/^\.\//, "");

    function check(cwd: string, files: string[]): Diagnostic[] {
      const diagnostics: Diagnostic[] = [];
      for (let index = 0; index < files.length; index += CHUNK) {
        const result = Bun.spawnSync({
          cmd: [
            biome,
            "check",
            "--reporter=json",
            "--max-diagnostics=none",
            "--vcs-enabled=false",
            "--files-ignore-unknown=true",
            "--no-errors-on-unmatched",
            ...files.slice(index, index + CHUNK),
          ],
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const text = result.stdout.toString().trim();
        let parsed: { diagnostics?: Diagnostic[] } | undefined;
        try {
          parsed = text
            ? (JSON.parse(text) as { diagnostics?: Diagnostic[] })
            : undefined;
        } catch {
          parsed = undefined;
        }
        // Biome 有诊断时退出 1 但照样给 JSON；退出码非 0 又解析不到结果 = Biome 自己出错（配置坏了、二进制不在…）。
        if (!parsed || !Array.isArray(parsed.diagnostics)) {
          if (result.exitCode === 0 && !text) continue;
          throw new Failure(
            `biome-new-issues: Biome 没给出可解析的结果（退出码 ${result.exitCode}，${cwd}）：\n${text.slice(0, 2000)}\n${result.stderr.toString()}`,
          );
        }
        diagnostics.push(...parsed.diagnostics);
      }
      return diagnostics;
    }

    function pathOf(diagnostic: Diagnostic): string {
      const path = diagnostic.location?.path;
      return normalize(typeof path === "string" ? path : (path?.file ?? ""));
    }

    function count(diagnostics: Diagnostic[]): Map<string, number> {
      const counts = new Map<string, number>();
      for (const diagnostic of diagnostics) {
        if (!COUNTED.has(diagnostic.severity)) continue;
        const key = `${pathOf(diagnostic)}\u0000${diagnostic.category ?? diagnostic.severity}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    }

    // 基线版本：取到临时目录的同一（当前）路径下，配上基线的 biome.json。
    const baseDir = mkdtempSync(
      join(options.tmpRoot ?? tmpdir(), "biome-base-"),
    );
    try {
      const baseFiles: string[] = [];
      for (const [current, previous] of changed) {
        if (!previous) continue;
        const content = Bun.spawnSync({
          cmd: ["git", "show", `${base}:${previous}`],
          cwd: root,
          stdout: "pipe",
        });
        if (content.exitCode !== 0) continue;
        mkdirSync(dirname(join(baseDir, current)), { recursive: true });
        writeFileSync(join(baseDir, current), content.stdout);
        baseFiles.push(current);
      }
      for (const config of ["biome.json", "biome.jsonc"]) {
        const content = Bun.spawnSync({
          cmd: ["git", "show", `${base}:${config}`],
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (content.exitCode === 0)
          writeFileSync(join(baseDir, config), content.stdout);
      }

      const before = count(check(baseDir, baseFiles));
      const headDiagnostics = check(
        root,
        changed.map(([current]) => current),
      );
      const after = count(headDiagnostics);

      const grown = [...after].filter(
        ([key, value]) => value > (before.get(key) ?? 0),
      );
      const sum = (counts: Map<string, number>) =>
        [...counts.values()].reduce((a, b) => a + b, 0);
      log(
        `biome-new-issues: 基线 ${base.slice(0, 10)}，改动文件 ${changed.length} 个；error+warning 基线 ${sum(before)} → 当前 ${sum(after)}。`,
      );

      if (grown.length === 0) {
        log("biome-new-issues: 没有新增问题。");
        return 0;
      }

      error(
        "\nbiome-new-issues: 以下「文件 × 规则」的问题数变多了（本地可以跑 `bunx biome check <文件>` 查看详情）：",
      );
      for (const [key, value] of grown) {
        const [path, category] = key.split("\u0000");
        error(`\n  ${path}  ${category}: ${before.get(key) ?? 0} → ${value}`);
        for (const diagnostic of headDiagnostics) {
          if (
            pathOf(diagnostic) !== path ||
            (diagnostic.category ?? diagnostic.severity) !== category
          )
            continue;
          if (!COUNTED.has(diagnostic.severity)) continue;
          const start = diagnostic.location?.start?.line
            ? diagnostic.location.start
            : undefined;
          const where = start ? `:${start.line}:${start.column}` : "";
          error(`    ${path}${where} ${diagnostic.message.split("\n")[0]}`);
          if (process.env.GITHUB_ACTIONS) {
            log(
              `::error file=${path}${start ? `,line=${start.line},col=${start.column}` : ""},title=${category}::${diagnostic.message.split("\n")[0]}`,
            );
          }
        }
      }
      return 1;
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  process.exitCode = run({
    root: process.cwd(),
    baseRef: process.argv[2] ?? "origin/main",
  });
}
