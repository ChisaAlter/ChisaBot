"use strict";
/**
 * 云端工作区节点上的 Claude Code 运行时（docs/cloud-claude-code.md，ADR-0014）。
 *
 * 只在云端节点容器里打开（环境变量 CHISABOT_CLOUD_WORKSPACE=1，见 deploy/cloud-node/）。和设备节点共用同一条 WebSocket：
 * core 把不认识的消息交给 onExtra，这里认 cc_* 消息，其余交回本地 agent 运行时。
 *
 * 服务器 → 节点
 *   cc_probe                                   问「你是云端工作区吗」→ 回 cc_info
 *   cc_rpc { id, op, args }                    一问一答（登录、状态、目录树、读文件、diff、撤销…）→ cc_rpc_result { id, ok, result | error }
 *   cc_turn { sessionId, turnId, workspaceId, prompt, claudeSessionId, resume, model, effort, rules }
 *   cc_stop { sessionId }
 *   cc_approval_result { approvalId, decision: "approve" | "deny", always }
 *   cc_browser_input { loginId, events }       云端登录浏览器的点击 / 键盘（不记录）
 *   「在云端完成登录」「Claude 上游代理」走 cc_rpc：browser_start / browser_stop / proxy_set / proxy_test / egress
 *   proxy_set / proxy_test 带 outbound（节点链接解析出的 sing-box 出站，DESIGN §85）时，在容器里起 sing-box（singbox.js），
 *   本机转发器把它当 socks5 上游。
 *   GitHub 工作区（P3，git.js）走 cc_rpc：ws_clone / ws_merge / ws_push / ws_push_preview / ws_base_diff / ws_delete / ws_drop_tree；
 *   cc_turn 带 git: { branch } 时，会话目录是工作区 work/ 的一个工作树（分支 cc/…）。
 * 节点 → 服务器
 *   cc_info { version, claudeVersion, root }
 *   cc_event { sessionId, turnId, seq, event }  （event 见 stream.js，另加 status / approval / approval_done）
 *   cc_done { sessionId, turnId, ok, stopped, error, claudeSessionId, costUsd, turns, changes }
 *   cc_approval_request { sessionId, turnId, approvalId, tool, summary, input, rule }
 *   cc_browser_frame { loginId, data, w, h } / cc_browser_state { loginId, url, egress, closed… } / cc_browser_done { loginId, ok, error, …登录状态 }
 *
 *   电脑文件夹同步（P4，sync.js）：sync_tunnel_open { tunnelId } / sync_tunnel_close；cc_rpc sync_keys_set / sync_host_key /
 *   sync_lease / sync_lease_get / ws_init_local / ws_manifest。ws_merge 先过租约（电脑正在用 work/ 时拒绝）。
 *
 * 授权码、令牌：只经过登录进程的标准输入，不写日志、不回传。
 */
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { parseLine, slimInput } = require("./stream");
const { decide } = require("./policy");
const { createForwarder, parseProxy, maskProxy, scrubProxy, httpsGet, traceIp, testRoute } = require("./proxy");
const { createSingBox, singBoxVersion, cleanOutbound, scrub: scrubSecrets } = require("./singbox");
const { createRemoteBrowser, findChromium } = require("./browser");
const { createGitWorkspaces } = require("./git");
const { createSyncNode } = require("./sync");

const HANDLED = new Set(["cc_probe", "cc_rpc", "cc_turn", "cc_stop", "cc_approval_result", "cc_browser_input", "sync_tunnel_open", "sync_tunnel_close"]);
const TRACE_URL = process.env.CHISABOT_EGRESS_TRACE_URL || "https://claude.ai/cdn-cgi/trace";
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const APPROVAL_MS = 125_000;
const LOGIN_MS = 10 * 60_000;
/** 退出：`claude auth logout` 最多等这么久（卡住就直接结束进程），之后每次 `auth status` 各有自己的预算。
 *  最坏 8 + 10 + 8 + 8 = 34 秒（服务器 38 秒、网页 45 秒的预算之内）。 */
const LOGOUT_MS = 10_000;
const LOGOUT_STATUS_MS = 8_000;
/** 节点程序自更新（容器里）：同一个新版指纹至少隔这么久才再试，任何自动重启一小时最多一次。
 *  下载失败时入口脚本会继续用旧文件，没有这两道闸就会「重启 → 还是旧的 → 又重启」地循环。 */
const SELF_UPDATE_RETRY_MS = 15 * 60_000;
const SELF_UPDATE_COOLDOWN_MS = 60 * 60_000;
/** 自动重启前的缓冲：先把 cc_info 等消息发出去，再让容器重启。 */
const SELF_UPDATE_DELAY_MS = 1500;
const FILE_CAP = 1024 * 1024;
const PATCH_CAP = 400 * 1024;
const SNAP_EXCLUDE = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".next/", ".cache/", "dist/", "build/", "coverage/", ".git"].join("\n");

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: options.timeout || 60_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

function lines(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, i).replace(/\r$/, ""));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length > 4_000_000) buffer = "";
    },
    end() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

/** 登录输出里的授权地址。 */
function findUrl(text) {
  // 只认 https；CHISABOT_CC_ALLOW_HTTP_AUTH=1 只给 e2e 的模拟授权页用
  const scheme = process.env.CHISABOT_CC_ALLOW_HTTP_AUTH === "1" ? "https?" : "https";
  const m = new RegExp(`(${scheme}:\\/\\/[^\\s"'<>]+oauth[^\\s"'<>]*)`, "i").exec(text) || new RegExp(`visit:\\s*(${scheme}:\\/\\/\\S+)`, "i").exec(text);
  return m ? m[1] : null;
}

function parseStatus(stdout) {
  try {
    const j = JSON.parse(stdout);
    const email = j.email || (j.account && j.account.email) || j.emailAddress || null;
    const plan = j.subscriptionType || j.plan || (j.account && j.account.subscriptionType) || null;
    // configDirectory：退出时 CLI 没删掉凭据的话，节点照着这个目录自己删（见 clearCredentials）
    return { loggedIn: !!j.loggedIn, method: j.authMethod || null, email, plan: plan ? String(plan) : null, org: j.orgName || null, configDirectory: typeof j.configDirectory === "string" ? j.configDirectory : null };
  } catch {
    return { loggedIn: false, method: null, email: null, plan: null, org: null, configDirectory: null, error: "读不懂 claude auth status 的输出" };
  }
}

/**
 * 正在跑的节点程序文件（`chisabot-node.cjs`）的 sha256。服务器拿它和「现在发给节点的程序」比，
 * 判断节点是不是当前版本：云端节点只在容器启动时下载一次，改过 pc/src/cloud-cc 又不重启容器，
 * 进程就一直在跑旧代码（2026-10-22「退出 Claude 无效」就是这样：服务器和网页都是新的，节点还是旧的）。
 */
function scriptHash(file = process.argv[1]) {
  try {
    if (!file) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * @param {{ send: (m: object) => boolean, log?: (s: string) => void, root?: string, claude?: string, hookCommand?: string[], serverUrl?: string, getToken?: () => string, exit?: (code: number) => void }} options
 */
function createCloudCc(options) {
  const log = options.log || (() => {});
  const root = path.resolve(options.root || process.env.CHISABOT_CC_ROOT || path.join(os.homedir(), "cc-workspace"));
  const claude = options.claude || process.env.CHISABOT_CLAUDE_BIN || "claude";
  const hookCommand = options.hookCommand || [process.execPath, path.resolve(process.argv[1] || "chisabot-node.cjs"), "cc-hook"];
  const turns = new Map(); // turnId -> ctx
  const bySession = new Map(); // sessionId -> turnId
  const approvals = new Map(); // approvalId -> { resolve, timer, ctx }
  const outbox = [];
  let login = null; // { id, child, output, timer, done }
  let hookServer = null;
  let sockPath = null;
  // 「Claude 上游代理」：本机转发器（只听容器的 127.0.0.1），上游地址只在内存里
  const forwarder = createForwarder({ log });
  // 节点链接（trojan / vless / vmess / ss / hysteria2 / tuic）：sing-box 子进程，本机 socks5 入站给转发器当上游
  // 换节点时先起新的、起好了再停旧的：新节点起不来，旧的照常用
  let singbox = null;
  let singboxVersion;
  const singboxVer = async () => (singboxVersion === undefined ? (singboxVersion = await singBoxVersion()) : singboxVersion);
  let remote = null; // { loginId, browser }
  /** 设了上游代理时给 claude 进程的环境变量（指向本机转发器，里面没有密码）。 */
  function proxyEnv() {
    if (!forwarder.upstream() || !forwarder.port) return {};
    const url = `http://127.0.0.1:${forwarder.port}`;
    return { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
  }
  const gitWs = createGitWorkspaces({ root, log });
  // 电脑文件夹同步（P4，sync.js）：隧道、公钥、租约
  const syncNode = createSyncNode({ root, log, serverUrl: options.serverUrl, getToken: options.getToken });

  // ---------- 节点程序自更新 ----------
  /** 进程退出（测试可换掉，否则一自更新整个测试进程就没了）。 */
  const exit = options.exit || ((code) => process.exit(code));
  /** 自己在跑的文件指纹；服务器下发的指纹对不上就是要重启换程序。 */
  const script = scriptHash();
  let expectedScript = null;
  /** 自动重启的闸门写在节点目录里：容器重启后还记得「这个版本刚试过」，下载失败时不至于来回重启。 */
  function selfUpdateFile() {
    const dir = process.env.CHISABOT_NODE_DIR || path.join(process.env.HOME || os.homedir(), ".chisabot-node");
    return path.join(dir, "self-update.json");
  }
  function lastAttempt() {
    try {
      const j = JSON.parse(fs.readFileSync(selfUpdateFile(), "utf8"));
      return { script: String(j.script || ""), at: Number(j.at) || 0 };
    } catch {
      return null;
    }
  }
  function noteAttempt(sha) {
    try {
      fs.mkdirSync(path.dirname(selfUpdateFile()), { recursive: true });
      fs.writeFileSync(selfUpdateFile(), JSON.stringify({ script: sha, at: Date.now() }));
    } catch (error) {
      log(`记下自动更新失败：${error.message}`);
    }
  }
  /** 能不能现在重启：没有会话、没有登录流程、没有云端登录浏览器。 */
  function idle() {
    return turns.size === 0 && !login && !remote;
  }
  /**
   * 节点程序过期时自己退出，让容器按 restart 策略重新起来、入口脚本顺手把最新的程序下载下来——
   * 不用等人想起来 `docker restart`。只在云端节点镜像里做（CHISABOT_CLOUD_WORKSPACE=1）：
   * 普通服务器节点由 systemd `Restart=on-failure` 管，干净退出不会被拉起，绝不能这么做。
   */
  function maybeSelfUpdate() {
    if (process.env.CHISABOT_CLOUD_WORKSPACE !== "1") return;
    if (!script || !expectedScript || expectedScript === script) return;
    if (!idle()) return;
    const last = lastAttempt();
    if (last) {
      const same = last.script === expectedScript;
      if (Date.now() - last.at < (same ? SELF_UPDATE_RETRY_MS : SELF_UPDATE_COOLDOWN_MS)) return;
    }
    noteAttempt(expectedScript);
    log(`节点程序有新版本（${script.slice(0, 8)} → ${expectedScript.slice(0, 8)}）：空闲，重启以更新（容器会自动起来并下载新程序）`);
    // 这 1.5 秒里可能刚好来了一轮：再看一眼，忙就等下一次探测（尝试记录照留，15 分钟内不会再试）。
    setTimeout(() => {
      if (idle()) exit(0);
    }, SELF_UPDATE_DELAY_MS).unref?.();
  }

  function out(message) {
    if (options.send(message)) return;
    outbox.push(message);
    if (outbox.length > 4000) outbox.shift();
  }
  function flush() {
    while (outbox.length) {
      if (!options.send(outbox[0])) return;
      outbox.shift();
    }
  }

  // ---------- 路径 ----------
  function wsDir(workspaceId) {
    if (!ID.test(String(workspaceId))) throw new Error("工作区 id 不对");
    return path.join(root, "projects", workspaceId);
  }
  function treeDir(workspaceId, sessionId) {
    if (!ID.test(String(sessionId))) throw new Error("会话 id 不对");
    return path.join(wsDir(workspaceId), "trees", sessionId);
  }
  function snapDir(workspaceId, sessionId) {
    return path.join(wsDir(workspaceId), ".chisabot", "snap", `${sessionId}.git`);
  }
  function turnsFile(workspaceId, sessionId) {
    return path.join(wsDir(workspaceId), ".chisabot", "turns", `${sessionId}.json`);
  }
  function readTurns(workspaceId, sessionId) {
    try {
      return JSON.parse(fs.readFileSync(turnsFile(workspaceId, sessionId), "utf8"));
    } catch {
      return [];
    }
  }
  function writeTurns(workspaceId, sessionId, list) {
    const file = turnsFile(workspaceId, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(list.slice(-60)));
    fs.renameSync(`${file}.tmp`, file);
  }
  /** 用户给的相对路径 → 会话目录里的绝对路径（不许跳出去）。 */
  function within(base, rel) {
    const target = path.resolve(base, String(rel || "").replace(/^\/+/, ""));
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error("路径不在会话目录里");
    return target;
  }

  // ---------- 快照（独立 GIT_DIR，不碰工作区自己的 .git） ----------
  function git(workspaceId, sessionId, args, extra = {}) {
    const env = {
      ...process.env,
      GIT_DIR: snapDir(workspaceId, sessionId),
      GIT_WORK_TREE: treeDir(workspaceId, sessionId),
      GIT_AUTHOR_NAME: "chisabot",
      GIT_AUTHOR_EMAIL: "chisabot@localhost",
      GIT_COMMITTER_NAME: "chisabot",
      GIT_COMMITTER_EMAIL: "chisabot@localhost",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    return run("git", ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], { cwd: treeDir(workspaceId, sessionId), env, ...extra });
  }
  async function ensureTree(workspaceId, sessionId, branch) {
    const tree = treeDir(workspaceId, sessionId);
    // GitHub 工作区：会话目录是 work/ 的工作树，分支 cc/…（第一次用时从工作目录当前的提交切出来）
    if (gitWs.isGitWorkspace(workspaceId)) await gitWs.ensureTree(workspaceId, sessionId, branch);
    fs.mkdirSync(tree, { recursive: true });
    const snap = snapDir(workspaceId, sessionId);
    if (!fs.existsSync(path.join(snap, "HEAD"))) {
      fs.mkdirSync(path.dirname(snap), { recursive: true });
      await run("git", ["init", "-q", "--bare", snap]);
      fs.mkdirSync(path.join(snap, "info"), { recursive: true });
      fs.writeFileSync(path.join(snap, "info", "exclude"), SNAP_EXCLUDE + "\n");
    }
    return tree;
  }
  async function snapshot(workspaceId, sessionId, label) {
    await git(workspaceId, sessionId, ["add", "-A", "."]);
    await git(workspaceId, sessionId, ["commit", "-q", "--allow-empty", "--no-verify", "-m", label]);
    const head = await git(workspaceId, sessionId, ["rev-parse", "HEAD"]);
    return head.stdout.trim() || null;
  }
  async function numstat(workspaceId, sessionId, a, b) {
    const r = await git(workspaceId, sessionId, ["diff", "--numstat", "-z", "--no-renames", a, b]);
    const status = await git(workspaceId, sessionId, ["diff", "--name-status", "-z", "--no-renames", a, b]);
    const kinds = new Map();
    const st = status.stdout.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < st.length; i += 2) kinds.set(st[i + 1], st[i]);
    const files = [];
    for (const rec of r.stdout.split("\0").filter(Boolean)) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      if (!m) continue;
      files.push({ path: m[3], add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]), status: kinds.get(m[3]) || "M" });
    }
    return files.slice(0, 500);
  }

  // ---------- 钩子服务器（PreToolUse） ----------
  function ensureHookServer() {
    if (hookServer) return Promise.resolve(sockPath);
    sockPath = path.join(os.tmpdir(), `chisabot-cc-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);
    return new Promise((resolve, reject) => {
      hookServer = net.createServer((socket) => {
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buf += chunk;
          if (buf.length > 2_000_000) socket.destroy();
          const i = buf.indexOf("\n");
          if (i < 0) return;
          let q;
          try {
            q = JSON.parse(buf.slice(0, i));
          } catch {
            socket.end(JSON.stringify({ decision: "deny", reason: "钩子请求格式不对" }) + "\n");
            return;
          }
          onHook(q)
            .then((answer) => socket.end(JSON.stringify(answer) + "\n"))
            .catch((error) => socket.end(JSON.stringify({ decision: "deny", reason: `权限检查失败：${error.message}` }) + "\n"));
        });
        socket.on("error", () => {});
      });
      hookServer.on("error", reject);
      hookServer.listen(sockPath, () => {
        try {
          fs.chmodSync(sockPath, 0o600);
        } catch {}
        resolve(sockPath);
      });
    });
  }

  async function onHook(q) {
    const ctx = turns.get(String(q.turnId || ""));
    if (!ctx || ctx.finished) return { decision: "deny", reason: "这一轮已经结束" };
    const verdict = decide({ tool: q.tool, input: q.input, root: ctx.tree, cwd: q.cwd || ctx.tree, rules: ctx.rules });
    if (verdict.decision !== "ask") {
      if (verdict.decision === "deny") emit(ctx, { kind: "denied", tool: q.tool, reason: verdict.reason, input: slimInput(q.input) });
      return verdict;
    }
    const approvalId = crypto.randomUUID();
    const summary = verdict.reason;
    out({ type: "cc_approval_request", sessionId: ctx.sessionId, turnId: ctx.turnId, approvalId, tool: q.tool, summary, input: slimInput(q.input), rule: verdict.rule || null });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(approvalId);
        resolve({ decision: "deny", always: false, expired: true });
      }, APPROVAL_MS);
      approvals.set(approvalId, { resolve, timer, ctx });
      ctx.waiting.add(approvalId);
    });
    ctx.waiting.delete(approvalId);
    if (answer.decision === "approve") {
      if (answer.always && verdict.rule) ctx.rules.push(verdict.rule);
      return { decision: "allow", reason: "你在 ChisaBot 里允许了" };
    }
    return { decision: "deny", reason: answer.expired ? "2 分钟没有人批准，已拒绝。换个不需要这一步的办法。" : answer.stopped ? "这一轮已停止。" : "用户拒绝了这一步。换个办法，或者先问问用户。" };
  }

  // ---------- 一轮对话 ----------
  function emit(ctx, event) {
    ctx.seq += 1;
    out({ type: "cc_event", sessionId: ctx.sessionId, turnId: ctx.turnId, seq: ctx.seq, event });
  }

  async function startTurn(m) {
    const sessionId = String(m.sessionId || "");
    const turnId = String(m.turnId || "");
    if (!ID.test(sessionId) || !ID.test(turnId) || !ID.test(String(m.workspaceId || ""))) {
      out({ type: "cc_done", sessionId, turnId, ok: false, error: "参数不对" });
      return;
    }
    if (bySession.has(sessionId)) {
      out({ type: "cc_done", sessionId, turnId, ok: false, error: "这个会话上一轮还没结束" });
      return;
    }
    const ctx = { sessionId, turnId, workspaceId: m.workspaceId, tree: "", rules: Array.isArray(m.rules) ? m.rules.slice(0, 200) : [], seq: 0, child: null, stopped: false, finished: false, waiting: new Set(), result: null, claudeSessionId: m.claudeSessionId || null, stderr: [] };
    turns.set(turnId, ctx);
    bySession.set(sessionId, turnId);
    let before = null;
    try {
      ctx.tree = await ensureTree(m.workspaceId, sessionId, m.git && m.git.branch);
      const syncInfo = gitWs.takeSyncResult ? gitWs.takeSyncResult(m.workspaceId, sessionId) : null;
      before = await snapshot(m.workspaceId, sessionId, `before ${turnId}`);
      if (syncInfo && syncInfo.conflicts && syncInfo.conflicts.length) {
        emit(ctx, {
          kind: "notice",
          text: `主工作目录也改了 ${syncInfo.conflicts.slice(0, 8).join("、")}${syncInfo.conflicts.length > 8 ? ` 等 ${syncInfo.conflicts.length} 个文件` : ""}，与本会话已有改动同处冲突，会话目录保留了 Claude 当前版本（未覆盖）。`,
        });
      }
      const sock = await ensureHookServer();
      const settingsFile = path.join(os.tmpdir(), `chisabot-cc-settings-${turnId}.json`);
      const hook = hookCommand.map((p) => (/[\s"'$]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p)).join(" ");
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: Math.ceil(APPROVAL_MS / 1000) + 30 }] }] } }),
        { mode: 0o600 },
      );
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "default", "--settings", settingsFile];
      if (ctx.claudeSessionId && m.resume) args.push("--resume", ctx.claudeSessionId);
      else if (ctx.claudeSessionId) args.push("--session-id", ctx.claudeSessionId);
      if (m.model) args.push("--model", String(m.model));
      if (m.effort) args.push("--effort", String(m.effort));
      emit(ctx, { kind: "status", text: "Claude Code 启动中" });
      const env = {
        HOME: process.env.HOME || os.homedir(),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG || "C.UTF-8",
        TERM: "dumb",
        TMPDIR: os.tmpdir(),
        DISABLE_AUTOUPDATER: "1",
        CHISABOT_CC_SOCK: sock,
        CHISABOT_CC_TURN: turnId,
        ...proxyEnv(),
        ...(process.env.CHISABOT_CC_EXTRA_ENV ? JSON.parse(process.env.CHISABOT_CC_EXTRA_ENV) : {}),
      };
      const exit = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(claude, args, { cwd: ctx.tree, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
          resolve({ code: -1, error });
          return;
        }
        ctx.child = child;
        const so = lines((line) => {
          for (const event of parseLine(line)) {
            if (event.kind === "init") {
              ctx.sawInit = true;
              if (event.sessionId) ctx.claudeSessionId = event.sessionId;
            }
            if (event.kind === "result") {
              ctx.result = event;
              if (event.sessionId) ctx.claudeSessionId = event.sessionId;
            }
            emit(ctx, event);
          }
        });
        const se = lines((line) => {
          if (ctx.stderr.length < 200 && line.trim()) ctx.stderr.push(line.slice(0, 500));
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c) => so.push(c));
        child.stderr.on("data", (c) => se.push(c));
        child.on("error", (error) => resolve({ code: -1, error }));
        child.on("close", (code) => {
          so.end();
          se.end();
          resolve({ code });
        });
        child.stdin.on("error", () => {});
        const conflictHint =
          syncInfo && syncInfo.conflicts && syncInfo.conflicts.length
            ? `\n\n[系统提示：主工作目录近期也修改了 ${syncInfo.conflicts.slice(0, 8).join("、")}，因与本会话未合入改动同处冲突，本会话工作树保留了你的版本而未自动覆盖。若需修改这些文件或处理冲突，请先读取 ../../work/ 下对应的文件，将主工作目录的修改与当前会话的修改合并到当前目录中。]`
            : "";
        child.stdin.end(String(m.prompt || "") + conflictHint);
      });
      try {
        fs.unlinkSync(settingsFile);
      } catch {}
      ctx.finished = true;
      for (const id of [...ctx.waiting]) {
        const a = approvals.get(id);
        if (a) {
          clearTimeout(a.timer);
          approvals.delete(id);
          a.resolve({ decision: "deny", stopped: true });
        }
      }
      const after = await snapshot(m.workspaceId, sessionId, `after ${turnId}`);
      const changes = before && after ? await numstat(m.workspaceId, sessionId, before, after) : [];
      const list = readTurns(m.workspaceId, sessionId);
      list.push({ turnId, before, after, at: new Date().toISOString(), files: changes.length });
      writeTurns(m.workspaceId, sessionId, list);
      const ok = !ctx.stopped && !!ctx.result && ctx.result.ok;
      let error = null;
      if (!ok && !ctx.stopped) {
        if (exit.error && exit.error.code === "ENOENT") error = "云端节点上没有找到 claude 命令。";
        else if (ctx.result && ctx.result.error) error = ctx.result.error;
        else {
          const tail = ctx.stderr.join("\n");
          error = /not logged in|login|unauthor|401|invalid api key|OAuth/i.test(tail) ? "Claude 账号没有登录或登录已失效：去 设置 → 云端工作区 重新登录。" : `Claude Code 退出（${exit.code}）${tail ? `：${tail.slice(-600)}` : ""}`;
        }
      }
      out({
        type: "cc_done",
        sessionId,
        turnId,
        ok,
        stopped: ctx.stopped,
        error,
        claudeSessionId: ctx.claudeSessionId,
        resumable: !!ctx.sawInit,
        costUsd: ctx.result ? ctx.result.costUsd : null,
        turns: ctx.result ? ctx.result.turns : null,
        changes,
      });
    } catch (error) {
      ctx.finished = true;
      out({ type: "cc_done", sessionId, turnId, ok: false, stopped: ctx.stopped, error: `云端节点出错：${error.message}`, claudeSessionId: ctx.claudeSessionId, changes: [] });
    } finally {
      turns.delete(turnId);
      if (bySession.get(sessionId) === turnId) bySession.delete(sessionId);
    }
  }

  function stopSession(sessionId) {
    const turnId = bySession.get(String(sessionId || ""));
    const ctx = turnId ? turns.get(turnId) : null;
    if (!ctx) return false;
    ctx.stopped = true;
    for (const id of [...ctx.waiting]) {
      const a = approvals.get(id);
      if (a) {
        clearTimeout(a.timer);
        approvals.delete(id);
        a.resolve({ decision: "deny", stopped: true });
      }
    }
    killTree(ctx.child);
    return true;
  }

  // ---------- 登录 ----------
  async function authStatus(timeoutMs = 20_000) {
    const r = await run(claude, ["auth", "status", "--json"], { timeout: timeoutMs, env: { ...process.env, TERM: "dumb", ...proxyEnv() } });
    if (r.error && r.error.code === "ENOENT") return { loggedIn: false, configDirectory: null, error: "云端节点上没有找到 claude 命令" };
    return parseStatus(r.stdout);
  }
  /** claude 认的凭据文件：优先用它自己报告的 configDirectory，其次 $HOME/.claude（容器里就是这两处）。 */
  function credentialFiles(status) {
    const home = process.env.HOME || os.homedir();
    const dirs = new Set([path.join(home, ".claude")]);
    if (status && typeof status.configDirectory === "string" && status.configDirectory) dirs.add(status.configDirectory);
    if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR);
    return [...dirs].map((dir) => path.join(dir, ".credentials.json"));
  }
  /** 直接删掉凭据文件（`claude auth logout` 做的就是这件事）。返回真正删掉的路径。 */
  function clearCredentials(status) {
    const removed = [];
    for (const file of credentialFiles(status)) {
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
          removed.push(file);
        }
      } catch (error) {
        log(`删除 Claude 凭据失败（${file}）：${error.message}`);
      }
    }
    return removed;
  }
  /** 一句人话：CLI 为什么没退掉（stdout / stderr 的最后一行 + 退出码 / 超时）。令牌、地址一律抹掉。 */
  function cliNote(r) {
    const text = `${r.stderr || ""}\n${r.stdout || ""}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-1)[0];
    const clean = (text || "没有输出").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[令牌]").replace(/https?:\/\/\S+/g, "[地址]").slice(0, 200);
    const code = r.error && r.error.killed ? "超时被结束" : String(typeof r.code === "number" ? r.code : (r.error && r.error.code) || "?");
    return `${clean}（退出码 ${code}）`;
  }
  /**
   * 退出 Claude（用户报告「退出无效」）。以前只看命令跑完没有，CLI 没真退出（旧版没有 `auth logout`、
   * 网络卡住被超时结束、凭据没删掉）时也回「已退出」，下一次检查又变回「已登录」。
   * 现在以 `auth status` 为准：CLI 没做到就直接删掉它认的凭据文件，再确认一次；还登着才报错。
   */
  async function logoutClaude() {
    // 「没登录」只认一次读得懂的 status：读不懂（CLI 没输出 / 找不到）不当成「本来就没登录」。
    const verified = (s) => !!s && s.loggedIn === false && !s.error;
    const before = await authStatus(LOGOUT_STATUS_MS);
    if (verified(before)) return before;
    const r = await run(claude, ["auth", "logout"], { timeout: LOGOUT_MS, killSignal: "SIGKILL", env: { ...process.env, TERM: "dumb", ...proxyEnv() } });
    let after = await authStatus(LOGOUT_STATUS_MS);
    if (!verified(after)) {
      const removed = clearCredentials(after);
      log(`claude auth logout 没有退出（${cliNote(r)}）${removed.length ? `，已删除凭据 ${removed.join(", ")}` : ""}`);
      if (removed.length) after = await authStatus(LOGOUT_STATUS_MS);
      if (!verified(after)) {
        const reason = removed.length ? (after.error ? `删掉凭据后仍然读不懂登录状态（${after.error}）` : "删掉凭据后它还是登录状态") : "也没有找到凭据文件";
        throw new Error(`Claude 没有退出：${cliNote(r)}，${reason}。可以再试一次，或更新云端节点镜像。`);
      }
    }
    return after;
  }
  function endLogin(reason) {
    if (remote && login && remote.loginId === login.id) void remote.browser.stop(reason);
    if (!login) return;
    clearTimeout(login.timer);
    killTree(login.child);
    log(`登录流程结束：${reason}`);
    login = null;
  }
  function loginStart(args) {
    if (login) endLogin("新的登录流程");
    const id = String(args.id || crypto.randomUUID());
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(claude, ["auth", "login", "--claudeai"], { env: { ...process.env, TERM: "dumb", BROWSER: "/bin/false", ...proxyEnv() }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      const state = { id, child, output: "", url: null, exited: null, timer: null, waiters: [] };
      login = state;
      state.timer = setTimeout(() => {
        if (login === state) endLogin("过期");
      }, LOGIN_MS);
      const onData = (chunk) => {
        state.output = (state.output + chunk).slice(-20000);
        if (!state.url) {
          const url = findUrl(state.output);
          if (url) {
            state.url = url;
            resolve({ id, url, expiresInMs: LOGIN_MS });
          }
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        if (login === state) login = null;
        reject(error.code === "ENOENT" ? new Error("云端节点上没有找到 claude 命令") : error);
      });
      child.on("close", (code) => {
        state.exited = code;
        for (const w of state.waiters) w(code);
        state.waiters = [];
        if (!state.url) reject(new Error("claude 没有给出授权地址"));
      });
      setTimeout(() => {
        if (!state.url && login === state) {
          endLogin("没拿到授权地址");
          reject(new Error("30 秒内没有拿到授权地址"));
        }
      }, 30_000).unref?.();
    });
  }
  async function loginCode(args) {
    const state = login;
    if (!state || state.id !== String(args.id || "")) throw new Error("登录流程已经过期，请重新开始");
    const code = String(args.code || "").trim();
    if (!code || code.length > 4000 || /[\r\n]/.test(code)) throw new Error("授权码格式不对");
    const exited = new Promise((resolve) => {
      if (state.exited !== null) resolve(state.exited);
      else state.waiters.push(resolve);
    });
    state.child.stdin.write(`${code}\n`);
    let raceTimer = null;
    const code2 = await Promise.race([exited, new Promise((r) => (raceTimer = setTimeout(() => r("timeout"), 60_000)))]);
    clearTimeout(raceTimer);
    const tail = state.output.slice(-1500).replace(/https:\/\/\S+/g, "[地址]");
    if (login === state) {
      clearTimeout(state.timer);
      if (code2 === "timeout") killTree(state.child);
      login = null;
    }
    const status = await authStatus();
    if (status.loggedIn) return { ok: true, ...status };
    const reason = code2 === "timeout" ? "Claude 60 秒内没有完成登录" : /invalid|expired|error|fail/i.test(tail) ? "授权码无效或已过期，请重新开始登录" : "登录没有成功";
    return { ok: false, error: reason, ...status };
  }

  // ---------- 文件 / diff / 撤销 ----------
  /** 右栏看哪一份：会话目录（默认）或工作区的工作目录 work/（P3「工作目录」视图）。 */
  function viewBase(args) {
    if (args.ref === "work") {
      if (!ID.test(String(args.workspaceId))) throw new Error("工作区 id 不对");
      return gitWs.workDir(args.workspaceId);
    }
    return treeDir(args.workspaceId, args.sessionId);
  }
  function listDir(args) {
    const base = viewBase(args);
    if (!fs.existsSync(base)) return { entries: [] };
    const dir = within(base, args.path || "");
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .slice(0, 800)
      .map((e) => {
        let size = null;
        try {
          if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size;
        } catch {}
        return { name: e.name, dir: e.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { path: path.relative(base, dir).split(path.sep).join("/"), entries };
  }
  function readFile(args) {
    const base = viewBase(args);
    const file = within(base, args.path || "");
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error("不是文件");
    if (st.size > FILE_CAP) return { path: args.path, size: st.size, tooLarge: true, text: null };
    const buf = fs.readFileSync(file);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: args.path, size: st.size, binary, text: binary ? null : buf.toString("utf8") };
  }
  async function diff(args) {
    const list = readTurns(args.workspaceId, args.sessionId);
    const t = args.turnId ? list.find((x) => x.turnId === args.turnId) : list[list.length - 1];
    if (!t || !t.before || !t.after) return { turnId: args.turnId || null, files: [], patch: "" };
    const files = await numstat(args.workspaceId, args.sessionId, t.before, t.after);
    const p = await git(args.workspaceId, args.sessionId, ["diff", "--no-renames", "--no-color", t.before, t.after]);
    const patch = p.stdout.length > PATCH_CAP ? `${p.stdout.slice(0, PATCH_CAP)}\n…（diff 太长，已截断）` : p.stdout;
    return { turnId: t.turnId, files, patch };
  }
  async function undo(args) {
    if (bySession.has(String(args.sessionId))) throw new Error("这一轮还在进行，先停止");
    const list = readTurns(args.workspaceId, args.sessionId);
    const t = list[list.length - 1];
    if (!t || (args.turnId && t.turnId !== args.turnId)) throw new Error("只能撤销最后一轮");
    if (t.undone) throw new Error("这一轮已经撤销过了");
    const now = await snapshot(args.workspaceId, args.sessionId, `check ${t.turnId}`);
    const since = await numstat(args.workspaceId, args.sessionId, t.after, now);
    if (since.length) throw new Error("这一轮之后目录又被改过，不能自动撤销");
    const added = (await numstat(args.workspaceId, args.sessionId, t.before, t.after)).filter((f) => f.status === "A");
    const r = await git(args.workspaceId, args.sessionId, ["checkout", "-f", t.before, "--", "."]);
    if (r.code !== 0 && !/did not match/.test(r.stderr)) throw new Error(`恢复失败：${r.stderr.slice(0, 300)}`);
    const base = treeDir(args.workspaceId, args.sessionId);
    for (const f of added) {
      try {
        fs.rmSync(within(base, f.path), { force: true });
      } catch {}
    }
    await snapshot(args.workspaceId, args.sessionId, `undo ${t.turnId}`);
    t.undone = true;
    writeTurns(args.workspaceId, args.sessionId, list);
    return { turnId: t.turnId, restored: true };
  }

  // ---------- 在云端完成登录（远程浏览器） ----------
  async function browserStart(args) {
    const id = String(args.id || "");
    if (!login || login.id !== id || !login.url) throw new Error("登录流程已经过期，请重新开始");
    if (remote) await remote.browser.stop("新的登录");
    if (forwarder.upstream()) await forwarder.start();
    const loginId = id;
    let done = false;
    const sendRaw = (m) => options.send(m); // 画面不进 outbox：断线就丢
    const browser = createRemoteBrowser({
      width: args.width,
      height: args.height,
      mobile: !!args.mobile,
      proxyPort: forwarder.upstream() ? forwarder.port : null,
      log,
      onFrame: (f) => sendRaw({ type: "cc_browser_frame", loginId, ...f }),
      onState: (st) => sendRaw({ type: "cc_browser_state", loginId, ...st }),
      onCode: (code) => {
        // 授权码直接交给等着的 `claude auth login`，不经过服务器、不写日志
        void loginCode({ id: loginId, code })
          .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }))
          .then((result) => {
            done = true;
            out({ type: "cc_browser_done", loginId, ...result });
            void browser.stop("登录结束");
          });
      },
      onExit: (reason) => {
        if (remote && remote.browser === browser) remote = null;
        if (!done) sendRaw({ type: "cc_browser_state", loginId, closed: true, reason });
        log(`云端登录浏览器已关闭（${reason}），配置目录已删除`);
      },
    });
    remote = { loginId, browser };
    await browser.start(login.url);
    // 出口 IP：浏览器和 Claude Code 各看一次 claude.ai 的 /cdn-cgi/trace（应该一样）
    void (async () => {
      const [b, n] = await Promise.all([
        browser.readPage(TRACE_URL).then(traceIp, () => null),
        httpsGet(TRACE_URL, forwarder.upstream()).then((r) => traceIp(r.body), () => null),
      ]);
      if (!browser.closed) sendRaw({ type: "cc_browser_state", loginId, egress: { browser: b, node: n, match: !!b && b === n, viaProxy: !!forwarder.upstream() } });
    })();
    return { started: true, width: browser.size.width, height: browser.size.height };
  }

  async function rpc(op, args) {
    switch (op) {
      case "status":
        return await authStatus();
      case "login_start":
        return await loginStart(args);
      case "login_code":
        return await loginCode(args);
      case "login_cancel":
        endLogin("取消");
        return { cancelled: true };
      case "logout": {
        endLogin("退出");
        return await logoutClaude();
      }
      case "restart_node": {
        if (process.env.CHISABOT_CLOUD_WORKSPACE !== "1") throw new Error("这台节点不是云端工作区容器：请在服务器上重启节点程序。");
        if (!idle()) throw new Error("还有会话在跑，先停止再重启节点。");
        log("网页请求重启节点（容器会重新下载最新的节点程序）");
        setTimeout(() => exit(0), 800).unref?.();
        return { restarting: true };
      }
      case "session_init":
        await ensureTree(args.workspaceId, args.sessionId, args.branch);
        return { tree: path.relative(root, treeDir(args.workspaceId, args.sessionId)) };
      case "tree":
        return listDir(args);
      case "read":
        return readFile(args);
      case "diff":
        return await diff(args);
      case "undo":
        return await undo(args);
      case "running":
        return { sessions: [...bySession.keys()] };
      case "browser_start":
        return await browserStart(args);
      case "browser_stop":
        if (remote && (!args.id || remote.loginId === args.id)) await remote.browser.stop("取消");
        return { stopped: true };
      case "proxy_set": {
        if (args.outbound) {
          // 节点链接：先把 sing-box 起好（起不来就保持原样、报错），再换转发器的上游
          const next = createSingBox({ log });
          const local = await next.start(args.outbound);
          const old = singbox;
          singbox = next;
          forwarder.setUpstream(local);
          await forwarder.start();
          if (old) await old.stop();
          const o = singbox.state();
          return { active: true, converter: true, masked: `${o.type} ${String(args.outbound.server).slice(0, 100)}:${args.outbound.server_port}`, running: [...bySession.keys()].length };
        }
        const url = args.url ? String(args.url) : null;
        if (url && !parseProxy(url)) throw new Error("代理地址不对");
        forwarder.setUpstream(url);
        if (singbox) await singbox.stop();
        singbox = null;
        if (url) await forwarder.start();
        // 正在跑的那一轮不打断：它新建的连接马上按新设置走，下一轮的 claude 进程从头用新设置
        return { active: !!url, converter: false, masked: url ? maskProxy(url) : null, running: [...bySession.keys()].length };
      }
      case "proxy_state":
        return { converter: singbox ? singbox.state() : null, singbox: await singboxVer(), upstream: !!forwarder.upstream() };
      case "proxy_test": {
        if (args.outbound) {
          // 还没保存的节点链接：临时起一个 sing-box，测完就停
          const clean = cleanOutbound(args.outbound);
          const temp = createSingBox({ log, supervise: false, name: "sing-box（测试）" });
          try {
            const local = await temp.start(clean);
            return await testRoute(local);
          } catch (e) {
            return { ok: false, ip: null, country: null, claudeAi: null, anthropicApi: null, ms: null, error: scrubSecrets(e.message, temp.secrets()) };
          } finally {
            await temp.stop();
          }
        }
        const url = args.url === undefined ? null : args.url ? String(args.url) : null;
        const p = url ? parseProxy(url) : forwarder.upstream();
        if (url && !p) return { ok: false, error: "代理地址不对：写成 http://、https:// 或 socks5://主机:端口，可以带 用户名:密码@" };
        try {
          return await testRoute(url || (p ? `${p.protocol}://${p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : ""}${p.host.includes(":") ? `[${p.host}]` : p.host}:${p.port}` : null));
        } catch (e) {
          return { ok: false, error: scrubProxy(e.message, p) };
        }
      }
      // ---- GitHub 工作区（P3） ----
      case "ws_clone":
        wsDir(args.workspaceId);
        return await gitWs.clone(args);
      case "ws_merge":
        treeDir(args.workspaceId, args.sessionId);
        if (bySession.has(String(args.sessionId))) throw new Error("这一轮还在进行，先停止");
        // 第二道闸（服务器的租约为准）：电脑正在用 work/ 时不写，交接中要带对得上的交接号
        syncNode.assertCloudMayWrite(args.workspaceId, args.handoffId);
        return await gitWs.merge(args);
      // ---- 电脑同步的 Git（P4b，§4.5） ----
      case "ws_git_info":
        wsDir(args.workspaceId);
        return await gitWs.gitInfo(args.workspaceId);
      case "ws_git_adopt":
        wsDir(args.workspaceId);
        return await gitWs.adopt(args);
      case "ws_push_preview":
        treeDir(args.workspaceId, args.sessionId);
        return await gitWs.pushPreview(args);
      case "ws_push":
        treeDir(args.workspaceId, args.sessionId);
        if (bySession.has(String(args.sessionId))) throw new Error("这一轮还在进行，先停止");
        return await gitWs.push(args);
      case "ws_base_diff":
        treeDir(args.workspaceId, args.sessionId);
        return await gitWs.baseDiff(args, PATCH_CAP);
      case "ws_drop_tree":
        treeDir(args.workspaceId, args.sessionId);
        if (bySession.has(String(args.sessionId))) throw new Error("这一轮还在进行，先停止");
        return await gitWs.dropTree(args.workspaceId, args.sessionId);
      case "ws_delete": {
        wsDir(args.workspaceId);
        for (const ctx of turns.values()) if (ctx.workspaceId === args.workspaceId) throw new Error("这个工作区还有会话在跑，先停止");
        return await gitWs.remove(args.workspaceId);
      }
      default:
        if (syncNode.rpcs.has(op)) return await syncNode.rpc(op, args);
        throw new Error(`不认识的操作 ${op}`);
    }
  }

  async function info() {
    const v = await run(claude, ["--version"], { timeout: 15_000 });
    out({ type: "cc_info", root, script, claudeVersion: v.code === 0 ? v.stdout.trim().split("\n")[0].slice(0, 120) : null, running: [...bySession.keys()], browser: !!findChromium(), proxy: !!forwarder.upstream(), singbox: await singboxVer() });
  }

  return {
    root,
    handles: (type) => HANDLED.has(type),
    handle(message) {
      if (!message || !HANDLED.has(message.type)) return false;
      switch (message.type) {
        case "cc_probe":
          // 服务器在探测里带上它现在发的节点程序指纹（旧服务器没有这个字段 = 不判断）。
          expectedScript = typeof message.script === "string" ? message.script : null;
          void info();
          maybeSelfUpdate();
          break;
        case "cc_rpc":
          Promise.resolve()
            .then(() => rpc(String(message.op || ""), message.args || {}))
            .then((result) => out({ type: "cc_rpc_result", id: message.id, ok: true, result }))
            .catch((error) => out({ type: "cc_rpc_result", id: message.id, ok: false, error: String(error && error.message ? error.message : error).slice(0, 500) }));
          break;
        case "cc_turn":
          void startTurn(message);
          break;
        case "cc_stop":
          stopSession(message.sessionId);
          break;
        case "sync_tunnel_open":
        case "sync_tunnel_close":
          syncNode.handle(message);
          break;
        case "cc_browser_input":
          if (remote && remote.loginId === String(message.loginId || "")) void remote.browser.input(message.events);
          break;
        case "cc_approval_result": {
          const a = approvals.get(String(message.approvalId || ""));
          if (a) {
            clearTimeout(a.timer);
            approvals.delete(String(message.approvalId));
            a.resolve({ decision: message.decision === "approve" ? "approve" : "deny", always: !!message.always });
          }
          break;
        }
      }
      return true;
    },
    onOnline() {
      flush();
      void info();
    },
    stopAll() {
      syncNode.closeAll();
      if (remote) void remote.browser.stop("紧急停止");
      for (const sessionId of [...bySession.keys()]) stopSession(sessionId);
      endLogin("紧急停止");
    },
    close() {
      this.stopAll();
      forwarder.close();
      if (singbox) void singbox.stop();
      if (hookServer) hookServer.close();
      if (sockPath) {
        try {
          fs.unlinkSync(sockPath);
        } catch {}
      }
    },
  };
}

module.exports = { createCloudCc, findUrl, parseStatus };
