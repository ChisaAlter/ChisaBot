"use strict";
/**
 * 本地 agent 任务的工作目录与沙盒（docs/local-agents.md §4）。
 *
 * - worktree：在 git 仓库里开一个新的 worktree（从当前提交 + 未提交的已跟踪改动开始），agent 在里面改；
 *   做完算出改动，用户在卡片上点「应用改动」才合回原文件夹。
 * - copy：把文件夹复制到临时目录里做（不是 git 仓库时 worktree 自动退成 copy），同样要点「应用改动」。
 * - none：直接在原文件夹里做（改动当场生效；仍然统计改了什么）。
 * - bwrap / sandbox-exec：系统级沙盒（整个系统只读、只有工作目录和 agent 自己的配置目录可写，可断网）。
 * - docker / podman：内置 agent 的命令在一次性容器里跑（只挂载工作目录，可断网）。
 * - wsl：Windows 上在 WSL 里运行 agent。
 *
 * 改动统计用一个放在工作目录之外的 git 快照（GIT_DIR 在临时目录里），不碰用户自己的 .git 和暂存区。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const COPY_LIMIT_BYTES = 800 * 1024 * 1024;
const COPY_LIMIT_FILES = 60_000;
const PATCH_PREVIEW = 24_000;

function tmpRoot() {
  const dir = path.join(os.tmpdir(), "chisabot-agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, out: "", err: String(error && error.message) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(error && error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function folderSize(dir, limitBytes, limitFiles) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files++;
        try {
          bytes += (await fsp.stat(full)).size;
        } catch {}
        if (bytes > limitBytes || files > limitFiles) return { bytes, files, over: true };
      }
    }
  }
  return { bytes, files, over: false };
}

/** 用工作目录之外的 GIT_DIR 给一个文件夹拍快照，之后可以算改动。没有 git 时返回 null。 */
async function snapshot(workTree, gitDir) {
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: workTree };
  if ((await git(["init", "-q"], { env })).code !== 0) return null;
  // 用户自己的 .git 不进快照。
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "info", "exclude"), ".git\n");
  const add = await git(["add", "-A"], { env, timeoutMs: 180_000 });
  if (add.code !== 0) return null;
  const commit = await git(["-c", "user.name=ChisaBot", "-c", "user.email=agent@chisabot.local", "commit", "-q", "--allow-empty", "--no-verify", "-m", "chisabot: before"], { env, timeoutMs: 180_000 });
  if (commit.code !== 0) return null;
  const head = await git(["rev-parse", "HEAD"], { env });
  return head.code === 0 ? { env, base: head.out.trim() } : null;
}

/**
 * 准备工作目录。返回 { workdir, mode, original, notes[], diffEnv, base, cleanup() }。
 */
async function prepare({ taskId, cwd, isolation }) {
  const notes = [];
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不存在：${cwd || "（没有指定）"}`);
  const original = path.resolve(cwd);
  const taskDir = path.join(tmpRoot(), `task-${taskId.slice(0, 8)}-${Date.now().toString(36)}`);
  fs.mkdirSync(taskDir, { recursive: true });
  const gitDir = path.join(taskDir, "snap.git");
  let mode = isolation === "worktree" || isolation === "copy" ? isolation : "direct";

  if (mode === "worktree") {
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: original });
    if (top.code !== 0) {
      notes.push("这个文件夹不是 git 仓库，改用临时副本。");
      mode = "copy";
    } else {
      const toplevel = path.resolve(top.out.trim());
      // 未提交的已跟踪改动一起带进 worktree（stash create 不动用户的工作区和 stash 列表）。
      const stash = await git(["stash", "create"], { cwd: toplevel });
      const start = stash.code === 0 && stash.out.trim() ? stash.out.trim() : "HEAD";
      const wt = path.join(taskDir, "worktree");
      const add = await git(["worktree", "add", "--detach", wt, start], { cwd: toplevel });
      if (add.code !== 0) {
        notes.push(`git worktree 失败（${add.err.trim().slice(0, 160)}），改用临时副本。`);
        mode = "copy";
      } else {
        if (start !== "HEAD") notes.push("worktree 里带上了未提交的已跟踪改动；未跟踪的新文件没有带进去。");
        const relative = path.relative(toplevel, original);
        const workdir = path.join(wt, relative);
        const snap = await snapshot(wt, gitDir);
        return {
          workdir,
          workRoot: wt,
          mode,
          original,
          originalRoot: toplevel,
          notes,
          diffEnv: snap && snap.env,
          base: snap && snap.base,
          taskDir,
          async cleanup() {
            await git(["worktree", "remove", "--force", wt], { cwd: toplevel });
            await fsp.rm(taskDir, { recursive: true, force: true });
          },
        };
      }
    }
  }

  if (mode === "copy") {
    const size = await folderSize(original, COPY_LIMIT_BYTES, COPY_LIMIT_FILES);
    if (size.over) throw new Error(`文件夹太大，不适合复制（超过 ${COPY_LIMIT_FILES} 个文件或 ${Math.round(COPY_LIMIT_BYTES / 1048576)} MB）。请选一个更小的子文件夹，或用 worktree / 直接在文件夹里做。`);
    const work = path.join(taskDir, "copy");
    await fsp.cp(original, work, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
    const snap = await snapshot(work, gitDir);
    return {
      workdir: work,
      workRoot: work,
      mode,
      original,
      originalRoot: original,
      notes,
      diffEnv: snap && snap.env,
      base: snap && snap.base,
      taskDir,
      async cleanup() {
        await fsp.rm(taskDir, { recursive: true, force: true });
      },
    };
  }

  // 直接在原文件夹里做：只拍快照用来统计改动。文件太多就不统计。
  const size = await folderSize(original, Number.MAX_SAFE_INTEGER, 20_000);
  const snap = size.over ? null : await snapshot(original, gitDir);
  if (!snap) notes.push(size.over ? "文件夹文件太多，这次不统计改动。" : "没有找到 git，这次不统计改动。");
  return {
    workdir: original,
    workRoot: original,
    mode: "direct",
    original,
    originalRoot: original,
    notes,
    diffEnv: snap && snap.env,
    base: snap && snap.base,
    taskDir,
    async cleanup() {
      await fsp.rm(taskDir, { recursive: true, force: true });
    },
  };
}

/** 算改动：文件列表（+/-）、总数、补丁预览。 */
async function diff(prep) {
  if (!prep.diffEnv || !prep.base) return null;
  const env = prep.diffEnv;
  await git(["add", "-A"], { env, timeoutMs: 180_000 });
  const numstat = await git(["diff", "--cached", "--numstat", "-M", prep.base], { env });
  const status = await git(["diff", "--cached", "--name-status", "-M", prep.base], { env });
  if (numstat.code !== 0) return null;
  const kinds = new Map();
  for (const line of status.out.split("\n")) {
    const [code, ...rest] = line.split("\t");
    if (!code || !rest.length) continue;
    const file = rest[rest.length - 1];
    kinds.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of numstat.out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const r = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    let file = parts.slice(2).join("\t");
    if (file.includes(" => ")) file = file.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "");
    added += a;
    removed += r;
    files.push({ path: file, added: a, removed: r, status: kinds.get(file) || "modified" });
  }
  let patch = "";
  if (files.length) {
    const full = await git(["diff", "--cached", "-M", prep.base], { env });
    patch = full.out.length > PATCH_PREVIEW ? `${full.out.slice(0, PATCH_PREVIEW)}\n…（补丁太长，后面省略）` : full.out;
  }
  return { files: files.slice(0, 300), added, removed, pending: prep.mode !== "direct", applied: false, patch };
}

/** 把一次性副本里的改动合回原文件夹。 */
async function apply(prep) {
  if (prep.mode === "direct") return { ok: true };
  if (!prep.diffEnv || !prep.base) return { ok: false, error: "没有改动记录，无法应用。" };
  const env = prep.diffEnv;
  await git(["add", "-A"], { env });
  const patch = await git(["diff", "--cached", "--binary", prep.base], { env, timeoutMs: 180_000 });
  if (patch.code !== 0) return { ok: false, error: patch.err.trim().slice(0, 300) || "生成补丁失败。" };
  if (!patch.out.trim()) return { ok: true };
  // 补丁里的路径相对快照的工作树根（worktree 根 / 副本根），对应原仓库根 / 原文件夹。
  const check = await git(["apply", "--check", "--whitespace=nowarn", "-"], { cwd: prep.originalRoot, input: patch.out });
  if (check.code !== 0)
    return { ok: false, error: `原文件夹在这期间也改过，补丁对不上：${check.err.trim().slice(0, 300)}` };
  const done = await git(["apply", "--whitespace=nowarn", "-"], { cwd: prep.originalRoot, input: patch.out });
  return done.code === 0 ? { ok: true } : { ok: false, error: done.err.trim().slice(0, 300) || "应用补丁失败。" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** agent 自己的配置 / 登录目录（沙盒里要可写，否则 Claude Code / Codex 起不来）。 */
function agentStateDirs() {
  const home = os.homedir();
  return [".claude", ".claude.json", ".codex", ".config", ".cache", ".local/share/opencode", ".local/state", ".npm", ".gemini", ".aider"].map((p) => path.join(home, p)).filter((p) => fs.existsSync(p));
}

/**
 * 按隔离方式包一层命令。返回 { file, args }。container 只给内置 agent 的 shell 命令用（command 是一段 sh）。
 */
function wrap({ isolation, workdir, network, file, args, containerImage }) {
  if (isolation === "bwrap") {
    const binds = [];
    for (const dir of agentStateDirs()) binds.push("--bind", dir, dir);
    return {
      file: "bwrap",
      args: [
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--bind", workdir, workdir,
        ...binds,
        "--die-with-parent",
        ...(network ? [] : ["--unshare-net"]),
        "--chdir", workdir,
        "--", file, ...args,
      ],
    };
  }
  if (isolation === "sandbox-exec") {
    const writable = [workdir, "/private/tmp", "/private/var/folders", "/dev", ...agentStateDirs()]
      .map((p) => `(subpath ${JSON.stringify(p)})`)
      .join(" ");
    const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* ${writable})${network ? "" : "(deny network*)"}`;
    return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, file, ...args] };
  }
  if (isolation === "docker" || isolation === "podman") {
    // file 必须是 "sh"，args = ["-c", 命令]。
    return {
      file: isolation,
      args: ["run", "--rm", "-i", "-v", `${workdir}:${workdir}`, "-w", workdir, ...(network ? [] : ["--network", "none"]), containerImage || "debian:bookworm-slim", file, ...args],
    };
  }
  if (isolation === "wsl") {
    const winPath = workdir.replace(/\\/g, "/");
    const command = [file, ...args].map(shellQuote).join(" ");
    return { file: "wsl.exe", args: ["-e", "bash", "-lc", `cd "$(wslpath ${shellQuote(winPath)})" && ${command}`] };
  }
  return { file, args };
}

/** 启动时清掉三天前留下的临时目录（任务被丢下没应用也没放弃的）。 */
async function sweepOld(maxAgeMs = 3 * 24 * 3600_000) {
  const root = tmpRoot();
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      const stat = await fsp.stat(full);
      if (Date.now() - stat.mtimeMs > maxAgeMs) await fsp.rm(full, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { prepare, diff, apply, wrap, sweepOld, git, shellQuote, agentStateDirs, tmpRoot };
