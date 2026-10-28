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
 * 用法：`bun scripts/biome-new-issues.ts [基线 ref]`。CI 在 PR 的合并提交上用 `HEAD^1`（目标分支的最新提交）。
 * 比较对象是工作区，所以本地没提交的改动也算在内。
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

const root = process.cwd();
const baseRef = process.argv[2] ?? "origin/main";
const COUNTED = new Set(["error", "warning", "fatal"]);
const CHUNK = 100;

function git(args: string[], allowFailure = false): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    if (allowFailure) return "";
    console.error(
      `biome-new-issues: git ${args.join(" ")} 失败：\n${result.stderr.toString()}`,
    );
    process.exit(2);
  }
  return result.stdout.toString();
}

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
for (const line of git(["ls-files", "--others", "--exclude-standard"]).split(
  "\n",
)) {
  if (line.trim()) changed.push([line.trim(), null]);
}

if (changed.length === 0) {
  console.log(`biome-new-issues: 相对 ${base.slice(0, 10)} 没有改动文件。`);
  process.exit(0);
}

const biome = join(
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
    if (!text) continue;
    try {
      diagnostics.push(
        ...((JSON.parse(text) as { diagnostics?: Diagnostic[] }).diagnostics ??
          []),
      );
    } catch {
      console.error(
        `biome-new-issues: 读不懂 Biome 的输出（${cwd}）：\n${text.slice(0, 2000)}\n${result.stderr.toString()}`,
      );
      process.exit(2);
    }
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
const baseDir = mkdtempSync(join(tmpdir(), "biome-base-"));
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
  console.log(
    `biome-new-issues: 基线 ${base.slice(0, 10)}，改动文件 ${changed.length} 个；error+warning 基线 ${sum(before)} → 当前 ${sum(after)}。`,
  );

  if (grown.length === 0) {
    console.log("biome-new-issues: 没有新增问题。");
    process.exit(0);
  }

  console.error(
    "\nbiome-new-issues: 以下「文件 × 规则」的问题数变多了（本地可以跑 `bunx biome check <文件>` 查看详情）：",
  );
  for (const [key, value] of grown) {
    const [path, category] = key.split("\u0000");
    console.error(
      `\n  ${path}  ${category}: ${before.get(key) ?? 0} → ${value}`,
    );
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
      console.error(`    ${path}${where} ${diagnostic.message.split("\n")[0]}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(
          `::error file=${path}${start ? `,line=${start.line},col=${start.column}` : ""},title=${category}::${diagnostic.message.split("\n")[0]}`,
        );
      }
    }
  }
  process.exit(1);
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}
