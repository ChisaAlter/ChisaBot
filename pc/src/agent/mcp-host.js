"use strict";

/**
 * PC 端原生 stdio MCP 沙盒执行器与本机配置只读发现。
 *
 * 1. 所有子进程调用强制 shell: false + 引号分词 + shell 元字符拒绝。
 * 2. 子进程环境变量白名单裁剪，显式剔除 ChisaBot / 数据库 / 动态注入变量。
 * 3. 本机 MCP 配置发现只读返回服务端清单与 key 名，不回传任何真实环境变量或 Header 密钥。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SHELL_METACHAR_ERROR =
  "命令包含不允许的 shell 元字符，请直接提供可执行文件与参数。";
const DEFAULT_TIMEOUT_MS = 25_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * 固定字节上限的尾部环形 stderr 缓冲区：
 * 持续保留最近 `maxBytes` 的尾端输出，并在发生滚动覆盖时标记 `truncated = true`。
 */
class StderrRingBuffer {
  constructor(maxBytes = MAX_STDERR_BYTES) {
    this.maxBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : MAX_STDERR_BYTES;
    this._chunks = [];
    this._bytes = 0;
    this._truncated = false;
    this._droppedBytes = 0;
    this._totalBytes = 0;
  }

  get bytes() {
    return this._bytes;
  }

  get truncated() {
    return this._truncated;
  }

  get droppedBytes() {
    return this._droppedBytes;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  append(chunk) {
    if (chunk === null || chunk === undefined) return;
    let buf;
    if (Buffer.isBuffer(chunk)) {
      buf = chunk;
    } else if (chunk instanceof Uint8Array) {
      buf = Buffer.from(chunk);
    } else {
      const str = String(chunk);
      if (!str) return;
      buf = Buffer.from(str, "utf8");
    }
    if (buf.length === 0) return;

    this._totalBytes += buf.length;
    if (buf.length >= this.maxBytes) {
      const overflow = this._bytes + buf.length - this.maxBytes;
      if (overflow > 0) {
        this._truncated = true;
        this._droppedBytes += overflow;
      }
      const tail = buf.subarray(buf.length - this.maxBytes);
      this._chunks = [tail];
      this._bytes = tail.length;
      return;
    }

    this._chunks.push(buf);
    this._bytes += buf.length;
    while (this._bytes > this.maxBytes && this._chunks.length > 0) {
      this._truncated = true;
      const excess = this._bytes - this.maxBytes;
      const head = this._chunks[0];
      if (head.length <= excess) {
        this._chunks.shift();
        this._bytes -= head.length;
        this._droppedBytes += head.length;
      } else {
        this._chunks[0] = head.subarray(excess);
        this._bytes -= excess;
        this._droppedBytes += excess;
      }
    }
  }

  toString() {
    if (this._chunks.length === 0) return "";
    let merged =
      this._chunks.length === 1
        ? this._chunks[0]
        : Buffer.concat(this._chunks, this._bytes);
    if (this._truncated && merged.length > 0) {
      // 跳过前部被截断的 UTF-8 续字节（10xxxxxx），避免尾部首字符出现乱码替换符。
      let offset = 0;
      while (
        offset < merged.length &&
        offset < 3 &&
        (merged[offset] & 0xc0) === 0x80
      ) {
        offset += 1;
      }
      if (offset > 0) {
        merged = merged.subarray(offset);
      }
    }
    return merged.toString("utf8");
  }
}

const ALLOWED_ENV_KEYS_UPPER = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const BLOCKED_ENV_EXACT_UPPER = new Set([
  "DATABASE_URL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "ELECTRON_RUN_AS_NODE",
]);

function isBlockedEnvKey(key) {
  const upper = String(key || "").toUpperCase();
  if (!upper) return true;
  if (upper.startsWith("CHISABOT_")) return true;
  return BLOCKED_ENV_EXACT_UPPER.has(upper);
}

/**
 * 裁剪并净化传给本地 MCP 子进程的环境变量。
 * 只从 baseEnv 白名单保留基础运行变量，再合并 extraEnv，最后强制剔除敏感注入键。
 */
function sanitizeMcpEnv(baseEnv = process.env, extraEnv = {}) {
  const clean = Object.create(null);

  if (baseEnv && typeof baseEnv === "object") {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value !== "string") continue;
      if (!ALLOWED_ENV_KEYS_UPPER.has(key.toUpperCase())) continue;
      if (isBlockedEnvKey(key)) continue;
      clean[key] = value;
    }
  }

  if (extraEnv && typeof extraEnv === "object") {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value !== "string") continue;
      if (isBlockedEnvKey(key)) continue;
      // 大小写覆盖：Windows 上 extraEnv 可能写 PATH 或 Path，需替换同义大小写键。
      for (const existingKey of Object.keys(clean)) {
        if (
          existingKey.toUpperCase() === key.toUpperCase() &&
          existingKey !== key
        ) {
          Reflect.deleteProperty(clean, existingKey);
        }
      }
      clean[key] = value;
    }
  }

  for (const existingKey of Object.keys(clean)) {
    if (isBlockedEnvKey(existingKey)) {
      Reflect.deleteProperty(clean, existingKey);
    }
  }

  return clean;
}

function hasControlChars(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) return true;
  }
  return false;
}

function validateExecutableToken(file) {
  if (!file || hasControlChars(file)) {
    throw new Error(SHELL_METACHAR_ERROR);
  }
  if (file.includes("`") || file.includes("$(")) {
    throw new Error(SHELL_METACHAR_ERROR);
  }
  // 显式参数模式下允许绝对 Windows 路径中的反斜杠，但仍禁止命令分隔与重定向符号。
  if (/[;|&><]/.test(file)) {
    throw new Error(SHELL_METACHAR_ERROR);
  }
}

/**
 * 解析并校验本地 MCP 启动命令：
 * - 传了 explicitArgs（非空数组）时校验可执行文件与参数合法性并直接返回 `[file, ...argv]`。
 * - 否则按单/双引号分词，并拒绝任何未受引号保护或危险的 shell 元字符。
 */
function parseCommandArgs(command, explicitArgs) {
  if (typeof command !== "string") {
    throw new Error("MCP 命令必须为非空字符串。");
  }
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("MCP 命令不能为空。");
  }

  if (explicitArgs !== undefined) {
    if (!Array.isArray(explicitArgs)) {
      throw new Error("MCP 参数必须为字符串数组。");
    }
    if (explicitArgs.length > 0) {
      validateExecutableToken(trimmed);
      const outArgs = [];
      for (const item of explicitArgs) {
        if (typeof item !== "string" || item.includes("\0")) {
          throw new Error("MCP 参数数组中包含无效项。");
        }
        outArgs.push(item);
      }
      return [trimmed, ...outArgs];
    }
  }

  if (hasControlChars(trimmed)) {
    throw new Error(SHELL_METACHAR_ERROR);
  }

  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "`" || (ch === "$" && trimmed[i + 1] === "(")) {
        throw new Error(SHELL_METACHAR_ERROR);
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === ">" ||
      ch === "<" ||
      ch === "\\" ||
      ch === "`" ||
      (ch === "$" && trimmed[i + 1] === "(")
    ) {
      throw new Error(SHELL_METACHAR_ERROR);
    }

    current += ch;
    inToken = true;
  }

  if (quote !== null) {
    throw new Error("MCP 命令包含未闭合的引号。");
  }
  if (inToken) {
    tokens.push(current);
  }
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error("MCP 命令不能为空。");
  }

  return tokens;
}

function stopChildProcessTree(child, platform, hasCustomSpawn) {
  if (!child) return;
  try {
    child.stdin?.end();
  } catch {}
  if (!hasCustomSpawn && child.pid) {
    try {
      if (platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.on?.("error", () => {});
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {}
  }
  try {
    child.kill?.("SIGKILL");
  } catch {}
}

/**
 * 通过 stdio JSON-RPC 2.0 在沙盒进程中调用本地 MCP 服务（initialize -> initialized -> tools/list | tools/call）。
 */
async function callLocalMcp({
  command,
  args,
  env,
  cwd,
  action = "list_tools",
  toolName,
  toolArgs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  spawnImpl,
  platform = process.platform,
}) {
  if (action !== "list_tools" && action !== "call_tool") {
    throw new Error(`不支持的 MCP action：${String(action)}`);
  }
  const cleanToolName = typeof toolName === "string" ? toolName.trim() : "";
  if (action === "call_tool" && !cleanToolName) {
    throw new Error("action 为 call_tool 时必须提供 toolName。");
  }
  if (signal?.aborted) {
    throw new Error("本地 MCP 调用已取消。");
  }

  const [file, ...argv] = parseCommandArgs(command, args);
  const sanitizedEnv = sanitizeMcpEnv(process.env, env);
  const effectiveTimeoutMs = Math.min(
    Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const hasCustomSpawn = typeof spawnImpl === "function";
  const runner = hasCustomSpawn ? spawnImpl : spawn;

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalStdoutBytes = 0;
    const stderrRing = new StderrRingBuffer(MAX_STDERR_BYTES);
    let lineBuffer = "";
    let sentActionRequest = false;

    const child = runner(file, argv, {
      shell: false,
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
      env: sanitizedEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: platform !== "win32",
    });

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stopChildProcessTree(child, platform, hasCustomSpawn);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      stopChildProcessTree(child, platform, hasCustomSpawn);
      resolve(result);
    };

    const onAbort = () => fail(new Error("本地 MCP 调用已取消。"));
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      fail(new Error(`调用本地 MCP 服务超时（${effectiveTimeoutMs}ms）。`));
    }, effectiveTimeoutMs);

    const writeRpc = (payload) => {
      if (settled || !child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        fail(error);
      }
    };

    const handleJsonLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 忽略启动阶段非 JSON 日志行，避免少量调试输出打断握手。
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.id === 1 && !sentActionRequest) {
        if (msg.error) {
          fail(new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
        sentActionRequest = true;
        writeRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
        if (action === "list_tools") {
          writeRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else {
          writeRpc({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: cleanToolName,
              arguments:
                toolArgs &&
                typeof toolArgs === "object" &&
                !Array.isArray(toolArgs)
                  ? toolArgs
                  : {},
            },
          });
        }
        return;
      }

      if (msg.id === 2) {
        if (msg.error) {
          fail(new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
        succeed(msg.result);
      }
    };

    const consumeStdout = (chunk) => {
      if (settled) return;
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      totalStdoutBytes += Buffer.byteLength(text, "utf8");
      if (totalStdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error("本地 MCP 服务 stdout 输出超过安全上限。"));
        return;
      }
      lineBuffer += text;
      if (Buffer.byteLength(lineBuffer, "utf8") > MAX_LINE_BYTES) {
        fail(new Error("本地 MCP 服务单行输出超过安全上限。"));
        return;
      }
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleJsonLine(line);
        if (settled) return;
      }
    };

    child.stdin?.on?.("error", () => {});

    child.stdout?.on?.("data", consumeStdout);
    child.stdout?.on?.("end", () => {
      if (!settled && lineBuffer.trim()) {
        const rest = lineBuffer;
        lineBuffer = "";
        handleJsonLine(rest);
      }
    });

    child.stderr?.on?.("data", (chunk) => {
      stderrRing.append(chunk);
    });

    child.on?.("error", (error) => fail(error));
    child.on?.("close", (code) => {
      if (!settled && lineBuffer.trim()) {
        const rest = lineBuffer;
        lineBuffer = "";
        handleJsonLine(rest);
      }
      if (!settled) {
        const rawStderr = stderrRing.toString().trim();
        let detail = "";
        if (rawStderr) {
          const tail =
            rawStderr.length > 400 ? `…${rawStderr.slice(-400)}` : rawStderr;
          detail = stderrRing.truncated
            ? `：[stderr 已滚动截断，保留尾部] ${tail}`
            : `：${tail}`;
        }
        fail(
          new Error(
            `本地 MCP 服务未返回响应即退出（code=${String(code ?? "null")}）${detail}`,
          ),
        );
      }
    });

    writeRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "chisabot-pc", version: "1.0.0" },
      },
    });
  });
}

function redactHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.username = "";
    parsed.password = "";
    if (parsed.search) {
      const redacted = new URLSearchParams();
      for (const key of parsed.searchParams.keys()) {
        redacted.set(key, "***");
      }
      parsed.search = `?${redacted.toString()}`;
    }
    return parsed.toString();
  } catch {
    return "***";
  }
}

function redactCliArg(arg, prevArg) {
  if (typeof arg !== "string") return "";
  if (
    prevArg &&
    /^(--?(token|api[-_]?key|secret|password|auth|bearer|pat)|-k)$/i.test(
      prevArg,
    )
  ) {
    return "***";
  }
  const eqMatch = arg.match(
    /^(--?(?:token|api[-_]?key|secret|password|auth|bearer))=(.+)$/i,
  );
  if (eqMatch) {
    return `${eqMatch[1]}=***`;
  }
  if (/^https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(arg)) {
    return redactHttpUrl(arg) || "***";
  }
  return arg;
}

/**
 * 剥离 UTF-8 BOM、JSONC 单行/多行注释与尾逗号（严格跳过双引号字符串字面量内的 `//`、`/*` 与 `, }`）。
 */
function stripJsonCommentsAndBom(rawText) {
  if (typeof rawText !== "string") return "";
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

  // Pass 1: 剥离 // 与 /* */ 注释，保留字符串字面量与换行位置
  let noComments = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        noComments += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
        noComments += " ";
      } else if (ch === "\n" || ch === "\r") {
        noComments += ch;
      }
      continue;
    }

    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    noComments += ch;
  }

  // Pass 2: 剥离对象/数组尾逗号（仅在双引号字符串外生效）
  let output = "";
  inString = false;
  escaped = false;

  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) {
        j += 1;
      }
      if (noComments[j] === "}" || noComments[j] === "]") {
        continue;
      }
    }

    output += ch;
  }

  return output;
}

const UNRESOLVED_VAR_RE = /\$\{[^{}]+\}/;

function expandWorkspaceVariables(text, workspaceDir) {
  if (typeof text !== "string" || !workspaceDir) return text;
  const folder = workspaceDir;
  const basename = path.basename(folder);
  return text
    .replace(/\$\{workspaceFolder\}/g, () => folder)
    .replace(/\$\{workspaceFolderBasename\}/g, () => basename);
}

function hasUnresolvedVariable(text) {
  return typeof text === "string" && UNRESOLVED_VAR_RE.test(text);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectServerMaps(container) {
  if (!isPlainObject(container)) return [];
  const maps = [];
  for (const key of ["mcpServers", "servers", "mcp_servers"]) {
    if (isPlainObject(container[key])) {
      maps.push(container[key]);
    }
  }
  return maps;
}

function normalizePathForMatch(targetPath, platform) {
  const resolved = path.resolve(targetPath);
  const trimmed =
    resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function findMatchingClaudeProjectConfigs(
  parsed,
  workspaceDir,
  workspaceRootReal,
  platform,
) {
  if (!isPlainObject(parsed.projects) || !workspaceDir) return [];
  const matchKeys = new Set([normalizePathForMatch(workspaceDir, platform)]);
  if (workspaceRootReal) {
    matchKeys.add(normalizePathForMatch(workspaceRootReal, platform));
  }
  const matchedConfigs = [];
  for (const [projectPath, projectConfig] of Object.entries(parsed.projects)) {
    if (!isPlainObject(projectConfig)) continue;
    if (matchKeys.has(normalizePathForMatch(projectPath, platform))) {
      matchedConfigs.push(projectConfig);
    }
  }
  return matchedConfigs;
}

function firstNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

function extractEntriesFromServerMap(source, rawMap, workspaceDir) {
  const candidates = [];
  for (const [name, entry] of Object.entries(rawMap)) {
    if (!isPlainObject(entry)) continue;

    let needsConfig = false;
    const rawUrl = firstNonEmptyString(
      entry.url,
      entry.httpUrl,
      entry.serverUrl,
      entry.sseUrl,
    );
    const expandedUrl = rawUrl
      ? expandWorkspaceVariables(rawUrl, workspaceDir)
      : undefined;
    if (expandedUrl && hasUnresolvedVariable(expandedUrl)) {
      needsConfig = true;
    }

    const rawCommand = firstNonEmptyString(entry.command);
    const expandedCommand = rawCommand
      ? expandWorkspaceVariables(rawCommand, workspaceDir)
      : undefined;
    if (expandedCommand && hasUnresolvedVariable(expandedCommand)) {
      needsConfig = true;
    }

    if (typeof entry.cwd === "string" && entry.cwd.trim()) {
      const expandedCwd = expandWorkspaceVariables(
        entry.cwd.trim(),
        workspaceDir,
      );
      if (hasUnresolvedVariable(expandedCwd)) {
        needsConfig = true;
      }
    }

    const rawArgs = Array.isArray(entry.args)
      ? entry.args.filter((item) => typeof item === "string")
      : [];
    const expandedArgs = rawArgs.map((item) =>
      expandWorkspaceVariables(item, workspaceDir),
    );
    for (const arg of expandedArgs) {
      if (hasUnresolvedVariable(arg)) {
        needsConfig = true;
      }
    }
    const safeArgs = [];
    for (let i = 0; i < expandedArgs.length; i += 1) {
      safeArgs.push(
        redactCliArg(expandedArgs[i], i > 0 ? expandedArgs[i - 1] : ""),
      );
    }

    const envKeys = [];
    if (isPlainObject(entry.env)) {
      for (const [envKey, envVal] of Object.entries(entry.env)) {
        envKeys.push(envKey);
        if (typeof envVal === "string") {
          const expandedVal = expandWorkspaceVariables(envVal, workspaceDir);
          if (hasUnresolvedVariable(expandedVal)) {
            needsConfig = true;
          }
        }
      }
    }

    const headerKeys = [];
    if (isPlainObject(entry.headers)) {
      for (const [headerKey, headerVal] of Object.entries(entry.headers)) {
        headerKeys.push(headerKey);
        if (typeof headerVal === "string") {
          const expandedVal = expandWorkspaceVariables(headerVal, workspaceDir);
          if (hasUnresolvedVariable(expandedVal)) {
            needsConfig = true;
          }
        }
      }
    }

    candidates.push({
      source,
      name,
      transport: expandedUrl ? "http" : "stdio",
      ...(expandedCommand ? { command: expandedCommand } : {}),
      ...(safeArgs.length > 0 ? { args: safeArgs } : {}),
      ...(expandedUrl ? { url: redactHttpUrl(expandedUrl) } : {}),
      envKeys,
      ...(headerKeys.length > 0 ? { headerKeys } : {}),
      ...(needsConfig ? { needsConfig: true } : {}),
    });
  }
  return candidates;
}

function extractEntriesFromConfig(source, parsed, options = {}) {
  if (!isPlainObject(parsed)) return [];
  const workspaceDir =
    typeof options.workspaceDir === "string" && options.workspaceDir.trim()
      ? options.workspaceDir.trim()
      : undefined;
  const workspaceRootReal =
    typeof options.workspaceRootReal === "string" &&
    options.workspaceRootReal.trim()
      ? options.workspaceRootReal.trim()
      : undefined;
  const platform = options.platform || process.platform;

  const byName = new Map();
  for (const rawMap of collectServerMaps(parsed)) {
    for (const item of extractEntriesFromServerMap(
      source,
      rawMap,
      workspaceDir,
    )) {
      byName.set(item.name, item);
    }
  }

  if (source === "claude-code" && workspaceDir) {
    const projectConfigs = findMatchingClaudeProjectConfigs(
      parsed,
      workspaceDir,
      workspaceRootReal,
      platform,
    );
    for (const projectConfig of projectConfigs) {
      for (const rawMap of collectServerMaps(projectConfig)) {
        for (const item of extractEntriesFromServerMap(
          source,
          rawMap,
          workspaceDir,
        )) {
          byName.set(item.name, item);
        }
      }
    }
  }

  return [...byName.values()];
}

function isPathInside(targetPath, rootPath, platform = process.platform) {
  const normTarget =
    platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const normRoot = platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const rel = path.relative(normRoot, normTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 安全只读打开本地配置文件：
 * 1. `lstat` 拒绝 symlink 与非普通文件及超大文件；
 * 2. 对工作区配置额外执行 `realpath` 校验，防止目录联接/符号链接逃逸出 `workspaceDir`；
 * 3. 使用 `O_RDONLY | O_NOFOLLOW` 打开句柄并二次校验 `fh.stat()` 后读取文本。
 */
async function readConfigFileSafely(filePath, options = {}) {
  const lstat = await fsp.lstat(filePath);
  if (
    lstat.isSymbolicLink() ||
    !lstat.isFile() ||
    lstat.size > MAX_CONFIG_BYTES
  ) {
    return null;
  }

  if (options.isWorkspace) {
    if (!options.workspaceRootReal) return null;
    const realFilePath = await fsp.realpath(filePath);
    if (
      !isPathInside(realFilePath, options.workspaceRootReal, options.platform)
    ) {
      return null;
    }
  }

  const oNoFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fh = await fsp.open(filePath, fs.constants.O_RDONLY | oNoFollow);
  try {
    const fstat = await fh.stat();
    if (!fstat.isFile() || fstat.size > MAX_CONFIG_BYTES) {
      return null;
    }
    return await fh.readFile({ encoding: "utf8" });
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 只读扫描本机常见 MCP 配置文件位置，提取脱敏后的服务清单。
 */
async function discoverLocalMcpConfigs(options = {}) {
  const platform = options.platform || process.platform;
  const pathImpl = path;
  const hasCustomHome =
    typeof options.homeDir === "string" && options.homeDir.length > 0;
  const home = hasCustomHome ? options.homeDir : os.homedir();
  const winAppData =
    options.appDataDir ||
    (!hasCustomHome ? process.env.APPDATA : "") ||
    pathImpl.join(home, "AppData", "Roaming");
  const xdgConfig =
    (!hasCustomHome ? process.env.XDG_CONFIG_HOME : "") ||
    pathImpl.join(home, ".config");
  const rawWorkspaceDir =
    typeof options.workspaceDir === "string" && options.workspaceDir.trim()
      ? pathImpl.resolve(options.workspaceDir.trim())
      : undefined;
  const workspaceRootReal = rawWorkspaceDir
    ? await fsp.realpath(rawWorkspaceDir).catch(() => null)
    : null;

  const targets = [];

  if (platform === "win32") {
    targets.push({
      source: "claude-desktop",
      filePath: pathImpl.join(
        winAppData,
        "Claude",
        "claude_desktop_config.json",
      ),
    });
    targets.push({
      source: "vscode-user",
      filePath: pathImpl.join(winAppData, "Code", "User", "mcp.json"),
    });
  } else if (platform === "darwin") {
    targets.push({
      source: "claude-desktop",
      filePath: pathImpl.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    });
    targets.push({
      source: "vscode-user",
      filePath: pathImpl.join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "mcp.json",
      ),
    });
  } else {
    targets.push({
      source: "claude-desktop",
      filePath: pathImpl.join(
        xdgConfig,
        "Claude",
        "claude_desktop_config.json",
      ),
    });
    targets.push({
      source: "vscode-user",
      filePath: pathImpl.join(xdgConfig, "Code", "User", "mcp.json"),
    });
  }

  targets.push({
    source: "claude-code",
    filePath: pathImpl.join(home, ".claude.json"),
  });
  targets.push({
    source: "cursor",
    filePath: pathImpl.join(home, ".cursor", "mcp.json"),
  });

  if (rawWorkspaceDir) {
    targets.push({
      source: "vscode-workspace",
      filePath: pathImpl.join(rawWorkspaceDir, ".vscode", "mcp.json"),
      isWorkspace: true,
    });
    targets.push({
      source: "cursor-workspace",
      filePath: pathImpl.join(rawWorkspaceDir, ".cursor", "mcp.json"),
      isWorkspace: true,
    });
    targets.push({
      source: "claude-workspace",
      filePath: pathImpl.join(rawWorkspaceDir, ".mcp.json"),
      isWorkspace: true,
    });
    targets.push({
      source: "workspace",
      filePath: pathImpl.join(rawWorkspaceDir, "mcp.json"),
      isWorkspace: true,
    });
  }

  const servers = [];
  const foundFiles = [];

  for (const target of targets) {
    try {
      const text = await readConfigFileSafely(target.filePath, {
        isWorkspace: Boolean(target.isWorkspace),
        workspaceRootReal,
        platform,
      });
      if (text === null) continue;
      const parsed = JSON.parse(stripJsonCommentsAndBom(text));
      const extracted = extractEntriesFromConfig(target.source, parsed, {
        workspaceDir: rawWorkspaceDir,
        workspaceRootReal,
        platform,
      });
      foundFiles.push({ source: target.source, filePath: target.filePath });
      servers.push(...extracted);
    } catch {
      // 文件不存在、权限不足或 JSON 损坏时静默跳过，避免影响其余来源扫描。
    }
  }

  return { servers, files: foundFiles };
}

module.exports = {
  MAX_STDERR_BYTES,
  SHELL_METACHAR_ERROR,
  StderrRingBuffer,
  stripJsonCommentsAndBom,
  extractEntriesFromConfig,
  parseCommandArgs,
  sanitizeMcpEnv,
  callLocalMcp,
  discoverLocalMcpConfigs,
};
