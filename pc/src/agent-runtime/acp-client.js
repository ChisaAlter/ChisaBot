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

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const ACP_STDOUT_BUF_CAP = 4 * 1024 * 1024;
const ACP_STDERR_BUF_CAP = 256 * 1024;
const ACP_FULLTEXT_CAP = 512 * 1024;

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {});
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

const WIN_CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;
const WIN_ARG_META_RE = /([()!%^&<>"|])/g;
const WIN_SAFE_ARG_RE = /^[A-Za-z0-9._:+/@\\-]+$/;

/**
 * Windows cmd.exe 命令路径转义（配合 cmd.exe /d /s /c + windowsVerbatimArguments 使用）。
 */
function escapeWinCmdCommand(filePath) {
  return String(filePath ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(WIN_CMD_META_RE, "^$1");
}

/**
 * Windows cmd.exe 参数安全转义（面向 .cmd / .bat 两段解析）：
 * 1) 纯安全简单参数（无空白、引号、= 及 cmd 元字符）原样传递，兼容 `if "%~1"=="--version"` 等批处理写法；
 * 2) 其余参数按 MSVCRT 规则加双引号并转义反斜杠/双引号，再对 cmd.exe 元字符（含 % 与 "）执行两轮 ^ 转义，
 *    阻断 `"` 提前闭合引发的 `&|<>` 命令注入以及 `%VAR%` 环境变量展开。
 */
function quoteWinCmdToken(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (text.length > 0 && WIN_SAFE_ARG_RE.test(text)) {
    return text;
  }
  let escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(WIN_ARG_META_RE, "^$1");
  escaped = escaped.replace(WIN_ARG_META_RE, "^$1");
  return escaped;
}

/**
 * 跨平台安全启动子进程：
 * Windows 下 .cmd / .bat 路径含空格或括号时，直接 spawn(..., { shell: true }) 会被 cmd.exe 截断或触发注入；
 * 统一改为经 ComSpec /d /s /c 传完整外层双引号命令行，并关闭 Node shell 拼接。
 */
function spawnCommand(file, args = [], options = {}) {
  const win = process.platform === "win32";
  const argList = Array.isArray(args) ? args.map(String) : [];
  const isWinBatch = win && /\.(cmd|bat)$/i.test(String(file || ""));
  if (isWinBatch && !options.shell) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const cmdTokens = [
      escapeWinCmdCommand(file),
      ...argList.map(quoteWinCmdToken),
    ];
    const commandLine = `"${cmdTokens.join(" ")}"`;
    const { shell: _ignoredShell, ...restOptions } = options;
    return spawn(comspec, ["/d", "/s", "/c", commandLine], {
      ...restOptions,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, argList, options);
}

/**
 * 合并子进程环境变量：若调用方已传入 env 对象，则尊重其中的删除语义（不把 process.env 中被删除的键重新注回）。
 */
function resolveSpawnEnv(env, extra = {}) {
  const base =
    env && typeof env === "object" ? { ...env } : { ...process.env };
  return { ...base, ...extra };
}

/**
 * Antigravity 环境净化：移除干扰 Electron/Node 宿主变量，并为缺少协议前缀的代理补齐 http://。
 */
function sanitizeAntigravityEnv(env, fixProxy = true) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    const upper = key.toUpperCase();
    if (
      upper === "ELECTRON_RUN_AS_NODE" ||
      upper === "ELECTRON_NO_ATTACH_CONSOLE"
    ) {
      delete next[key];
    }
  }
  if (fixProxy !== false) {
    for (const key of PROXY_KEYS) {
      const val = next[key];
      if (
        typeof val === "string" &&
        val.trim() &&
        !/^[a-z][a-z0-9+.-]*:\/\//i.test(val.trim())
      ) {
        next[key] = `http://${val.trim()}`;
      }
    }
  }
  return next;
}

function createJsonRpcConnection(
  child,
  {
    onNotification,
    onRequest,
    onStderrLine,
    maxStdoutBytes = ACP_STDOUT_BUF_CAP,
    maxStderrBytes = ACP_STDERR_BUF_CAP,
  },
) {
  let seq = 0;
  const pending = new Map();
  let closed = false;
  const stdoutCap = Math.max(1024, Number(maxStdoutBytes) || ACP_STDOUT_BUF_CAP);
  const stderrCap = Math.max(512, Number(maxStderrBytes) || ACP_STDERR_BUF_CAP);

  child.stdin?.on("error", () => {});

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

  function handleStdoutLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined) &&
      !msg.method
    ) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        const message =
          typeof msg.error.message === "string"
            ? msg.error.message
            : JSON.stringify(msg.error);
        entry.reject(
          Object.assign(new Error(message), {
            code: msg.error.code,
            data: msg.error.data,
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
    } else if (msg.id !== undefined && typeof msg.method === "string") {
      Promise.resolve()
        .then(() =>
          onRequest
            ? onRequest(msg.method, msg.params || {})
            : Promise.reject(new Error(`不支持的客户端方法: ${msg.method}`)),
        )
        .then(
          (result) =>
            sendRaw({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }),
          (err) =>
            sendRaw({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32000,
                message: err?.message ? err.message : String(err),
              },
            }),
        );
    } else if (typeof msg.method === "string") {
      if (onNotification) onNotification(msg.method, msg.params || {});
    }
  }

  let outBuf = "";
  let outDropping = false;
  child.stdout?.on("data", (chunk) => {
    let text = String(chunk);
    if (outDropping) {
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      outDropping = false;
      text = text.slice(nl + 1);
      if (!text) return;
    }
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const seg = text.slice(start, nl);
      start = nl + 1;
      if (Buffer.byteLength(outBuf, "utf8") + Buffer.byteLength(seg, "utf8") > stdoutCap) {
        outBuf = "";
        continue;
      }
      const line = `${outBuf}${seg}`.replace(/\r$/, "").trim();
      outBuf = "";
      handleStdoutLine(line);
    }
    const tail = start > 0 ? text.slice(start) : text;
    if (tail) {
      if (
        Buffer.byteLength(outBuf, "utf8") + Buffer.byteLength(tail, "utf8") >
        stdoutCap
      ) {
        outBuf = "";
        outDropping = true;
      } else {
        outBuf += tail;
      }
    }
  });

  let errBuf = "";
  let errDropping = false;
  child.stderr?.on("data", (chunk) => {
    let text = String(chunk);
    if (errDropping) {
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      errDropping = false;
      text = text.slice(nl + 1);
      if (!text) return;
    }
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const seg = text.slice(start, nl);
      start = nl + 1;
      let line = `${errBuf}${seg}`.replace(/\r$/, "").trim();
      errBuf = "";
      if (Buffer.byteLength(line, "utf8") > stderrCap) {
        line = `${line.slice(0, Math.min(4096, stderrCap))}…（stderr 行过长已截断）`;
      }
      if (line && onStderrLine) onStderrLine(line);
    }
    const tail = start > 0 ? text.slice(start) : text;
    if (tail) {
      if (
        Buffer.byteLength(errBuf, "utf8") + Buffer.byteLength(tail, "utf8") >
        stderrCap
      ) {
        const preview = `${errBuf}${tail}`
          .slice(0, Math.min(4096, stderrCap))
          .trim();
        errBuf = "";
        errDropping = true;
        if (preview && onStderrLine) {
          onStderrLine(`${preview}…（stderr 缓冲超限已截断）`);
        }
      } else {
        errBuf += tail;
      }
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
  child.on("close", (code) =>
    closeAll(new Error(`ACP 进程已退出（退出码 ${code ?? "null"}）`)),
  );

  return { request, notify, closeAll };
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(extractTextFromContent).filter(Boolean).join("");
  if (content.type === "text" && typeof content.text === "string")
    return content.text;
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
  if (
    targNorm === origNorm ||
    targNorm.startsWith(
      origNorm.endsWith(path.sep) ? origNorm : origNorm + path.sep,
    )
  ) {
    return path.join(workdir, path.relative(origNorm, targNorm));
  }
  return target;
}

function formatAcpAuthLabel(authMethods) {
  if (!Array.isArray(authMethods) || authMethods.length === 0) {
    return "ACP 就绪";
  }
  const names = authMethods
    .map((m) => String(m?.name || m?.id || "").trim())
    .filter(Boolean);
  if (names.length === 0 || names.length > 2) {
    return "ACP 就绪";
  }
  const joined = names.join(" / ");
  return joined.length > 24 ? "ACP 就绪" : `支持 ${joined}`;
}

/**
 * 探活 ACP 智能体：启动进程并发 initialize 请求，读取版本与认证信息后立即退出。
 */
async function probeAcpAgent({
  file,
  args = [],
  env,
  cwd = process.cwd(),
  timeoutMs = 10_000,
}) {
  const win = process.platform === "win32";
  let child;
  let stderrTail = "";
  try {
    child = spawnCommand(file, args, {
      cwd,
      env: resolveSpawnEnv(env, { NO_COLOR: "1", FORCE_COLOR: "0" }),
      windowsHide: true,
      detached: !win,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      status: "missing",
      version: null,
      authenticated: null,
      authLabel: null,
      message: error?.message ? error.message : String(error),
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
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      },
      timeoutMs,
    );
    const info = init?.agentInfo || {};
    const authMethods = Array.isArray(init?.authMethods)
      ? init.authMethods
      : [];
    const version = info.version ? String(info.version) : null;
    return {
      status: "available",
      version,
      authenticated: authMethods.length === 0 ? true : null,
      authLabel: formatAcpAuthLabel(authMethods),
      message: info.title || info.name || null,
    };
  } catch (error) {
    return {
      status: "error",
      version: null,
      authenticated: null,
      authLabel: null,
      message: (stderrTail.trim() || error?.message || String(error)).slice(
        0,
        300,
      ),
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
  env,
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
  resumeSessionId = null,
  timeoutMs = 600_000,
  maxFullTextChars = ACP_FULLTEXT_CAP,
  signal,
  approve,
  askUser,
  emit,
}) {
  const win = process.platform === "win32";
  const scope = disposable ? [workdir] : [workdir, ...(roots || [])];
  const terminals = new Map();
  let termSeq = 0;
  let stderrTail = "";
  let fullText = "";
  let fullTextTruncated = false;
  const fullTextCap = Math.max(
    1024,
    Number(maxFullTextChars) || ACP_FULLTEXT_CAP,
  );
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
    for (;;) {
      const idx = lineBuffer.indexOf("\n");
      if (idx < 0) break;
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

  const sessionAbortController = new AbortController();

  async function checkGate(operation, targetPath, summaryText) {
    if (profile === "full" || skipPermissions) return true;
    const isRead = operation === "read_file";
    if (isRead) {
      if (!targetPath || isInside(real(targetPath), scope)) return true;
      if (!approve) return false;
      emit(
        "approval",
        `需要你批准：${summaryText}（不在工作区文件夹里）`,
        "等待你批准",
      );
      return !!(await approve(
        "read_file",
        `${summaryText}（不在工作区文件夹里）`,
        sessionAbortController.signal,
      ));
    }
    if (profile === "readonly") {
      if (!approve) return false;
      emit(
        "approval",
        `需要你批准：${summaryText}（当前是只读档位）`,
        "等待你批准",
      );
      return !!(await approve(
        operation,
        `${summaryText}（当前是只读档位）`,
        sessionAbortController.signal,
      ));
    }
    if (targetPath && !isInside(real(targetPath), scope)) {
      if (!approve) return false;
      emit(
        "approval",
        `需要你批准：${summaryText}（不在工作区文件夹里）`,
        "等待你批准",
      );
      return !!(await approve(
        operation,
        `${summaryText}（不在工作区文件夹里）`,
        sessionAbortController.signal,
      ));
    }
    return true;
  }

  let child;
  try {
    child = spawnCommand(file, args, {
      cwd: workdir,
      env: resolveSpawnEnv(env, { NO_COLOR: "1", FORCE_COLOR: "0" }),
      windowsHide: true,
      detached: !win,
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
          if (fullText.length < fullTextCap) {
            const remain = fullTextCap - fullText.length;
            if (chunk.length <= remain) {
              fullText += chunk;
            } else {
              fullText += chunk.slice(0, remain);
              fullTextTruncated = true;
            }
          } else {
            fullTextTruncated = true;
          }
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
      } else if (
        kind === "plan" &&
        Array.isArray(update.entries) &&
        update.entries.length
      ) {
        const active =
          update.entries.find((e) => e.status === "in_progress") ||
          update.entries[0];
        if (active?.content) {
          emit(
            "status",
            `计划：${String(active.content).slice(0, 140)}`,
            String(active.content).slice(0, 100),
          );
        }
      }
    },
    async onRequest(method, params) {
      if (
        method === "item/tool/requestUserInput" ||
        method === "session/request_user_input"
      ) {
        const rawQuestions = Array.isArray(params.questions)
          ? params.questions
          : [];
        if (!askUser || !rawQuestions.length) {
          throw new Error("当前会话不支持交互式用户追问。");
        }
        const questions = rawQuestions.map((q, index) => ({
          id: String(q?.id || `q_${index + 1}`),
          ...(typeof q?.header === "string" && q.header.trim()
            ? { header: q.header.trim() }
            : {}),
          question: String(q?.question || q?.prompt || "请补充决策信息"),
          ...(Array.isArray(q?.options)
            ? {
                options: q.options
                  .filter((opt) => opt && typeof opt.label === "string")
                  .map((opt) => ({
                    label: String(opt.label),
                    ...(typeof opt.description === "string"
                      ? { description: opt.description }
                      : {}),
                  })),
              }
            : {}),
          allowMultiple: q?.allowMultiple === true || q?.multiSelect === true,
          required: q?.required !== false,
        }));
        const reply = await askUser(questions, sessionAbortController.signal);
        if (reply?.cancelled) {
          throw new Error(reply.reason || "用户取消了追问。");
        }
        const rawAnswers =
          reply?.answers && typeof reply.answers === "object"
            ? reply.answers
            : {};
        return {
          answers: Object.fromEntries(
            questions.map((q) => [
              q.id,
              {
                answers: Array.isArray(rawAnswers[q.id])
                  ? rawAnswers[q.id].map((v) => String(v))
                  : [],
              },
            ]),
          ),
        };
      }

      if (method === "session/request_permission") {
        const options = Array.isArray(params.options) ? params.options : [];
        const allowOpt =
          options.find((o) => o.kind === "allow_once") ||
          options.find((o) => o.kind === "allow_always") ||
          options.find((o) =>
            /allow|approve|accept|yes/i.test(
              `${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`,
            ),
          ) ||
          options[0];
        const rejectOpt =
          options.find((o) => o.kind === "reject_once") ||
          options.find((o) =>
            /reject|deny|cancel|no/i.test(
              `${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`,
            ),
          );

        const toolCall = params.toolCall || {};
        const title = String(toolCall.title || toolCall.kind || "执行工具操作");
        const isReadKind = /^(read|search|fetch|think)$/i.test(
          String(toolCall.kind || ""),
        );
        let allowed = false;
        if (skipPermissions || profile === "full") {
          allowed = true;
        } else if (isReadKind) {
          allowed = true;
        } else if (profile === "workspace") {
          const locations = Array.isArray(toolCall.locations)
            ? toolCall.locations
            : [];
          const allInScope = locations.every(
            (loc) =>
              !loc?.path ||
              isInside(real(path.resolve(workdir, loc.path)), scope),
          );
          if (allInScope && !(disposable && origin && title.includes(origin))) {
            allowed = true;
          }
        }
        if (!allowed && approve) {
          emit("approval", `需要你批准：${title}`, "等待你批准");
          allowed = !!(await approve(
            "shell",
            title,
            sessionAbortController.signal,
          ));
        }
        if (allowed && allowOpt) {
          return {
            outcome: { outcome: "selected", optionId: allowOpt.optionId },
          };
        }
        if (rejectOpt) {
          return {
            outcome: { outcome: "selected", optionId: rejectOpt.optionId },
          };
        }
        return { outcome: { outcome: "cancelled" } };
      }

      if (method === "fs/read_text_file") {
        const target = mapDisposablePath(
          params.path,
          workdir,
          origin,
          disposable,
        );
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
        const target = mapDisposablePath(
          params.path,
          workdir,
          origin,
          disposable,
        );
        const ok = await checkGate("write_file", target, `写入 ${params.path}`);
        if (!ok) throw new Error("用户拒绝写入该文件");
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, String(params.content ?? ""), "utf8");
        emit(
          "tool",
          `写入 ${path.relative(workdir, target) || target}`,
          `写入 ${path.basename(target)}`,
        );
        return {};
      }

      if (method === "terminal/create") {
        const cmd = String(params.command || "");
        const cmdArgs = Array.isArray(params.args)
          ? params.args.map(String)
          : [];
        const termCwd = params.cwd
          ? mapDisposablePath(params.cwd, workdir, origin, disposable)
          : workdir;
        const label = `运行 ${cmd} ${cmdArgs.join(" ")}`.trim().slice(0, 140);
        const ok = await checkGate("shell", termCwd, label);
        if (!ok) throw new Error("用户拒绝运行该终端命令");
        emit("tool", label, label);
        const terminalId = `term_${++termSeq}`;
        const termEnv = resolveSpawnEnv(env);
        if (Array.isArray(params.env)) {
          for (const item of params.env) {
            if (item?.name) termEnv[item.name] = String(item.value ?? "");
          }
        }
        const proc = spawnCommand(cmd, cmdArgs, {
          cwd: fs.existsSync(termCwd) ? termCwd : workdir,
          env: termEnv,
          windowsHide: true,
          detached: !win,
          ...(cmdArgs.length === 0 ? { shell: true } : {}),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const byteLimit = Math.min(
          2_000_000,
          Math.max(8192, Number(params.outputByteLimit) || 256_000),
        );
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
    if (!sessionAbortController.signal.aborted) {
      sessionAbortController.abort(new Error("timeout"));
    }
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    killTree(child);
  }, timeoutMs);

  const onAbort = () => {
    if (!sessionAbortController.signal.aborted) {
      sessionAbortController.abort(signal?.reason || new Error("已停止"));
    }
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    setTimeout(() => killTree(child), 250);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const init = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "ChisaBot", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      },
      30_000,
    );
    const agentInfo = init?.agentInfo || {};
    emit(
      "status",
      `ACP 会话已连接${agentInfo.title || agentInfo.name ? `（${agentInfo.title || agentInfo.name}${agentInfo.version ? ` v${agentInfo.version}` : ""}）` : ""}`,
      "ACP 会话已连接",
    );

    if (authMethodId) {
      await rpc
        .request("authenticate", { methodId: authMethodId }, 30_000)
        .catch(() => {});
    }

    if (resumeSessionId) {
      let resumed = false;
      for (const methodName of ["session/load", "thread/resume"]) {
        try {
          const loaded = await rpc.request(
            methodName,
            {
              sessionId: resumeSessionId,
              threadId: resumeSessionId,
              cwd: workdir,
              mcpServers: mcpServers || [],
            },
            30_000,
          );
          sessionId =
            loaded?.sessionId || loaded?.thread?.id || resumeSessionId;
          resumed = true;
          emit("status", `已续接 ACP 上下文（${sessionId}）`, "已续接上下文");
          break;
        } catch {
          // 当前 ACP 实现不支持该续接方法时尝试下一个或新建会话
        }
      }
      if (!resumed) {
        const created = await rpc.request(
          "session/new",
          {
            cwd: workdir,
            mcpServers: mcpServers || [],
          },
          45_000,
        );
        sessionId = created?.sessionId;
      }
    } else {
      const created = await rpc.request(
        "session/new",
        {
          cwd: workdir,
          mcpServers: mcpServers || [],
        },
        45_000,
      );
      sessionId = created?.sessionId;
    }
    if (!sessionId) throw new Error("ACP 智能体未返回有效的 sessionId");

    if (model) {
      await rpc
        .request("session/set_model", { sessionId, modelId: model }, 10_000)
        .catch(() => {});
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
    const stopReason = promptResult?.stopReason;
    const trimmedFullText = fullText.trim();
    const summaryText = trimmedFullText
      ? fullTextTruncated
        ? `${trimmedFullText}\n…（输出超过上限已截断）`
        : trimmedFullText
      : `（ACP 会话完成${stopReason ? `：${stopReason}` : ""}）`;
    return {
      exitCode: 0,
      summary: summaryText,
      isError: false,
      stderrTail,
      sessionId,
    };
  } catch (error) {
    flushTextLine(true);
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("已停止");
    }
    return {
      exitCode: 1,
      summary: fullText.trim(),
      isError: true,
      stderrTail:
        stderrTail || (error?.message ? error.message : String(error)),
      sessionId,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (!sessionAbortController.signal.aborted) {
      sessionAbortController.abort(new Error("closed"));
    }
    cleanupTerminals();
    rpc.closeAll();
    killTree(child);
  }
}

module.exports = {
  ACP_STDOUT_BUF_CAP,
  ACP_STDERR_BUF_CAP,
  ACP_FULLTEXT_CAP,
  probeAcpAgent,
  runAcpSession,
  sanitizeAntigravityEnv,
  createJsonRpcConnection,
  killTree,
  spawnCommand,
  quoteWinCmdToken,
  resolveSpawnEnv,
  formatAcpAuthLabel,
};
