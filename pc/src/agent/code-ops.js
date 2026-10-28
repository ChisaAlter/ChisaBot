"use strict";
/**
 * 编码用的节点操作（docs/pc-node.md §12）：搜索、按行读取、精确替换编辑、应用补丁、git、
 * 后台命令（启动 / 轮询输出 / 结束）、持久 shell 会话、进程列表 / 结束、文件上传下载、管理员命令。
 * PC 客户端（Electron）和无界面节点（chisabot-node，Linux / macOS / Windows）共用这一份。
 *
 * 路径：普通模式只能在「允许的文件夹」里（ops.js 的 resolveInRoots）；完全访问模式（ctx.fullAccess）
 * 可以是整台电脑的任意路径，相对路径相对于 cwd 参数 / 会话目录 / 第一个允许的文件夹 / 主目录。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { unifiedDiff, diffStat, parsePatch, applyHunks, PatchError } = require("./textdiff");

const OUT_CAP = 64 * 1024;
const JOB_BUFFER = 2 * 1024 * 1024;
const MAX_JOBS = 20;
const JOB_KEEP_MS = 60 * 60_000;
const SEARCH_SKIP = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv", ".cache", ".turbo", ".gradle", "Pods", ".idea", "coverage"]);
const READ_RANGE_MAX_LINES = 2000;
const TRANSFER_CHUNK = 4 * 1024 * 1024;

const GIT_READ = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "remote", "blame", "ls-files", "stash-list"]);
const GIT_ALL = new Set([...GIT_READ, "add", "commit", "checkout", "switch", "restore", "reset", "pull", "push", "fetch", "clone", "init", "stash", "merge", "rebase", "tag", "rm", "mv", "apply", "cherry-pick", "config"]);

class OpError extends Error {}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function which(command) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

/** 首选 shell：Windows = PowerShell；其它 = $SHELL（bash / zsh）→ bash → sh。 */
function preferredShell(platform = process.platform) {
  if (platform === "win32") return { kind: "powershell", file: "powershell.exe" };
  const fromEnv = process.env.SHELL && /\/(bash|zsh)$/.test(process.env.SHELL) && fs.existsSync(process.env.SHELL) ? process.env.SHELL : null;
  const file = fromEnv || which("bash") || "/bin/sh";
  return { kind: path.basename(file), file };
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
const PS_PREFIX =
  "$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue';" +
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

function shellArgv(script, platform = process.platform) {
  const sh = preferredShell(platform);
  if (sh.kind === "powershell")
    return { sh, file: sh.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(PS_PREFIX + script)] };
  return { sh, file: sh.file, args: ["-c", script] };
}

function killTree(child, platform = process.platform, signal = "SIGKILL") {
  if (!child || !child.pid) return;
  try {
    if (platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function capBuffer(buffer, cap = OUT_CAP) {
  if (buffer.length <= cap) return [buffer.toString("utf8"), false];
  // 保留头尾：编译 / 测试输出最有用的常常在最后
  const head = buffer.subarray(0, Math.floor(cap * 0.3)).toString("utf8");
  const tail = buffer.subarray(buffer.length - (cap - Math.floor(cap * 0.3) - 120)).toString("utf8");
  return [`${head}\n…（中间省略 ${buffer.length - cap} 字节）…\n${tail}`, true];
}

function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

/** 简单 glob → 正则：** 任意层、* 不跨 /、? 单字符、{a,b} 任选。 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = close;
      }
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

function createCodeOps(options = {}) {
  const platform = options.platform || process.platform;
  const P = pathApi(platform);
  const resolveInRoots = options.resolveInRoots;
  const jobs = new Map();
  const sessions = new Map();
  let elevatedHelper = null;

  function baseDir(args, ctx) {
    const session = args.session ? sessions.get(String(args.session)) : null;
    if (args.cwd) return String(args.cwd);
    if (session) return session.cwd;
    if (ctx.allowedRoots && ctx.allowedRoots.length) return ctx.allowedRoots[0];
    return os.homedir();
  }

  /** 解析路径：完全访问 = 任意路径；否则必须在允许的文件夹内。 */
  async function resolvePath(requested, args, ctx) {
    const raw = typeof requested === "string" ? requested.trim() : "";
    if (ctx.fullAccess) {
      const base = baseDir(args, ctx);
      const expanded = raw.startsWith("~") ? P.join(os.homedir(), raw.slice(1)) : raw;
      return expanded ? (P.isAbsolute(expanded) ? P.resolve(expanded) : P.resolve(base, expanded)) : P.resolve(base);
    }
    if (args.cwd && raw && !P.isAbsolute(raw)) return resolveInRoots(P.resolve(String(args.cwd), raw), ctx.allowedRoots, platform);
    if (!raw && args.cwd) return resolveInRoots(String(args.cwd), ctx.allowedRoots, platform);
    return resolveInRoots(raw, ctx.allowedRoots, platform);
  }

  /**
   * 工作目录。free = 命令行类操作（命令本身就能去任何地方，限制目录没有意义，和以前一样不限）；
   * 否则（git 只读等读取文件能力的操作）必须在允许的文件夹里。
   */
  async function resolveCwd(args, ctx, free = false) {
    if (!args.cwd && !args.session) return ctx.fullAccess || free ? undefined : ctx.allowedRoots?.[0];
    const want = args.cwd ? String(args.cwd) : baseDir(args, ctx);
    const dir = await resolvePath(want, {}, free || ctx.fullAccess ? { ...ctx, fullAccess: true } : ctx);
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new OpError(`工作目录不存在：${dir}`);
    return dir;
  }

  // ---------- 读 / 搜索 ----------

  async function readRange(args, ctx) {
    const file = await resolvePath(args.path, args, ctx);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) throw new OpError(`文件不存在：${file}`);
    if (!stat.isFile()) throw new OpError(`不是文件：${file}`);
    const start = Math.max(1, Number(args.startLine) || 1);
    const wantEnd = Number(args.endLine) || start + READ_RANGE_MAX_LINES - 1;
    const end = Math.min(wantEnd, start + READ_RANGE_MAX_LINES - 1);
    const handle = await fsp.open(file, "r");
    try {
      const probe = Buffer.alloc(Math.min(8000, stat.size));
      await handle.read(probe, 0, probe.length, 0);
      if (looksBinary(probe)) throw new OpError(`这是二进制文件（${stat.size} 字节），不能按行读取。`);
    } finally {
      await handle.close();
    }
    const lines = [];
    let lineNo = 0;
    let bytes = 0;
    let truncatedBytes = false;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file, { encoding: "utf8" });
      let rest = "";
      const take = (line) => {
        lineNo++;
        if (lineNo >= start && lineNo <= end) {
          const clipped = line.length > 2000 ? `${line.slice(0, 2000)}…（本行 ${line.length} 字符，已截断）` : line;
          bytes += clipped.length;
          if (bytes > 512 * 1024) truncatedBytes = true;
          else lines.push(clipped.replace(/\r$/, ""));
        }
      };
      stream.on("data", (chunk) => {
        rest += chunk;
        let index;
        while ((index = rest.indexOf("\n")) >= 0) {
          take(rest.slice(0, index));
          rest = rest.slice(index + 1);
        }
      });
      stream.on("end", () => {
        if (rest.length) take(rest);
        resolve();
      });
      stream.on("error", reject);
    });
    const lastShown = start + lines.length - 1;
    const numbered = args.lineNumbers !== false;
    const width = String(Math.max(lastShown, 1)).length;
    return {
      path: file,
      size: stat.size,
      totalLines: lineNo,
      startLine: start,
      endLine: lines.length ? lastShown : start - 1,
      more: lastShown < lineNo,
      truncated: truncatedBytes,
      content: numbered ? lines.map((line, i) => `${String(start + i).padStart(width, " ")}│${line}`).join("\n") : lines.join("\n"),
      note: numbered ? "每行前面是行号和「│」，编辑时不要把它们写进 oldText。" : undefined,
    };
  }

  async function search(args, ctx) {
    const root = await resolvePath(args.path || "", args, ctx);
    const rootStat = await fsp.stat(root).catch(() => null);
    if (!rootStat) throw new OpError(`不存在：${root}`);
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 100, 1), 1000);
    const contextLines = Math.min(Math.max(Number(args.contextLines) || 0, 0), 5);
    const globs = (Array.isArray(args.glob) ? args.glob : args.glob ? [args.glob] : []).map(String).filter(Boolean);
    const globRes = globs.map(globToRegExp);
    let matcher = null;
    if (args.pattern) {
      const flags = args.ignoreCase ? "i" : "";
      try {
        matcher = args.literal ? new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags) : new RegExp(String(args.pattern), flags);
      } catch (error) {
        throw new OpError(`正则写法不对：${error.message}（要按字面搜索请设 literal: true）`);
      }
    }
    const started = Date.now();
    const deadline = started + Math.min(Math.max(Number(args.timeoutSec) || 20, 1), 60) * 1000;
    const results = [];
    const files = [];
    let scanned = 0;
    let stopped = null;
    const includeIgnored = !!args.includeIgnored;
    const rel = (full) => (rootStat.isDirectory() ? P.relative(root, full) : P.basename(full)).split(P.sep).join("/");
    const globOk = (full) => {
      if (!globRes.length) return true;
      const r = rel(full);
      const base = r.split("/").pop();
      return globRes.some((re, i) => (globs[i].includes("/") ? re.test(r) : re.test(base)));
    };
    async function scanFile(full, size) {
      if (size > 4 * 1024 * 1024) return;
      const buffer = await fsp.readFile(full).catch(() => null);
      if (!buffer || looksBinary(buffer)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        matcher.lastIndex = 0;
        if (!matcher.test(lines[i])) continue;
        const entry = { file: rel(full), line: i + 1, text: lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i] };
        if (contextLines) {
          entry.before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 300));
          entry.after = lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 300));
        }
        results.push(entry);
        if (results.length >= maxResults) {
          stopped = "maxResults";
          return;
        }
      }
    }
    async function walk(dir, depth) {
      if (stopped) return;
      if (Date.now() > deadline) {
        stopped = "timeout";
        return;
      }
      let names;
      try {
        names = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      names.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of names) {
        if (stopped) return;
        const full = P.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!includeIgnored && (SEARCH_SKIP.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github"))) continue;
          if (depth < 40) await walk(full, depth + 1);
        } else if (entry.isFile()) {
          if (++scanned > 50_000) {
            stopped = "fileLimit";
            return;
          }
          if (!globOk(full)) continue;
          if (!matcher) {
            files.push(rel(full));
            if (files.length >= maxResults) stopped = "maxResults";
            continue;
          }
          const stat = await fsp.stat(full).catch(() => null);
          if (stat) await scanFile(full, stat.size);
        }
      }
    }
    if (rootStat.isFile()) {
      if (!matcher) files.push(rel(root));
      else await scanFile(root, rootStat.size);
    } else await walk(root, 0);
    return {
      root,
      ...(matcher ? { matches: results, count: results.length } : { files, count: files.length }),
      scannedFiles: scanned,
      truncated: !!stopped,
      stoppedBy: stopped || undefined,
      durationMs: Date.now() - started,
      note: stopped === "maxResults" ? "结果太多，已截断：缩小 path / glob 或换更具体的 pattern。" : stopped === "timeout" ? "搜索超时，已截断：缩小范围。" : undefined,
    };
  }

  // ---------- 写 ----------

  /** 文件所在的 git 工作区根（向上找 .git 目录；.git 是文件的 worktree / submodule 不算），找不到返回 null。 */
  function gitRootOf(file) {
    let dir = path.dirname(file);
    for (let i = 0; i < 64; i++) {
      try {
        if (fs.statSync(path.join(dir, ".git")).isDirectory()) return dir;
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  /**
   * 改前备份。git 仓库里的文件备份到 <仓库>/.git/chisabot-backups/<相对路径>（不会变成未跟踪文件、不会被误提交），
   * 其它地方照旧放在旁边 <文件>.chisabot-bak。
   */
  async function backupOf(file) {
    const root = gitRootOf(file);
    let backup = `${file}.chisabot-bak`;
    if (root) {
      const rel = path.relative(root, file);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) backup = path.join(root, ".git", "chisabot-backups", rel);
    }
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    await fsp.copyFile(file, backup);
    return backup;
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      count++;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  }

  /** 按 edits 计算新内容（不写盘）。抛错时说明是哪一处、为什么。 */
  function planEdits(original, edits, file) {
    const crlf = /\r\n/.test(original);
    let content = original;
    const applied = [];
    edits.forEach((edit, i) => {
      const label = edits.length > 1 ? `第 ${i + 1} 处编辑` : "编辑";
      let oldText = String(edit.oldText ?? "");
      let newText = String(edit.newText ?? "");
      if (crlf && !oldText.includes("\r\n")) {
        oldText = oldText.replace(/\n/g, "\r\n");
        newText = newText.replace(/\r?\n/g, "\r\n");
      }
      if (!oldText) throw new OpError(`${label}：oldText 为空。要新建文件用 device_write_file。`);
      const count = countOccurrences(content, oldText);
      if (count === 0) {
        const probe = oldText.split(/\r?\n/).find((l) => l.trim().length > 3);
        const hint = probe ? content.split(/\r?\n/).findIndex((l) => l.includes(probe.trim())) : -1;
        throw new OpError(`${label}：在 ${file} 里找不到 oldText（必须逐字一致，包括缩进和空白）。${hint >= 0 ? `第 ${hint + 1} 行有相似内容，请先用 device_read_file 读那一段再编辑。` : "请先用 device_read_file 重新读取文件。"}`);
      }
      if (count > 1 && !edit.replaceAll) {
        const lines = [];
        let index = content.indexOf(oldText);
        while (index >= 0 && lines.length < 6) {
          lines.push(lineOf(content, index));
          index = content.indexOf(oldText, index + oldText.length);
        }
        throw new OpError(`${label}：oldText 在 ${file} 里出现了 ${count} 次（第 ${lines.join("、")} 行…），不知道改哪一处。请在 oldText 里多带几行上下文让它唯一，或设 replaceAll: true 全部替换。`);
      }
      const at = lineOf(content, content.indexOf(oldText));
      content = edit.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
      applied.push({ line: at, replaced: edit.replaceAll ? count : 1 });
    });
    return { content, applied };
  }

  async function editFile(args, ctx) {
    const edits = Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }];
    if (!edits.length) throw new OpError("没有要做的编辑。");
    if (edits.length > 50) throw new OpError("一次最多 50 处编辑。");
    const file = await resolvePath(args.path, args, ctx);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) throw new OpError(`文件不存在：${file}。新建文件用 device_write_file。`);
    if (!stat.isFile()) throw new OpError(`不是文件：${file}`);
    if (stat.size > 8 * 1024 * 1024) throw new OpError("文件超过 8 MB，不能这样编辑。");
    const original = await fsp.readFile(file, "utf8");
    const { content, applied } = planEdits(original, edits, P.basename(file));
    const diff = unifiedDiff(original, content, { path: P.basename(file) });
    if (args.dryRun) return { path: file, dryRun: true, diff, ...diffStat(diff), edits: applied };
    if (!diff) return { path: file, changed: false, diff: "", note: "替换前后内容相同，文件没有改动。" };
    const backup = await backupOf(file);
    await fsp.writeFile(file, content, "utf8");
    return { path: file, changed: true, backup, diff: clipDiff(diff), ...diffStat(diff), edits: applied };
  }

  function clipDiff(diff, max = 48 * 1024) {
    return diff.length > max ? `${diff.slice(0, max)}\n…（diff 过长，已截断；完整内容可用 device_git diff 查看）` : diff;
  }

  async function applyPatch(args, ctx) {
    const text = String(args.patch || "");
    if (!text.trim()) throw new OpError("补丁为空。");
    let files;
    try {
      files = parsePatch(text);
    } catch (error) {
      throw new OpError(error.message);
    }
    if (files.length > 100) throw new OpError("一次最多改 100 个文件。");
    const base = args.cwd ? { cwd: args.cwd } : {};
    // 先全部算好、全部校验，再统一写盘（任何一个文件对不上就一个都不改）
    const planned = [];
    for (const f of files) {
      const target = f.newPath ?? f.oldPath;
      if (!target) throw new OpError("补丁里有文件头两边都是 /dev/null。");
      const full = await resolvePath(target, base, ctx);
      const fromFull = f.oldPath && f.newPath && f.oldPath !== f.newPath ? await resolvePath(f.oldPath, base, ctx) : null;
      if (f.newPath === null) {
        const exists = await fsp.stat(full).catch(() => null);
        if (!exists) throw new OpError(`要删除的文件不存在：${full}`);
        planned.push({ full, delete: true, before: await fsp.readFile(full, "utf8"), after: "" });
        continue;
      }
      const source = fromFull || full;
      const exists = f.oldPath === null ? null : await fsp.stat(source).catch(() => null);
      if (f.oldPath !== null && !exists) throw new OpError(`文件不存在：${source}（新建文件的补丁要用 --- /dev/null）`);
      if (f.oldPath === null && (await fsp.stat(full).catch(() => null))) throw new OpError(`要新建的文件已存在：${full}`);
      const before = exists ? await fsp.readFile(source, "utf8") : "";
      let after;
      try {
        after = applyHunks(before, f.hunks, target);
      } catch (error) {
        throw new OpError(error instanceof PatchError ? error.message : String(error.message || error));
      }
      planned.push({ full, from: fromFull, before, after, created: f.oldPath === null });
    }
    if (args.dryRun) return { dryRun: true, files: planned.map((p) => ({ path: p.full, ...diffStat(unifiedDiff(p.before, p.after)) })) };
    const results = [];
    let combined = "";
    for (const p of planned) {
      const label = p.full;
      const diff = unifiedDiff(p.before, p.after, { path: P.basename(p.full), oldLabel: p.created ? "/dev/null" : undefined, newLabel: p.delete ? "/dev/null" : undefined });
      combined += diff;
      if (p.delete) {
        const backup = await backupOf(p.full);
        await fsp.unlink(p.full);
        results.push({ path: label, deleted: true, backup });
        continue;
      }
      let backup = null;
      if (!p.created) backup = await backupOf(p.from || p.full);
      await fsp.mkdir(P.dirname(p.full), { recursive: true });
      await fsp.writeFile(p.full, p.after, "utf8");
      if (p.from) await fsp.unlink(p.from);
      results.push({ path: label, created: !!p.created, renamedFrom: p.from || undefined, backup, ...diffStat(diff) });
    }
    return { files: results, diff: clipDiff(combined), ...diffStat(combined) };
  }

  // ---------- 进程 ----------

  function spawnShell(script, { cwd, env, elevated }) {
    let { file, args } = shellArgv(script, platform);
    if (elevated && platform !== "win32") {
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid !== 0) {
        if (!which("sudo")) throw new OpError("这台电脑没有 sudo，不能以管理员身份运行。");
        const probe = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5000 });
        if (probe.status !== 0) throw new OpError("节点所在账号没有免密码 sudo 权限（sudo -n 失败），不能以管理员身份运行。可以用 root 安装节点，或给这个账号配置 NOPASSWD。");
        args = ["-n", "-E", file, ...args];
        file = "sudo";
      }
    }
    return spawn(file, args, { cwd: cwd || undefined, env: env || process.env, windowsHide: true, detached: platform !== "win32" });
  }

  function runCollect(script, { cwd, env, timeoutMs, signal, elevated, input, noCap }) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let child;
      try {
        child = spawnShell(script, { cwd, env, elevated });
      } catch (error) {
        reject(error instanceof OpError ? error : new OpError(`无法启动命令：${error.message}`));
        return;
      }
      const out = [];
      const err = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      const maxBuf = noCap ? 8 * 1024 * 1024 : 1024 * 1024;
      const keep = (list, chunk, bytes) => {
        // 只留头 1MB 以内 + 最后的输出（见 capBuffer）
        list.push(chunk);
        let total = bytes + chunk.length;
        while (total > maxBuf && list.length > 2) total -= list.splice(1, 1)[0].length;
        return total;
      };
      child.stdout.on("data", (c) => (outBytes = keep(out, c, outBytes)));
      child.stderr.on("data", (c) => (errBytes = keep(err, c, errBytes)));
      const timer = timeoutMs ? setTimeout(() => ((timedOut = true), killTree(child, platform)), timeoutMs) : null;
      const onAbort = () => killTree(child, platform);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(new OpError(`命令出错：${error.message}`));
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const [stdout, t1] = noCap ? [Buffer.concat(out).toString("utf8"), false] : capBuffer(Buffer.concat(out));
        const [stderr, t2] = capBuffer(Buffer.concat(err));
        resolve({ exitCode: code, stdout, stderr, truncated: t1 || t2, timedOut, cancelled: !!signal?.aborted, durationMs: Date.now() - started });
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  function cleanEnv(env) {
    const out = {};
    const seen = new Map();
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("CB_STATE") || k.startsWith("CB_CWD")) continue;
      if (platform === "win32") {
        const lower = k.toLowerCase();
        const canonical = lower === "path" ? "Path" : seen.get(lower) || k;
        if (seen.has(lower) && seen.get(lower) !== canonical) delete out[seen.get(lower)];
        seen.set(lower, canonical);
        out[canonical] = v;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 持久会话里的一条命令：先切到会话目录、带上会话环境变量，跑完把新目录和环境写回会话。 */
  async function sessionShell(args, ctx, run) {
    const name = String(args.session).slice(0, 64);
    let session = sessions.get(name);
    if (!session) {
      if (sessions.size >= 20) throw new OpError("同时最多 20 个 shell 会话；用 device_shell_session close 关掉不用的。");
      session = { name, cwd: (args.cwd ? await resolveCwd({ cwd: args.cwd }, ctx, true) : null) || ctx.allowedRoots?.[0] || os.homedir(), env: cleanEnv(process.env), createdAt: Date.now(), commands: 0 };
      sessions.set(name, session);
    } else if (args.cwd) session.cwd = await resolveCwd({ cwd: args.cwd }, ctx, true);
    const stateFile = P.join(os.tmpdir(), `chisabot-state-${crypto.randomBytes(8).toString("hex")}`);
    const sh = preferredShell(platform);
    const command = String(args.command);
    const script =
      sh.kind === "powershell"
        ? `Set-Location -LiteralPath $env:CB_CWD -ErrorAction SilentlyContinue\n$global:LASTEXITCODE = $null\n$__cbok = $true\ntry {\n. {\n${command}\n}\n$__cbok = $?\n} finally {\n$__s = (Get-Location).Path + "\`n__CB_ENV__\`n" + ((Get-ChildItem env: | ForEach-Object { $_.Name + '=' + ($_.Value -replace "\`r?\`n", ' ') }) -join "\`n")\n[IO.File]::WriteAllText($env:CB_STATE, $__s)\n}\n$__cbrc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($__cbok) { 0 } else { 1 }\nexit $__cbrc`
        : `cd -- "$CB_CWD" 2>/dev/null\n${command}\n__cb_rc=$?\n{ pwd; echo __CB_ENV__; env; } > "$CB_STATE" 2>/dev/null\nexit $__cb_rc`;
    const env = { ...cleanEnv(session.env), CB_CWD: session.cwd, CB_STATE: stateFile };
    try {
      const result = await run(script, { cwd: session.cwd, env });
      const state = await fsp.readFile(stateFile, "utf8").catch(() => null);
      if (state) {
        const [cwdPart, envPart = ""] = state.split(/\r?\n__CB_ENV__\r?\n/);
        if (cwdPart && cwdPart.trim()) session.cwd = cwdPart.trim();
        const next = {};
        for (const line of envPart.split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_().]*)=(.*)$/.exec(line);
          if (m) next[m[1]] = m[2];
        }
        if (Object.keys(next).length > 3) session.env = cleanEnv(next);
      }
      session.commands++;
      return { ...result, session: name, cwd: session.cwd, shell: sh.kind };
    } finally {
      fsp.unlink(stateFile).catch(() => {});
    }
  }

  async function shell(args, ctx) {
    const command = String(args.command || "");
    if (!command.trim()) throw new OpError("命令为空。");
    const capSec = ctx.fullAccess ? 24 * 3600 : 600;
    const timeoutMs = Math.min(Math.max(Number(args.timeoutSec) || 60, 1), capSec) * 1000;
    const elevated = !!args.elevated;
    if (elevated && !ctx.fullAccess) throw new OpError("管理员身份运行只在「完全访问」模式下可用。");
    if (elevated && platform === "win32") return elevatedRun(command, { cwd: await resolveCwd(args, ctx, true), timeoutMs, signal: ctx.signal });
    const run = (script, extra) => runCollect(script, { timeoutMs, signal: ctx.signal, elevated, ...extra });
    if (args.session) return sessionShell(args, ctx, run);
    const cwd = await resolveCwd(args, ctx, true);
    const result = await run(command, { cwd });
    return { shell: preferredShell(platform).kind, cwd: cwd || process.cwd(), ...result };
  }

  function sessionOp(args) {
    const action = String(args.action || "list");
    if (action === "list")
      return { sessions: [...sessions.values()].map((s) => ({ name: s.name, cwd: s.cwd, commands: s.commands, createdAt: new Date(s.createdAt).toISOString() })) };
    if (action === "close") {
      const ok = sessions.delete(String(args.session || ""));
      return { closed: ok };
    }
    if (action === "env") {
      const s = sessions.get(String(args.session || ""));
      if (!s) throw new OpError("没有这个会话。");
      const keys = Object.keys(s.env).sort();
      return { session: s.name, cwd: s.cwd, env: Object.fromEntries(keys.filter((k) => !/TOKEN|SECRET|PASSWORD|KEY/i.test(k)).map((k) => [k, String(s.env[k]).slice(0, 300)])), hidden: keys.filter((k) => /TOKEN|SECRET|PASSWORD|KEY/i.test(k)) };
    }
    throw new OpError(`不支持的会话动作：${action}`);
  }

  // ---------- 后台任务 ----------

  function sweepJobs() {
    const cutoff = Date.now() - JOB_KEEP_MS;
    for (const [id, job] of jobs) if (job.status !== "running" && job.endedAt && job.endedAt < cutoff) jobs.delete(id);
  }

  function jobView(job) {
    return {
      jobId: job.id,
      command: job.command.length > 300 ? `${job.command.slice(0, 300)}…` : job.command,
      cwd: job.cwd,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
      runningSec: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000),
      outputBytes: job.total,
      botName: job.botName || null,
      elevated: !!job.elevated,
      lastLine: lastLine(job),
    };
  }

  function lastLine(job) {
    const tail = Buffer.concat(job.chunks.slice(-3)).toString("utf8").replace(/\s+$/, "");
    const line = tail.split(/\r?\n|\r/).pop() || "";
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  }

  async function execStart(args, ctx) {
    sweepJobs();
    const command = String(args.command || "");
    if (!command.trim()) throw new OpError("命令为空。");
    const running = [...jobs.values()].filter((j) => j.status === "running").length;
    if (running >= MAX_JOBS) throw new OpError(`同时最多 ${MAX_JOBS} 个后台命令，先结束一些（device_shell_kill）。`);
    const elevated = !!args.elevated;
    if (elevated && !ctx.fullAccess) throw new OpError("管理员身份运行只在「完全访问」模式下可用。");
    if (elevated && platform === "win32") throw new OpError("Windows 上管理员命令暂时只能在前台运行（device_run_shell elevated:true）。");
    // 普通模式最长 2 小时；完全访问模式可以不限（timeoutSec 省略或 0）。
    const maxSec = ctx.fullAccess ? Infinity : 7200;
    const asked = Number(args.timeoutSec) || 0;
    const timeoutSec = asked > 0 ? Math.min(asked, maxSec) : ctx.fullAccess ? 0 : 7200;
    let cwd;
    let env = process.env;
    const session = args.session ? sessions.get(String(args.session)) : null;
    if (session) {
      cwd = args.cwd ? await resolveCwd({ cwd: args.cwd }, ctx, true) : session.cwd;
      env = session.env;
    } else cwd = await resolveCwd(args, ctx, true);
    let child;
    try {
      child = spawnShell(command, { cwd, env, elevated });
    } catch (error) {
      throw error instanceof OpError ? error : new OpError(`无法启动命令：${error.message}`);
    }
    const id = `job_${crypto.randomBytes(5).toString("hex")}`;
    const job = { id, command, cwd: cwd || process.cwd(), child, status: "running", exitCode: null, startedAt: Date.now(), endedAt: 0, chunks: [], buffered: 0, base: 0, total: 0, waiters: new Set(), botName: ctx.botName, elevated };
    jobs.set(id, job);
    const push = (chunk) => {
      job.chunks.push(chunk);
      job.buffered += chunk.length;
      job.total += chunk.length;
      while (job.buffered > JOB_BUFFER && job.chunks.length > 1) {
        const dropped = job.chunks.shift();
        job.buffered -= dropped.length;
        job.base += dropped.length;
      }
      for (const wake of job.waiters) wake();
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.stdin.end();
    let timer = null;
    if (timeoutSec > 0)
      timer = setTimeout(() => {
        if (job.status === "running") {
          job.status = "timeout";
          killTree(child, platform);
        }
      }, timeoutSec * 1000);
    if (timer && timer.unref) timer.unref();
    child.on("error", (error) => {
      push(Buffer.from(`\n[启动失败] ${error.message}\n`));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (job.status === "running") job.status = "exited";
      job.exitCode = code ?? (signal ? `signal ${signal}` : null);
      job.endedAt = Date.now();
      for (const wake of job.waiters) wake();
    });
    // 等一小会儿：很快结束的命令（或启动报错）直接带上结果
    const firstWait = Math.min(Math.max(Number(args.waitMs) || 1500, 0), 10_000);
    // 等到结束或 waitMs 用完（中间有输出也继续等，最多 waitMs）
    const until = Date.now() + firstWait;
    while (firstWait && job.status === "running" && Date.now() < until && !ctx.signal?.aborted) await waitJob(job, job.total, until - Date.now(), ctx.signal);
    return { ...jobView(job), ...readJob(job, 0), timeoutSec: timeoutSec || null, note: "用 device_shell_output 看后续输出（带上 nextOffset），用 device_shell_kill 结束。" };
  }

  function readJob(job, since) {
    let from = Math.max(Number(since) || 0, 0);
    const skipped = from < job.base ? job.base - from : 0;
    if (from < job.base) from = job.base;
    const all = Buffer.concat(job.chunks);
    let slice = all.subarray(from - job.base);
    let more = false;
    if (slice.length > OUT_CAP) {
      slice = slice.subarray(0, OUT_CAP);
      more = true;
    }
    return { output: slice.toString("utf8"), nextOffset: from + slice.length, more, droppedBytes: skipped || undefined };
  }

  function waitJob(job, since, ms, signal) {
    if (job.status !== "running" || job.total > since || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        job.waiters.delete(done);
        signal?.removeEventListener?.("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      job.waiters.add(done);
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  async function execPoll(args, ctx) {
    const job = jobs.get(String(args.jobId || ""));
    if (!job) throw new OpError(`没有这个后台命令：${args.jobId}（结束超过 1 小时的会被清理）。`);
    const since = Number(args.since) || 0;
    await waitJob(job, since, Math.min(Math.max(Number(args.waitMs) || 0, 0), 25_000), ctx.signal);
    return { ...jobView(job), ...readJob(job, since) };
  }

  function execKill(args) {
    const job = jobs.get(String(args.jobId || ""));
    if (!job) throw new OpError(`没有这个后台命令：${args.jobId}`);
    if (job.status === "running") {
      job.status = "killed";
      killTree(job.child, platform, args.signal === "SIGTERM" || args.signal === "SIGINT" ? args.signal : "SIGKILL");
    }
    return jobView(job);
  }

  function execList() {
    sweepJobs();
    return { jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(jobView) };
  }

  // ---------- git ----------

  function gitArgsSafe(list) {
    for (const a of list) {
      if (typeof a !== "string" || a.length > 2000 || a.includes("\0")) throw new OpError("git 参数格式不对。");
      if (/^--(output|exec|upload-pack|receive-pack|config-env|ext-diff)(=|$)/.test(a) || a === "-c")
        throw new OpError(`git 参数 ${a} 不允许（会执行或写入任意内容）。需要的话用 device_run_shell。`);
    }
    return list;
  }

  async function git(args, ctx) {
    const sub = String(args.subcommand || "");
    if (!GIT_ALL.has(sub)) throw new OpError(`不支持的 git 子命令：${sub}`);
    if (!which("git")) throw new OpError("这台电脑上没有安装 git。");
    const extra = gitArgsSafe(Array.isArray(args.args) ? args.args.map(String) : []);
    const free = !gitIsRead(sub, extra);
    const want = { cwd: args.cwd || (ctx.allowedRoots && ctx.allowedRoots[0]) || os.homedir() };
    const cwd =
      sub === "clone" || sub === "init"
        ? await resolvePath(want.cwd, {}, free ? { ...ctx, fullAccess: true } : ctx)
        : await resolveCwd(want, ctx, free);
    if (sub === "clone" || sub === "init") await fsp.mkdir(cwd, { recursive: true });
    const argv = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "color.ui=false"];
    if (sub === "stash-list") argv.push("stash", "list");
    else argv.push(sub);
    if (["diff", "show", "log"].includes(sub)) argv.push("--no-ext-diff");
    if (sub === "log" && !extra.some((a) => /^(-n|--max-count|-\d+)/.test(a))) argv.push("-n", "30");
    argv.push(...extra);
    const long = ["pull", "push", "fetch", "clone"].includes(sub);
    const result = await new Promise((resolve, reject) => {
      const child = spawn("git", argv, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: process.env.LC_ALL || "C.UTF-8" },
        windowsHide: true,
        detached: platform !== "win32",
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (c) => out.push(c));
      child.stderr.on("data", (c) => err.push(c));
      const timer = setTimeout(() => killTree(child, platform), (long ? 300 : 60) * 1000);
      const onAbort = () => killTree(child, platform);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new OpError(`git 出错：${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const [stdout, t1] = capBuffer(Buffer.concat(out), 96 * 1024);
        const [stderr] = capBuffer(Buffer.concat(err), 16 * 1024);
        resolve({ exitCode: code, stdout, stderr, truncated: t1 });
      });
    });
    return { cwd, command: `git ${[sub === "stash-list" ? "stash list" : sub, ...extra].join(" ")}`, ...result };
  }

  // ---------- 进程列表 / 结束 ----------

  async function processList(args) {
    const filter = String(args.filter || "").toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 300);
    let list = [];
    if (platform === "win32") {
      const r = await runCollect(
        "$cpu = @{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $cpu[[int]$_.Id] = $_.CPU }; " +
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize," +
          "@{n='CommandLine';e={if ($_.CommandLine -and $_.CommandLine.Length -gt 300) { $_.CommandLine.Substring(0, 300) } else { $_.CommandLine }}}," +
          "@{n='CPU';e={$cpu[[int]$_.ProcessId]}} | ConvertTo-Json -Compress",
        { timeoutMs: 30_000, noCap: true },
      );
      try {
        const rows = JSON.parse(r.stdout || "[]");
        list = (Array.isArray(rows) ? rows : [rows]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cpuSec: p.CPU ? Math.round(p.CPU) : 0, memMB: Math.round((p.WorkingSetSize || 0) / 1048576), command: (p.CommandLine || "").slice(0, 300) }));
      } catch {
        throw new OpError(`读取进程列表失败：${(r.stderr || r.stdout).slice(0, 300)}`);
      }
    } else {
      const r = await new Promise((resolve) => {
        const child = spawn("ps", ["-axo", "pid=,ppid=,user=,pcpu=,rss=,etime=,args="], { env: { ...process.env, LC_ALL: "C" } });
        const out = [];
        child.stdout.on("data", (c) => out.push(c));
        child.on("close", () => resolve(Buffer.concat(out).toString("utf8")));
        child.on("error", () => resolve(""));
      });
      list = r
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpu: Number(m[4]), memMB: Math.round(Number(m[5]) / 1024), elapsed: m[6], name: path.basename(m[7].split(" ")[0] || ""), command: m[7].slice(0, 300) }));
    }
    if (filter) list = list.filter((p) => `${p.name} ${p.command}`.toLowerCase().includes(filter));
    list.sort((a, b) => (b.cpu ?? b.cpuSec ?? 0) - (a.cpu ?? a.cpuSec ?? 0) || b.memMB - a.memMB);
    return { total: list.length, processes: list.slice(0, limit) };
  }

  function processKill(args) {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 1) throw new OpError("pid 不对。");
    if (pid === process.pid) throw new OpError("不能结束 ChisaBot 节点自己。");
    if (platform === "win32") {
      const r = spawnSync("taskkill", ["/PID", String(pid), ...(args.tree === false ? [] : ["/T"]), "/F"], { windowsHide: true, encoding: "utf8" });
      if (r.status !== 0) throw new OpError(`结束失败：${(r.stderr || r.stdout || "").slice(0, 300)}`);
      return { killed: pid };
    }
    const signal = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"].includes(args.signal) ? args.signal : "SIGTERM";
    try {
      process.kill(pid, signal);
    } catch (error) {
      throw new OpError(error.code === "EPERM" ? "没有权限结束这个进程。" : error.code === "ESRCH" ? "没有这个进程。" : error.message);
    }
    return { killed: pid, signal };
  }

  // ---------- 传文件 ----------

  async function fileUpload(args, ctx) {
    const file = await resolvePath(args.path, args, ctx);
    const offset = Number(args.offset) || 0;
    const data = Buffer.from(String(args.base64 || ""), "base64");
    if (data.length > TRANSFER_CHUNK + 1024) throw new OpError("单块太大。");
    await fsp.mkdir(P.dirname(file), { recursive: true });
    const part = `${file}.chisabot-part`;
    if (offset === 0) {
      const exists = await fsp.stat(file).catch(() => null);
      if (exists && !exists.isFile()) throw new OpError(`目标是文件夹：${file}`);
      if (exists && args.overwrite === false) throw new OpError(`文件已存在：${file}`);
      await fsp.writeFile(part, data);
    } else {
      const st = await fsp.stat(part).catch(() => null);
      if (!st || st.size !== offset) throw new OpError("上传中断了（分块偏移对不上），请重新上传。");
      await fsp.appendFile(part, data);
    }
    if (!args.final) return { path: file, received: offset + data.length };
    const exists = await fsp.stat(file).catch(() => null);
    let backup = null;
    if (exists) backup = await backupOf(file);
    await fsp.rename(part, file);
    const hash = crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex");
    if (args.sha256 && args.sha256 !== hash) throw new OpError("上传后校验不一致（sha256）。");
    return { path: file, bytes: offset + data.length, sha256: hash, backup };
  }

  async function fileDownload(args, ctx) {
    const file = await resolvePath(args.path, args, ctx);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) throw new OpError(`文件不存在：${file}`);
    if (!stat.isFile()) throw new OpError(`不是文件：${file}`);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const length = Math.min(Math.max(Number(args.length) || TRANSFER_CHUNK, 1), TRANSFER_CHUNK);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size - offset)));
      await handle.read(buffer, 0, buffer.length, offset);
      return { path: file, size: stat.size, offset, base64: buffer.toString("base64"), done: offset + buffer.length >= stat.size, name: P.basename(file) };
    } finally {
      await handle.close();
    }
  }

  // ---------- Windows 管理员助手（一次 UAC） ----------

  const HELPER_PS = `
param([string]$Dir, [string]$Key, [int]$ParentPid)
$ErrorActionPreference = 'Continue'
$idle = [DateTime]::UtcNow
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  if (Test-Path (Join-Path $Dir 'stop')) { break }
  if (([DateTime]::UtcNow - $idle).TotalMinutes -gt 30) { break }
  Set-Content -LiteralPath (Join-Path $Dir 'alive') -Value ([DateTime]::UtcNow.ToString('o'))
  foreach ($f in Get-ChildItem -LiteralPath $Dir -Filter '*.cmd' -ErrorAction SilentlyContinue) {
    $idle = [DateTime]::UtcNow
    $id = $f.BaseName
    try {
      $job = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
      Remove-Item -LiteralPath $f.FullName -Force
      if ($job.key -ne $Key) { continue }
      $out = Join-Path $Dir "$id.out"; $err = Join-Path $Dir "$id.err"
      $args = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', $job.script)
      $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WorkingDirectory $job.cwd -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
      if (-not $p.WaitForExit([int]$job.timeoutMs)) { & taskkill /PID $p.Id /T /F | Out-Null; Set-Content -LiteralPath (Join-Path $Dir "$id.timeout") -Value '1' }
      Set-Content -LiteralPath (Join-Path $Dir "$id.rc") -Value $p.ExitCode
    } catch { Set-Content -LiteralPath (Join-Path $Dir "$id.rc") -Value ("ERR " + $_.Exception.Message) }
  }
  Start-Sleep -Milliseconds 300
}
Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
`;

  async function ensureHelper() {
    if (elevatedHelper) {
      const alive = await fsp.stat(P.join(elevatedHelper.dir, "alive")).catch(() => null);
      if (alive && Date.now() - alive.mtimeMs < 10_000) return elevatedHelper;
      elevatedHelper = null;
    }
    const dir = P.join(os.tmpdir(), `chisabot-elev-${crypto.randomBytes(8).toString("hex")}`);
    await fsp.mkdir(dir, { recursive: true });
    const key = crypto.randomBytes(24).toString("hex");
    const script = P.join(dir, "helper.ps1");
    await fsp.writeFile(script, HELPER_PS, "utf8");
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const launcher = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${q(script)},'-Dir',${q(dir)},'-Key',${q(key)},'-ParentPid','${process.pid}')`;
    const r = await runCollect(launcher, { timeoutMs: 120_000 });
    if (r.exitCode !== 0) throw new OpError(`没有拿到管理员权限（UAC 被拒绝或取消）：${(r.stderr || "").slice(0, 200)}`);
    for (let i = 0; i < 100; i++) {
      if (await fsp.stat(P.join(dir, "alive")).catch(() => null)) {
        elevatedHelper = { dir, key, startedAt: Date.now() };
        return elevatedHelper;
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    throw new OpError("管理员助手没有启动（30 秒内没有响应）。");
  }

  async function elevatedRun(command, { cwd, timeoutMs, signal }) {
    const helper = await ensureHelper();
    const id = crypto.randomBytes(6).toString("hex");
    const started = Date.now();
    await fsp.writeFile(
      P.join(helper.dir, `${id}.tmp`),
      JSON.stringify({ key: helper.key, script: encodePowerShell(PS_PREFIX + command), cwd: cwd || os.homedir(), timeoutMs }),
      "utf8",
    );
    await fsp.rename(P.join(helper.dir, `${id}.tmp`), P.join(helper.dir, `${id}.cmd`));
    const rcFile = P.join(helper.dir, `${id}.rc`);
    while (!(await fsp.stat(rcFile).catch(() => null))) {
      if (signal?.aborted) throw new OpError("已取消。");
      if (Date.now() - started > timeoutMs + 30_000) throw new OpError("管理员命令超时。");
      await new Promise((r) => setTimeout(r, 250));
    }
    const read = async (ext) => (await fsp.readFile(P.join(helper.dir, `${id}.${ext}`)).catch(() => Buffer.alloc(0)));
    const rc = (await read("rc")).toString("utf8").trim();
    const [stdout, t1] = capBuffer(await read("out"));
    const [stderr, t2] = capBuffer(await read("err"));
    const timedOut = (await read("timeout")).length > 0;
    for (const ext of ["rc", "out", "err", "timeout"]) fsp.unlink(P.join(helper.dir, `${id}.${ext}`)).catch(() => {});
    return { shell: "powershell", elevated: true, exitCode: /^-?\d+$/.test(rc) ? Number(rc) : null, error: /^ERR/.test(rc) ? rc : undefined, stdout, stderr, truncated: t1 || t2, timedOut, durationMs: Date.now() - started };
  }

  /** 紧急停止 / 撤销 / 完全访问结束时：结束所有后台命令、关掉管理员助手。 */
  function stopAll(reason = "stopped") {
    for (const job of jobs.values())
      if (job.status === "running") {
        job.status = "killed";
        killTree(job.child, platform);
      }
    if (elevatedHelper) {
      fs.writeFile(P.join(elevatedHelper.dir, "stop"), reason, () => {});
      elevatedHelper = null;
    }
  }

  function activity() {
    return {
      ...execList(),
      sessions: sessionOp({ action: "list" }).sessions,
      elevatedHelper: elevatedHelper ? { startedAt: new Date(elevatedHelper.startedAt).toISOString() } : null,
      shell: preferredShell(platform).kind,
      git: !!which("git"),
    };
  }

  return {
    stopAll,
    table: {
      search,
      read_range: readRange,
      edit_file: editFile,
      apply_patch: applyPatch,
      git,
      shell,
      shell_session: sessionOp,
      exec_start: execStart,
      exec_poll: execPoll,
      exec_kill: execKill,
      exec_list: execList,
      process_list: processList,
      process_kill: processKill,
      file_upload: fileUpload,
      file_download: fileDownload,
      activity,
    },
  };
}

/** git 子命令是只读的吗（只读 = 读取文件能力；其余 = 命令行能力；push 另外总要审批）。 */
function gitIsRead(subcommand, args = []) {
  const sub = String(subcommand || "");
  if (!GIT_READ.has(sub)) return false;
  if (sub === "branch") return args.every((a) => /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-contains|-merged|-no-merged)$/.test(a) || a.startsWith("--format"));
  if (sub === "remote") return args.length === 0 || (args.length === 1 && args[0] === "-v");
  return true;
}

module.exports = { createCodeOps, gitIsRead, globToRegExp, preferredShell, OpError, GIT_ALL, GIT_READ };
