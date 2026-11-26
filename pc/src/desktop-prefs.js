"use strict";
/**
 * ChisaBot 桌面壳基础项（右键菜单、硬件加速开关、显式时区覆盖、拼写检查与出口域名白名单）。
 * 纯 Node/CommonJS 模块，不直接依赖 electron，便于在单测与启动早期（app.whenReady 之前）复用。
 */
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_PREFS_DEFAULTS = Object.freeze({
  hardwareAcceleration: true,
  spellcheck: true,
  timezone: "",
  allowedEgressDomains: [],
});

const MAX_ALLOWED_EGRESS_DOMAINS = 64;
const DOMAIN_RE =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const SAFE_INTERNAL_PROTOCOLS = new Set([
  "file:",
  "data:",
  "blob:",
  "about:",
  "devtools:",
  "chrome-extension:",
  "chisabot:",
]);
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 校验 IANA 时区名称；空字符串代表跟随系统时区。 */
function isValidTimezone(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.length > 80 || hasControlChar(trimmed)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/** 规范化并校验出口白名单域名（支持 `cdn.example.com` 或 `*.example.com`）。 */
function normalizeAllowedDomains(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().toLowerCase().replace(/\.+$/, "");
    if (!cleaned || cleaned.length > 253 || hasControlChar(cleaned)) continue;
    if (!DOMAIN_RE.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_ALLOWED_EGRESS_DOMAINS) break;
  }
  return out;
}

const bootstrapRawConfigCache = new Map();

function readConfigFileStrictBootstrap(filePath) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) return null;
  if (process.platform !== "win32" && (Number(before.mode) & 0o777) !== 0o600) {
    return null;
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== info.dev || before.ino !== info.ino || !info.isFile()) {
      return null;
    }
    if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o600) {
      return null;
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** 取出冷启阶段安全读取的原始 config.json 解析结果（一次性消费，避免冷启二次同步读盘）。 */
function takeBootstrapRawConfig(userDataDir) {
  if (typeof userDataDir !== "string" || !userDataDir.trim()) return null;
  const key = path.resolve(userDataDir);
  if (!bootstrapRawConfigCache.has(key)) return null;
  const cached = bootstrapRawConfigCache.get(key);
  bootstrapRawConfigCache.delete(key);
  return cached;
}

/** 在 `app.whenReady()` 之前同步读取持久化配置，用于硬件加速与时区初始化。 */
function readBootstrapDesktopPrefs(userDataDir) {
  const result = {
    hardwareAcceleration: DESKTOP_PREFS_DEFAULTS.hardwareAcceleration,
    spellcheck: DESKTOP_PREFS_DEFAULTS.spellcheck,
    timezone: DESKTOP_PREFS_DEFAULTS.timezone,
    allowedEgressDomains: [...DESKTOP_PREFS_DEFAULTS.allowedEgressDomains],
  };
  if (typeof userDataDir !== "string" || !userDataDir.trim()) return result;
  try {
    const file = path.join(userDataDir, "config.json");
    if (!fs.existsSync(file)) return result;
    const strictParsed = readConfigFileStrictBootstrap(file);
    const parsed = strictParsed || JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return result;
    if (strictParsed && typeof strictParsed === "object") {
      bootstrapRawConfigCache.set(path.resolve(userDataDir), strictParsed);
    }
    if (typeof parsed.hardwareAcceleration === "boolean") {
      result.hardwareAcceleration = parsed.hardwareAcceleration;
    }
    if (typeof parsed.spellcheck === "boolean") {
      result.spellcheck = parsed.spellcheck;
    }
    if (
      typeof parsed.timezone === "string" &&
      isValidTimezone(parsed.timezone)
    ) {
      result.timezone = parsed.timezone.trim();
    }
    if (Array.isArray(parsed.allowedEgressDomains)) {
      result.allowedEgressDomains = normalizeAllowedDomains(
        parsed.allowedEgressDomains,
      );
    }
  } catch {}
  return result;
}

/** 清洗来自本机桥的桌面偏好增量补丁。 */
function sanitizeDesktopPrefsPatch(patch) {
  const next = {};
  if (!patch || typeof patch !== "object") return next;
  if (typeof patch.hardwareAcceleration === "boolean") {
    next.hardwareAcceleration = patch.hardwareAcceleration;
  }
  if (typeof patch.spellcheck === "boolean") {
    next.spellcheck = patch.spellcheck;
  }
  if (typeof patch.timezone === "string") {
    const tz = patch.timezone.trim();
    if (isValidTimezone(tz)) {
      next.timezone = tz;
    }
  }
  if (Array.isArray(patch.allowedEgressDomains)) {
    next.allowedEgressDomains = normalizeAllowedDomains(
      patch.allowedEgressDomains,
    );
  }
  return next;
}

function isSafeExternalHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096 || hasControlChar(trimmed))
    return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 构造原生右键菜单模板（`context-menu`）：
 * - 拼写建议（仅可编辑区域且存在拼写纠错候选）
 * - 新窗口打开外链 + 复制链接地址（仅合法 http/https 链接）
 * - 剪切 / 复制 / 粘贴 / 全选
 */
function buildContextMenuTemplate(params, actions = {}) {
  const info = params && typeof params === "object" ? params : {};
  const editFlags =
    info.editFlags && typeof info.editFlags === "object" ? info.editFlags : {};
  const template = [];

  const suggestions =
    info.isEditable &&
    typeof info.misspelledWord === "string" &&
    info.misspelledWord.trim() &&
    Array.isArray(info.dictionarySuggestions)
      ? info.dictionarySuggestions
          .filter((word) => typeof word === "string" && word.trim())
          .slice(0, 6)
      : [];

  if (suggestions.length > 0) {
    for (const suggestion of suggestions) {
      template.push({
        label: suggestion,
        click: () => actions.replaceMisspelling?.(suggestion),
      });
    }
  }

  const linkURL = isSafeExternalHttpUrl(info.linkURL)
    ? info.linkURL.trim()
    : "";
  if (linkURL) {
    if (template.length > 0) template.push({ type: "separator" });
    template.push(
      {
        label: "在新窗口中打开链接",
        click: () => actions.openExternal?.(linkURL),
      },
      {
        label: "复制链接地址",
        click: () => actions.writeClipboard?.(linkURL),
      },
    );
  }

  const hasSelection =
    typeof info.selectionText === "string" &&
    info.selectionText.trim().length > 0;

  if (info.isEditable) {
    if (template.length > 0) template.push({ type: "separator" });
    template.push(
      {
        role: "cut",
        label: "剪切",
        enabled: editFlags.canCut !== false && hasSelection,
      },
      {
        role: "copy",
        label: "复制",
        enabled: editFlags.canCopy !== false && hasSelection,
      },
      {
        role: "paste",
        label: "粘贴",
        enabled: editFlags.canPaste !== false,
      },
      { type: "separator" },
      {
        role: "selectAll",
        label: "全选",
        enabled: editFlags.canSelectAll !== false,
      },
    );
  } else if (hasSelection) {
    if (template.length > 0) template.push({ type: "separator" });
    template.push(
      {
        role: "copy",
        label: "复制",
        enabled: editFlags.canCopy !== false,
      },
      {
        role: "selectAll",
        label: "全选",
        enabled: editFlags.canSelectAll !== false,
      },
    );
  }

  return template;
}

function isLoopbackHost(hostname) {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    bare === "localhost" ||
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare.startsWith("127.")
  );
}

function defaultPortForProtocol(protocol) {
  if (protocol === "https:" || protocol === "wss:") return "443";
  if (protocol === "http:" || protocol === "ws:") return "80";
  return "";
}

function parseServerOriginRule(serverOriginRaw) {
  if (!serverOriginRaw || typeof serverOriginRaw !== "string") return null;
  try {
    const server = new URL(serverOriginRaw);
    if (server.protocol !== "https:" && server.protocol !== "http:") {
      return null;
    }
    return {
      host: server.hostname.toLowerCase(),
      port: server.port || defaultPortForProtocol(server.protocol),
      protocol: server.protocol,
    };
  } catch {
    return null;
  }
}

/**
 * 预编译出口域名白名单策略：在配置加载或变更时调用一次，
 * 避免 `session.webRequest.onBeforeRequest` 逐请求重复 `new URL(serverOrigin)` 与正则归一化。
 */
function compileEgressPolicy({ serverOrigin = "", allowedDomains = [] } = {}) {
  const server = parseServerOriginRule(serverOrigin);
  const normalized = normalizeAllowedDomains(allowedDomains);
  const exactHosts = new Set();
  const wildcardBases = [];
  for (const rule of normalized) {
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      exactHosts.add(base);
      wildcardBases.push(`.${base}`);
    } else {
      exactHosts.add(rule);
    }
  }
  return Object.freeze({
    serverHost: server ? server.host : "",
    serverPort: server ? server.port : "",
    serverProtocol: server ? server.protocol : "",
    exactHosts,
    wildcardDotSuffixes: Object.freeze(wildcardBases),
  });
}

function matchesCompiledServerOrigin(targetUrl, policy) {
  if (!policy?.serverHost) return false;
  if (targetUrl.hostname.toLowerCase() !== policy.serverHost) return false;
  const targetPort =
    targetUrl.port || defaultPortForProtocol(targetUrl.protocol);
  if (targetPort !== policy.serverPort) return false;
  if (policy.serverProtocol === "https:") {
    return targetUrl.protocol === "https:" || targetUrl.protocol === "wss:";
  }
  if (policy.serverProtocol === "http:") {
    return targetUrl.protocol === "http:" || targetUrl.protocol === "ws:";
  }
  return false;
}

function matchesCompiledAllowedDomain(hostname, policy) {
  if (
    !policy ||
    (policy.exactHosts.size === 0 && policy.wildcardDotSuffixes.length === 0)
  ) {
    return false;
  }
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (policy.exactHosts.has(host)) return true;
  for (const suffix of policy.wildcardDotSuffixes) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * 渲染进程出口域名白名单校验（供 `session.webRequest.onBeforeRequest` 使用）：
 * - 放行内部安全协议（file/data/blob/about/devtools/chisabot）
 * - 放行已配置 `serverOrigin` 同源（含对应的 ws/wss）
 * - 放行 loopback（localhost / 127.0.0.1 / ::1）
 * - 放行显式配置的 `allowedDomains`（精确域名或 `*.domain.tld`）
 * - 其余外域请求一律拦截，防止恶意渲染脚本外泄数据
 *
 * 调用方可传入 `options.policy`（`compileEgressPolicy` 预编译结果）以走零分配热路径。
 */
function isEgressUrlAllowed(rawUrl, options = {}) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (SAFE_INTERNAL_PROTOCOLS.has(protocol)) return true;
  if (!NETWORK_PROTOCOLS.has(protocol)) return false;

  if (isLoopbackHost(parsed.hostname)) return true;

  const policy = options.policy || compileEgressPolicy(options);
  if (matchesCompiledServerOrigin(parsed, policy)) return true;
  if (matchesCompiledAllowedDomain(parsed.hostname, policy)) return true;

  return false;
}

module.exports = {
  DESKTOP_PREFS_DEFAULTS,
  isValidTimezone,
  normalizeAllowedDomains,
  readBootstrapDesktopPrefs,
  takeBootstrapRawConfig,
  sanitizeDesktopPrefsPatch,
  buildContextMenuTemplate,
  compileEgressPolicy,
  isEgressUrlAllowed,
};
