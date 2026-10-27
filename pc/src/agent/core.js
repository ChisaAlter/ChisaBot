"use strict";
/**
 * PC 节点核心（docs/pc-node.md §5、§8）：出站 WebSocket 连接服务器，执行调用，处理审批与紧急停止。
 *
 * 本机是最后一道闸：即使服务器说可以，本机的紧急停止、本机那份能力开关（从服务器同步，
 * 但在本机先检查）都会拒绝。断线自动重连（1s → 30s 指数退避 + 抖动），被撤销则停止。
 */
const { EventEmitter } = require("node:events");
const { gitIsRead } = require("./code-ops");

const OPERATION_CAPABILITY = {
  system_info: null,
  shell: "shell",
  list_files: "files_read",
  read_file: "files_read",
  write_file: "files_write",
  screenshot: "screenshot",
  input: "input",
  open: "open",
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
  // 编码 / 完全访问（docs/pc-node.md §12、§13）
  search: "files_read",
  read_range: "files_read",
  edit_file: "files_write",
  apply_patch: "files_write",
  git: "shell", // 只读子命令按 files_read，见 capabilityFor
  shell_session: "shell",
  exec_start: "shell",
  exec_poll: "shell",
  exec_kill: "shell",
  exec_list: "shell",
  process_list: "shell",
  process_kill: "shell",
  file_upload: "files_write",
  file_download: "files_read",
  activity: null,
};

/** 某次调用需要的能力（git 只读子命令只要「读取文件」）。和 shared/devices.ts 的 capabilityFor 一致。 */
function capabilityFor(operation, args = {}) {
  if (operation === "git") return gitIsRead(args.subcommand, Array.isArray(args.args) ? args.args : []) ? "files_read" : "shell";
  return OPERATION_CAPABILITY[operation];
}

// open 也算：它能 Start-Process / xdg-open 任意程序（带参数），等同命令行（CB-030）。
const DANGEROUS = new Set(["shell", "files_write", "input", "open"]);

function wsUrlFor(serverUrl) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/devices/agent/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function summarize(operation, args) {
  switch (operation) {
    case "shell":
      return `运行命令：${String(args.command || "").slice(0, 200)}`;
    case "write_file":
      return `写入：${args.path}`;
    case "read_file":
    case "read_range":
      return `读取：${args.path}`;
    case "edit_file":
    case "apply_patch":
      return `修改文件：${args.path || "补丁"}`;
    case "git":
      return `git ${args.subcommand || ""}`;
    case "exec_start":
      return `后台运行：${String(args.command || "").slice(0, 200)}`;
    case "list_files":
      return `列出：${args.path || "允许的文件夹"}`;
    case "input":
      return `鼠标键盘：${args.action}`;
    case "open":
      return `打开：${String(args.target || "").slice(0, 200)}`;
    default:
      return operation;
  }
}

/**
 * @param {object} options
 * @param {string} options.serverUrl
 * @param {() => string|null} options.getToken
 * @param {{run: Function, platform: string}} options.ops
 * @param {Function} [options.WebSocket]  ws 包的 WebSocket（可注入以便测试）
 * @param {(req) => Promise<"approve"|"deny">} [options.approve]  弹出本机审批
 * @param {() => {paused: boolean, forceLocalApproval: boolean}} [options.local]
 * @param {object} [options.clientInfo]
 * @param {(url: string) => Promise<object|undefined>} [options.getAgent]  走系统代理时给 ws 的 Agent（proxy.js）
 * @param {number} [options.silenceMs]  多久收不到服务器任何消息就判定连接已死、重连（服务器每 25 秒 ping 一次）
 * @param {number} [options.backoffBaseMs]  重连退避起点，默认 1 秒（上限 30 倍）
 * @param {number} [options.invalidTokenRetryMs]  401 但服务器没说「已撤销」（body 没有 revoked:true）时，多久再试一次（默认 60 秒）
 */
function createNodeAgent(options) {
  const events = new EventEmitter();
  const WebSocketImpl = options.WebSocket || require("ws");
  const local = options.local || (() => ({ paused: false, forceLocalApproval: false }));
  // 完全访问（docs/pc-node.md §13）：服务器说开了，还要本机同意一次（PC 弹窗 / 无界面节点的启动参数）。
  // acceptFullAccess(device) → Promise<boolean>；不提供时按 allowFullAccess（默认 true）。
  let fullAccessAccepted = null; // 已同意的那次开启（fullAccessUntil）
  let fullAccessAsking = null;
  let fullAccessTimer = null;
  let fullAccessExpired = false;
  let socket = null;
  let state = "offline"; // offline | connecting | online | revoked | stopped
  let device = null;
  let attempt = 0;
  let reconnectTimer = null;
  let stopped = false;
  let lastError = "";
  let watchdog = null;
  const silenceMs = options.silenceMs ?? 70_000;
  const invalidTokenRetryMs = options.invalidTokenRetryMs ?? 60_000;
  const backoffBaseMs = options.backoffBaseMs ?? 1000; // 退避起点（测试里调小）；上限是它的 30 倍
  const running = new Map(); // call id -> AbortController
  const approvalPrompts = new Map(); // approval id -> { cancel }

  function setState(next, detail) {
    if (state === next && !detail) return;
    state = next;
    events.emit("state", { state, detail, device });
  }

  function send(message) {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function audit(entry) {
    events.emit("audit", { at: new Date().toISOString(), ...entry });
  }

  /** 连接还在但一直没有消息（休眠唤醒、换网络、代理悄悄断开）：服务器那边早就判离线了，这里也要尽快重连。 */
  function armWatchdog(ws) {
    clearTimeout(watchdog);
    if (!silenceMs) return;
    watchdog = setTimeout(() => {
      if (socket !== ws) return;
      lastError = "长时间没有收到服务器消息";
      try {
        ws.terminate();
      } catch {}
    }, silenceMs);
    if (typeof watchdog.unref === "function" && options.unrefTimers) watchdog.unref();
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const base = Math.min(30 * backoffBaseMs, backoffBaseMs * 2 ** Math.min(attempt, 5));
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    attempt++;
    events.emit("reconnect", { delay, attempt });
    reconnectTimer = setTimeout(() => void connect(), delay);
    if (typeof reconnectTimer.unref === "function" && options.unrefTimers) reconnectTimer.unref();
  }

  /** 401 但没有明确撤销（令牌未知、设备行被删、服务器那边临时认证异常）：保持「revoked」状态，隔很久再试一次（CB-113）。 */
  function scheduleInvalidTokenRetry() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    events.emit("reconnect", { delay: invalidTokenRetryMs, attempt, invalidToken: true });
    reconnectTimer = setTimeout(() => void connect(), invalidTokenRetryMs);
    if (typeof reconnectTimer.unref === "function" && options.unrefTimers) reconnectTimer.unref();
  }

  function fullAccessOn() {
    return !!(device && device.fullAccess && !fullAccessExpired && fullAccessAccepted && fullAccessAccepted === device.fullAccessUntil);
  }

  /** 收到新配置时：完全访问刚开 → 本机确认一次；关了 / 到期 → 结束后台命令和管理员助手。 */
  function syncFullAccess(previous) {
    clearTimeout(fullAccessTimer);
    const wasOn = previous && previous.fullAccess;
    if (!device?.fullAccess) {
      fullAccessAccepted = null;
      fullAccessExpired = false;
      if (wasOn) {
        options.ops.stopAll?.("full_access_off");
        events.emit("full_access", { on: false });
      }
      return;
    }
    fullAccessExpired = false;
    if (typeof device.fullAccessRemainingMs === "number" && device.fullAccessRemainingMs < 400 * 24 * 3600_000) {
      fullAccessTimer = setTimeout(() => {
        fullAccessExpired = true;
        options.ops.stopAll?.("full_access_expired");
        events.emit("full_access", { on: false, expired: true });
      }, Math.max(0, device.fullAccessRemainingMs));
      if (typeof fullAccessTimer.unref === "function" && options.unrefTimers) fullAccessTimer.unref();
    }
    if (fullAccessAccepted === device.fullAccessUntil || fullAccessAsking === device.fullAccessUntil) return;
    const grant = device.fullAccessUntil;
    fullAccessAsking = grant;
    const ask = options.acceptFullAccess ? options.acceptFullAccess(device) : Promise.resolve(options.allowFullAccess !== false);
    Promise.resolve(ask)
      .catch(() => false)
      .then((ok) => {
        fullAccessAsking = null;
        if (!device || device.fullAccessUntil !== grant) return;
        if (ok) {
          fullAccessAccepted = grant;
          send({ type: "local_audit", action: "full_access_accepted", outcome: "succeeded", summary: "本机同意了完全访问" });
          events.emit("full_access", { on: true });
        } else {
          send({ type: "set_config", fullAccess: "off" });
          send({ type: "local_audit", action: "full_access_declined", outcome: "denied", summary: "本机拒绝了完全访问，已关闭" });
        }
      });
  }

  async function handleCall(message) {
    const { id, operation } = message;
    const args = message.args || {};
    const capability = capabilityFor(operation, args);
    const full = fullAccessOn();
    const policy = full ? "allow" : capability ? device?.capabilities?.[capability] ?? "off" : "allow";
    const started = Date.now();
    const reply = (ok, payload) => {
      running.delete(id);
      send(ok ? { type: "result", id, ok: true, result: payload } : { type: "result", id, ok: false, error: payload });
      audit({
        actor: message.botName || "机器人",
        operation,
        summary: summarize(operation, args),
        outcome: ok ? "succeeded" : "failed",
        detail: ok ? undefined : payload,
        durationMs: Date.now() - started,
      });
    };
    if (capability === undefined) return reply(false, `PC 客户端不支持操作 ${operation}。`);
    if (local().paused) return reply(false, "这台电脑已在本机紧急停止，拒绝所有远程操作。");
    if (device?.paused) return reply(false, "这台设备已紧急停止。");
    if (policy === "off") return reply(false, "本机设置中这项能力是关闭的。");
    if (args.elevated && !full) return reply(false, "管理员身份运行只在「完全访问」模式下可用（本机尚未同意或已到期）。");
    // 本机强制审批：危险能力即使服务器设为「直接执行」也在本机再问一次。完全访问模式下不问（用户已在本机同意过）。
    if (!full && local().forceLocalApproval && capability && DANGEROUS.has(capability) && policy === "allow" && options.approve) {
      const decision = await options
        .approve({
          id: `local-${id}`,
          operation,
          summary: summarize(operation, args),
          botName: message.botName,
          local: true,
          // 本机确认最多等到这次调用的超时（服务器那边到点就按失败处理），上限 2 分钟。
          remainingMs: Math.min(120_000, Math.max(10_000, (message.timeoutMs || 120_000) - 5_000)),
        })
        .catch(() => "deny");
      if (decision !== "approve") return reply(false, "用户在本机拒绝了这次操作。");
    }
    const controller = new AbortController();
    running.set(id, controller);
    events.emit("call", { id, operation, botName: message.botName });
    try {
      const result = await options.ops.run(operation, args, {
        allowedRoots: device?.allowedRoots || [],
        signal: controller.signal,
        fullAccess: full,
        botName: message.botName,
      });
      if (controller.signal.aborted) return reply(false, "已取消。");
      reply(true, result);
    } catch (error) {
      reply(false, error && error.message ? error.message : String(error));
    }
  }

  async function handleApproval(message) {
    if (!options.approve) return; // 无界面：等网页上审批
    let cancelled = false;
    approvalPrompts.set(message.id, { cancel: () => (cancelled = true) });
    const decision = await options.approve(message).catch(() => "deny");
    approvalPrompts.delete(message.id);
    if (cancelled || decision === "dismissed") return;
    send({ type: "approval", id: message.id, decision: decision === "approve" ? "approve" : "deny" });
    audit({
      actor: message.botName || "机器人",
      operation: message.operation,
      summary: message.summary,
      outcome: decision === "approve" ? "approved_local" : "denied_local",
    });
  }

  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (message.type) {
      case "welcome":
      case "config": {
        const previous = device;
        device = message.device;
        attempt = 0;
        if (device?.paused && !previous?.paused) options.ops.stopAll?.("paused");
        syncFullAccess(previous);
        setState("online");
        events.emit("config", device);
        return;
      }
      case "call":
        void handleCall(message);
        return;
      case "cancel": {
        running.get(message.id)?.abort();
        return;
      }
      case "approval_request":
        void handleApproval(message);
        return;
      case "approval_closed": {
        const prompt = approvalPrompts.get(message.id);
        if (prompt) {
          prompt.cancel();
          events.emit("approval_closed", message);
        }
        return;
      }
      case "revoked":
        options.ops.stopAll?.("revoked");
        stopped = true;
        setState("revoked");
        events.emit("revoked");
        return;
      case "ping":
        send({ type: "pong" });
        return;
      default:
        // 本地 agent 运行时（agent-runtime/）等扩展：不认识的消息交给它。
        if (options.onExtra) options.onExtra(message);
    }
  }

  let connecting = false;
  async function connect() {
    if (stopped || connecting || socket) return;
    const token = options.getToken();
    if (!token) {
      setState("offline", "未登录");
      return;
    }
    connecting = true;
    setState("connecting");
    const origin = new URL(options.serverUrl).origin;
    const url = wsUrlFor(options.serverUrl);
    let ws;
    try {
      // 系统代理（proxy.js）：窗口里的 Chromium 走代理，节点也得走同一条路，否则直连不通的网络里永远离线。
      const agent = options.getAgent ? await options.getAgent(url).catch(() => undefined) : undefined;
      if (stopped) return;
      ws = new WebSocketImpl(url, {
        headers: { "X-Device-Token": token, Origin: origin, "User-Agent": `ChisaBotPC/${options.clientInfo?.clientVersion || "0"}` },
        handshakeTimeout: 15_000,
        ...(agent ? { agent } : {}),
      });
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      setState("offline", lastError);
      scheduleReconnect();
      return;
    } finally {
      connecting = false;
    }
    socket = ws;
    armWatchdog(ws);
    ws.on("open", () => {
      lastError = "";
      send({ type: "hello", ...(options.clientInfo || {}), features: options.ops.features || undefined });
    });
    ws.on("message", (data) => {
      armWatchdog(ws);
      onMessage(data);
    });
    // 握手被 HTTP 拒绝（401/502/503…）：有这个监听时 ws 既不报 error 也不触发 close（CB-113），
    // 所以重连只能在这里排，不能指望 close。
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (socket !== ws) return; // 已被 stop()/reconnectNow() 丢弃
        socket = null;
        clearTimeout(watchdog);
        if (stopped) return;
        if (res.statusCode === 401) {
          let revoked = false;
          try {
            revoked = JSON.parse(body).revoked === true;
          } catch {}
          if (revoked) {
            // 服务器明确说这台设备被撤销（server/src/devices/routes.ts requireDevice）：停下。
            stopped = true;
            setState("revoked", "设备已被撤销");
            events.emit("revoked");
          } else {
            // 令牌不认识但没说撤销：可能是临时问题，隔 invalidTokenRetryMs 再试，不发 revoked 事件（无界面节点收到会退出）。
            lastError = "设备令牌无效";
            setState("revoked", lastError);
            scheduleInvalidTokenRetry();
          }
        } else {
          lastError = `服务器返回 ${res.statusCode}`;
          setState("offline", lastError);
          scheduleReconnect();
        }
      };
      res.on("data", (c) => (body += c));
      res.on("end", settle);
      res.on("error", settle);
      res.on("aborted", settle);
    });
    ws.on("close", (code) => {
      if (socket === ws) socket = null;
      else return; // 已被 reconnectNow() 换掉的旧连接
      clearTimeout(watchdog);
      for (const controller of running.values()) controller.abort();
      running.clear();
      for (const prompt of approvalPrompts.values()) prompt.cancel();
      approvalPrompts.clear();
      if (code === 4401) {
        stopped = true;
        setState("revoked", "设备已被撤销");
        events.emit("revoked");
        return;
      }
      if (state !== "revoked" && !stopped) {
        setState("offline", code === 4000 ? "在别处重新连接" : lastError || (code === 1006 ? "连接中断" : `连接关闭（${code}）`));
        scheduleReconnect();
      }
    });
    ws.on("error", (error) => {
      // stop()/reconnectNow() 主动丢弃的连接（可能还在握手中，ws 会报「closed before the connection was established」）不再上报。
      if (socket !== ws) return;
      lastError = error && error.message ? error.message : String(error);
      events.emit("error", error);
    });
  }

  return {
    events,
    start() {
      stopped = false;
      attempt = 0;
      void connect();
    },
    /**
     * 立刻重连（网络恢复、休眠唤醒、聊天窗口刚成功加载、用户在设备页点「重新连接」）：
     * 已在线就什么都不做；否则丢掉退避等待，马上再连一次。
     */
    reconnectNow() {
      if (stopped) return false;
      if (state === "online" && socket && socket.readyState === 1) return false;
      clearTimeout(reconnectTimer);
      attempt = 0;
      if (socket && socket.readyState !== 1) {
        const old = socket;
        socket = null;
        try {
          old.terminate();
        } catch {}
      }
      void connect();
      return true;
    },
    get lastError() {
      return lastError;
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(watchdog);
      const ws = socket;
      socket = null;
      // 握手中的连接 close() 会中止握手并异步报错；先置空 socket，error 监听据此忽略。
      if (ws) ws.close(1000, "bye");
      setState("stopped");
    },
    /** 改本机设置并同步到服务器（能力、文件夹、名称、紧急停止）。 */
    setConfig(patch) {
      if (device) {
        if (patch.capabilities) device = { ...device, capabilities: { ...device.capabilities, ...patch.capabilities } };
        if (patch.allowedRoots) device = { ...device, allowedRoots: patch.allowedRoots };
        if (patch.paused !== undefined) device = { ...device, paused: patch.paused };
        if (patch.name) device = { ...device, name: patch.name };
        events.emit("config", device);
      }
      if (patch.paused === true) {
        for (const controller of running.values()) controller.abort();
        options.ops.stopAll?.("paused");
      }
      return send({ type: "set_config", ...patch });
    },
    /** 扩展协议（本地 agent）用：发一条消息，离线返回 false。 */
    sendRaw(message) {
      return send(message);
    },
    reportLocal(action, outcome, summary) {
      send({ type: "local_audit", action, outcome, summary });
    },
    get state() {
      return state;
    },
    get device() {
      return device;
    },
    /** 完全访问是否在本机生效（服务器开了、本机同意了、没到期）。 */
    get fullAccess() {
      return fullAccessOn();
    },
  };
}

module.exports = { createNodeAgent, wsUrlFor, OPERATION_CAPABILITY, capabilityFor, summarize };
