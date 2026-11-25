"use strict";
/**
 * P2 可选原生加速旁路驱动（DesktopDriver SPI）：封装外部 `agent-desktop` CLI。
 *
 * 安全红线：
 * 1. 二进制探测按 options.binPath -> CHISABOT_AGENT_DESKTOP_BIN -> PATH；
 *    配置 SHA-256 时严格校验不匹配即拒用；
 * 2. 所有子进程均以 { shell: false, windowsHide: true } 启动，严禁经由 shell 拼接；
 * 3. 硬编码禁止 `--headed`（含 `--headed=*`），任何入口传入即 fail-closed 返回 POLICY_DENIED；
 * 4. 所有操作前做 ChisaBot 自保护校验，拒绝访问自身进程/PID 或审批确认窗（SELF_TARGET_FORBIDDEN）；
 * 5. 窗口截屏临时 PNG 在 finally 中安全清理，绝不遗留临时文件。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DRIVER_NAME = "agent-desktop";
const DEFAULT_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^@([1-9]\d*):e([1-9]\d*)$/;
const HEADED_FLAG_RE = /^--headed(?:=|$)/i;

const SELF_PROCESS_NAMES = new Set([
  "chisabot",
  "chisabot-pc",
  "cn.ayase.chisabot.pc",
]);

const STANDARD_ERROR_CODES = new Set([
  "POLICY_DENIED",
  "ACTION_NOT_SUPPORTED",
  "STALE_REF",
  "AMBIGUOUS_TARGET",
  "WINDOW_MINIMIZED",
  "WINDOW_NOT_FOUND",
  "SELF_TARGET_FORBIDDEN",
  "NEEDS_PERMISSION",
  "DRIVER_UNAVAILABLE",
  "TIMEOUT",
]);

const UPSTREAM_CODE_MAP = Object.freeze({
  POLICY_DENIED: "POLICY_DENIED",
  HEADED_REQUIRED: "POLICY_DENIED",
  HEADED_FORBIDDEN: "POLICY_DENIED",
  ACTION_NOT_SUPPORTED: "ACTION_NOT_SUPPORTED",
  PLATFORM_NOT_SUPPORTED: "ACTION_NOT_SUPPORTED",
  UNSUPPORTED_ACTION: "ACTION_NOT_SUPPORTED",
  UNSUPPORTED_PATTERN: "ACTION_NOT_SUPPORTED",
  STALE_REF: "STALE_REF",
  STALE_SNAPSHOT: "STALE_REF",
  REF_NOT_FOUND: "STALE_REF",
  SAVED_REF_ABSENT: "STALE_REF",
  ELEMENT_NOT_FOUND: "STALE_REF",
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",
  IDENTITY_NOT_UNIQUE: "AMBIGUOUS_TARGET",
  SAVED_REF_AMBIGUOUS: "AMBIGUOUS_TARGET",
  WINDOW_MINIMIZED: "WINDOW_MINIMIZED",
  WINDOW_NOT_FOUND: "WINDOW_NOT_FOUND",
  APP_NOT_FOUND: "WINDOW_NOT_FOUND",
  SELF_TARGET_FORBIDDEN: "SELF_TARGET_FORBIDDEN",
  PERM_DENIED: "NEEDS_PERMISSION",
  PERMISSION_DENIED: "NEEDS_PERMISSION",
  NEEDS_PERMISSION: "NEEDS_PERMISSION",
  ACCESSIBILITY_DENIED: "NEEDS_PERMISSION",
  TIMEOUT: "TIMEOUT",
  TIMED_OUT: "TIMEOUT",
  ETIMEDOUT: "TIMEOUT",
  DRIVER_UNAVAILABLE: "DRIVER_UNAVAILABLE",
  BINARY_NOT_FOUND: "DRIVER_UNAVAILABLE",
  SHA256_MISMATCH: "DRIVER_UNAVAILABLE",
  ENOENT: "DRIVER_UNAVAILABLE",
});

const ACTION_SUBCOMMAND_MAP = Object.freeze({
  click: "click",
  set_value: "set-value",
  clear: "clear",
  toggle: "toggle",
  check: "check",
  uncheck: "uncheck",
  select: "select",
  expand: "expand",
  collapse: "collapse",
  scroll: "scroll",
  scroll_to: "scroll-to",
  type: "type",
});

const VALID_SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

function normalizeProcessName(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const lastSlash = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  const base = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed)
    .trim()
    .toLowerCase();
  if (!base) return "";
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function isSafeUpstreamRef(refStr) {
  if (
    typeof refStr !== "string" ||
    refStr.length === 0 ||
    refStr.length > 256
  ) {
    return false;
  }
  if (refStr.startsWith("-")) return false;
  for (let i = 0; i < refStr.length; i += 1) {
    const code = refStr.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isProtectedSelfTarget(target = {}) {
  const pid = Number(target.pid);
  const selfPid = Number(target.selfPid);
  if (
    Number.isInteger(pid) &&
    pid > 0 &&
    Number.isInteger(selfPid) &&
    selfPid > 0 &&
    pid === selfPid
  ) {
    return true;
  }
  const extraSet = new Set();
  if (Array.isArray(target.excludeProcessNames)) {
    for (const item of target.excludeProcessNames) {
      const norm = normalizeProcessName(item);
      if (norm) extraSet.add(norm);
    }
  }
  const procNorm = normalizeProcessName(target.processName);
  if (
    procNorm &&
    (SELF_PROCESS_NAMES.has(procNorm) || extraSet.has(procNorm))
  ) {
    return true;
  }
  const bundleNorm = normalizeProcessName(target.bundleId);
  if (
    bundleNorm &&
    (SELF_PROCESS_NAMES.has(bundleNorm) || extraSet.has(bundleNorm))
  ) {
    return true;
  }
  const titleLower = String(target.title || "").toLowerCase();
  if (
    titleLower.includes("chisabot 审批") ||
    titleLower.includes("chisabot 确认")
  ) {
    return true;
  }
  return false;
}

function containsHeadedFlag(args) {
  if (!Array.isArray(args)) return false;
  for (const arg of args) {
    if (HEADED_FLAG_RE.test(String(arg ?? "").trim())) {
      return true;
    }
  }
  return false;
}

/**
 * 校验外部二进制文件的 SHA-256 摘要。
 */
function verifyBinarySha256(filePath, expectedHex, options = {}) {
  const readFileSyncImpl = options.readFileSync || fs.readFileSync;
  const rawExpected = String(expectedHex || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  if (!SHA256_HEX_RE.test(rawExpected)) {
    return {
      ok: false,
      expected: rawExpected,
      actual: null,
      reason: "invalid_sha256_format",
      error: "expectedSha256 必须是 64 位十六进制 SHA-256 摘要。",
    };
  }
  let buf;
  try {
    buf = readFileSyncImpl(filePath);
  } catch (error) {
    return {
      ok: false,
      expected: rawExpected,
      actual: null,
      reason: "read_failed",
      error: `无法读取二进制文件进行 SHA-256 校验：${error?.message || String(error)}`,
    };
  }
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  const expectedBuf = Buffer.from(rawExpected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  const match =
    expectedBuf.length === actualBuf.length &&
    crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!match) {
    return {
      ok: false,
      expected: rawExpected,
      actual,
      reason: "sha256_mismatch",
      error: `agent-desktop 二进制 SHA-256 校验不匹配（期望 ${rawExpected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）。`,
    };
  }
  return {
    ok: true,
    expected: rawExpected,
    actual,
  };
}

function isRegularFile(filePath, statSyncImpl) {
  try {
    const st = statSyncImpl(filePath);
    return Boolean(st && typeof st.isFile === "function" && st.isFile());
  } catch {
    return false;
  }
}

function findInPath(binNames, pathEnv, platform, statSyncImpl) {
  const rawPath = String(pathEnv || "");
  if (!rawPath) return null;
  const sep = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const dirs = rawPath
    .split(sep)
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of binNames) {
      const candidate = pathApi.join(dir, name);
      if (isRegularFile(candidate, statSyncImpl)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 探测 `agent-desktop` 可执行文件路径并按需执行 SHA-256 校验。
 * 优先级：options.binPath -> env.CHISABOT_AGENT_DESKTOP_BIN -> PATH。
 */
function resolveAgentDesktopBinary(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const statSyncImpl = options.statSync || fs.statSync;
  const readFileSyncImpl = options.readFileSync || fs.readFileSync;
  const verifySha256Impl =
    options.verifySha256 ||
    ((fp, hex) =>
      verifyBinarySha256(fp, hex, { readFileSync: readFileSyncImpl }));

  let binPath = null;
  let source = null;

  const optPath = String(options.binPath || "").trim();
  const envPath = String(env.CHISABOT_AGENT_DESKTOP_BIN || "").trim();

  if (optPath) {
    if (isRegularFile(optPath, statSyncImpl)) {
      binPath = optPath;
      source = "option";
    } else {
      return {
        found: false,
        binPath: optPath,
        source: "option",
        sha256Verified: false,
        reason: "binary_not_found",
        error: `指定的 agent-desktop 路径不存在或不是文件：${optPath}`,
      };
    }
  } else if (envPath) {
    if (isRegularFile(envPath, statSyncImpl)) {
      binPath = envPath;
      source = "env";
    } else {
      return {
        found: false,
        binPath: envPath,
        source: "env",
        sha256Verified: false,
        reason: "binary_not_found",
        error: `环境变量 CHISABOT_AGENT_DESKTOP_BIN 指向的文件不存在：${envPath}`,
      };
    }
  } else {
    const names =
      platform === "win32" ? ["agent-desktop.exe"] : ["agent-desktop"];
    const pathEnv =
      options.pathEnv !== undefined
        ? options.pathEnv
        : env.PATH || env.Path || "";
    const foundPath = findInPath(names, pathEnv, platform, statSyncImpl);
    if (!foundPath) {
      return {
        found: false,
        binPath: null,
        source: null,
        sha256Verified: false,
        reason: "binary_not_found",
        error: "未在 PATH 中找到 agent-desktop 可执行文件。",
      };
    }
    binPath = foundPath;
    source = "path";
  }

  const expectedSha256 = String(
    options.expectedSha256 || env.CHISABOT_AGENT_DESKTOP_SHA256 || "",
  ).trim();
  if (expectedSha256) {
    const check = verifySha256Impl(binPath, expectedSha256);
    if (!check?.ok) {
      return {
        found: false,
        binPath,
        source,
        sha256Verified: false,
        expectedSha256: check?.expected || expectedSha256,
        actualSha256: check?.actual || null,
        reason: check?.reason || "sha256_mismatch",
        error: check?.error || "agent-desktop 二进制 SHA-256 校验失败。",
      };
    }
    return {
      found: true,
      binPath,
      source,
      sha256Verified: true,
      actualSha256: check.actual || null,
    };
  }

  return {
    found: true,
    binPath,
    source,
    sha256Verified: false,
  };
}

/**
 * 将 `agent-desktop` CLI 错误输出 / 异常统一归一化为 ChisaBot 标准后台错误码。
 */
function normalizeAgentDesktopError(
  rawError,
  fallbackCode = "DRIVER_UNAVAILABLE",
) {
  const safeFallback = STANDARD_ERROR_CODES.has(fallbackCode)
    ? fallbackCode
    : "DRIVER_UNAVAILABLE";

  let rawCode = "";
  let message = "";

  if (typeof rawError === "string") {
    const trimmed = rawError.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeAgentDesktopError(parsed, safeFallback);
      } catch {}
    }
    message = trimmed;
  } else if (rawError instanceof Error) {
    rawCode = String(rawError.code || "").trim();
    message = String(rawError.message || String(rawError)).trim();
  } else if (rawError && typeof rawError === "object") {
    const inner =
      rawError.error && typeof rawError.error === "object"
        ? rawError.error
        : null;
    rawCode = String(
      inner?.code || rawError.code || rawError.reason || "",
    ).trim();
    message = String(
      inner?.message ||
        (typeof rawError.error === "string" ? rawError.error : "") ||
        rawError.message ||
        rawError.stderr ||
        "",
    ).trim();
  }

  const upperCode = rawCode.toUpperCase();
  let code = UPSTREAM_CODE_MAP[upperCode] || "";

  if (!code && message) {
    if (/--headed|policy_denied|policy denied/i.test(message)) {
      code = "POLICY_DENIED";
    } else if (/self_target_forbidden|自身进程|自身窗口/i.test(message)) {
      code = "SELF_TARGET_FORBIDDEN";
    } else if (/stale_ref|stale snapshot|saved_ref_absent/i.test(message)) {
      code = "STALE_REF";
    } else if (
      /ambiguous_target|identity_not_unique|ambiguous/i.test(message)
    ) {
      code = "AMBIGUOUS_TARGET";
    } else if (/window_minimized|minimi[sz]ed/i.test(message)) {
      code = "WINDOW_MINIMIZED";
    } else if (
      /window_not_found|app_not_found|no matching window/i.test(message)
    ) {
      code = "WINDOW_NOT_FOUND";
    } else if (
      /perm_denied|permission|assistive|accessibility|uipi|access is denied/i.test(
        message,
      )
    ) {
      code = "NEEDS_PERMISSION";
    } else if (/timed?\s*out|timeout/i.test(message)) {
      code = "TIMEOUT";
    } else if (
      /action_not_supported|platform_not_supported|not supported/i.test(message)
    ) {
      code = "ACTION_NOT_SUPPORTED";
    }
  }

  if (!code) code = safeFallback;
  const result = {
    ok: false,
    code,
    error: message || `agent-desktop 执行失败（${code}）。`,
  };
  if (rawCode && rawCode !== code) {
    result.rawCode = rawCode;
  }
  return result;
}

function parsePngDimensions(buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return { width: 0, height: 0 };
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function parseJsonLoose(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line);
      } catch {}
    }
  }
  return null;
}

function normalizeWindowEntry(raw) {
  const b = raw?.bounds || raw?.rect || {};
  const left = Number(b.left ?? b.x ?? 0) || 0;
  const top = Number(b.top ?? b.y ?? 0) || 0;
  const width = Number(b.width ?? b.w ?? 0) || 0;
  const height = Number(b.height ?? b.h ?? 0) || 0;
  const hwndRaw = raw?.hwnd ?? raw?.window_id ?? raw?.windowId ?? raw?.id ?? 0;
  const hwnd = Number.isFinite(Number(hwndRaw)) ? Number(hwndRaw) : hwndRaw;
  return {
    hwnd,
    pid: Number(raw?.pid ?? raw?.process_id ?? raw?.processId ?? 0) || 0,
    processStartTicks: String(
      raw?.processStartTicks ?? raw?.process_start_ticks ?? "",
    ),
    processName: String(
      raw?.processName ?? raw?.process_name ?? raw?.app ?? "",
    ),
    bundleId: String(
      raw?.bundleId ?? raw?.bundle_id ?? raw?.app_id ?? raw?.app ?? "",
    ),
    title: String(raw?.title ?? raw?.name ?? ""),
    isActive: Boolean(raw?.isActive ?? raw?.is_active ?? raw?.focused),
    isMinimized: Boolean(
      raw?.isMinimized ?? raw?.is_minimized ?? raw?.minimized,
    ),
    bounds: { left, top, width, height },
  };
}

function flattenTreeNodes(tree, out = [], depth = 0) {
  if (!tree) return out;
  const list = Array.isArray(tree) ? tree : [tree];
  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    const states = Array.isArray(node.states)
      ? node.states.map((s) => String(s).toLowerCase())
      : [];
    const role = String(node.role || "").toLowerCase();
    const isPassword = Boolean(
      node.isPassword ??
        node.is_password ??
        (role.includes("password") ||
          role === "axsecuretextfield" ||
          states.includes("password") ||
          states.includes("protected")),
    );
    const b = node.bounds || {};
    const children = Array.isArray(node.children) ? node.children : [];
    const nativeId =
      node.automationId ??
      node.automation_id ??
      (typeof node.native_id === "string"
        ? node.native_id
        : node.native_id?.value) ??
      "";
    out.push({
      ref: node.ref_id ?? node.ref ?? null,
      role,
      name: String(node.name ?? ""),
      automationId: String(nativeId ?? ""),
      description: String(node.description ?? ""),
      isPassword,
      value: isPassword ? null : (node.value ?? null),
      enabled:
        node.enabled !== undefined
          ? Boolean(node.enabled)
          : !states.includes("disabled"),
      focused:
        node.focused !== undefined
          ? Boolean(node.focused)
          : states.includes("focused"),
      isOffscreen:
        node.isOffscreen !== undefined
          ? Boolean(node.isOffscreen)
          : states.includes("offscreen"),
      checked: node.checked ?? (states.includes("checked") ? true : null),
      expanded: node.expanded ?? (states.includes("expanded") ? true : null),
      selected: node.selected ?? (states.includes("selected") ? true : null),
      patterns: Array.isArray(node.patterns)
        ? node.patterns
        : Array.isArray(node.available_actions)
          ? node.available_actions
          : [],
      depth: Number.isInteger(node.depth) ? node.depth : depth,
      childrenCount: Number(
        node.childrenCount ?? node.children_count ?? children.length,
      ),
      bounds: {
        x: Number(b.x ?? b.left ?? 0) || 0,
        y: Number(b.y ?? b.top ?? 0) || 0,
        width: Number(b.width ?? 0) || 0,
        height: Number(b.height ?? 0) || 0,
      },
    });
    if (children.length > 0) {
      flattenTreeNodes(children, out, depth + 1);
    }
  }
  return out;
}

/**
 * 创建标准 DesktopDriver SPI 实现（`name: "agent-desktop"`）。
 */
function createAgentDesktopDriver(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const selfPid =
    options.selfPid !== undefined ? Number(options.selfPid) : process.pid;
  const defaultTimeoutMs = Math.max(
    500,
    Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
  );
  const spawnImpl = options.spawn || (options.execFile ? null : spawn);
  const execFileImpl = options.execFile || null;
  const tmpDir = options.tmpDir || os.tmpdir();
  const baseExtraArgs = Array.isArray(options.extraArgs)
    ? options.extraArgs
    : [];

  let cachedProbe = null;
  const knownWindows = new Map();
  const knownRefTargets = new Map();

  function rememberWindow(win) {
    if (!win?.hwnd) return;
    knownWindows.set(String(win.hwnd), win);
    if (knownWindows.size > 256) {
      const oldestKey = knownWindows.keys().next().value;
      knownWindows.delete(oldestKey);
    }
  }

  function rememberRefs(nodes, winMeta) {
    if (!Array.isArray(nodes) || !winMeta) return;
    for (const n of nodes) {
      if (n && typeof n.ref === "string" && isSafeUpstreamRef(n.ref)) {
        knownRefTargets.set(n.ref, winMeta);
        if (knownRefTargets.size > 2048) {
          const oldestKey = knownRefTargets.keys().next().value;
          knownRefTargets.delete(oldestKey);
        }
      }
    }
  }

  function runCli(
    binPath,
    args,
    { timeoutMs = defaultTimeoutMs, signal } = {},
  ) {
    if (containsHeadedFlag(args)) {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({
          code: "POLICY_DENIED",
          message: "安全策略禁止向 agent-desktop 传递 --headed 参数。",
        }),
        timedOut: false,
        policyDenied: true,
      });
    }

    if (execFileImpl && !spawnImpl) {
      return new Promise((resolve) => {
        try {
          execFileImpl(
            binPath,
            args,
            {
              shell: false,
              windowsHide: true,
              timeout: timeoutMs,
              maxBuffer: MAX_OUTPUT_BYTES,
              signal,
              env,
            },
            (err, stdout, stderr) => {
              if (!err) {
                resolve({
                  exitCode: 0,
                  stdout: String(stdout || ""),
                  stderr: String(stderr || ""),
                  timedOut: false,
                });
                return;
              }
              resolve({
                exitCode: typeof err.code === "number" ? err.code : 1,
                stdout: String(stdout || ""),
                stderr: String(stderr || err.message || ""),
                timedOut: Boolean(err.killed || err.code === "ETIMEDOUT"),
                spawnError: err,
              });
            },
          );
        } catch (error) {
          resolve({
            exitCode: 1,
            stdout: "",
            stderr: String(error?.message || error),
            timedOut: false,
            spawnError: error,
          });
        }
      });
    }

    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawnImpl(binPath, args, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      } catch (error) {
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: String(error?.message || error),
          timedOut: false,
          spawnError: error,
        });
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      let totalBytes = 0;
      let settled = false;
      let timedOut = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(payload);
      };

      const killProc = () => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      };

      const onAbort = () => {
        killProc();
        finish({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: "操作已取消",
          timedOut: false,
          aborted: true,
        });
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        killProc();
        finish({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `agent-desktop 执行超时（${timeoutMs}ms）`,
          timedOut: true,
        });
      }, timeoutMs);
      timer.unref?.();

      proc.stdout?.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (totalBytes + buf.length <= MAX_OUTPUT_BYTES) {
          stdoutChunks.push(buf);
          totalBytes += buf.length;
        }
      });
      proc.stderr?.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (stderrChunks.length < 64) stderrChunks.push(buf);
      });
      proc.on("error", (error) => {
        finish({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: String(error?.message || error),
          timedOut: false,
          spawnError: error,
        });
      });
      proc.on("close", (code) => {
        finish({
          exitCode: typeof code === "number" ? code : 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
        });
      });
    });
  }

  function validateExtraArgs(callExtraArgs) {
    const merged = [
      ...baseExtraArgs,
      ...(Array.isArray(callExtraArgs) ? callExtraArgs : []),
    ];
    if (containsHeadedFlag(merged)) {
      return {
        ok: false,
        error: {
          ok: false,
          code: "POLICY_DENIED",
          error: "安全策略禁止向 agent-desktop 传递 --headed 参数。",
        },
      };
    }
    return { ok: true, args: merged.map((a) => String(a)) };
  }

  function resolveReadyBinary() {
    const resolved = resolveAgentDesktopBinary({ ...options, platform, env });
    if (!resolved.found) {
      return {
        ok: false,
        error: {
          ok: false,
          code: "DRIVER_UNAVAILABLE",
          reason: resolved.reason,
          error: resolved.error || "agent-desktop 驱动不可用。",
        },
      };
    }
    return { ok: true, resolved };
  }

  async function isAvailable({ forceRefresh = false } = {}) {
    const resolved = resolveAgentDesktopBinary({ ...options, platform, env });
    if (!resolved.found) {
      cachedProbe = null;
      return {
        available: false,
        binPath: resolved.binPath,
        reason: resolved.reason,
        error: resolved.error,
      };
    }
    if (
      !forceRefresh &&
      cachedProbe &&
      cachedProbe.binPath === resolved.binPath
    ) {
      return { ...cachedProbe };
    }
    const probe = await runCli(resolved.binPath, ["--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (probe.exitCode !== 0 || probe.timedOut || probe.spawnError) {
      return {
        available: false,
        binPath: resolved.binPath,
        reason: probe.timedOut
          ? "version_probe_timeout"
          : "version_probe_failed",
        error: probe.stderr.trim() || "无法探测 agent-desktop 版本。",
      };
    }
    const version = probe.stdout.trim().split(/\r?\n/)[0]?.trim() || "unknown";
    cachedProbe = {
      available: true,
      binPath: resolved.binPath,
      version,
      sha256Verified: resolved.sha256Verified,
    };
    return { ...cachedProbe };
  }

  async function listWindows({
    query,
    excludePid,
    excludeProcessNames,
    extraArgs,
    signal,
    timeoutMs,
  } = {}) {
    const extraCheck = validateExtraArgs(extraArgs);
    if (!extraCheck.ok) return extraCheck.error;
    const binCheck = resolveReadyBinary();
    if (!binCheck.ok) return binCheck.error;

    const res = await runCli(
      binCheck.resolved.binPath,
      ["list-windows", "--json", ...extraCheck.args],
      { timeoutMs, signal },
    );
    if (res.policyDenied) {
      return normalizeAgentDesktopError(res.stderr, "POLICY_DENIED");
    }
    if (res.timedOut) {
      return normalizeAgentDesktopError(res.stderr, "TIMEOUT");
    }
    const parsed = parseJsonLoose(res.stdout);
    if (res.exitCode !== 0 || parsed?.ok === false) {
      return normalizeAgentDesktopError(
        parsed || res.stderr || res.spawnError,
        "DRIVER_UNAVAILABLE",
      );
    }

    const rawList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.data?.windows)
        ? parsed.data.windows
        : Array.isArray(parsed?.windows)
          ? parsed.windows
          : Array.isArray(parsed?.data)
            ? parsed.data
            : [];

    const q = String(query || "")
      .trim()
      .toLowerCase();
    const effectiveExcludePid =
      Number.isInteger(Number(excludePid)) && Number(excludePid) > 0
        ? Number(excludePid)
        : selfPid;
    const windows = [];
    for (const item of rawList) {
      const w = normalizeWindowEntry(item);
      if (
        isProtectedSelfTarget({
          pid: w.pid,
          selfPid: effectiveExcludePid,
          processName: w.processName,
          bundleId: w.bundleId,
          title: w.title,
          excludeProcessNames,
        }) ||
        isProtectedSelfTarget({
          pid: w.pid,
          selfPid,
          processName: w.processName,
          bundleId: w.bundleId,
          title: w.title,
          excludeProcessNames,
        })
      ) {
        continue;
      }
      rememberWindow(w);
      if (q) {
        const hay = `${w.title} ${w.processName} ${w.bundleId}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      windows.push(w);
    }
    return {
      ok: true,
      driver: DRIVER_NAME,
      windows,
    };
  }

  async function snapshot({
    bundleId,
    processName,
    hwnd,
    pid,
    title,
    interactiveOnly,
    compact,
    maxDepth,
    excludePid,
    excludeProcessNames,
    extraArgs,
    signal,
    timeoutMs,
  } = {}) {
    const extraCheck = validateExtraArgs(extraArgs);
    if (!extraCheck.ok) return extraCheck.error;

    const cachedWin =
      hwnd !== undefined && hwnd !== null
        ? knownWindows.get(String(hwnd))
        : null;
    const checkTarget = {
      pid: pid ?? cachedWin?.pid,
      selfPid: excludePid || selfPid,
      processName: processName ?? cachedWin?.processName,
      bundleId: bundleId ?? cachedWin?.bundleId,
      title: title ?? cachedWin?.title,
      excludeProcessNames,
    };
    if (
      isProtectedSelfTarget(checkTarget) ||
      isProtectedSelfTarget({ ...checkTarget, selfPid })
    ) {
      return {
        ok: false,
        code: "SELF_TARGET_FORBIDDEN",
        error: "禁止读取 ChisaBot 自身窗口控件树。",
      };
    }

    const binCheck = resolveReadyBinary();
    if (!binCheck.ok) return binCheck.error;

    const args = ["snapshot", "--json"];
    if (hwnd !== undefined && hwnd !== null && String(hwnd).trim() !== "") {
      args.push("--window-id", String(hwnd));
    } else if (bundleId || processName) {
      args.push("--app", String(bundleId || processName));
    }
    if (interactiveOnly) args.push("-i");
    if (compact) args.push("--compact");
    if (maxDepth !== undefined && maxDepth !== null) {
      const clamped = Math.min(
        50,
        Math.max(1, Math.trunc(Number(maxDepth) || 10)),
      );
      args.push("--max-depth", String(clamped));
    }
    args.push(...extraCheck.args);

    const res = await runCli(binCheck.resolved.binPath, args, {
      timeoutMs,
      signal,
    });
    if (res.policyDenied) {
      return normalizeAgentDesktopError(res.stderr, "POLICY_DENIED");
    }
    if (res.timedOut) {
      return normalizeAgentDesktopError(res.stderr, "TIMEOUT");
    }
    const parsed = parseJsonLoose(res.stdout);
    if (res.exitCode !== 0 || parsed?.ok === false) {
      return normalizeAgentDesktopError(
        parsed || res.stderr || res.spawnError,
        "DRIVER_UNAVAILABLE",
      );
    }

    const data =
      parsed?.data && typeof parsed.data === "object"
        ? parsed.data
        : parsed || {};
    const winMeta = normalizeWindowEntry({
      ...(data.window && typeof data.window === "object" ? data.window : {}),
      hwnd:
        data.window?.hwnd ??
        data.window?.window_id ??
        data.window?.id ??
        hwnd ??
        0,
      pid: data.window?.pid ?? data.app?.pid ?? pid ?? 0,
      processName:
        data.window?.processName ??
        data.app?.name ??
        (typeof data.app === "string" ? data.app : processName) ??
        "",
      bundleId:
        data.window?.bundleId ??
        data.app?.bundle_id ??
        data.app?.bundleId ??
        bundleId ??
        "",
      title: data.window?.title ?? title ?? "",
    });
    if (
      isProtectedSelfTarget({ ...winMeta, selfPid, excludeProcessNames }) ||
      (excludePid &&
        isProtectedSelfTarget({
          ...winMeta,
          selfPid: excludePid,
          excludeProcessNames,
        }))
    ) {
      return {
        ok: false,
        code: "SELF_TARGET_FORBIDDEN",
        error: "禁止读取 ChisaBot 自身窗口控件树。",
      };
    }

    const tree = data.tree ?? null;
    const nodes = Array.isArray(data.nodes)
      ? flattenTreeNodes(data.nodes)
      : flattenTreeNodes(tree);
    rememberWindow(winMeta);
    rememberRefs(nodes, winMeta);

    const snapshotId = data.snapshot_id ?? data.snapshotId ?? null;
    return {
      ok: true,
      found: true,
      driver: DRIVER_NAME,
      snapshotId,
      window: winMeta,
      tree,
      nodes,
      refCount: Number(
        data.ref_count ?? data.refCount ?? nodes.filter((n) => n.ref).length,
      ),
      complete:
        data.complete !== undefined ? Boolean(data.complete) : !data.truncated,
      truncated: Boolean(data.truncated),
    };
  }

  async function act({
    ref,
    action,
    value,
    direction,
    amount,
    option,
    pid,
    processName,
    bundleId,
    title,
    hwnd,
    excludePid,
    excludeProcessNames,
    extraArgs,
    signal,
    timeoutMs,
  } = {}) {
    const extraCheck = validateExtraArgs(extraArgs);
    if (!extraCheck.ok) return extraCheck.error;

    const refStr = String(ref || "").trim();
    const cachedByRef = refStr ? knownRefTargets.get(refStr) : null;
    const cachedByHwnd =
      hwnd !== undefined && hwnd !== null
        ? knownWindows.get(String(hwnd))
        : null;
    const checkTarget = {
      pid: pid ?? cachedByRef?.pid ?? cachedByHwnd?.pid,
      selfPid: excludePid || selfPid,
      processName:
        processName ?? cachedByRef?.processName ?? cachedByHwnd?.processName,
      bundleId: bundleId ?? cachedByRef?.bundleId ?? cachedByHwnd?.bundleId,
      title: title ?? cachedByRef?.title ?? cachedByHwnd?.title,
      excludeProcessNames,
    };
    if (
      isProtectedSelfTarget(checkTarget) ||
      isProtectedSelfTarget({ ...checkTarget, selfPid })
    ) {
      return {
        ok: false,
        code: "SELF_TARGET_FORBIDDEN",
        error: "禁止后台操控 ChisaBot 自身进程或窗口。",
      };
    }

    const actName = String(action || "")
      .trim()
      .toLowerCase();
    if (actName === "focus") {
      return {
        ok: false,
        code: "POLICY_DENIED",
        error: "后台操控禁止抢占前景焦点。",
      };
    }
    const subcmd = ACTION_SUBCOMMAND_MAP[actName];
    if (!subcmd) {
      return {
        ok: false,
        code: "ACTION_NOT_SUPPORTED",
        error: `agent-desktop 不支持的操作：${actName || "(empty)"}`,
      };
    }
    const isKnownUpstreamRef =
      Boolean(cachedByRef) && isSafeUpstreamRef(refStr);
    if (!REF_RE.test(refStr) && !isKnownUpstreamRef) {
      return {
        ok: false,
        code: "STALE_REF",
        error: `无效的元素引用格式（必须为 @<snapshotId>:e<n> 或当前会话已记录的合法上游 ref）：${refStr}`,
      };
    }

    const binCheck = resolveReadyBinary();
    if (!binCheck.ok) return binCheck.error;

    const args = [subcmd, refStr];
    if (actName === "set_value" || actName === "type") {
      args.push(String(value ?? ""));
    } else if (
      actName === "select" &&
      option !== undefined &&
      option !== null &&
      String(option) !== ""
    ) {
      args.push(String(option));
    } else if (actName === "scroll") {
      const dir = String(direction || "down")
        .trim()
        .toLowerCase();
      if (!VALID_SCROLL_DIRECTIONS.has(dir)) {
        return {
          ok: false,
          code: "ACTION_NOT_SUPPORTED",
          error: `不支持的滚动方向：${dir}`,
        };
      }
      args.push("--direction", dir);
      if (amount !== undefined && amount !== null) {
        const steps = Math.min(
          20,
          Math.max(1, Math.trunc(Number(amount) || 1)),
        );
        args.push("--amount", String(steps));
      }
    }
    args.push("--json", ...extraCheck.args);

    const res = await runCli(binCheck.resolved.binPath, args, {
      timeoutMs,
      signal,
    });
    if (res.policyDenied) {
      return normalizeAgentDesktopError(res.stderr, "POLICY_DENIED");
    }
    if (res.timedOut) {
      return normalizeAgentDesktopError(res.stderr, "TIMEOUT");
    }
    const parsed = parseJsonLoose(res.stdout);
    if (res.exitCode !== 0 || parsed?.ok === false) {
      return normalizeAgentDesktopError(
        parsed || res.stderr || res.spawnError,
        "ACTION_NOT_SUPPORTED",
      );
    }

    const data =
      parsed?.data && typeof parsed.data === "object"
        ? parsed.data
        : parsed || {};
    return {
      ok: true,
      driver: DRIVER_NAME,
      action: actName,
      ref: refStr,
      matchedName: String(data.matchedName ?? data.name ?? ""),
      delivery: String(data.delivery ?? "delivered_unverified"),
      data,
    };
  }

  async function captureWindow({
    hwnd,
    bundleId,
    processName,
    pid,
    title,
    maxWidth,
    excludePid,
    excludeProcessNames,
    extraArgs,
    signal,
    timeoutMs,
  } = {}) {
    const extraCheck = validateExtraArgs(extraArgs);
    if (!extraCheck.ok) return extraCheck.error;

    const cachedWin =
      hwnd !== undefined && hwnd !== null
        ? knownWindows.get(String(hwnd))
        : null;
    const checkTarget = {
      pid: pid ?? cachedWin?.pid,
      selfPid: excludePid || selfPid,
      processName: processName ?? cachedWin?.processName,
      bundleId: bundleId ?? cachedWin?.bundleId,
      title: title ?? cachedWin?.title,
      excludeProcessNames,
    };
    if (
      isProtectedSelfTarget(checkTarget) ||
      isProtectedSelfTarget({ ...checkTarget, selfPid })
    ) {
      return {
        ok: false,
        code: "SELF_TARGET_FORBIDDEN",
        error: "禁止截取 ChisaBot 自身窗口。",
      };
    }

    if (
      (hwnd === undefined || hwnd === null || String(hwnd).trim() === "") &&
      !bundleId &&
      !processName
    ) {
      return {
        ok: false,
        code: "WINDOW_NOT_FOUND",
        error: "captureWindow 需要提供 hwnd 或 bundleId。",
      };
    }

    const binCheck = resolveReadyBinary();
    if (!binCheck.ok) return binCheck.error;

    const token = crypto.randomBytes(8).toString("hex");
    const tmpPng = path.join(tmpDir, `cb-ad-shot-${process.pid}-${token}.png`);

    try {
      const args = ["screenshot"];
      if (hwnd !== undefined && hwnd !== null && String(hwnd).trim() !== "") {
        args.push("--window-id", String(hwnd));
      } else {
        args.push("--app", String(bundleId || processName));
      }
      args.push(tmpPng, "--json", ...extraCheck.args);

      const res = await runCli(binCheck.resolved.binPath, args, {
        timeoutMs,
        signal,
      });
      if (res.policyDenied) {
        return normalizeAgentDesktopError(res.stderr, "POLICY_DENIED");
      }
      if (res.timedOut) {
        return normalizeAgentDesktopError(res.stderr, "TIMEOUT");
      }
      const parsed = parseJsonLoose(res.stdout);
      if (res.exitCode !== 0 || parsed?.ok === false) {
        return normalizeAgentDesktopError(
          parsed || res.stderr || res.spawnError,
          "ACTION_NOT_SUPPORTED",
        );
      }

      const buf = await fsp.readFile(tmpPng);
      const dims = parsePngDimensions(buf);
      const data =
        parsed?.data && typeof parsed.data === "object"
          ? parsed.data
          : parsed || {};
      const width = Number(data.width || dims.width || 0);
      const height = Number(data.height || dims.height || 0);

      return {
        ok: true,
        driver: DRIVER_NAME,
        format: "png",
        hwnd: hwnd ?? data.hwnd ?? data.window_id ?? 0,
        maxWidth: maxWidth ?? null,
        width,
        height,
        windowWidth: Number(data.windowWidth ?? data.window_width ?? width),
        windowHeight: Number(data.windowHeight ?? data.window_height ?? height),
        base64: buf.toString("base64"),
      };
    } catch (error) {
      return normalizeAgentDesktopError(error, "ACTION_NOT_SUPPORTED");
    } finally {
      try {
        await fsp.rm(tmpPng, { force: true });
      } catch {}
    }
  }

  return {
    name: DRIVER_NAME,
    isAvailable,
    listWindows,
    snapshot,
    act,
    captureWindow,
  };
}

module.exports = {
  DRIVER_NAME,
  SELF_PROCESS_NAMES,
  STANDARD_ERROR_CODES,
  createAgentDesktopDriver,
  resolveAgentDesktopBinary,
  verifyBinarySha256,
  normalizeAgentDesktopError,
};
