"use strict";
/**
 * 本地 agent 运行时（docs/local-agents.md）：接服务器发来的 agent_run / agent_stop / agent_apply / agent_probe…，
 * 在这台电脑（或服务器本机受控工作区）上准备工作目录（worktree / 副本 / 沙盒）、影子 Home 与子代理互调桥，
 * 启动选定的智能体驱动（Codex、Claude Code、Antigravity、通用 ACP、OpenCode、Gemini、Aider、自定义命令或内置循环），
 * 把输出流回服务器，结束时报告改动。
 *
 * 和设备节点（agent/core.js）共用同一条 WebSocket：core 把不认识的消息交给 handle()，
 * 这里用 core 的 send 回消息；断线期间的消息先存着，重连后补发。
 */
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  detectAll,
  probeInstance,
  resolveExecutable,
  resolveAntigravityExecutable,
  resolveAntigravityExecutableWithSource,
  findSystemAntigravityBinary,
  isStandaloneAcpServerBinary,
  resolveAcpCommand,
  clearWhichCache,
  capture,
  firstVersion,
  AGENT_BINARIES,
  which,
} = require("./detect");
const {
  resolveAntigravityIsolation,
  ensureAntigravityHomeDirs,
  getAntigravityRuntimeStatus,
  installManagedAntigravity,
  createAntigravityLoginManager,
  logoutAntigravityInstance,
} = require("./antigravity-managed");
const sandbox = require("./sandbox");
const {
  buildCommand,
  cmdSafe,
  assertValidResumeSessionId,
  normalizeResumeSessionId,
} = require("./cli-agents");
const { runBuiltin, localModel } = require("./builtin");
const { isInside } = require("./profile");
const { prepareShadowHome } = require("./shadow-home");
const {
  runAcpSession,
  sanitizeAntigravityEnv,
  killTree,
  spawnCommand,
} = require("./acp-client");
const { createSubagentBridge } = require("./subagent-bridge");

const HANDLED = new Set([
  "agent_detect",
  "agent_probe",
  "agent_runtime_status",
  "agent_runtime_install",
  "agent_runtime_install_cancel",
  "agent_runtime_login_start",
  "agent_runtime_login_submit",
  "agent_runtime_login_cancel",
  "agent_runtime_logout",
  "agent_run",
  "agent_continue",
  "agent_stop",
  "agent_apply",
  "agent_discard",
  "agent_llm_result",
  "agent_approval_result",
  "agent_user_input_result",
  "agent_subcall_result",
]);
const MAX_LINES = 3000;
const LINE_CAP = 2000;
const MAX_RETAINED_SESSIONS = 16;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const MAX_PREPARED_WORKSPACES = 8;
const DEFAULT_PREPARED_TTL_MS = 6 * 60 * 60_000;

/** 支持通过真实外部会话 ID 续接上下文的外部驱动（builtin 走内存 builtinMessages，其余如 opencode/gemini/aider/custom 不支持 --resume）。 */
const RESUMABLE_EXTERNAL_DRIVERS = new Set([
  "claude",
  "codex",
  "antigravity",
  "acp",
]);

function isSyntheticSessionId(sessionId, taskId) {
  if (typeof sessionId !== "string") return false;
  return sessionId === `sess-${taskId}` || sessionId.startsWith("sess-");
}

function normalizeExternalSessionId(raw, taskId) {
  const normalized = normalizeResumeSessionId(raw);
  if (!normalized || isSyntheticSessionId(normalized, taskId)) return null;
  return normalized;
}

function lineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        onLine(line);
      }
      if (buffer.length > 1_000_000) {
        onLine(buffer.slice(0, 4000));
        buffer = "";
      }
    },
    end() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

function combineAbortSignals(primary, secondary) {
  if (!secondary || secondary === primary) {
    return { signal: primary, cleanup() {} };
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([primary, secondary]), cleanup() {} };
  }
  const merged = new AbortController();
  const forward = (src) => {
    if (!merged.signal.aborted) {
      merged.abort(src.reason || new Error("已停止"));
    }
  };
  if (primary.aborted) forward(primary);
  else if (secondary.aborted) forward(secondary);
  const onPrimary = () => forward(primary);
  const onSecondary = () => forward(secondary);
  primary.addEventListener("abort", onPrimary, { once: true });
  secondary.addEventListener("abort", onSecondary, { once: true });
  return {
    signal: merged.signal,
    cleanup() {
      primary.removeEventListener("abort", onPrimary);
      secondary.removeEventListener("abort", onSecondary);
    },
  };
}

/**
 * @param {{ send: (message: object) => boolean, log?: (line: string) => void, isPaused?: () => boolean, sessionTtlMs?: number }} options
 */
function createAgentRuntime(options) {
  const log = options.log || (() => {});
  const sessionTtlMs = Math.max(
    1_000,
    Number(options.sessionTtlMs) || DEFAULT_SESSION_TTL_MS,
  );
  const maxPrepared = Math.max(
    1,
    Number(options.maxPrepared) || MAX_PREPARED_WORKSPACES,
  );
  const preparedTtlMs = Math.max(
    1_000,
    Number(options.preparedTtlMs) || DEFAULT_PREPARED_TTL_MS,
  );
  const tasks = new Map(); // taskId -> { controller, child }
  const prepared = new Map(); // taskId -> prep（等用户应用 / 放弃）
  const preparedAt = new Map(); // taskId -> timestamp
  const sessions = new Map(); // taskId -> { prep, sessionId, builtinMessages, lastUsedAt }
  const llmPending = new Map();
  const approvalPending = new Map();
  const userInputPending = new Map();
  const subcallPending = new Map();
  const installJobs = new Map(); // jobId -> { controller }
  const loginManager = createAntigravityLoginManager();
  const agyOpts = options.antigravityOptions || {};
  const outbox = [];
  let detection = null;

  function prunePrepared(now = Date.now()) {
    const evict = (oldTaskId) => {
      const oldPrep = prepared.get(oldTaskId);
      prepared.delete(oldTaskId);
      preparedAt.delete(oldTaskId);
      if (!oldPrep) return;
      const retained = sessions.get(oldTaskId);
      if (retained && retained.prep === oldPrep) {
        retained.prep = null;
      }
      void oldPrep.cleanup().catch(() => {});
    };

    for (const [oldTaskId] of [...prepared.entries()]) {
      if (tasks.has(oldTaskId)) continue;
      const ts = preparedAt.get(oldTaskId) || 0;
      if (ts > 0 && now - ts > preparedTtlMs) {
        evict(oldTaskId);
      }
    }
    if (prepared.size <= maxPrepared) return;
    const ordered = [...prepared.keys()].sort(
      (a, b) => (preparedAt.get(a) || 0) - (preparedAt.get(b) || 0),
    );
    while (prepared.size > maxPrepared && ordered.length) {
      const oldTaskId = ordered.shift();
      if (tasks.has(oldTaskId)) continue;
      evict(oldTaskId);
    }
  }

  function rememberPrepared(taskId, prep) {
    prepared.set(taskId, prep);
    preparedAt.set(taskId, Date.now());
    prunePrepared();
  }

  function pruneSessions(now = Date.now()) {
    prunePrepared(now);
    for (const [oldTaskId, entry] of [...sessions.entries()]) {
      if (tasks.has(oldTaskId)) continue;
      if (now - entry.lastUsedAt <= sessionTtlMs) continue;
      sessions.delete(oldTaskId);
      if (entry.prep && prepared.get(oldTaskId) !== entry.prep) {
        void entry.prep.cleanup().catch(() => {});
      }
    }
    if (sessions.size <= MAX_RETAINED_SESSIONS) return;
    const ordered = [...sessions.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    while (sessions.size > MAX_RETAINED_SESSIONS && ordered.length) {
      const [oldTaskId, entry] = ordered.shift();
      if (tasks.has(oldTaskId)) continue;
      sessions.delete(oldTaskId);
      if (entry.prep && prepared.get(oldTaskId) !== entry.prep) {
        void entry.prep.cleanup().catch(() => {});
      }
    }
  }

  const sessionSweepTimer = setInterval(
    () => pruneSessions(),
    Math.min(sessionTtlMs, 5 * 60_000),
  );
  sessionSweepTimer.unref?.();

  function out(message) {
    if (options.send(message)) return;
    outbox.push(message);
    if (outbox.length > 2000) outbox.shift();
  }

  function flush() {
    while (outbox.length) {
      if (!options.send(outbox[0])) return;
      outbox.shift();
    }
  }

  async function detect() {
    clearWhichCache();
    try {
      detection = await detectAll();
      out({ type: "agents_detected", detection });
    } catch (error) {
      log(`检测本地 agent 失败：${error.message}`);
    }
  }

  async function probe(message) {
    clearWhichCache();
    try {
      const result = await probeInstance(message.instance || {});
      out({ type: "agent_probe_result", reqId: message.reqId, probe: result });
    } catch (error) {
      out({
        type: "agent_probe_result",
        reqId: message.reqId,
        probe: {
          status: "error",
          version: null,
          resolvedPath: null,
          authenticated: null,
          authLabel: null,
          message: error?.message ? error.message : String(error),
        },
      });
    }
  }

  async function queryAntigravityStatus(checkLatest = false) {
    clearWhichCache();
    const baseEnv = agyOpts.customEnv || process.env;
    return getAntigravityRuntimeStatus({
      checkLatest: Boolean(checkLatest),
      customEnv: baseEnv,
      findSystemBinary: findSystemAntigravityBinary,
      probeVersion: async (bin) => {
        const env = sanitizeAntigravityEnv(baseEnv, true);
        const res = await capture(bin, ["--version"], {
          env,
          timeoutMs: 5000,
        });
        return firstVersion(res.out);
      },
      ...agyOpts,
    });
  }

  async function handleRuntimeStatus(message) {
    if (message.driver !== "antigravity") {
      out({
        type: "agent_runtime_status_result",
        reqId: message.reqId,
        ok: false,
        error: `不支持的托管运行时驱动：${String(message.driver || "")}`,
      });
      return;
    }
    try {
      const status = await queryAntigravityStatus(Boolean(message.checkLatest));
      out({
        type: "agent_runtime_status_result",
        reqId: message.reqId,
        ok: true,
        status,
      });
    } catch (error) {
      out({
        type: "agent_runtime_status_result",
        reqId: message.reqId,
        ok: false,
        error: error?.message ? error.message : String(error),
      });
    }
  }

  async function handleRuntimeInstall(message) {
    const jobId = String(message.jobId || "");
    if (!jobId) return;
    if (message.driver !== "antigravity") {
      out({
        type: "agent_runtime_install_result",
        jobId,
        ok: false,
        version: null,
        binaryPath: null,
        status: null,
        error: `不支持的托管运行时驱动：${String(message.driver || "")}`,
        cancelled: false,
      });
      return;
    }
    if (installJobs.has(jobId)) return;
    const controller = new AbortController();
    installJobs.set(jobId, { controller });
    try {
      const res = await installManagedAntigravity({
        jobId,
        force: Boolean(message.force),
        version: message.version,
        signal: controller.signal,
        customEnv: agyOpts.customEnv || process.env,
        onProgress: (p) => {
          out({
            type: "agent_runtime_install_progress",
            jobId,
            stage: p.stage,
            percent: p.percent ?? null,
            downloadedBytes: p.downloadedBytes ?? 0,
            totalBytes: p.totalBytes ?? null,
            message: p.message ?? null,
          });
        },
        ...agyOpts,
      });
      clearWhichCache();
      let status = null;
      try {
        status = await queryAntigravityStatus(false);
      } catch {}
      out({
        type: "agent_runtime_install_result",
        jobId,
        ok: true,
        version: res.version || null,
        binaryPath: res.binaryPath || null,
        status,
        error: null,
        cancelled: false,
      });
    } catch (error) {
      const cancelled = Boolean(
        controller.signal.aborted ||
          error?.cancelled ||
          error?.name === "AbortError",
      );
      out({
        type: "agent_runtime_install_result",
        jobId,
        ok: false,
        version: null,
        binaryPath: null,
        status: null,
        error: cancelled
          ? "已取消安装"
          : error?.message
            ? error.message
            : String(error),
        cancelled,
      });
    } finally {
      installJobs.delete(jobId);
    }
  }

  function handleRuntimeInstallCancel(message) {
    const jobId = String(message.jobId || "");
    const job = installJobs.get(jobId);
    if (!job) return;
    const abortErr = new Error("已取消安装");
    abortErr.name = "AbortError";
    abortErr.cancelled = true;
    job.controller.abort(abortErr);
  }

  function handleRuntimeLoginStart(message) {
    const sessionId = String(message.sessionId || "");
    if (!sessionId) return;
    if (message.driver !== "antigravity") {
      out({
        type: "agent_runtime_login_result",
        sessionId,
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: null,
        error: `不支持的登录驱动：${String(message.driver || "")}`,
        cancelled: false,
      });
      return;
    }
    clearWhichCache();
    const baseEnv = agyOpts.customEnv || process.env;
    const inst = message.instance || { driver: "antigravity" };
    const lookupEnv = sanitizeAntigravityEnv(
      { ...baseEnv, ...(inst.env || {}) },
      inst.config?.fixProxy !== false,
    );
    const iso = resolveAntigravityIsolation(inst, lookupEnv);
    const resolved = resolveAntigravityExecutableWithSource(
      inst.config?.commandPath,
      lookupEnv,
    );
    if (!resolved.file) {
      out({
        type: "agent_runtime_login_result",
        sessionId,
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error: "未安装 Antigravity 运行时，请先一键安装后再登录。",
        cancelled: false,
      });
      return;
    }
    if (isStandaloneAcpServerBinary(resolved.file)) {
      out({
        type: "agent_runtime_login_result",
        sessionId,
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error:
          "当前可执行文件为旧版独立 agy_acp_server，不支持页内 Google 登录，请使用 ChisaBot 一键托管安装。",
        cancelled: false,
      });
      return;
    }

    loginManager.startLogin({
      sessionId,
      binaryPath: resolved.file,
      instance: inst,
      baseEnv,
      onEvent: (ev) => {
        out({
          type: "agent_runtime_login_event",
          sessionId,
          stage: ev.stage,
          authUrl: ev.authUrl ?? null,
          userCode: ev.userCode ?? null,
          message: ev.message ?? null,
        });
      },
      onResult: (res) => {
        out({
          type: "agent_runtime_login_result",
          sessionId,
          ok: Boolean(res.ok),
          authenticated: Boolean(res.authenticated),
          authLabel: res.authLabel ?? null,
          email: res.email ?? null,
          homePath: res.homePath ?? iso.homeDir,
          error: res.error ?? null,
          cancelled: Boolean(res.cancelled),
        });
      },
    });
  }

  function handleRuntimeLoginSubmit(message) {
    const sessionId = String(message.sessionId || "");
    if (!sessionId) return;
    const res = loginManager.submitCode(sessionId, message.code);
    if (!res.ok) {
      log(`提交 Antigravity 登录授权码未受理：${res.error}`);
      if (!res.finished) {
        loginManager.disposeLoginSilent(sessionId);
        out({
          type: "agent_runtime_login_result",
          sessionId,
          ok: false,
          authenticated: false,
          authLabel: null,
          email: null,
          homePath: res.homePath ?? null,
          error: res.error || "登录会话不存在或已结束",
          cancelled: false,
        });
      }
    }
  }

  function handleRuntimeLoginCancel(message) {
    const sessionId = String(message.sessionId || "");
    if (!sessionId) return;
    loginManager.cancelLogin(sessionId);
  }

  async function handleRuntimeLogout(message) {
    if (message.driver !== "antigravity") {
      out({
        type: "agent_runtime_logout_result",
        reqId: message.reqId,
        ok: false,
        homePath: null,
        message: null,
        error: `不支持的登出驱动：${String(message.driver || "")}`,
      });
      return;
    }
    try {
      const baseEnv = agyOpts.customEnv || process.env;
      const res = await logoutAntigravityInstance({
        instance: message.instance || { driver: "antigravity" },
        baseEnv,
      });
      out({
        type: "agent_runtime_logout_result",
        reqId: message.reqId,
        ok: Boolean(res.ok),
        homePath: res.homePath ?? null,
        message: res.message ?? null,
        error: null,
      });
    } catch (error) {
      out({
        type: "agent_runtime_logout_result",
        reqId: message.reqId,
        ok: false,
        homePath: null,
        message: null,
        error: error?.message ? error.message : String(error),
      });
    }
  }

  function request(map, message, timeoutMs, signal) {
    const reqId = crypto.randomUUID();
    const expectedTaskId =
      typeof message?.taskId === "string" && message.taskId
        ? message.taskId
        : null;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("已停止"),
        );
        return;
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        map.delete(reqId);
        reject(new Error("服务器没有及时回应"));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        map.delete(reqId);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("已停止"),
        );
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      map.set(reqId, {
        taskId: expectedTaskId,
        resolve: (value) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
      });
      out({ ...message, reqId });
    });
  }

  function resolvePending(map, message) {
    const reqId = typeof message?.reqId === "string" ? message.reqId : "";
    if (!reqId) return;
    const pending = map.get(reqId);
    if (!pending) return;
    const msgTaskId =
      typeof message.taskId === "string" && message.taskId
        ? message.taskId
        : null;
    if (pending.taskId && msgTaskId !== pending.taskId) {
      log(
        `拒绝跨任务回包（type=${String(message.type)} reqId=${reqId} expected=${pending.taskId} actual=${String(msgTaskId)}）`,
      );
      return;
    }
    map.delete(reqId);
    pending.resolve(message);
  }

  async function runCli(message, prep, emit, controller, ctx) {
    const win = process.platform === "win32";
    const isolation = message.isolation;
    const name = ctx.driver;
    const cfg = ctx.cfg || {};
    const customEnv = ctx.env || {};
    const defaults = AGENT_BINARIES[name] || [name];
    // WSL：agent 装在 WSL 里，用名字或自定义路径调；其它在本机找到可执行文件。
    const lookupEnv = { ...process.env, ...customEnv };
    const file =
      isolation === "wsl"
        ? (cfg.commandPath && String(cfg.commandPath).trim()) || name
        : name === "antigravity"
          ? resolveAntigravityExecutable(cfg.commandPath, lookupEnv)
          : resolveExecutable(cfg.commandPath, defaults, customEnv) ||
            (name !== "custom" ? which(name, customEnv) : null);
    if (!file) {
      throw new Error(
        `没有找到可执行文件 ${cfg.commandPath || name}（请检查提供方路径配置或先安装）。`,
      );
    }
    const viaStdin =
      win &&
      /\.(cmd|bat)$/i.test(file) &&
      (name === "claude" ||
        name === "codex" ||
        name === "antigravity" ||
        name === "custom");
    const prompt =
      win && /\.(cmd|bat)$/i.test(file) && !viaStdin
        ? cmdSafe(message.prompt)
        : message.prompt;
    const root = typeof process.getuid === "function" && process.getuid() === 0;
    const command = buildCommand(name, {
      prompt,
      profile: message.profile,
      skipPermissions: message.skipPermissions,
      network: message.network,
      workdir: prep.workdir,
      root,
      viaStdin,
      model: cfg.model,
      extraArgs: cfg.extraArgs,
      claudeMcpConfigPath: ctx.bridge ? ctx.bridge.claudeMcpConfigPath : null,
      codexConfigArgs: ctx.bridge ? ctx.bridge.codexConfigArgs : null,
      stdinPrompt: cfg.stdinPrompt,
      outputFormat: cfg.outputFormat,
      resumeSessionId: ctx.resumeSessionId || null,
    });
    const wrapped = sandbox.wrap({
      isolation,
      workdir: prep.workdir,
      network: message.network,
      file,
      args: command.args,
    });
    emit(
      "status",
      `启动 ${path.basename(file)}${isolation !== "none" && isolation !== "worktree" && isolation !== "copy" ? `（${isolation}）` : ""}`,
    );
    let mergedEnv = {
      ...process.env,
      ...command.env,
      ...customEnv,
      CHISABOT_TASK: message.taskId,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    if (name === "antigravity") {
      const agyIso =
        ctx.antigravityIsolation ||
        resolveAntigravityIsolation(
          ctx.instance || {
            driver: "antigravity",
            config: cfg,
            env: customEnv,
          },
          process.env,
        );
      ensureAntigravityHomeDirs(agyIso);
      mergedEnv = {
        ...command.env,
        ...agyIso.env,
        CHISABOT_TASK: message.taskId,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      };
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        const hasStdin = command.stdin !== null && command.stdin !== undefined;
        child = spawnCommand(wrapped.file, wrapped.args, {
          cwd: prep.workdir,
          env: mergedEnv,
          windowsHide: true,
          detached: !win,
          stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      const taskState = tasks.get(message.taskId);
      if (taskState) taskState.child = child;
      child.stdin?.on("error", () => {});
      if (command.stdin !== null && command.stdin !== undefined) {
        try {
          child.stdin.end(command.stdin);
        } catch {}
      }
      const stdout = lineSplitter((line) => command.parser.line(line, emit));
      let stderrLines = 0;
      let stderrTail = "";
      const stderr = lineSplitter((line) => {
        if (!line.trim()) return;
        stderrTail = `${stderrTail}\n${line}`.slice(-1500);
        if (++stderrLines <= 200) emit("stderr", line);
      });
      child.stdout.on("data", (d) => stdout.push(String(d)));
      child.stderr.on("data", (d) => stderr.push(String(d)));
      const timer = setTimeout(() => {
        emit(
          "status",
          `超过 ${Math.round(message.timeoutMs / 60000)} 分钟，已停止`,
        );
        controller.abort(new Error("timeout"));
      }, message.timeoutMs);
      const onAbort = () => killTree(child);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const cleanupListeners = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      };
      child.on("error", (error) => {
        cleanupListeners();
        reject(new Error(`无法启动 ${name}：${error.message}`));
      });
      child.on("close", (code) => {
        cleanupListeners();
        stdout.end();
        stderr.end();
        const result = command.parser.result();
        resolve({
          exitCode: code,
          summary: result.summary,
          isError: result.isError || (code !== 0 && code !== null),
          stderrTail,
          sessionId: result.sessionId || ctx.resumeSessionId || null,
        });
      });
    });
  }

  async function run(message, { isContinue = false } = {}) {
    const { taskId } = message;
    if (tasks.has(taskId)) return;
    const controller = new AbortController();
    tasks.set(taskId, { controller, child: null });
    let lines = 0;
    const emit = (kind, text, step) => {
      if (!text) return;
      if (
        ++lines > MAX_LINES &&
        kind !== "tool" &&
        kind !== "approval" &&
        kind !== "question"
      )
        return;
      const value = String(text);
      out({
        type: "agent_event",
        taskId,
        kind,
        text: value.length > LINE_CAP ? `${value.slice(0, LINE_CAP)}…` : value,
        ...(step ? { step: String(step).slice(0, 200) } : {}),
      });
    };
    const inst = message.instance || null;
    const driver = inst?.driver || message.agent;
    const isBuiltin = driver === "builtin";
    const supportsExternalResume = RESUMABLE_EXTERNAL_DRIVERS.has(driver);
    const previousSession = isContinue ? sessions.get(taskId) || null : null;
    let resumeSessionId = null;
    let prep = previousSession?.prep || null;
    let reusedPrep = Boolean(prep);
    let bridge = null;
    let started = false;
    try {
      const validatedInputSessionId =
        message.sessionId !== undefined && message.sessionId !== null
          ? assertValidResumeSessionId(message.sessionId)
          : null;
      const rawResumeSessionId =
        validatedInputSessionId ||
        normalizeResumeSessionId(previousSession?.sessionId) ||
        null;
      resumeSessionId = isBuiltin
        ? rawResumeSessionId
        : supportsExternalResume
          ? normalizeExternalSessionId(rawResumeSessionId, taskId)
          : null;
      if (options.isPaused?.())
        throw new Error("这台电脑已紧急停止，拒绝启动本地 agent。");
      // 本机再检查一次：工作目录要在工作区文件夹里（完全访问除外）。
      if (
        message.profile !== "full" &&
        message.roots?.length &&
        message.cwd &&
        !isInside(message.cwd, message.roots)
      )
        throw new Error("工作目录不在这台电脑的工作区文件夹里。");

      // 启动前 5s 沙盒目录 pwd -P 预检（防 symlink 越界与不可访问目录，超时 5s fail-closed）。
      emit("status", "正在执行沙盒目录预检（pwd -P）", "正在预检工作目录");
      await sandbox.preflightSandboxCwd({
        workdir: message.cwd,
        roots: message.roots || [],
        profile: message.profile,
        isolation: message.isolation,
        network: message.network,
        timeoutMs: options.preflightTimeoutMs ?? sandbox.PREFLIGHT_TIMEOUT_MS,
        probeFn: options.preflightProbe,
      });
      controller.signal.throwIfAborted();

      if (prep) {
        // 校验保留的 worktree / 副本目录仍在受控边界内；仅当目录被清理不存在时重建，超时/越界/路径不一致一律 fail-closed。
        let prepStillPresent = true;
        if (prep.mode !== "direct") {
          if (!prep.taskDir) {
            throw new Error(
              "续接工作目录安全校验失败：缺少受控 taskDir（fail-closed）。",
            );
          }
          const taskDirStat = await fsp.stat(prep.taskDir).catch(() => null);
          if (!taskDirStat?.isDirectory()) {
            prepStillPresent = false;
            reusedPrep = false;
            prep = null;
          } else {
            const taskDirReal = await fsp.realpath(prep.taskDir);
            const tmpRootReal = await fsp.realpath(sandbox.tmpRoot());
            if (!isInside(taskDirReal, [tmpRootReal])) {
              throw new Error(
                "续接工作目录安全校验失败：taskDir 不在受控临时根目录内（fail-closed）。",
              );
            }
          }
        }
        if (prepStillPresent && prep) {
          const prepRoots =
            prep.mode === "direct" ? message.roots || [] : [prep.taskDir];
          try {
            await sandbox.preflightSandboxCwd({
              workdir: prep.workdir,
              roots: prepRoots,
              profile: prep.mode === "direct" ? message.profile : "workspace",
              isolation: message.isolation,
              network: message.network,
              timeoutMs:
                options.preflightTimeoutMs ?? sandbox.PREFLIGHT_TIMEOUT_MS,
              probeFn: options.preflightProbe,
            });
            emit(
              "status",
              `续接同一工作目录：${prep.workdir}`,
              "正在续接上下文",
            );
          } catch (preflightError) {
            const msg = String(preflightError?.message || preflightError || "");
            const missingDir =
              preflightError?.code === "ENOENT" ||
              msg.includes("不存在或不是文件夹");
            if (!missingDir) {
              throw preflightError;
            }
            reusedPrep = false;
            prep = null;
          }
        }
      }
      if (!prep) {
        emit("status", "正在准备工作目录", "正在准备工作目录");
        prep = await sandbox.prepare({
          taskId,
          cwd: message.cwd,
          isolation: message.isolation,
        });
        controller.signal.throwIfAborted();
        for (const note of prep.notes) emit("status", note);
      }

      const cfg = inst?.config || {};
      const instEnv = inst?.env || {};

      // 准备账号隔离的影子 Home（如 Codex shadowHomePath / Claude configDir）
      const shadow = prepareShadowHome({
        driver,
        homePath: cfg.homePath,
        shadowHomePath: cfg.shadowHomePath,
      });
      for (const note of shadow.notes) emit("status", note);

      // 准备外部 Agent 嵌套互调本地桥（当允许嵌套且未达最大深度时）
      if (message.subagentBridge?.enabled) {
        bridge = await createSubagentBridge({
          taskId,
          depth: message.subagentBridge.depth,
          maxDepth: message.subagentBridge.maxDepth,
          enabled: true,
          onSubcall: async (action, params) => {
            const reply = await request(
              subcallPending,
              { type: "agent_subcall", taskId, action, params },
              600_000,
              controller.signal,
            );
            if (!reply.ok) throw new Error(reply.error || "子代理调用失败");
            return reply.data;
          },
        });
      }

      const mergedCustomEnv = {
        ...shadow.env,
        ...instEnv,
        ...(bridge ? bridge.env : {}),
      };

      const approveStep = async (operation, summary, overrideSignal) => {
        const linked = combineAbortSignals(controller.signal, overrideSignal);
        try {
          const reply = await request(
            approvalPending,
            { type: "agent_approval", taskId, operation, summary },
            150_000,
            linked.signal,
          ).catch(() => ({ approved: false }));
          return !!reply.approved;
        } finally {
          linked.cleanup();
        }
      };

      const askUser = async (questions, overrideSignal) => {
        const linked = combineAbortSignals(controller.signal, overrideSignal);
        try {
          return await request(
            userInputPending,
            { type: "agent_needs_input", taskId, questions },
            600_000,
            linked.signal,
          );
        } finally {
          linked.cleanup();
        }
      };

      const startedSessionId = isBuiltin
        ? resumeSessionId || `sess-${taskId}`
        : resumeSessionId;
      started = true;
      out({
        type: "agent_started",
        taskId,
        workdir: prep.workdir,
        sessionId: startedSessionId,
      });
      emit(
        "status",
        reusedPrep
          ? `在同一${prep.mode === "worktree" ? " worktree " : prep.mode === "copy" ? "副本" : "目录"}继续：${prep.workdir}`
          : prep.mode === "direct"
            ? `在 ${prep.workdir} 里工作`
            : `在一次性${prep.mode === "worktree" ? " worktree " : "副本"}里工作：${prep.workdir}`,
        isContinue ? "继续执行任务" : "agent 开始工作",
      );

      let result;
      let nextBuiltinMessages = previousSession?.builtinMessages || null;
      if (driver === "builtin") {
        const model =
          message.builtinModel && message.builtinModel.kind === "local"
            ? (messages, system) =>
                localModel(
                  message.builtinModel,
                  system,
                  messages,
                  controller.signal,
                )
            : async (messages, system) => {
                const reply = await request(
                  llmPending,
                  { type: "agent_llm", taskId, messages, system },
                  180_000,
                  controller.signal,
                );
                if (!reply.ok) throw new Error(reply.error || "模型调用失败");
                return reply.content || [];
              };
        const timer = setTimeout(
          () => controller.abort(new Error("timeout")),
          message.timeoutMs,
        );
        try {
          const outcome = await runBuiltin({
            prompt: message.prompt,
            initialMessages: isContinue
              ? previousSession?.builtinMessages
              : undefined,
            workdir: prep.workdir,
            profile: message.profile,
            roots: message.roots,
            isolation: message.isolation,
            network: message.network,
            containerImage: message.containerImage,
            disposable: prep.mode !== "direct",
            origin: message.cwd,
            signal: controller.signal,
            model,
            approve: approveStep,
            askUser,
            emit,
          });
          nextBuiltinMessages = outcome.messages || nextBuiltinMessages;
          result = {
            exitCode: 0,
            summary: outcome.summary,
            isError: false,
            sessionId: startedSessionId,
          };
        } finally {
          clearTimeout(timer);
        }
      } else if (driver === "acp" || driver === "antigravity") {
        let lookupEnv = { ...process.env, ...mergedCustomEnv };
        const agyInstance =
          driver === "antigravity"
            ? {
                ...(inst || {}),
                driver: "antigravity",
                config: cfg,
                env: mergedCustomEnv,
              }
            : null;
        if (driver === "antigravity") {
          lookupEnv = sanitizeAntigravityEnv(lookupEnv, cfg.fixProxy !== false);
        }
        const resolved = resolveAcpCommand(
          driver,
          cfg,
          lookupEnv,
          agyInstance,
        );
        const sessionEnv =
          driver === "antigravity" && resolved.isolation
            ? resolved.isolation.env
            : lookupEnv;
        if (driver === "antigravity" && resolved.isolation) {
          ensureAntigravityHomeDirs(resolved.isolation);
        }
        if (resolved.mode === "acp") {
          if (!resolved.file) {
            throw new Error(
              resolved.missingReason ||
                `没有找到 ACP 智能体可执行文件（${driver}）`,
            );
          }
          emit("status", `启动 ACP 进程 ${path.basename(resolved.file)}`);
          result = await runAcpSession({
            file: resolved.file,
            args: resolved.args,
            env: sessionEnv,
            workdir: prep.workdir,
            origin: message.cwd,
            disposable: prep.mode !== "direct",
            roots: message.roots,
            profile: message.profile,
            skipPermissions: message.skipPermissions,
            prompt: message.prompt,
            model: cfg.model || null,
            authMethodId: cfg.authMethodId || null,
            mcpServers: bridge ? bridge.acpMcpServers : [],
            resumeSessionId,
            timeoutMs: message.timeoutMs,
            signal: controller.signal,
            approve: approveStep,
            askUser,
            emit,
          });
        } else {
          result = await runCli(message, prep, emit, controller, {
            driver,
            cfg,
            env: mergedCustomEnv,
            bridge,
            resumeSessionId,
            instance: agyInstance,
            antigravityIsolation: resolved.isolation || null,
          });
        }
      } else {
        result = await runCli(message, prep, emit, controller, {
          driver,
          cfg,
          env: mergedCustomEnv,
          bridge,
          resumeSessionId,
        });
      }
      if (controller.signal.aborted)
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("已停止");
      emit("status", "正在统计改动", "正在统计改动");
      const diff = await sandbox.diff(prep).catch(() => null);
      if (diff?.pending && diff.files.length) rememberPrepared(taskId, prep);
      const finalSessionId = isBuiltin
        ? normalizeResumeSessionId(result.sessionId) || startedSessionId
        : supportsExternalResume
          ? normalizeExternalSessionId(result.sessionId, taskId) ||
            normalizeExternalSessionId(resumeSessionId, taskId) ||
            null
          : null;
      const continuable = isBuiltin || Boolean(finalSessionId);
      if (continuable) {
        sessions.set(taskId, {
          prep,
          sessionId: finalSessionId,
          builtinMessages: nextBuiltinMessages,
          lastUsedAt: Date.now(),
        });
        pruneSessions();
      } else {
        sessions.delete(taskId);
        if (prep && prepared.get(taskId) !== prep) {
          await prep.cleanup().catch(() => {});
        }
      }
      out({
        type: "agent_done",
        taskId,
        ok: !result.isError,
        exitCode: result.exitCode,
        summary: String(result.summary || "").slice(0, 8000),
        diff,
        sessionId: finalSessionId,
        continuable,
        ...(result.isError
          ? {
              error: (
                result.stderrTail ||
                result.summary ||
                `退出码 ${result.exitCode}`
              ).slice(-1200),
            }
          : {}),
      });
    } catch (error) {
      const reason =
        error?.message === "timeout"
          ? "超时，已停止。"
          : error?.message
            ? error.message
            : String(error);
      let diff = null;
      let continuable = false;
      const stopped = controller.signal.aborted && reason !== "超时，已停止。";
      const fallbackSessionId = isBuiltin
        ? resumeSessionId || `sess-${taskId}`
        : supportsExternalResume
          ? normalizeExternalSessionId(resumeSessionId, taskId)
          : null;
      const canRetainSession = isBuiltin || Boolean(fallbackSessionId);
      if (prep) {
        if (!started && !reusedPrep) {
          await prep.cleanup().catch(() => {});
        } else {
          diff = stopped ? null : await sandbox.diff(prep).catch(() => null);
          if (diff?.pending && diff.files.length)
            rememberPrepared(taskId, prep);
          if (canRetainSession) {
            // 暂停或失败时保留可续接的 worktree / session 供显式 continue 续接（不丢失已有上下文与文件）。
            sessions.set(taskId, {
              prep,
              sessionId: fallbackSessionId,
              builtinMessages: previousSession?.builtinMessages || null,
              lastUsedAt: Date.now(),
            });
            pruneSessions();
            continuable = true;
          } else {
            sessions.delete(taskId);
            if (prepared.get(taskId) !== prep) {
              await prep.cleanup().catch(() => {});
            }
          }
        }
      }
      out({
        type: "agent_done",
        taskId,
        ok: false,
        error: reason.slice(0, 1200),
        diff,
        stopped,
        sessionId: fallbackSessionId,
        continuable,
      });
    } finally {
      if (bridge) await bridge.close().catch(() => {});
      tasks.delete(taskId);
    }
  }

  async function applyOrDiscard(taskId, apply) {
    if (tasks.has(taskId)) {
      out({
        type: "agent_applied",
        taskId,
        ok: false,
        discarded: !apply,
        error: "任务仍在运行中，禁止在执行期间应用或放弃工作目录。",
      });
      return;
    }
    const prep = prepared.get(taskId);
    if (!prep) {
      out({
        type: "agent_applied",
        taskId,
        ok: false,
        discarded: !apply,
        error:
          "这台电脑上已经没有这次任务的副本了（客户端重启过，或已经处理过）。",
      });
      return;
    }
    if (apply) {
      const result = await sandbox.apply(prep);
      if (!result.ok) {
        out({ type: "agent_applied", taskId, ok: false, error: result.error });
        return;
      }
    }
    prepared.delete(taskId);
    preparedAt.delete(taskId);
    const retained = sessions.get(taskId);
    if (retained && retained.prep === prep) {
      retained.prep = null;
    }
    await prep.cleanup().catch(() => {});
    out({ type: "agent_applied", taskId, ok: true, discarded: !apply });
  }

  void sandbox.sweepOld().catch(() => {});

  return {
    /** core.js 把不认识的消息交给这里；处理了返回 true。 */
    handle(message) {
      if (!message || !HANDLED.has(message.type)) return false;
      switch (message.type) {
        case "agent_detect":
          void detect();
          break;
        case "agent_probe":
          void probe(message);
          break;
        case "agent_runtime_status":
          void handleRuntimeStatus(message);
          break;
        case "agent_runtime_install":
          void handleRuntimeInstall(message);
          break;
        case "agent_runtime_install_cancel":
          handleRuntimeInstallCancel(message);
          break;
        case "agent_runtime_login_start":
          handleRuntimeLoginStart(message);
          break;
        case "agent_runtime_login_submit":
          handleRuntimeLoginSubmit(message);
          break;
        case "agent_runtime_login_cancel":
          handleRuntimeLoginCancel(message);
          break;
        case "agent_runtime_logout":
          void handleRuntimeLogout(message);
          break;
        case "agent_run":
          void run(message, { isContinue: false });
          break;
        case "agent_continue":
          void run(message, { isContinue: true });
          break;
        case "agent_stop": {
          const task = tasks.get(message.taskId);
          if (task) {
            task.controller.abort(new Error("已停止"));
            killTree(task.child);
          }
          break;
        }
        case "agent_apply":
          void applyOrDiscard(message.taskId, true);
          break;
        case "agent_discard":
          void applyOrDiscard(message.taskId, false);
          break;
        case "agent_llm_result":
          resolvePending(llmPending, message);
          break;
        case "agent_approval_result":
          resolvePending(approvalPending, message);
          break;
        case "agent_user_input_result":
          resolvePending(userInputPending, message);
          break;
        case "agent_subcall_result":
          resolvePending(subcallPending, message);
          break;
        default:
      }
      return true;
    },
    /** 连上服务器时：补发断线期间的消息。 */
    onOnline() {
      flush();
    },
    detect,
    get detection() {
      return detection;
    },
    get running() {
      return tasks.size;
    },
    stopAll() {
      for (const task of tasks.values()) {
        task.controller.abort(new Error("已停止"));
        killTree(task.child);
      }
      for (const job of installJobs.values()) {
        const abortErr = new Error("已停止");
        abortErr.name = "AbortError";
        abortErr.cancelled = true;
        job.controller.abort(abortErr);
      }
      loginManager.stopAll();
    },
    pruneSessions,
    async cleanupSessions() {
      clearInterval(sessionSweepTimer);
      const cleanups = new Set();
      for (const entry of sessions.values()) {
        if (entry.prep) cleanups.add(entry.prep);
      }
      for (const prep of prepared.values()) {
        cleanups.add(prep);
      }
      sessions.clear();
      prepared.clear();
      preparedAt.clear();
      for (const prep of cleanups) {
        await prep.cleanup().catch(() => {});
      }
    },
  };
}

module.exports = { createAgentRuntime, lineSplitter };
