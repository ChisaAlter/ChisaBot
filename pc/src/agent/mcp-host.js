"use strict";

/**
 * PC 端原生 stdio MCP 沙盒执行器与本机配置只读发现。
 *
 * 1. 所有子进程调用强制 shell: false + 引号分词 + shell 元字符拒绝。
 * 2. 子进程环境变量白名单裁剪，显式剔除 ChisaBot / 数据库 / 动态注入变量。
 * 3. 本机 MCP 配置发现只读返回服务端清单与 key 名，不回传任何真实环境变量或 Header 密钥。
 */

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
    let totalStderrBytes = 0;
    let stderrText = "";
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
      if (totalStderrBytes >= MAX_STDERR_BYTES) return;
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const remaining = MAX_STDERR_BYTES - totalStderrBytes;
      const slice = text.slice(0, remaining);
      totalStderrBytes += Buffer.byteLength(slice, "utf8");
      stderrText += slice;
    });

    child.on?.("error", (error) => fail(error));
    child.on?.("close", (code) => {
      if (!settled && lineBuffer.trim()) {
        const rest = lineBuffer;
        lineBuffer = "";
        handleJsonLine(rest);
      }
      if (!settled) {
        const detail = stderrText.trim()
          ? `：${stderrText.trim().slice(0, 400)}`
          : "";
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

function extractEntriesFromConfig(source, parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const candidates = [];
  const rawMap =
    (parsed.mcpServers &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers) &&
      parsed.mcpServers) ||
    (parsed.servers &&
      typeof parsed.servers === "object" &&
      !Array.isArray(parsed.servers) &&
      parsed.servers) ||
    null;
  if (!rawMap) return candidates;

  for (const [name, entry] of Object.entries(rawMap)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rawUrl =
      typeof entry.url === "string" && entry.url.trim()
        ? entry.url.trim()
        : undefined;
    const rawCommand =
      typeof entry.command === "string" && entry.command.trim()
        ? entry.command.trim()
        : undefined;
    const rawArgs = Array.isArray(entry.args)
      ? entry.args.filter((item) => typeof item === "string")
      : [];
    const safeArgs = [];
    for (let i = 0; i < rawArgs.length; i += 1) {
      safeArgs.push(redactCliArg(rawArgs[i], i > 0 ? rawArgs[i - 1] : ""));
    }
    const envKeys =
      entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
        ? Object.keys(entry.env)
        : [];
    const headerKeys =
      entry.headers &&
      typeof entry.headers === "object" &&
      !Array.isArray(entry.headers)
        ? Object.keys(entry.headers)
        : [];

    candidates.push({
      source,
      name,
      transport: rawUrl ? "http" : "stdio",
      ...(rawCommand ? { command: rawCommand } : {}),
      ...(safeArgs.length > 0 ? { args: safeArgs } : {}),
      ...(rawUrl ? { url: redactHttpUrl(rawUrl) } : {}),
      envKeys,
      ...(headerKeys.length > 0 ? { headerKeys } : {}),
    });
  }
  return candidates;
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
  const workspaceDir = options.workspaceDir;

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

  if (workspaceDir && typeof workspaceDir === "string" && workspaceDir.trim()) {
    const root = workspaceDir.trim();
    targets.push({
      source: "vscode-workspace",
      filePath: pathImpl.join(root, ".vscode", "mcp.json"),
    });
    targets.push({
      source: "cursor-workspace",
      filePath: pathImpl.join(root, ".cursor", "mcp.json"),
    });
    targets.push({
      source: "claude-workspace",
      filePath: pathImpl.join(root, ".mcp.json"),
    });
  }

  const servers = [];
  const foundFiles = [];

  for (const target of targets) {
    try {
      const stat = await fsp.stat(target.filePath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const text = await fsp.readFile(target.filePath, "utf8");
      const parsed = JSON.parse(text);
      const extracted = extractEntriesFromConfig(target.source, parsed);
      foundFiles.push({ source: target.source, filePath: target.filePath });
      servers.push(...extracted);
    } catch {
      // 文件不存在、权限不足或 JSON 损坏时静默跳过，避免影响其余来源扫描。
    }
  }

  return { servers, files: foundFiles };
}

module.exports = {
  SHELL_METACHAR_ERROR,
  parseCommandArgs,
  sanitizeMcpEnv,
  callLocalMcp,
  discoverLocalMcpConfigs,
};
