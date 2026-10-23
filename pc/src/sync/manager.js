"use strict";
/**
 * 电脑文件夹同步的同步管理（P4b，docs/cloud-claude-code.md §4，DESIGN.md §73.9）：PC 客户端主进程里跑。
 *
 *  - 「电脑上的文件夹」新建：选文件夹 → 检查（Git、分支、远端、文件数、大小、不上传的规则）→ 云端建空的 work/ →
 *    登记公钥（bind）→ Mutagen two-way-safe 上传 → Git 历史经隧道推上去 →「PC 正在使用」（没勾「开启同步」就交还 =「已暂停」）。
 *  - 已有的云端工作区在这台电脑上开启同步（第一次选空文件夹：云端 → 电脑；非空：两边对比，两边都改过的进冲突）。
 *  - 交还云端（关闭）：flush → Git → 暂停 Mutagen（不终止，留共同基线）→ /release。再开启 = resume，Mutagen 自己比。
 *  - 冲突对话框：每个文件「用云端 / 用电脑 / 两份都留（电脑那份另存为 名.电脑副本.扩展名）」；Git 分叉「以云端为准」
 *    （电脑上的分支先备份到 chisabot/backup/<时间>）或「在电脑上合并后再试」。永远不静默覆盖，挪走的文件进备份目录。
 *  - 交接 ①–⑤（服务器经设备 WSS 发 sync_begin / sync_end / sync_cancel）：先推上去再暂停、写交接记录、回 ready；
 *    写完恢复、拉回、删记录、回 released。重启后拿交接记录去对（recover），对不上不算放行。
 *  - 隧道：ssh 的 ProxyCommand 连本机中转（broker.js），设备令牌只在主进程里。
 *
 * 平台相关的东西都从参数进来（Mutagen、ssh、ssh 包装器、当 Node 跑 tunnel.js 的程序），Linux 上的测试替身用同一份代码。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { ensureKey } = require("./keys");
const { createBroker } = require("./broker");
const { createMutagen, classify, conflictList, sessionName, IGNORES } = require("./mutagen");

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const BIG_BYTES = 2 * 1024 ** 3;
const BIG_FILES = 50_000;
const PC_COPY = "电脑副本";

function nowIso() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** §4.6 默认规则（mutagen.js 的 IGNORES）对一个相对路径是否生效（检查文件夹时统计用）。 */
function ignoredRel(rel) {
  const parts = rel.split("/");
  let hit = false;
  for (const raw of IGNORES) {
    const neg = raw.startsWith("!");
    const rule = neg ? raw.slice(1) : raw;
    const re = new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    if (parts.some((p) => re.test(p))) hit = !neg;
  }
  return hit || parts.includes(".git");
}

/** 「两份都留」：电脑那份另存为 名.电脑副本.扩展名（已经有就 名.电脑副本 2.扩展名…）。 */
function pcCopyName(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const name = `${stem}.${PC_COPY}${i > 1 ? ` ${i}` : ""}${ext}`;
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error("找不到可用的副本文件名");
}

/**
 * @param {{
 *   dataDir: string,                       userData/sync
 *   serverUrl: () => string,
 *   getToken: () => string | null,
 *   fetchImpl?: typeof fetch, WebSocket?: any,
 *   mutagenPath: string,                   mutagen(.exe)
 *   sshPath: string,                       系统的 ssh（Windows: C:\Windows\System32\OpenSSH\ssh.exe）
 *   sshShim?: string | null,               Windows：ssh 包装器 exe（复制成 ssh.exe / scp.exe）；其它平台用 sh 脚本
 *   nodeExe: string, nodeArgs?: string[],  跑 tunnel.js 的程序（PC：ChisaBotPC.exe + ELECTRON_RUN_AS_NODE=1）
 *   tunnelScript: string,
 *   proxyExe?: string,                     测试用：在非 Windows 上也用 Go 写的 ssh 包装器当 ProxyCommand
 *   gitPath?: string,
 *   deviceLabel?: string,
 *   platform?: string,
 *   log?: (s: string) => void,
 *   audit?: (entry: object) => void,
 * }} options
 */
function createSyncManager(options) {
  const log = options.log || (() => {});
  const audit = options.audit || (() => {});
  const platform = options.platform || process.platform;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const dataDir = options.dataDir;
  const stateFile = path.join(dataDir, "sync.json");
  const binDir = path.join(dataDir, "bin");
  const sshDir = path.join(dataDir, "ssh");
  const journalDir = path.join(dataDir, "handoff");
  const backupDir = path.join(dataDir, "backup");
  const events = new EventEmitter();
  let state = { bindings: {} };
  let started = false;
  let startError = "";
  let monitorTimer = null;
  const busy = new Map(); // workspaceId → 正在做的事（文字）
  const progress = new Map(); // workspaceId → { done, total }
  const lastReport = new Map(); // workspaceId → { state, detail, at }
  const handoffs = new Map(); // workspaceId → handoffId（进行中）

  try {
    state = { bindings: {}, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch {}
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  function binding(workspaceId) {
    return state.bindings[workspaceId] || null;
  }
  function changed() {
    events.emit("change");
  }

  const broker = createBroker({
    serverUrl: options.serverUrl,
    getToken: options.getToken,
    allow: (ws) => !!binding(ws),
    WebSocket: options.WebSocket,
    fetchImpl,
    log,
  });

  // ── ssh 配置、包装器 ─────────────────────────────────────────────────
  const wrapperDir = path.join(binDir, "ssh");
  const sshConfig = path.join(sshDir, "config");
  const knownHosts = path.join(sshDir, "known_hosts");
  let key = null;

  function q(p) {
    return `"${String(p).replace(/"/g, '\\"')}"`;
  }
  function hostAlias(ws) {
    return `cb-${ws}`;
  }
  function writeSshFiles() {
    fs.mkdirSync(sshDir, { recursive: true });
    fs.mkdirSync(wrapperDir, { recursive: true });
    // Windows：ssh 包装器自己就能当 ProxyCommand（--chisabot-proxy，连本机中转）；其它平台用 Node 跑 tunnel.js
    const proxyFor = (ws) =>
      platform === "win32" || options.proxyExe
        ? `${q(options.proxyExe || path.join(wrapperDir, "ssh.exe"))} --chisabot-proxy ${broker.address()} ${ws}`
        : `${[options.nodeExe, ...(options.nodeArgs || []), options.tunnelScript].map(q).join(" ")} --broker ${broker.address()} --workspace ${ws}`;
    const lines = [];
    const known = [];
    for (const b of Object.values(state.bindings)) {
      if (!ID.test(b.workspaceId) || !b.hostKey) continue;
      lines.push(
        `Host ${hostAlias(b.workspaceId)}`,
        "  HostName sync.chisabot.invalid",
        "  User agent",
        `  IdentityFile ${q(key.keyFile)}`,
        "  IdentitiesOnly yes",
        `  HostKeyAlias chisabot-sync-${b.workspaceId}`,
        `  UserKnownHostsFile ${q(knownHosts)}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        "  ServerAliveInterval 30",
        "  ServerAliveCountMax 4",
        `  ProxyCommand ${proxyFor(b.workspaceId)}`,
        "",
      );
      known.push(`chisabot-sync-${b.workspaceId} ${b.hostKey}`);
    }
    fs.writeFileSync(sshConfig, lines.join("\n"), { mode: 0o600 });
    fs.writeFileSync(knownHosts, known.length ? `${known.join("\n")}\n` : "", { mode: 0o600 });
    if (platform === "win32") {
      if (!options.sshShim) throw new Error("缺少 ssh 包装器");
      for (const name of ["ssh.exe", "scp.exe"]) {
        const dest = path.join(wrapperDir, name);
        const src = fs.readFileSync(options.sshShim);
        let same = false;
        try {
          same = fs.readFileSync(dest).equals(src);
        } catch {}
        if (!same) fs.writeFileSync(dest, src);
      }
    } else {
      for (const name of ["ssh", "scp"]) {
        const real = name === "ssh" ? options.sshPath : path.join(path.dirname(options.sshPath), "scp");
        fs.writeFileSync(path.join(wrapperDir, name), `#!/bin/sh\nexec ${q(real)} -F ${q(sshConfig)} "$@"\n`, { mode: 0o755 });
      }
    }
  }
  /** Mutagen / git 子进程的环境：ssh 包装器 + 中转口令 + 让 ChisaBotPC.exe 当 Node 跑。 */
  function childEnv() {
    const env = { ...process.env };
    env.MUTAGEN_DATA_DIRECTORY = path.join(dataDir, "mutagen");
    env.MUTAGEN_SSH_PATH = wrapperDir;
    env.MUTAGEN_DISABLE_AUTOSTART = "1";
    env.CHISABOT_SYNC_SECRET = broker.secret;
    env.CHISABOT_SSH_CONFIG = sshConfig;
    env.CHISABOT_REAL_SSH = options.sshPath;
    env.ELECTRON_RUN_AS_NODE = "1";
    return env;
  }
  const mutagen = options.mutagenImpl || createMutagen({ bin: options.mutagenPath, env: childEnv, log });

  // ── git ──────────────────────────────────────────────────────────────
  const gitBin = options.gitPath || "git";
  function git(cwd, args, { timeout = 120_000 } = {}) {
    const env = { ...childEnv(), GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8" };
    // git 走同一个 ssh 包装器（Windows 上是 ssh.exe 包装器，它自己读 CHISABOT_SSH_CONFIG）
    if (platform === "win32") {
      env.GIT_SSH = path.join(wrapperDir, "ssh.exe");
      env.GIT_SSH_VARIANT = "ssh";
    } else env.GIT_SSH_COMMAND = q(path.join(wrapperDir, "ssh"));
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_RUN_AS_NODE = "1"; // ProxyCommand 要
    return new Promise((resolve) => {
      execFile(gitBin, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), missing: !!(error && error.code === "ENOENT") });
      });
    });
  }
  async function gitAvailable() {
    const r = await git(os.tmpdir(), ["--version"], { timeout: 10_000 });
    return r.code === 0;
  }
  async function localGit(dir) {
    if (!fs.existsSync(path.join(dir, ".git"))) return { repo: false };
    const branch = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
    const head = (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim() || null;
    const remote = (await git(dir, ["remote", "get-url", "origin"])).stdout.trim() || null;
    return { repo: true, branch, head, remote: remote ? remote.replace(/\/\/[^/@]+@/, "//") : null };
  }

  // ── 服务器 ───────────────────────────────────────────────────────────
  async function api(method, p, body) {
    const token = options.getToken();
    if (!token) throw new Error("这台电脑还没登记，先登录");
    const origin = new URL(options.serverUrl()).origin;
    const res = await fetchImpl(`${origin}/api/devices/agent/sync${p}`, {
      method,
      headers: { "content-type": "application/json", "X-Device-Token": token, Origin: origin },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(j.error || `服务器返回 ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return j;
  }
  async function report(workspaceId, s, detail, conflicts) {
    const prev = lastReport.get(workspaceId);
    const at = Date.now();
    // 同样的状态 60 秒内不重复报（PC 正在使用时每分钟刷新一次「上次同步」）
    if (prev && prev.state === s && prev.detail === detail && at - prev.at < 60_000 && !conflicts) return;
    lastReport.set(workspaceId, { state: s, detail, at });
    try {
      const r = await api("POST", "/state", { workspaceId, state: s, detail, conflicts: conflicts || null });
      const b = binding(workspaceId);
      if (b) {
        b.lastState = r.state || s;
        b.detail = detail;
        if ((r.state || s) === "pc_active") b.lastSyncedAt = nowIso();
        save();
      }
    } catch (e) {
      lastReport.delete(workspaceId);
      if (e.status === 404) {
        // 服务器上已经没有这个工作区了（网页上删了）：对一次账，确认后放下本机的记录（§87）
        void reconcileGone([workspaceId]).catch(() => {});
      } else if (e.status === 409 || e.status === 403) {
        // 服务器说这台电脑没开着这个工作区的同步了（交还 / 强制收回 / 撤销）：本机也停下
        log(`同步 ${workspaceId}：${e.message}`);
        await localStop(workspaceId, e.message).catch(() => {});
      }
    }
  }

  // ── 启动 / 停止 ──────────────────────────────────────────────────────
  async function start() {
    if (started) return true;
    try {
      if (!fs.existsSync(options.mutagenPath)) throw new Error("这个版本没有带同步组件（mutagen）");
      if (!fs.existsSync(options.sshPath)) throw new Error(platform === "win32" ? "找不到 Windows 自带的 OpenSSH 客户端（设置 → 应用 → 可选功能 → OpenSSH 客户端）" : "找不到 ssh");
      key = ensureKey(path.join(dataDir, "keys"), `chisabot-sync@${options.deviceLabel || os.hostname()}`);
      await broker.start();
      writeSshFiles();
      await mutagen.startDaemon();
      started = true;
      startError = "";
      monitorTimer = setInterval(() => void tick(), 4000);
      if (monitorTimer.unref) monitorTimer.unref();
      await recoverJournals();
      // 开着的同步：恢复会话（暂停着的只有在交接里才会是暂停）
      // 启动时对账：服务器上已经删掉的工作区，本机的同步记录和 Mutagen 会话也放下（§87）
      await reconcileGone(Object.keys(state.bindings)).catch((e) => log(`对账失败（下次再试）：${e.message}`));
      for (const b of Object.values(state.bindings)) if (b.enabled && !handoffs.has(b.workspaceId)) await mutagen.resume(b.workspaceId).catch(() => {});
      changed();
      return true;
    } catch (e) {
      startError = e.message;
      log(`同步组件没有启动：${e.message}`);
      changed();
      return false;
    }
  }
  async function stop() {
    clearInterval(monitorTimer);
    monitorTimer = null;
    if (started) await mutagen.stopDaemon().catch(() => {});
    broker.stop();
    started = false;
  }
  function need() {
    if (!started) throw new Error(startError || "同步组件还没准备好");
  }

  // ── 状态 ─────────────────────────────────────────────────────────────
  async function status() {
    const sessions = started ? (await mutagen.list()) || [] : [];
    const items = [];
    for (const b of Object.values(state.bindings)) {
      const s = sessions.find((x) => x.name === sessionName(b.workspaceId)) || null;
      const c = b.enabled ? classify(s) : { state: "paused", detail: "同步已关闭（交还云端）" };
      if (b.enabled && b.unconfirmed) Object.assign(c, { state: "conflict", detail: "交接未确认" });
      if (b.enabled && b.gitConflict) Object.assign(c, { state: "conflict", detail: b.gitConflict });
      items.push({
        workspaceId: b.workspaceId,
        name: b.name,
        path: b.path,
        enabled: !!b.enabled,
        state: busy.has(b.workspaceId) && c.state !== "conflict" ? "syncing" : c.state,
        detail: busy.get(b.workspaceId) || c.detail,
        busy: busy.get(b.workspaceId) || null,
        progress: progress.get(b.workspaceId) || null,
        lastSyncedAt: b.lastSyncedAt || null,
        files: s && s.alpha ? Number(s.alpha.files ?? 0) || null : null,
        bytes: s && s.alpha ? Number(s.alpha.totalFileSize ?? 0) || null : null,
        conflicts: b.enabled ? conflictList(s) : [],
        git: b.git || null,
        gitConflict: b.gitConflict || null,
        unconfirmed: !!b.unconfirmed,
        handoff: handoffs.get(b.workspaceId) || null,
        ignores: IGNORES,
      });
    }
    return { available: started, reason: startError || null, platform, ignores: IGNORES, bindings: items };
  }

  /** 轻量读取本机 .git/HEAD 与当前分支引用指纹（不拉起子进程），用于在 tick 中感知本地新 commit 或切分支。 */
  function gitHeadStamp(dir) {
    try {
      const gitDir = path.join(dir, ".git");
      const headRaw = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (headRaw.startsWith("ref:")) {
        const ref = headRaw.slice(4).trim();
        let sha = "";
        try {
          sha = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
        } catch {
          try {
            const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
            const m = new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed);
            if (m) sha = m[1];
          } catch {}
        }
        return `${ref}:${sha}`;
      }
      return headRaw;
    } catch {
      return "";
    }
  }

  /** 监视：Mutagen 状态 → 服务器（五种状态）；当后台首次上传完成或本地产生新 Git 提交时自动对齐 Git 历史。 */
  const lastGitStamp = new Map();
  let ticking = false;
  async function tick() {
    if (ticking || !started) return;
    ticking = true;
    try {
      const sessions = await mutagen.list();
      if (!sessions) return;
      for (const b of Object.values(state.bindings)) {
        if (!b.enabled || busy.has(b.workspaceId) || handoffs.has(b.workspaceId)) continue;
        if (b.unconfirmed || b.gitConflict) continue;
        const s = sessions.find((x) => x.name === sessionName(b.workspaceId)) || null;
        const c = classify(s);
        if (c.state === "paused") continue;
        if (c.state === "conflict") {
          await report(b.workspaceId, "conflict", c.detail, conflictList(s));
          continue;
        }
        if (c.state === "pc_active") {
          const stamp = b.path ? gitHeadStamp(b.path) : "";
          const prevStamp = lastGitStamp.get(b.workspaceId);
          const becameActive = b.lastState && b.lastState !== "pc_active";
          const headMoved = !!stamp && prevStamp !== undefined && prevStamp !== stamp;
          if (stamp) lastGitStamp.set(b.workspaceId, stamp);
          if (becameActive || headMoved) {
            const g = await gitSync(b.workspaceId).catch(() => "error");
            if (g === "diverged") continue;
            const afterStamp = b.path ? gitHeadStamp(b.path) : "";
            if (afterStamp) lastGitStamp.set(b.workspaceId, afterStamp);
          }
        }
        await report(b.workspaceId, c.state, c.detail);
      }
      changed();
    } finally {
      ticking = false;
    }
  }

  async function withBusy(workspaceId, text, fn) {
    if (busy.has(workspaceId)) throw new Error(`这个工作区正在${busy.get(workspaceId)}，等它结束`);
    busy.set(workspaceId, text);
    changed();
    try {
      return await fn((t) => {
        busy.set(workspaceId, t);
        changed();
      });
    } finally {
      busy.delete(workspaceId);
      progress.delete(workspaceId);
      changed();
    }
  }

  // ── 检查文件夹（图 2 右的检测结果卡） ─────────────────────────────
  async function inspect(dir) {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw new Error("请选一个文件夹");
    let files = 0;
    let bytes = 0;
    let truncated = false;
    const skipped = new Map();
    const walk = (abs, rel, depth) => {
      if (truncated) return;
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (ignoredRel(r)) {
          if (e.name !== ".git") skipped.set(e.name, (skipped.get(e.name) || 0) + 1);
          continue;
        }
        const full = path.join(abs, e.name);
        if (e.isDirectory()) {
          if (depth < 64) walk(full, r, depth + 1);
        } else if (e.isFile()) {
          files++;
          try {
            bytes += fs.statSync(full).size;
          } catch {}
          if (files > 200_000) {
            truncated = true;
            return;
          }
        }
      }
    };
    walk(dir, "", 0);
    const g = (await gitAvailable()) ? await localGit(dir) : { repo: fs.existsSync(path.join(dir, ".git")), noGit: true };
    let empty = true;
    try {
      empty = fs.readdirSync(dir).length === 0;
    } catch {}
    return {
      path: dir,
      name: path.basename(dir),
      empty,
      files,
      bytes,
      truncated,
      big: bytes > BIG_BYTES || files > BIG_FILES,
      git: g,
      skipped: [...skipped.entries()].map(([name, count]) => ({ name, count })).slice(0, 20),
      ignores: IGNORES,
      ...(await boundInfo(dir)),
    };
  }

  /** 同一个文件夹（Windows 不分大小写）在本机记着的同步。 */
  function samePath(a, b) {
    const x = path.resolve(a);
    const y = path.resolve(b);
    return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  }
  function bindingsAt(dir) {
    return Object.values(state.bindings).filter((b) => b.path && samePath(b.path, dir));
  }
  /**
   * 这个文件夹在本机记着的同步里，工作区还在的叫「在同步」，服务器上已经删掉的叫「残留」（boundStale）。
   * 服务器连不上时不下结论：当作还在同步（不让重复导入）。
   */
  async function boundInfo(dir) {
    const at = bindingsAt(dir);
    if (!at.length) return { bound: null, boundStale: false, staleIds: [] };
    let gone = [];
    try {
      gone = (await api("POST", "/reconcile", { workspaceIds: at.map((b) => b.workspaceId) })).gone || [];
    } catch (e) {
      log(`对账失败：${e.message}`);
      return { bound: at[0].workspaceId, boundStale: false, staleIds: [] };
    }
    const live = at.find((b) => !gone.includes(b.workspaceId));
    if (live) return { bound: live.workspaceId, boundName: live.name || null, boundStale: false, staleIds: [] };
    return { bound: at[0].workspaceId, boundName: at[0].name || null, boundStale: true, staleIds: at.map((b) => b.workspaceId) };
  }

  /**
   * 放下本机的一条同步记录：终止 Mutagen 会话、删交接记录、从 sync.json 里去掉、重写 ssh 配置。
   * 只动 ChisaBot 自己的记录，文件夹里的文件一个都不碰。
   */
  async function forgetLocal(workspaceId, why) {
    const b = binding(workspaceId);
    await mutagen.terminate(workspaceId).catch(() => {});
    removeJournal(workspaceId);
    handoffs.delete(workspaceId);
    lastReport.delete(workspaceId);
    if (b) {
      delete state.bindings[workspaceId];
      save();
      try {
        if (key) writeSshFiles();
      } catch (e) {
        log(`重写 ssh 配置失败：${e.message}`);
      }
      audit({ operation: "sync_forget", summary: `放下本机的同步记录「${b.name || workspaceId}」（${why}，文件夹里的文件没动）`, outcome: "succeeded" });
    }
    changed();
    return !!b;
  }

  /** 问服务器这些工作区还在不在；不在的放下本机记录。返回放下的 id。服务器连不上：抛错，什么都不动。 */
  async function reconcileGone(ids) {
    const list = ids.filter((id) => ID.test(String(id)));
    if (!list.length) return [];
    const { gone = [] } = await api("POST", "/reconcile", { workspaceIds: list });
    const dropped = [];
    for (const id of gone) {
      if (!list.includes(id) || busy.has(id)) continue;
      if (await forgetLocal(id, "工作区已在云端删除")) dropped.push(id);
    }
    return dropped;
  }

  /** 网页上的「解除旧的同步」：只有服务器确认工作区已经删掉了才放下。 */
  async function forget(workspaceId) {
    need();
    if (!ID.test(String(workspaceId))) throw new Error("工作区 id 不对");
    if (!binding(workspaceId)) return { forgotten: false };
    let gone;
    try {
      gone = (await api("POST", "/reconcile", { workspaceIds: [workspaceId] })).gone || [];
    } catch (e) {
      throw new Error(`连不上服务器，没法确认旧的工作区已经删掉：${e.message}`);
    }
    if (!gone.includes(workspaceId)) throw new Error("这个工作区还在云端，要停止同步请用「交还云端」，或者先删掉工作区");
    return { forgotten: await forgetLocal(workspaceId, "解除旧的同步") };
  }

  /** 让报错能看懂：同步组件 / ssh 的英文报错换成一句中文，原因附在后面。 */
  function explain(e) {
    const raw = String((e && e.message) || e || "未知错误");
    if (!/同步组件没有就绪/.test(raw) && /ECONNREFUSED|连不上同步边车|kex_exchange|Connection (closed|reset)|connection refused|Permission denied \(publickey\)|unable to connect|ssh/i.test(raw))
      return `连不上云端的同步组件（${raw.replace(/\s+/g, " ").slice(0, 160)}）`;
    return raw.replace(/\s+/g, " ").slice(0, 300);
  }

  /**
   * 新建失败的补偿（§87）：终止 Mutagen 会话、去掉本机记录、让服务器撤销这个工作区（删节点上的目录、绑定、租约）。
   * 返回服务器那边是否撤销成功。
   */
  async function rollbackCreate(workspaceId, cause) {
    log(`新建失败，撤销 ${workspaceId}：${cause && cause.message}`);
    busy.delete(workspaceId);
    progress.delete(workspaceId);
    await forgetLocal(workspaceId, "新建失败，已撤销");
    let ok = true;
    try {
      await api("POST", "/abandon", { workspaceId });
    } catch (e) {
      ok = e.status === 404;
      if (!ok) log(`服务器撤销失败：${e.message}`);
    }
    audit({ operation: "sync_create", summary: `新建失败，已撤销：${explain(cause)}`, outcome: "failed" });
    changed();
    return ok;
  }

  // ── 开启 / 新建 ──────────────────────────────────────────────────────
  async function bindAndSession(workspaceId, dir, meta, setText) {
    setText("登记这台电脑");
    const r = await api("POST", "/bind", { workspaceId, pubKey: key.publicKey, label: dir });
    const prev = binding(workspaceId);
    state.bindings[workspaceId] = {
      ...(prev || {}),
      workspaceId,
      name: meta.name || prev?.name || workspaceId,
      source: meta.source || prev?.source || "local",
      path: dir,
      bindingId: r.bindingId,
      epoch: r.epoch,
      hostKey: r.hostKey,
      workPath: r.workPath,
      cloudGit: !!r.isGit,
      enabled: true,
      unconfirmed: false,
      gitConflict: null,
    };
    save();
    writeSshFiles();
    setText("连接云端");
    const existing = await mutagen.get(workspaceId);
    if (existing && prev && path.resolve(prev.path) === path.resolve(dir)) await mutagen.resume(workspaceId);
    else {
      if (existing) await mutagen.terminate(workspaceId).catch(() => {});
      await mutagen.create({ workspaceId, local: dir, remote: `agent@${hostAlias(workspaceId)}:${r.workPath}`, labels: { chisabot: "1" } });
    }
    return r;
  }

  /** flush，同时把进度（云端 / 电脑的总字节）报给界面。 */
  async function flushWithProgress(workspaceId, setText, label) {
    let stop = false;
    const poll = (async () => {
      while (!stop) {
        await sleep(700);
        const s = await mutagen.get(workspaceId).catch(() => null);
        if (s && s.alpha && s.beta) {
          const total = Number(s.alpha.totalFileSize || 0);
          const done = Number(s.beta.totalFileSize || 0);
          if (total) {
            progress.set(workspaceId, { done: Math.min(done, total), total });
            setText(`${label} ${Math.min(100, Math.round((done / total) * 100))}%`);
          }
        }
      }
    })();
    try {
      await mutagen.flush(workspaceId);
    } finally {
      stop = true;
      await poll;
    }
  }

  async function afterFlush(workspaceId) {
    const s = await mutagen.get(workspaceId);
    const c = classify(s);
    if (c.state === "conflict") {
      await report(workspaceId, "conflict", c.detail, conflictList(s));
      return "conflict";
    }
    const g = await gitSync(workspaceId);
    if (g === "diverged") return "conflict";
    await report(workspaceId, "pc_active", "已同步");
    return "pc_active";
  }

  /** 「电脑上的文件夹」新建（图 2 右）。 */
  /**
   * 「电脑上的文件夹」新建（图 2 右）。一整件事：中间任何一步失败都撤销（§87）——终止 Mutagen 会话、去掉本机记录、
   * 服务器撤销工作区，报一句中文原因，可以直接重试。这个文件夹以前同步过的工作区已经在云端删掉了（残留）：先放下旧记录再导入。
   */
  async function createFromFolder({ dir, name, enableSync = true }) {
    need();
    const info = await inspect(dir);
    if (info.bound && !info.boundStale) throw new Error(`这个文件夹已经在同步工作区${info.boundName ? `「${info.boundName}」` : ""}了`);
    for (const id of info.staleIds || []) await forgetLocal(id, "旧的工作区已在云端删除，重新导入");
    let ws = null;
    try {
      ws = (await api("POST", "/workspaces", { name: String(name || info.name).slice(0, 80), label: dir })).workspace;
      audit({ operation: "sync_create", summary: `电脑上的文件夹 → 云端工作区「${ws.name}」`, outcome: "started" });
      const created = ws;
      return await withBusy(created.id, "上传中", async (setText) => {
        await bindAndSession(created.id, dir, { name: created.name, source: "local" }, setText);
        await report(created.id, "syncing", "第一次上传");
        try {
          await flushWithProgress(created.id, setText, "上传中");
          const result = await afterFlush(created.id);
          if (!enableSync && result === "pc_active") await releaseInner(created.id, setText);
          audit({ operation: "sync_create", summary: `工作区「${created.name}」已上传（${info.files} 个文件）`, outcome: "succeeded" });
          return { workspace: created, state: enableSync ? result : "paused", files: info.files, bytes: info.bytes };
        } catch (flushErr) {
          log(`首次全量上传未在单次 flush 内完成，转为后台继续同步（${created.id}）：${flushErr.message}`);
          await report(created.id, "syncing", "后台继续上传中").catch(() => {});
          audit({ operation: "sync_create", summary: `工作区「${created.name}」已创建，首次上传转入后台继续（${explain(flushErr)}）`, outcome: "succeeded" });
          return { workspace: created, state: "syncing", deferred: true, files: info.files, bytes: info.bytes };
        }
      });
    } catch (e) {
      if (!ws) throw new Error(`新建没有成功：${explain(e)}`);
      const undone = await rollbackCreate(ws.id, e);
      const err = new Error(
        undone
          ? `新建没有成功，已经撤销（云端没有留下工作区，电脑上的文件没动）：${explain(e)}。可以直接再点一次重试。`
          : `新建没有成功：${explain(e)}。云端可能留下了一个空的工作区「${ws.name}」，可以在左栏删掉它再重试。`,
      );
      err.rolledBack = undone;
      throw err;
    }
  }

  /** 在这台电脑上开启（或再次开启）一个云端工作区的同步。空文件夹：云端 → 电脑；非空：两边对比。 */
  async function enable({ workspaceId, dir, name, source }) {
    need();
    if (!ID.test(String(workspaceId))) throw new Error("工作区 id 不对");
    const prev = binding(workspaceId);
    const target = dir || prev?.path;
    if (!target) throw new Error("先选一个文件夹");
    fs.mkdirSync(target, { recursive: true });
    return await withBusy(workspaceId, "开启同步", async (setText) => {
      const empty = fs.readdirSync(target).length === 0;
      const r = await bindAndSession(workspaceId, target, { name, source }, setText);
      await report(workspaceId, "syncing", empty ? "第一次从云端下载" : "对比两边");
      // 第一次拉到空文件夹：Git 历史先从云端拉下来（§4.4），文件由 Mutagen 搬
      if (empty && r.isGit && (await gitAvailable())) await gitCloneInto(workspaceId, target).catch((e) => log(`git 拉取失败：${e.message}`));
      try {
        await flushWithProgress(workspaceId, setText, empty ? "下载中" : "对比中");
        const result = await afterFlush(workspaceId);
        audit({ operation: "sync_enable", summary: `开启同步「${binding(workspaceId)?.name}」→ ${target}`, outcome: result });
        return { state: result };
      } catch (flushErr) {
        log(`开启同步首次 flush 未在单次内完成，转为后台继续（${workspaceId}）：${flushErr.message}`);
        await report(workspaceId, "syncing", "后台继续同步中").catch(() => {});
        audit({ operation: "sync_enable", summary: `开启同步「${binding(workspaceId)?.name}」已转入后台继续（${explain(flushErr)}）`, outcome: "succeeded" });
        return { state: "syncing", deferred: true };
      }
    });
  }

  // ── 交还 ─────────────────────────────────────────────────────────────
  async function releaseInner(workspaceId, setText = () => {}) {
    setText("交还云端");
    const b = binding(workspaceId);
    try {
      await mutagen.resume(workspaceId).catch(() => {});
      await mutagen.flush(workspaceId, 120_000);
    } catch (e) {
      log(`交还前 flush 失败：${e.message}`);
    }
    if (!b?.gitConflict) await gitSync(workspaceId).catch(() => {});
    await mutagen.pause(workspaceId).catch(() => {});
    await api("POST", "/release", { workspaceId });
    if (b) {
      b.enabled = false;
      b.lastState = "paused";
      b.unconfirmed = false;
      save();
    }
    lastReport.delete(workspaceId);
    audit({ operation: "sync_release", summary: `交还云端「${b?.name || workspaceId}」（两份都留）`, outcome: "succeeded" });
    return { state: "paused" };
  }
  async function release(workspaceId) {
    need();
    return await withBusy(workspaceId, "交还云端", (setText) => releaseInner(workspaceId, setText));
  }
  /** 服务器那边已经不让同步了（强制收回 / 撤销）：本机暂停，不删任何东西。 */
  async function localStop(workspaceId, why) {
    const b = binding(workspaceId);
    if (!b || !b.enabled) return;
    await mutagen.pause(workspaceId).catch(() => {});
    b.enabled = false;
    b.detail = why;
    b.lastState = "paused";
    save();
    changed();
  }

  async function syncNow(workspaceId) {
    need();
    const b = binding(workspaceId);
    if (!b || !b.enabled) throw new Error("这个工作区没有在这台电脑上开着同步");
    return await withBusy(workspaceId, "同步中", async (setText) => {
      await mutagen.resume(workspaceId).catch(() => {});
      await flushWithProgress(workspaceId, setText, "同步中");
      return { state: await afterFlush(workspaceId) };
    });
  }

  // ── Git（§4.5） ─────────────────────────────────────────────────────
  function remoteUrl(b) {
    return `${hostAlias(b.workspaceId)}:${b.workPath}`;
  }
  async function ensureRemote(dir, b) {
    const url = remoteUrl(b);
    const cur = await git(dir, ["remote", "get-url", "chisabot"]);
    if (cur.code !== 0) await git(dir, ["remote", "add", "chisabot", url]);
    else if (cur.stdout.trim() !== url) await git(dir, ["remote", "set-url", "chisabot", url]);
    await git(dir, ["config", "remote.chisabot.fetch", "+refs/heads/*:refs/remotes/chisabot/*"]);
  }
  /** 空文件夹第一次开启：云端的提交历史拉下来，分支指过去，index 对齐（文件由 Mutagen 搬）。 */
  async function gitCloneInto(workspaceId, dir) {
    const b = binding(workspaceId);
    const info = await api("POST", "/git", { workspaceId, op: "info" });
    if (!info.repo || !info.head) return false;
    await git(dir, ["init", "-q"]);
    await ensureRemote(dir, b);
    const f = await git(dir, ["fetch", "-q", "chisabot"], { timeout: 15 * 60_000 });
    if (f.code !== 0) throw new Error(f.stderr.trim().slice(-200));
    const branch = info.branch || "main";
    await git(dir, ["update-ref", `refs/heads/${branch}`, info.head]);
    await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await git(dir, ["reset", "-q", "--mixed", info.head]);
    b.git = { branch, head: info.head, at: nowIso(), result: "cloned" };
    save();
    return true;
  }
  /**
   * 两边 HEAD 一样就跳过；云端是祖先 → 推上去（refs/remotes/pc/<分支>）+ 云端快进；电脑落后 → 电脑快进（reset --mixed，文件不动）；
   * 分叉 → 冲突（不自动合并）。电脑上没有 git 或者文件夹不是仓库：跳过（只同步文件）。
   */
  async function gitSync(workspaceId) {
    const b = binding(workspaceId);
    if (!b) return "skip";
    const dir = b.path;
    if (!fs.existsSync(path.join(dir, ".git"))) return "skip";
    if (!(await gitAvailable())) {
      b.git = { note: "这台电脑上没有 git，只同步文件" };
      save();
      return "skip";
    }
    const local = await localGit(dir);
    if (!local.head || !local.branch) return "skip";
    await ensureRemote(dir, b);
    const f = await git(dir, ["fetch", "-q", "chisabot"], { timeout: 10 * 60_000 });
    if (f.code !== 0 && !/couldn't find remote ref|does not appear to be a git repository/i.test(f.stderr)) log(`git fetch：${f.stderr.trim().slice(-200)}`);
    const cloud = await api("POST", "/git", { workspaceId, op: "info" });
    const done = (result, extra = {}) => {
      b.git = { branch: local.branch, head: local.head, cloudHead: cloud.head, result, at: nowIso(), ...extra };
      if (result !== "diverged") b.gitConflict = null;
      save();
      return result;
    };
    if (cloud.head === local.head && cloud.branch === local.branch) return done("same");
    if (cloud.head) {
      const haveCloud = (await git(dir, ["cat-file", "-e", `${cloud.head}^{commit}`])).code === 0;
      if (haveCloud && (await git(dir, ["merge-base", "--is-ancestor", local.head, cloud.head])).code === 0 && local.head !== cloud.head) {
        // 电脑落后：快进（只动分支和 index，工作区文件由 Mutagen 管）
        const r = await git(dir, ["reset", "-q", "--mixed", cloud.head]);
        return done(r.code === 0 ? "pulled" : "error", { head: cloud.head });
      }
    }
    const p = await git(dir, ["push", "-q", "chisabot", `+${local.head}:refs/remotes/pc/${local.branch}`], { timeout: 15 * 60_000 });
    if (p.code !== 0) {
      log(`git push：${p.stderr.trim().slice(-200)}`);
      return done("error", { error: p.stderr.trim().slice(-200) });
    }
    const a = await api("POST", "/git", { workspaceId, op: "adopt", branch: local.branch, sha: local.head });
    if (a.result === "diverged") {
      b.gitConflict = "Git 提交历史分叉了：云端和电脑上各有新的提交";
      done("diverged");
      await report(workspaceId, "conflict", b.gitConflict, [{ path: `.git（${local.branch}）`, kind: "git" }]);
      return "diverged";
    }
    if (a.result === "cloud_ahead") {
      // 云端在别的分支上更新（比如合入了会话）：拉一次再快进
      await git(dir, ["fetch", "-q", "chisabot"]);
      if ((await git(dir, ["merge-base", "--is-ancestor", local.head, a.head])).code === 0) {
        await git(dir, ["reset", "-q", "--mixed", a.head]);
        return done("pulled", { head: a.head });
      }
    }
    return done(a.result || "pushed");
  }

  // ── 冲突（图 4 右） ──────────────────────────────────────────────────
  function safeLocal(b, rel) {
    const clean = String(rel || "").replace(/\\/g, "/");
    if (!clean || clean.startsWith("/") || clean.split("/").some((p) => p === ".." || p === "" || p === ".git")) throw new Error("文件路径不对");
    const abs = path.resolve(b.path, ...clean.split("/"));
    if (!abs.startsWith(path.resolve(b.path) + path.sep)) throw new Error("文件路径不对");
    return { clean, abs };
  }
  async function resolve({ workspaceId, path: rel, choice }) {
    need();
    const b = binding(workspaceId);
    if (!b || !b.enabled) throw new Error("这个工作区没有在这台电脑上开着同步");
    return await withBusy(workspaceId, "处理冲突", async () => {
      if (choice === "git_cloud" || choice === "git_retry") return await resolveGit(workspaceId, choice);
      if (choice === "handoff_retry") {
        // 交接未确认：重新对比（交还 → 再开启；两边都改过的文件进冲突对话框，不会被覆盖）
        removeJournal(workspaceId);
        b.unconfirmed = false;
        save();
        await api("POST", "/release", { workspaceId }).catch(() => {});
        await bindAndSession(workspaceId, b.path, {}, () => {});
        await mutagen.flush(workspaceId);
        return { state: await afterFlush(workspaceId) };
      }
      const { clean, abs } = safeLocal(b, rel);
      if (choice === "cloud") {
        // 用云端：电脑这份挪进本机备份（不删），Mutagen 把云端那份带下来
        if (fs.existsSync(abs)) {
          const dest = path.join(backupDir, workspaceId, nowIso().replace(/[:.]/g, "-"), ...clean.split("/"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(abs, dest);
        }
      } else if (choice === "both") {
        if (fs.existsSync(abs)) fs.renameSync(abs, pcCopyName(abs));
      } else if (choice !== "pc") throw new Error("选项不对");
      await api("POST", "/resolve", { workspaceId, path: clean, choice });
      audit({ operation: "sync_conflict", summary: `冲突「${clean}」→ ${choice === "cloud" ? "用云端" : choice === "pc" ? "用电脑" : "两份都留"}`, outcome: "succeeded" });
      await mutagen.flush(workspaceId, 120_000).catch(() => {});
      const s = await mutagen.get(workspaceId);
      const left = conflictList(s);
      if (!left.length && !b.gitConflict) await report(workspaceId, "pc_active", "冲突已处理");
      else if (left.length) await report(workspaceId, "conflict", `${left.length} 个文件两边都改过`, left);
      return { left: left.length };
    });
  }
  async function resolveGit(workspaceId, choice) {
    const b = binding(workspaceId);
    const dir = b.path;
    if (choice === "git_cloud") {
      const cloud = await api("POST", "/git", { workspaceId, op: "info" });
      if (!cloud.head) throw new Error("云端还没有提交");
      await git(dir, ["fetch", "-q", "chisabot"]);
      const local = await localGit(dir);
      const stamp = nowIso().replace(/[-:]/g, "").replace(/\..*/, "");
      if (local.head) await git(dir, ["branch", "-f", `chisabot/backup/${stamp}`, local.head]);
      const r = await git(dir, ["reset", "-q", "--mixed", cloud.head]);
      if (r.code !== 0) throw new Error(`以云端为准失败：${r.stderr.trim().slice(-200)}`);
      await api("POST", "/resolve", { workspaceId, path: ".git", choice }).catch(() => {});
      audit({ operation: "sync_conflict", summary: `Git 分叉 → 以云端为准（电脑上的提交备份在 chisabot/backup/${stamp}）`, outcome: "succeeded" });
    }
    b.gitConflict = null;
    save();
    const g = await gitSync(workspaceId);
    if (g !== "diverged") await report(workspaceId, "pc_active", "Git 已对齐");
    return { git: g };
  }

  // ── 交接（§4.3） ─────────────────────────────────────────────────────
  function journalFile(ws) {
    return path.join(journalDir, `${ws}.json`);
  }
  function writeJournal(ws, data) {
    fs.mkdirSync(journalDir, { recursive: true });
    const tmp = `${journalFile(ws)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, at: nowIso() }));
    fs.renameSync(tmp, journalFile(ws));
  }
  function removeJournal(ws) {
    try {
      fs.rmSync(journalFile(ws), { force: true });
    } catch {}
  }

  async function onBegin({ workspaceId, handoffId }) {
    const b = binding(workspaceId);
    if (!b || !b.enabled || !started) {
      await api("POST", "/handoff", { workspaceId, handoffId, step: "failed", detail: "这台电脑没开着这个工作区的同步" }).catch(() => {});
      return;
    }
    handoffs.set(workspaceId, handoffId);
    changed();
    try {
      writeJournal(workspaceId, { handoffId, step: "begin" });
      // ② 先把电脑上的改动推上去，同步 Git，再暂停
      await mutagen.resume(workspaceId).catch(() => {});
      await mutagen.flush(workspaceId, 60_000);
      const s = await mutagen.get(workspaceId);
      if (conflictList(s).length) throw new Error("同步里还有没处理的冲突");
      const g = await gitSync(workspaceId).catch(() => "error");
      if (g === "diverged") throw new Error("Git 提交历史分叉了");
      await mutagen.pause(workspaceId);
      writeJournal(workspaceId, { handoffId, step: "paused" });
      await api("POST", "/handoff", { workspaceId, handoffId, step: "ready" });
      audit({ operation: "sync_handoff", summary: `云端要写入工作目录「${b.name}」：已暂停同步（交接 ${handoffId.slice(0, 9)}）`, outcome: "started" });
    } catch (e) {
      log(`交接失败：${e.message}`);
      removeJournal(workspaceId);
      handoffs.delete(workspaceId);
      await mutagen.resume(workspaceId).catch(() => {});
      await api("POST", "/handoff", { workspaceId, handoffId, step: "failed", detail: e.message }).catch(() => {});
      changed();
    }
  }
  async function onEnd({ workspaceId, handoffId, changed: wrote }) {
    try {
      // ④ 恢复同步，云端写了东西就拉回来
      await mutagen.resume(workspaceId).catch(() => {});
      if (wrote) {
        await mutagen.flush(workspaceId, 120_000).catch(() => {});
        await gitSync(workspaceId).catch(() => {});
      }
      // ⑤
      removeJournal(workspaceId);
      await api("POST", "/handoff", { workspaceId, handoffId, step: "released" });
      audit({ operation: "sync_handoff", summary: `交接完成，同步已恢复${wrote ? "（云端的改动已拉回）" : ""}`, outcome: "succeeded" });
    } finally {
      handoffs.delete(workspaceId);
      changed();
    }
  }
  async function onCancel({ workspaceId }) {
    removeJournal(workspaceId);
    handoffs.delete(workspaceId);
    await mutagen.resume(workspaceId).catch(() => {});
    changed();
  }
  /** 重启后：拿交接记录去服务器对（§4.3）。读不懂的记录也送去对（交接号对不上 = 冲突 · 交接未确认）。 */
  async function recoverJournals() {
    let files = [];
    try {
      files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".json"));
    } catch {}
    for (const f of files) {
      const ws = f.slice(0, -5);
      if (!ID.test(ws)) continue;
      const b = binding(ws);
      let handoffId = "unreadable";
      try {
        handoffId = JSON.parse(fs.readFileSync(path.join(journalDir, f), "utf8")).handoffId || "unreadable";
      } catch {}
      if (!ID.test(handoffId)) handoffId = "unreadable";
      // 记录还在：Mutagen 保持暂停，等服务器说可以
      await mutagen.pause(ws).catch(() => {});
      handoffs.set(ws, handoffId);
      let r = null;
      for (let i = 0; i < 40; i++) {
        r = await api("POST", "/handoff", { workspaceId: ws, handoffId, step: "recover" }).catch((e) => ({ action: e.status === 409 ? "gone" : "error", error: e.message }));
        if (r.action !== "wait") break;
        await sleep(3000);
      }
      handoffs.delete(ws);
      if (r && r.action === "resume") {
        removeJournal(ws);
        await mutagen.resume(ws).catch(() => {});
        await mutagen.flush(ws, 120_000).catch(() => {});
        if (b) await gitSync(ws).catch(() => {});
        audit({ operation: "sync_handoff", summary: "重启后按交接记录恢复了同步", outcome: "succeeded" });
      } else if (r && r.action === "gone") {
        // 服务器那边这台电脑已经不同步了（强制收回 / 交还）：记录作废，保持暂停
        removeJournal(ws);
        if (b) {
          b.enabled = false;
          save();
        }
      } else if (b) {
        // 对不上：不算放行，保持暂停，等你在冲突对话框里处理
        b.unconfirmed = true;
        save();
        audit({ operation: "sync_handoff", summary: "交接未确认：同步保持暂停", outcome: "failed" });
      }
    }
  }

  /** 云端对话启动前请求增量 flush：把刚在编辑器保存的文件尽快推上云端 work/，不暂停同步。 */
  async function onFlush({ workspaceId, flushId }) {
    const b = binding(workspaceId);
    if (!b || !b.enabled || !started || handoffs.has(workspaceId)) {
      await api("POST", "/flush", { workspaceId, flushId, ok: false }).catch(() => {});
      return;
    }
    let ok = true;
    try {
      await mutagen.resume(workspaceId).catch(() => {});
      await mutagen.flush(workspaceId, 6_000);
      if (!busy.has(workspaceId) && b.lastState && b.lastState !== "pc_active") {
        await afterFlush(workspaceId).catch(() => {});
      } else if (!b.gitConflict) {
        await gitSync(workspaceId).catch(() => {});
      }
    } catch (e) {
      ok = false;
      log(`回合前增量 flush 未在时限内完成（后台继续）：${e.message}`);
    }
    await api("POST", "/flush", { workspaceId, flushId, ok }).catch(() => {});
  }

  /** 设备 WSS 上服务器发来的同步消息（core.js 的 onExtra）。 */
  function onServerMessage(message) {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "sync_forget") {
      // 工作区在网页上删了（§87）：服务器确认后放下本机记录（对账，不光凭这一条消息）
      if (!ID.test(String(message.workspaceId || ""))) return false;
      if (started) void reconcileGone([String(message.workspaceId)]).catch((e) => log(`对账失败：${e.message}`));
      return true;
    }
    if (message.type === "sync_flush") {
      if (!ID.test(String(message.workspaceId || "")) || !ID.test(String(message.flushId || ""))) return false;
      void onFlush(message);
      return true;
    }
    if (!ID.test(String(message.workspaceId || "")) || !ID.test(String(message.handoffId || ""))) return false;
    if (message.type === "sync_begin") void onBegin(message);
    else if (message.type === "sync_end") void onEnd(message);
    else if (message.type === "sync_cancel") void onCancel(message);
    else return false;
    return true;
  }

  /** 撤销 / 紧急停止：全部暂停（不删任何东西）。 */
  async function pauseAll(why) {
    for (const b of Object.values(state.bindings)) if (b.enabled) await mutagen.pause(b.workspaceId).catch(() => {});
    log(`同步全部暂停：${why}`);
    changed();
  }

  return {
    start,
    stop,
    status,
    inspect,
    createFromFolder,
    enable,
    release,
    forget,
    syncNow,
    resolve,
    onServerMessage,
    pauseAll,
    events,
    // 测试用
    _internal: { gitSync, tick, binding, state: () => state, writeSshFiles, sshConfig, wrapperDir, childEnv, mutagen, broker, recoverJournals, journalFile, reconcileGone, forgetLocal, explain },
  };
}

module.exports = { createSyncManager, pcCopyName, ignoredRel };
