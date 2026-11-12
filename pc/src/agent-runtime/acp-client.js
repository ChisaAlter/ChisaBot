"use strict";
/**
 * 原生轻量级 ACP（Agent Client Protocol）stdio JSON-RPC 2.0 客户端。
 *
 * 零外部重依赖，支持：
 * - probeAcpAgent：发送 initialize 握手获取智能体名称、版本与认证方式；
 * - runAcpSession：完整驱动 initialize -> (authenticate) -> session/new -> session/prompt，
 *   流式消费 session/update（文本块、工具调用、思考进度），并在权限档位门控下响应
 *   session/request_permission、fs/read_text_file、fs/write_text_file 与 terminal/* 请求。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isInside, real } = require("./profile");

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/**
 * Antigravity 环境净化：移除干扰 Electron/Node 宿主变量，并为缺少协议前缀的代理补齐 http://。
 */
function sanitizeAntigravityEnv(env, fixProxy = true) {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.ELECTRON_NO_ATTACH_CONSOLE;
  if (fixProxy !== false) {
    for (const key of PROXY_KEYS) {
      const val = next[key];
      if (typeof val === "string" && val.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(val.trim())) {
        next[key] = `http://${val.trim()}`;
      }
    }
  }
  return next;
}

function createJsonRpcConnection(child, { onNotification, onRequest, onStderrLine }) {
  let seq = 0;
  const pending = new Map();
  let closed = false;

  function sendRaw(payload) {
    if (closed || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {}
  }

  function request(method, params, timeoutMs = 60_000) {
    if (closed) return Promise.reject(new Error("ACP 进程已退出"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`ACP 请求 ${method} 超时`));
            }, timeoutMs)
          : null;
      pending.set(id, {
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method, params) {
    sendRaw({ jsonrpc: "2.0", method, params });
  }

  let outBuf = "";
  child.stdout.on("data", (chunk) => {
    outBuf += String(chunk);
    let idx;
    while ((idx = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, idx).replace(/\r$/, "").trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
        const entry = pending.get(msg.id);
        if (!entry) continue;
        pending.delete(msg.id);
        if (msg.error) {
          const message = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
          entry.reject(Object.assign(new Error(message), { code: msg.error.code, data: msg.error.data }));
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.id !== undefined && typeof msg.method === "string") {
        Promise.resolve()
          .then(() => (onRequest ? onRequest(msg.method, msg.params || {}) : Promise.reject(new Error(`不支持的客户端方法: ${msg.method}`))))
          .then(
            (result) => sendRaw({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }),
            (err) =>
              sendRaw({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: err && err.message ? err.message : String(err) },
              }),
          );
      } else if (typeof msg.method === "string") {
        if (onNotification) onNotification(msg.method, msg.params || {});
      }
    }
  });

  let errBuf = "";
  child.stderr.on("data", (chunk) => {
    errBuf += String(chunk);
    let idx;
    while ((idx = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, idx).replace(/\r$/, "").trim();
      errBuf = errBuf.slice(idx + 1);
      if (line && onStderrLine) onStderrLine(line);
    }
  });

  function closeAll(reason) {
    if (closed) return;
    closed = true;
    for (const [, entry] of pending) {
      entry.reject(reason || new Error("ACP 连接已关闭"));
    }
    pending.clear();
  }

  child.on("error", (err) => closeAll(err));
  child.on("close", (code) => closeAll(new Error(`ACP 进程已退出（退出码 ${code ?? "null"}）`)));

  return { request, notify, closeAll };
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractTextFromContent).filter(Boolean).join("");
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (typeof content.text === "string") return content.text;
  return "";
}

function mapDisposablePath(rawPath, workdir, origin, disposable) {
  const target = path.resolve(workdir, String(rawPath || "."));
  if (!disposable || !origin) return target;
  const win = process.platform === "win32";
  const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
  const origNorm = norm(origin);
  const targNorm = norm(target);
  if (targNorm === origNorm || targNorm.startsWith(origNorm.endsWith(path.sep) ? origNorm : origNorm + path.sep)) {
    return path.join(workdir, path.relative(origNorm, targNorm));
  }
  return target;
}

/**
 * 探活 ACP 智能体：启动进程并发 initialize 请求，读取版本与认证信息后立即退出。
 */
async function probeAcpAgent({ file, args = [], env = {}, cwd = process.cwd(), timeoutMs = 10_000 }) {
  const win = process.platform === "win32";
  let child;
  let stderrTail = "";
  try {
    child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
      detached: !win,
      shell: win && /\.(cmd|bat)$/i.test(file),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      status: "missing",
      version: null,
      authenticated: null,
      authLabel: null,
      message: error && error.message ? error.message : String(error),
    };
  }

  const rpc = createJsonRpcConnection(child, {
    onStderrLine: (line) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-600);
    },
  });

  try {
    const init = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "ChisaBot", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      },
      timeoutMs,
    );
    const info = (init && init.agentInfo) || {};
    const authMethods = Array.isArray(init && init.authMethods) ? init.authMethods : [];
    const version = info.version ? String(info.version) : null;
    return {
      status: "available",
      version,
      authenticated: authMethods.length === 0 ? true : null,
      authLabel: authMethods.length ? `支持 ${authMethods.map((m) => m.name || m.id).join(" / ")}` : "ACP 就绪",
      message: info.title || info.name || null,
    };
  } catch (error) {
    return {
      status: "error",
      version: null,
      authenticated: null,
      authLabel: null,
      message: (stderrTail.trim() || (error && error.message) || String(error)).slice(0, 300),
    };
  } finally {
    rpc.closeAll();
    killTree(child);
  }
}

/**
 * 运行一次完整的 ACP 会话任务。
 */
async function runAcpSession({
  file,
  args = [],
  env = {},
  workdir,
  origin,
  disposable = false,
  roots = [],
  profile = "workspace",
  skipPermissions = false,
  prompt,
  model = null,
  authMethodId = null,
  mcpServers = [],
  timeoutMs = 600_000,
  signal,
  approve,
  emit,
}) {
  const win = process.platform === "win32";
  const scope = disposable ? [workdir] : [workdir, ...(roots || [])];
  const terminals = new Map();
  let termSeq = 0;
  let stderrTail = "";
  let fullText = "";
  let lineBuffer = "";
  const seenToolIds = new Set();

  function flushTextLine(force = false) {
    if (!lineBuffer) return;
    if (force) {
      const trimmed = lineBuffer.trim();
      if (trimmed) emit("text", trimmed);
      lineBuffer = "";
      return;
    }
    let idx;
    while ((idx = lineBuffer.indexOf("\n")) >= 0) {
      const piece = lineBuffer.slice(0, idx).trimEnd();
      lineBuffer = lineBuffer.slice(idx + 1);
      if (piece.trim()) emit("text", piece);
    }
    if (lineBuffer.length > 600) {
      emit("text", lineBuffer);
      lineBuffer = "";
    }
  }

  function cleanupTerminals() {
    for (const term of terminals.values()) {
      killTree(term.child);
    }
    terminals.clear();
  }

  async function checkGate(operation, targetPath, summaryText) {
    if (profile === "full" || skipPermissions) return true;
    const isRead = operation === "read_file";
    if (isRead) {
      if (!targetPath || isInside(real(targetPath), scope)) return true;
      if (!approve) return false;
      emit("approval", `需要你批准：${summaryText}（不在工作区文件夹里）`, "等待你批准");
      return !!(await approve("read_file", `${summaryText}（不在工作区文件夹里）`));
    }
    if (profile === "readonly") {
      if (!approve) return false;
      emit("approval", `需要你批准：${summaryText}（当前是只读档位）`, "等待你批准");
      return !!(await approve(operation, `${summaryText}（当前是只读档位）`));
    }
    if (targetPath && !isInside(real(targetPath), scope)) {
      if (!approve) return false;
      emit("approval", `需要你批准：${summaryText}（不在工作区文件夹里）`, "等待你批准");
      return !!(await approve(operation, `${summaryText}（不在工作区文件夹里）`));
    }
    return true;
  }

  let child;
  try {
    child = spawn(file, args, {
      cwd: workdir,
      env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
      detached: !win,
      shell: win && /\.(cmd|bat)$/i.test(file),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`无法启动 ACP 智能体（${file}）：${error.message}`);
  }

  let sessionId = null;

  const rpc = createJsonRpcConnection(child, {
    onStderrLine(line) {
      stderrTail = `${stderrTail}\n${line}`.slice(-1500);
      emit("stderr", line);
    },
    onNotification(method, params) {
      if (method !== "session/update") return;
      const update = params.update || params;
      const kind = update.sessionUpdate || update.type;
      if (kind === "agent_message_chunk") {
        const chunk = extractTextFromContent(update.content);
        if (chunk) {
          fullText += chunk;
          lineBuffer += chunk;
          flushTextLine(false);
        }
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const id = update.toolCallId || "";
        const title = update.title || update.name || update.kind || "";
        if (title && (!id || !seenToolIds.has(`${id}:${title}`))) {
          if (id) seenToolIds.add(`${id}:${title}`);
          emit("tool", String(title), String(title));
        }
      } else if (kind === "plan" && Array.isArray(update.entries) && update.entries.length) {
        const active = update.entries.find((e) => e.status === "in_progress") || update.entries[0];
        if (active && active.content) {
          emit("status", `计划：${String(active.content).slice(0, 140)}`, String(active.content).slice(0, 100));
        }
      }
    },
    async onRequest(method, params) {
      if (method === "session/request_permission") {
        const options = Array.isArray(params.options) ? params.options : [];
        const allowOpt =
          options.find((o) => o.kind === "allow_once") ||
          options.find((o) => o.kind === "allow_always") ||
          options.find((o) => /allow|approve|accept|yes/i.test(`${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`)) ||
          options[0];
        const rejectOpt =
          options.find((o) => o.kind === "reject_once") ||
          options.find((o) => /reject|deny|cancel|no/i.test(`${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`));

        const toolCall = params.toolCall || {};
        const title = String(toolCall.title || toolCall.kind || "执行工具操作");
        const isReadKind = /^(read|search|fetch|think)$/i.test(String(toolCall.kind || ""));
        let allowed = false;
        if (skipPermissions || profile === "full") {
          allowed = true;
        } else if (isReadKind) {
          allowed = true;
        } else if (profile === "workspace") {
          const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
          const allInScope = locations.every((loc) => !loc || !loc.path || isInside(real(path.resolve(workdir, loc.path)), scope));
          if (allInScope && !(disposable && origin && title.includes(origin))) {
            allowed = true;
          }
        }
        if (!allowed && approve) {
          emit("approval", `需要你批准：${title}`, "等待你批准");
          allowed = !!(await approve("shell", title));
        }
        if (allowed && allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
        }
        if (rejectOpt) {
          return { outcome: { outcome: "selected", optionId: rejectOpt.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      }

      if (method === "fs/read_text_file") {
        const target = mapDisposablePath(params.path, workdir, origin, disposable);
        const ok = await checkGate("read_file", target, `读取 ${params.path}`);
        if (!ok) throw new Error("用户拒绝读取该工作区外文件");
        const content = await fsp.readFile(target, "utf8");
        if (params.line || params.limit) {
          const lines = content.split(/\r?\n/);
          const start = Math.max(1, Number(params.line) || 1) - 1;
          const count = Math.max(1, Number(params.limit) || lines.length);
          return { content: lines.slice(start, start + count).join("\n") };
        }
        return { content };
      }

      if (method === "fs/write_text_file") {
        const target = mapDisposablePath(params.path, workdir, origin, disposable);
        const ok = await checkGate("write_file", target, `写入 ${params.path}`);
        if (!ok) throw new Error("用户拒绝写入该文件");
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, String(params.content ?? ""), "utf8");
        emit("tool", `写入 ${path.relative(workdir, target) || target}`, `写入 ${path.basename(target)}`);
        return {};
      }

      if (method === "terminal/create") {
        const cmd = String(params.command || "");
        const cmdArgs = Array.isArray(params.args) ? params.args.map(String) : [];
        const termCwd = params.cwd ? mapDisposablePath(params.cwd, workdir, origin, disposable) : workdir;
        const label = `运行 ${cmd} ${cmdArgs.join(" ")}`.trim().slice(0, 140);
        const ok = await checkGate("shell", termCwd, label);
        if (!ok) throw new Error("用户拒绝运行该终端命令");
        emit("tool", label, label);
        const terminalId = `term_${++termSeq}`;
        const termEnv = { ...process.env, ...env };
        if (Array.isArray(params.env)) {
          for (const item of params.env) {
            if (item && item.name) termEnv[item.name] = String(item.value ?? "");
          }
        }
        const proc = spawn(cmd, cmdArgs, {
          cwd: fs.existsSync(termCwd) ? termCwd : workdir,
          env: termEnv,
          windowsHide: true,
          detached: !win,
          shell: cmdArgs.length === 0 || (win && /\.(cmd|bat)$/i.test(cmd)),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const byteLimit = Math.min(2_000_000, Math.max(8192, Number(params.outputByteLimit) || 256_000));
        const state = {
          child: proc,
          output: "",
          truncated: false,
          exitStatus: null,
          exitPromise: null,
        };
        const append = (chunk) => {
          state.output += String(chunk);
          if (state.output.length > byteLimit) {
            state.output = state.output.slice(-byteLimit);
            state.truncated = true;
          }
        };
        proc.stdout.on("data", append);
        proc.stderr.on("data", append);
        state.exitPromise = new Promise((resolve) => {
          proc.on("close", (code, sig) => {
            state.exitStatus = { exitCode: code ?? 0, signal: sig || null };
            resolve(state.exitStatus);
          });
          proc.on("error", () => {
            state.exitStatus = { exitCode: 1, signal: null };
            resolve(state.exitStatus);
          });
        });
        terminals.set(terminalId, state);
        return { terminalId };
      }

      if (method === "terminal/output") {
        const term = terminals.get(params.terminalId);
        if (!term) throw new Error(`未知终端: ${params.terminalId}`);
        return {
          output: term.output,
          truncated: term.truncated,
          ...(term.exitStatus ? { exitStatus: term.exitStatus } : {}),
        };
      }

      if (method === "terminal/wait_for_exit") {
        const term = terminals.get(params.terminalId);
        if (!term) throw new Error(`未知终端: ${params.terminalId}`);
        const status = await term.exitPromise;
        return status;
      }

      if (method === "terminal/kill") {
        const term = terminals.get(params.terminalId);
        if (term) killTree(term.child);
        return {};
      }

      if (method === "terminal/release") {
        const term = terminals.get(params.terminalId);
        if (term) {
          killTree(term.child);
          terminals.delete(params.terminalId);
        }
        return {};
      }

      throw new Error(`未实现的 ACP 客户端方法: ${method}`);
    },
  });

  const timer = setTimeout(() => {
    emit("status", `超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止`);
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    killTree(child);
  }, timeoutMs);

  const onAbort = () => {
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    setTimeout(() => killTree(child), 250);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const init = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "ChisaBot", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      },
      30_000,
    );
    const agentInfo = (init && init.agentInfo) || {};
    emit(
      "status",
      `ACP 会话已连接${agentInfo.title || agentInfo.name ? `（${agentInfo.title || agentInfo.name}${agentInfo.version ? ` v${agentInfo.version}` : ""}）` : ""}`,
      "ACP 会话已连接",
    );

    if (authMethodId) {
      await rpc.request("authenticate", { methodId: authMethodId }, 30_000).catch(() => {});
    }

    const created = await rpc.request(
      "session/new",
      {
        cwd: workdir,
        mcpServers: mcpServers || [],
      },
      45_000,
    );
    sessionId = created && created.sessionId;
    if (!sessionId) throw new Error("ACP 智能体未返回有效的 sessionId");

    if (model) {
      await rpc.request("session/set_model", { sessionId, modelId: model }, 10_000).catch(() => {});
    }

    const promptResult = await rpc.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      },
      timeoutMs,
    );
    flushTextLine(true);
    const stopReason = promptResult && promptResult.stopReason;
    return {
      exitCode: 0,
      summary: fullText.trim() || `（ACP 会话完成${stopReason ? `：${stopReason}` : ""}）`,
      isError: false,
      stderrTail,
    };
  } catch (error) {
    flushTextLine(true);
    if (signal && signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("已停止");
    }
    return {
      exitCode: 1,
      summary: fullText.trim(),
      isError: true,
      stderrTail: stderrTail || (error && error.message ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    cleanupTerminals();
    rpc.closeAll();
    killTree(child);
  }
}

module.exports = {
  probeAcpAgent,
  runAcpSession,
  sanitizeAntigravityEnv,
  createJsonRpcConnection,
};
