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
const PREFLIGHT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUT_BYTES = 16 * 1024 * 1024;
const GIT_MAX_ERR_BYTES = 256 * 1024;

/** 统一路径分隔符为 `/`，消除 Windows `\` 在前缀/正则判断中的边界陷阱。 */
function normalizePosixPath(rawPath, platform = process.platform) {
  const sep = platform === "win32" ? "\\" : path.sep;
  let value = String(rawPath || "")
    .trim()
    .split(sep)
    .join("/")
    .split("\\")
    .join("/")
    .replace(/\/+$/g, "");
  if (!value) value = "/";
  return platform === "win32" ? value.toLowerCase() : value;
}

function killPreflightChild(child, platform) {
  if (!child?.pid) return;
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function runPwdProbe({ file, args, cwd, env, timeoutMs, platform }) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(file, args, {
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new Error(
          `沙盒目录预检无法启动进程：${error?.message || String(error)}`,
        ),
      );
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killPreflightChild(child, platform);
      reject(
        new Error(
          `沙盒目录 pwd -P 预检超时（${timeoutMs}ms），已安全中止（fail-closed）。`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (out.length < 8192) out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `沙盒目录 pwd -P 预检进程出错：${error?.message || String(error)}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

function isWithinNormalizedRoots(targetNorm, normalizedRoots) {
  return normalizedRoots.some(
    (base) =>
      targetNorm === base ||
      targetNorm.startsWith(base === "/" ? "/" : `${base}/`),
  );
}

/**
 * 启动前 5s 沙盒目录 `pwd -P` 预检：
 * - 通过真实子进程（POSIX / 沙盒走 `pwd -P`，Windows 走子进程物理 cwd 探测且显式注入 ELECTRON_RUN_AS_NODE=1）解析符号链接后的真实路径；
 * - 校验真实路径确实存在、可访问且位于允许工作区内（防 symlink 越界；非 full 档位不允许空 roots）；
 * - WSL 隔离在同命名空间内同时解析 workdir 与每个 root 的物理路径再做前缀包含校验；
 * - 任何超时（默认 5000ms）、realpath 失败或非零退出码一律 fail-closed 拒绝启动。
 */
async function preflightSandboxCwd({
  workdir,
  roots = [],
  profile = "workspace",
  isolation = "none",
  network = true,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
  platform = process.platform,
  probeFn,
}) {
  const effectiveTimeout = Math.min(
    Math.max(100, Number(timeoutMs) || PREFLIGHT_TIMEOUT_MS),
    15_000,
  );
  const rawCwd = typeof workdir === "string" ? workdir.trim() : "";
  if (!rawCwd) {
    throw new Error("沙盒目录预检失败：未提供工作目录。");
  }
  const normalizedRootInputs = Array.isArray(roots)
    ? roots
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter((r) => r.length > 0)
    : [];
  if (profile !== "full" && normalizedRootInputs.length === 0) {
    throw new Error(
      "沙盒目录预检拒绝：非完全访问档位缺少允许工作区目录（fail-closed）。",
    );
  }

  const isWslPosixCwd = isolation === "wsl" && rawCwd.startsWith("/");
  if (!isWslPosixCwd) {
    const stat = await fsp.stat(rawCwd).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(
        `沙盒目录预检失败：工作目录不存在或不是文件夹（${rawCwd}）。`,
      );
    }
  }

  const probePath = async (targetPath) => {
    if (typeof probeFn === "function") {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() =>
            probeFn({
              workdir: targetPath,
              isolation,
              network,
              timeoutMs: effectiveTimeout,
            }),
          ),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  `沙盒目录 pwd -P 预检超时（${effectiveTimeout}ms），已安全中止（fail-closed）。`,
                ),
              );
            }, effectiveTimeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (platform === "win32" && isolation !== "wsl") {
      // Windows 本机子进程真实 cwd 解析（打包后 process.execPath 为 Electron 可执行文件，必须带 ELECTRON_RUN_AS_NODE=1）。
      return runPwdProbe({
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(require('node:fs').realpathSync.native(process.cwd()))",
        ],
        cwd: targetPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeoutMs: effectiveTimeout,
        platform,
      });
    }
    if (isolation === "wsl") {
      if (targetPath.startsWith("/")) {
        return runPwdProbe({
          file: "wsl.exe",
          args: [
            "-e",
            "bash",
            "-lc",
            `cd ${shellQuote(targetPath)} && pwd -P`,
          ],
          timeoutMs: effectiveTimeout,
          platform,
        });
      }
      const wrappedWsl = wrap({
        isolation: "wsl",
        workdir: targetPath,
        network,
        file: "pwd",
        args: ["-P"],
      });
      return runPwdProbe({
        file: wrappedWsl.file,
        args: wrappedWsl.args,
        timeoutMs: effectiveTimeout,
        platform,
      });
    }
    const wrapped = wrap({
      isolation,
      workdir: targetPath,
      network,
      file: "/bin/pwd",
      args: ["-P"],
    });
    return runPwdProbe({
      file: wrapped.file,
      args: wrapped.args,
      cwd: targetPath,
      timeoutMs: effectiveTimeout,
      platform,
    });
  };

  const probeResult = await probePath(rawCwd);
  if (
    probeResult?.exitCode !== 0 ||
    !String(probeResult?.stdout || "").trim()
  ) {
    throw new Error(
      `沙盒目录 pwd -P 预检失败：${String(probeResult?.stderr || "退出码非 0 或未返回路径").slice(0, 240)}`,
    );
  }

  const probedRaw = String(probeResult.stdout).split(/\r?\n/)[0].trim();

  if (isolation === "wsl") {
    if (!probedRaw.startsWith("/")) {
      throw new Error(
        `沙盒目录 WSL 预检返回了非物理 POSIX 路径：${probedRaw}`,
      );
    }
    const probedWslNorm = normalizePosixPath(probedRaw, "linux");
    if (profile !== "full") {
      const resolvedWslRoots = [];
      for (const root of normalizedRootInputs) {
        try {
          const rootProbe = await probePath(root);
          if (rootProbe?.exitCode !== 0) continue;
          const rootOut = String(rootProbe.stdout || "")
            .split(/\r?\n/)[0]
            .trim();
          if (rootOut.startsWith("/")) {
            resolvedWslRoots.push(normalizePosixPath(rootOut, "linux"));
          }
        } catch {
          // 单个不可解析 root 不加入白名单；若全部不可解析则下方 fail-closed 拒绝。
        }
      }
      if (resolvedWslRoots.length === 0) {
        throw new Error(
          "沙盒目录 WSL 预检拒绝：允许工作区在 WSL 命名空间内均无法解析（fail-closed）。",
        );
      }
      if (!isWithinNormalizedRoots(probedWslNorm, resolvedWslRoots)) {
        throw new Error(
          `沙盒目录 WSL 预检拒绝：真实路径「${probedWslNorm}」超出允许工作区范围（可能存在 WSL 符号链接越界）。`,
        );
      }
    }
    return {
      ok: true,
      realPath: probedRaw,
      normalizedPath: probedWslNorm,
      probedPath: probedRaw,
    };
  }

  let realCwd;
  try {
    realCwd = await fsp.realpath(rawCwd);
  } catch (error) {
    throw new Error(
      `沙盒目录预检失败：无法解析工作目录真实路径（${error?.message || String(error)}）。`,
    );
  }
  const probedNorm = normalizePosixPath(probedRaw, platform);
  const realNorm = normalizePosixPath(realCwd, platform);
  if (probedNorm !== realNorm) {
    throw new Error(
      `沙盒目录 pwd -P 预检路径不一致：探测=${probedRaw}，真实=${realCwd}`,
    );
  }

  if (profile !== "full") {
    const resolvedRoots = (
      await Promise.all(
        normalizedRootInputs.map(async (root) => {
          try {
            const resolvedRoot = await fsp.realpath(root);
            return normalizePosixPath(resolvedRoot, platform);
          } catch {
            return null;
          }
        }),
      )
    ).filter((value) => typeof value === "string" && value.length > 0);
    if (resolvedRoots.length === 0) {
      throw new Error(
        "沙盒目录预检拒绝：允许工作区目录均无法解析真实路径（fail-closed）。",
      );
    }
    if (!isWithinNormalizedRoots(realNorm, resolvedRoots)) {
      throw new Error(
        `沙盒目录预检拒绝：真实路径「${realNorm}」超出允许工作区范围（可能存在符号链接越界）。`,
      );
    }
  }

  return {
    ok: true,
    realPath: realCwd,
    normalizedPath: realNorm,
    probedPath: probedRaw,
  };
}

function tmpRoot() {
  const dir = path.join(os.tmpdir(), "chisabot-agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(
  args,
  {
    cwd,
    env,
    timeoutMs = 120_000,
    input,
    maxOutBytes = GIT_MAX_OUT_BYTES,
    maxErrBytes = GIT_MAX_ERR_BYTES,
    signal,
  } = {},
) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, out: "", err: "已取消", truncated: false });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let outTruncated = false;
    let errTruncated = false;
    const outCap = Math.max(1024, Number(maxOutBytes) || GIT_MAX_OUT_BYTES);
    const errCap = Math.max(1024, Number(maxErrBytes) || GIT_MAX_ERR_BYTES);
    let child;
    let settled = false;
    try {
      child = spawn(
        "git",
        ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args],
        {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      resolve({
        code: -1,
        out: "",
        err: String(error?.message),
        truncated: false,
      });
      return;
    }
    child.stdin?.on("error", () => {});
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const finalize = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout.on("data", (d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      const remain = outCap - outBytes;
      if (remain > 0) {
        if (buf.length <= remain) {
          outChunks.push(buf);
          outBytes += buf.length;
        } else {
          outChunks.push(buf.subarray(0, remain));
          outBytes += remain;
          outTruncated = true;
        }
      } else {
        outTruncated = true;
      }
    });
    child.stderr.on("data", (d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      const remain = errCap - errBytes;
      if (remain > 0) {
        if (buf.length <= remain) {
          errChunks.push(buf);
          errBytes += buf.length;
        } else {
          errChunks.push(buf.subarray(0, remain));
          errBytes += remain;
          errTruncated = true;
        }
      } else {
        errTruncated = true;
      }
    });
    child.on("error", (error) => {
      finalize({
        code: -1,
        out: Buffer.concat(outChunks).toString("utf8"),
        err: String(error?.message),
        truncated: outTruncated || errTruncated,
      });
    });
    child.on("close", (code) => {
      finalize({
        code: code ?? -1,
        out: Buffer.concat(outChunks).toString("utf8"),
        err: Buffer.concat(errChunks).toString("utf8"),
        truncated: outTruncated || errTruncated,
      });
    });
    try {
      if (input) child.stdin.end(input);
      else child.stdin.end();
    } catch {}
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
        if (bytes > limitBytes || files > limitFiles)
          return { bytes, files, over: true };
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
  const commit = await git(
    [
      "-c",
      "user.name=ChisaBot",
      "-c",
      "user.email=agent@chisabot.local",
      "commit",
      "-q",
      "--allow-empty",
      "--no-verify",
      "-m",
      "chisabot: before",
    ],
    { env, timeoutMs: 180_000 },
  );
  if (commit.code !== 0) return null;
  const head = await git(["rev-parse", "HEAD"], { env });
  return head.code === 0 ? { env, base: head.out.trim() } : null;
}

/**
 * 准备工作目录。返回 { workdir, mode, original, notes[], diffEnv, base, cleanup() }。
 */
async function prepare({ taskId, cwd, isolation }) {
  const notes = [];
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
    throw new Error(`工作目录不存在：${cwd || "（没有指定）"}`);
  const original = path.resolve(cwd);
  const taskDir = path.join(
    tmpRoot(),
    `task-${taskId.slice(0, 8)}-${Date.now().toString(36)}`,
  );
  fs.mkdirSync(taskDir, { recursive: true });
  const gitDir = path.join(taskDir, "snap.git");
  let mode =
    isolation === "worktree" || isolation === "copy" ? isolation : "direct";

  if (mode === "worktree") {
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: original });
    if (top.code !== 0) {
      notes.push("这个文件夹不是 git 仓库，改用临时副本。");
      mode = "copy";
    } else {
      const toplevel = path.resolve(top.out.trim());
      // 未提交的已跟踪改动一起带进 worktree（stash create 不动用户的工作区和 stash 列表）。
      const stash = await git(["stash", "create"], { cwd: toplevel });
      const start =
        stash.code === 0 && stash.out.trim() ? stash.out.trim() : "HEAD";
      const wt = path.join(taskDir, "worktree");
      const add = await git(["worktree", "add", "--detach", wt, start], {
        cwd: toplevel,
      });
      if (add.code !== 0) {
        notes.push(
          `git worktree 失败（${add.err.trim().slice(0, 160)}），改用临时副本。`,
        );
        mode = "copy";
      } else {
        if (start !== "HEAD")
          notes.push(
            "worktree 里带上了未提交的已跟踪改动；未跟踪的新文件没有带进去。",
          );
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
          diffEnv: snap?.env,
          base: snap?.base,
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
    if (size.over)
      throw new Error(
        `文件夹太大，不适合复制（超过 ${COPY_LIMIT_FILES} 个文件或 ${Math.round(COPY_LIMIT_BYTES / 1048576)} MB）。请选一个更小的子文件夹，或用 worktree / 直接在文件夹里做。`,
      );
    const work = path.join(taskDir, "copy");
    await fsp.cp(original, work, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
    });
    const snap = await snapshot(work, gitDir);
    return {
      workdir: work,
      workRoot: work,
      mode,
      original,
      originalRoot: original,
      notes,
      diffEnv: snap?.env,
      base: snap?.base,
      taskDir,
      async cleanup() {
        await fsp.rm(taskDir, { recursive: true, force: true });
      },
    };
  }

  // 直接在原文件夹里做：只拍快照用来统计改动。文件太多就不统计。
  const size = await folderSize(original, Number.MAX_SAFE_INTEGER, 20_000);
  const snap = size.over ? null : await snapshot(original, gitDir);
  if (!snap)
    notes.push(
      size.over
        ? "文件夹文件太多，这次不统计改动。"
        : "没有找到 git，这次不统计改动。",
    );
  return {
    workdir: original,
    workRoot: original,
    mode: "direct",
    original,
    originalRoot: original,
    notes,
    diffEnv: snap?.env,
    base: snap?.base,
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
  const numstat = await git(
    ["diff", "--cached", "--numstat", "-M", prep.base],
    { env },
  );
  const status = await git(
    ["diff", "--cached", "--name-status", "-M", prep.base],
    { env },
  );
  if (numstat.code !== 0) return null;
  const kinds = new Map();
  for (const line of status.out.split("\n")) {
    const [code, ...rest] = line.split("\t");
    if (!code || !rest.length) continue;
    const file = rest[rest.length - 1];
    kinds.set(
      file,
      code.startsWith("A")
        ? "added"
        : code.startsWith("D")
          ? "deleted"
          : "modified",
    );
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
    if (file.includes(" => "))
      file = file
        .replace(/\{([^}]*) => ([^}]*)\}/, "$2")
        .replace(/^.* => /, "");
    added += a;
    removed += r;
    files.push({
      path: file,
      added: a,
      removed: r,
      status: kinds.get(file) || "modified",
    });
  }
  let patch = "";
  if (files.length) {
    const full = await git(["diff", "--cached", "-M", prep.base], {
      env,
      maxOutBytes: PATCH_PREVIEW * 4 + 4096,
    });
    patch =
      full.truncated || full.out.length > PATCH_PREVIEW
        ? `${full.out.slice(0, PATCH_PREVIEW)}\n…（补丁太长，后面省略）`
        : full.out;
  }
  return {
    files: files.slice(0, 300),
    added,
    removed,
    pending: prep.mode !== "direct",
    applied: false,
    patch,
  };
}

/** 把一次性副本里的改动合回原文件夹。 */
async function apply(prep) {
  if (prep.mode === "direct") return { ok: true };
  if (!prep.diffEnv || !prep.base)
    return { ok: false, error: "没有改动记录，无法应用。" };
  const env = prep.diffEnv;
  await git(["add", "-A"], { env });
  const patch = await git(["diff", "--cached", "--binary", prep.base], {
    env,
    timeoutMs: 180_000,
  });
  if (patch.code !== 0)
    return {
      ok: false,
      error: patch.err.trim().slice(0, 300) || "生成补丁失败。",
    };
  if (patch.truncated)
    return {
      ok: false,
      error: "改动补丁超过 16 MB 上限，无法自动应用，请手动处理。",
    };
  if (!patch.out.trim()) return { ok: true };
  // 补丁里的路径相对快照的工作树根（worktree 根 / 副本根），对应原仓库根 / 原文件夹。
  const check = await git(["apply", "--check", "--whitespace=nowarn", "-"], {
    cwd: prep.originalRoot,
    input: patch.out,
  });
  if (check.code !== 0)
    return {
      ok: false,
      error: `原文件夹在这期间也改过，补丁对不上：${check.err.trim().slice(0, 300)}`,
    };
  const done = await git(["apply", "--whitespace=nowarn", "-"], {
    cwd: prep.originalRoot,
    input: patch.out,
  });
  return done.code === 0
    ? { ok: true }
    : { ok: false, error: done.err.trim().slice(0, 300) || "应用补丁失败。" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** agent 自己的配置 / 登录目录（沙盒里要可写，否则 Claude Code / Codex 起不来）。 */
function agentStateDirs() {
  const home = os.homedir();
  return [
    ".claude",
    ".claude.json",
    ".codex",
    ".config",
    ".cache",
    ".local/share/opencode",
    ".local/state",
    ".npm",
    ".gemini",
    ".aider",
  ]
    .map((p) => path.join(home, p))
    .filter((p) => fs.existsSync(p));
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
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        workdir,
        workdir,
        ...binds,
        "--die-with-parent",
        ...(network ? [] : ["--unshare-net"]),
        "--chdir",
        workdir,
        "--",
        file,
        ...args,
      ],
    };
  }
  if (isolation === "sandbox-exec") {
    const writable = [
      workdir,
      "/private/tmp",
      "/private/var/folders",
      "/dev",
      ...agentStateDirs(),
    ]
      .map((p) => `(subpath ${JSON.stringify(p)})`)
      .join(" ");
    const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* ${writable})${network ? "" : "(deny network*)"}`;
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", profile, file, ...args],
    };
  }
  if (isolation === "docker" || isolation === "podman") {
    // file 必须是 "sh"，args = ["-c", 命令]。
    return {
      file: isolation,
      args: [
        "run",
        "--rm",
        "-i",
        "-v",
        `${workdir}:${workdir}`,
        "-w",
        workdir,
        ...(network ? [] : ["--network", "none"]),
        containerImage || "debian:bookworm-slim",
        file,
        ...args,
      ],
    };
  }
  if (isolation === "wsl") {
    const winPath = workdir.replace(/\\/g, "/");
    const command = [file, ...args].map(shellQuote).join(" ");
    return {
      file: "wsl.exe",
      args: [
        "-e",
        "bash",
        "-lc",
        `cd "$(wslpath ${shellQuote(winPath)})" && ${command}`,
      ],
    };
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
      if (Date.now() - stat.mtimeMs > maxAgeMs)
        await fsp.rm(full, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  prepare,
  diff,
  apply,
  wrap,
  sweepOld,
  git,
  shellQuote,
  agentStateDirs,
  tmpRoot,
  preflightSandboxCwd,
  normalizePosixPath,
  PREFLIGHT_TIMEOUT_MS,
};
