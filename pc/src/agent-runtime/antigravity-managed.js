"use strict";
/**
 * ChisaBot 托管 Antigravity 运行时、严格独立账号隔离与页内 OOB 登录模块。
 *
 * 兼容 Node 22 / Electron 与 Bun `server-host`：
 * - 数据根：优先 CHISABOT_AGENT_DATA_DIR，否则 <home>/.chisabot；
 * - 托管运行时：<dataDir>/tools/antigravity/<platform>-<arch>/（versions/、active.json、staging/）；
 * - 独立账号目录：<dataDir>/agent-homes/antigravity/<safeKey>/（或 instance.config.homePath）；
 * - 严格隔离：强制 AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1、AGY_CLI_DISABLE_AUTO_UPDATE=1，
 *   剥离宿主 ANTIGRAVITY_* / AGY_* 与 Electron 冲突变量，并显式传入
 *   `--gemini-dir <homeDir>/.gemini --app-data-dir antigravity-cli --disable-telemetry`；
 * - 官方分发（源 A）：antigravity-cli-auto-updater Manifest + storage.googleapis.com 载荷，
 *   全流式 SHA-512 校验、域名白名单、手动重定向审计、tar 安全审计与 finally 必清 staging。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  sanitizeAntigravityEnv,
  killTree,
  spawnCommand,
} = require("./acp-client");
const { parseProxyList, createProxyAgent } = require("../agent/proxy");

const DEFAULT_MANIFEST_BASE_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const DEFAULT_MANIFEST_HOST =
  "antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const DEFAULT_DOWNLOAD_HOST = "storage.googleapis.com";
const DEFAULT_DOWNLOAD_PATH_PREFIX = "/antigravity-public/antigravity-cli/";
const MAX_REDIRECTS = 5;
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // 1 GiB
const PROGRESS_THROTTLE_MS = 250;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_RETAINED_VERSIONS = 2;

const OAUTH_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/i;
const LOGGED_IN_EMAIL_RE = /Logged in as\s+([^\s<>'"()]+@[^\s<>'"()]+)/i;
const LOGGED_IN_FALLBACK_RE = /Logged in as\s+([^\r\n]+)/i;

const AUTH_METADATA_FILENAME = "chisabot-auth.json";
const KNOWN_TOKEN_FILENAMES = new Set([
  "acp_token.json",
  "token.json",
  "tokens.json",
  "oauth_creds.json",
  "oauth_token.json",
  "credentials.json",
  "cli_token.json",
  "auth_token.json",
  "auth.json",
  "file_token_storage.json",
  "google_accounts.json",
]);
const TOKEN_FILENAME_PATTERN =
  /^(?:.*(?:token|cred|oauth).*\.json|token(?:s)?|oauth_creds)$/i;

function stripWrappingQuotes(value) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function getOwnEnvCaseInsensitive(envObj, key) {
  if (!envObj || typeof envObj !== "object") return undefined;
  if (process.platform !== "win32") {
    return Object.hasOwn(envObj, key) ? envObj[key] : undefined;
  }
  const lower = key.toLowerCase();
  let matched;
  let found = false;
  for (const k of Object.keys(envObj)) {
    if (k.toLowerCase() === lower && envObj[k] !== undefined) {
      matched = envObj[k];
      found = true;
    }
  }
  return found ? matched : undefined;
}

function hasOwnEnvCaseInsensitive(envObj, key) {
  if (!envObj || typeof envObj !== "object") return false;
  if (process.platform !== "win32") {
    return Object.hasOwn(envObj, key);
  }
  const lower = key.toLowerCase();
  return Object.keys(envObj).some((k) => k.toLowerCase() === lower);
}

function deleteEnvCaseInsensitive(envObj, key) {
  if (!envObj || typeof envObj !== "object") return;
  if (process.platform !== "win32") {
    delete envObj[key];
    return;
  }
  const lower = key.toLowerCase();
  for (const k of Object.keys(envObj)) {
    if (k.toLowerCase() === lower) {
      delete envObj[k];
    }
  }
}

function setEnvCanonical(envObj, key, value) {
  deleteEnvCaseInsensitive(envObj, key);
  envObj[key] = value;
}

function getEnvValue(customEnv, key) {
  const fromCustom = getOwnEnvCaseInsensitive(customEnv, key);
  if (fromCustom !== undefined) return String(fromCustom);
  const fromProcess = process.env[key];
  return fromProcess !== undefined ? String(fromProcess) : undefined;
}

function getHomeDir(customEnv) {
  const win = process.platform === "win32";
  const customHome = win
    ? getOwnEnvCaseInsensitive(customEnv, "USERPROFILE") ||
      getOwnEnvCaseInsensitive(customEnv, "HOME")
    : getOwnEnvCaseInsensitive(customEnv, "HOME");
  if (customHome && String(customHome).trim()) {
    return stripWrappingQuotes(String(customHome));
  }
  return os.homedir();
}

function expandHomeWithEnv(rawPath, customEnv) {
  const trimmed = stripWrappingQuotes(rawPath);
  if (!trimmed) return null;
  const home = getHomeDir(customEnv);
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(home, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function isInsideDir(targetPath, rootDir) {
  const win = process.platform === "win32";
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootDir);
  const normTarget = win ? resolvedTarget.toLowerCase() : resolvedTarget;
  const normRoot = win ? resolvedRoot.toLowerCase() : resolvedRoot;
  if (normTarget === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep)
    ? normRoot
    : `${normRoot}${path.sep}`;
  return normTarget.startsWith(prefix);
}

function sanitizeHomeDirKey(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  return cleaned || "default";
}

function sanitizeVersionOrJobSegment(raw, fallback = "job") {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._+-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.+]+|[-.+]+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function resolveChisabotDataDir(customEnv) {
  if (hasOwnEnvCaseInsensitive(customEnv, "CHISABOT_AGENT_DATA_DIR")) {
    const rawCustom = stripWrappingQuotes(
      String(getOwnEnvCaseInsensitive(customEnv, "CHISABOT_AGENT_DATA_DIR") || ""),
    );
    if (rawCustom) {
      return expandHomeWithEnv(rawCustom, customEnv);
    }
    return path.join(getHomeDir(customEnv), ".chisabot");
  }
  const rawProcess = stripWrappingQuotes(
    String(process.env.CHISABOT_AGENT_DATA_DIR || ""),
  );
  if (rawProcess) {
    return expandHomeWithEnv(rawProcess, customEnv);
  }
  return path.join(getHomeDir(customEnv), ".chisabot");
}

function getPlatformKey(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  return `${platform}-${arch}`;
}

function resolveAntigravityToolsDir(customEnv, options = {}) {
  return path.join(
    resolveChisabotDataDir(customEnv),
    "tools",
    "antigravity",
    getPlatformKey(options),
  );
}

function resolveAntigravityHomeDir(instance = {}, customEnv = {}) {
  const rawHomePath =
    typeof instance?.config?.homePath === "string"
      ? stripWrappingQuotes(instance.config.homePath)
      : "";
  if (rawHomePath) {
    const expanded = expandHomeWithEnv(rawHomePath, customEnv);
    if (expanded) return expanded;
  }
  const rawKey =
    (typeof instance?.id === "string" && instance.id.trim()) ||
    (typeof instance?.slug === "string" && instance.slug.trim()) ||
    "default";
  const safeKey = sanitizeHomeDirKey(rawKey);
  return path.join(
    resolveChisabotDataDir(customEnv),
    "agent-homes",
    "antigravity",
    safeKey,
  );
}

/**
 * 构建 Antigravity 严格隔离环境与 ACP 启动参数：
 * 1) 剥离宿主继承的所有 ANTIGRAVITY_* / AGY_*（大小写无关）与 Electron 冲突变量；
 * 2) 叠加实例显式 env 并执行代理修复（sanitizeAntigravityEnv）；
 * 3) 强制覆盖 HOME / USERPROFILE / 平台用户目录变量，以及
 *    AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 与 AGY_CLI_DISABLE_AUTO_UPDATE=1；
 * 4) 返回相对 --app-data-dir 参数（绝不传绝对路径）。
 */
function resolveAntigravityIsolation(instance = {}, baseEnv = process.env) {
  const instEnv =
    instance?.env && typeof instance.env === "object" ? instance.env : {};
  const pathEnv = { ...(baseEnv || {}), ...instEnv };
  const homeDir = resolveAntigravityHomeDir(instance, pathEnv);
  const geminiDir = path.join(homeDir, ".gemini");

  // 1. 拷贝宿主环境并剥离宿主继承的 ANTIGRAVITY_* / AGY_* / Electron 冲突变量
  const cleanedBase = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (/^(?:ANTIGRAVITY_|AGY_)/i.test(k)) continue;
    const upper = k.toUpperCase();
    if (
      upper === "ELECTRON_RUN_AS_NODE" ||
      upper === "ELECTRON_NO_ATTACH_CONSOLE"
    ) {
      continue;
    }
    cleanedBase[k] = v;
  }

  // 2. 叠加用户显式 instance.env 并做代理前缀修复与二次 Electron 净化
  const overlaid = { ...cleanedBase };
  for (const [k, v] of Object.entries(instEnv)) {
    if (v === undefined) continue;
    if (process.platform === "win32") {
      deleteEnvCaseInsensitive(overlaid, k);
    }
    overlaid[k] = String(v);
  }
  const env = sanitizeAntigravityEnv(
    overlaid,
    instance?.config?.fixProxy !== false,
  );

  // 3. 强制设置隔离目录与文件型 Token 存储 / 禁止后台自更新
  setEnvCanonical(env, "HOME", homeDir);
  setEnvCanonical(env, "USERPROFILE", homeDir);
  if (process.platform === "win32") {
    const resolvedWin = path.resolve(homeDir);
    const driveMatch = /^([a-zA-Z]:)(.*)$/.exec(resolvedWin);
    if (driveMatch) {
      setEnvCanonical(env, "HOMEDRIVE", driveMatch[1]);
      setEnvCanonical(env, "HOMEPATH", driveMatch[2] || "\\");
    }
    setEnvCanonical(env, "APPDATA", path.join(homeDir, "AppData", "Roaming"));
    setEnvCanonical(
      env,
      "LOCALAPPDATA",
      path.join(homeDir, "AppData", "Local"),
    );
  } else {
    setEnvCanonical(env, "XDG_CONFIG_HOME", path.join(homeDir, ".config"));
    setEnvCanonical(
      env,
      "XDG_DATA_HOME",
      path.join(homeDir, ".local", "share"),
    );
    setEnvCanonical(env, "XDG_CACHE_HOME", path.join(homeDir, ".cache"));
  }
  setEnvCanonical(env, "AGY_CLI_FORCE_FILE_TOKEN_STORAGE", "1");
  setEnvCanonical(env, "AGY_CLI_DISABLE_AUTO_UPDATE", "1");

  const acpExtraArgs = [
    "--gemini-dir",
    geminiDir,
    "--app-data-dir",
    "antigravity-cli",
    "--disable-telemetry",
  ];

  return {
    homeDir,
    geminiDir,
    env,
    acpExtraArgs,
  };
}

function ensureAntigravityHomeDirs(isolation) {
  if (!isolation?.homeDir) return;
  try {
    fs.mkdirSync(path.join(isolation.geminiDir, "antigravity-cli"), {
      recursive: true,
    });
    if (process.platform === "win32") {
      fs.mkdirSync(path.join(isolation.homeDir, "AppData", "Roaming"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(isolation.homeDir, "AppData", "Local"), {
        recursive: true,
      });
    } else {
      fs.mkdirSync(path.join(isolation.homeDir, ".config"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(isolation.homeDir, ".local", "share"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(isolation.homeDir, ".cache"), {
        recursive: true,
      });
    }
  } catch {}
}

function detectLinuxMusl() {
  if (process.platform !== "linux") return false;
  for (const libDir of ["/lib", "/usr/lib", "/lib64"]) {
    try {
      const entries = fs.readdirSync(libDir);
      if (entries.some((name) => name.startsWith("libc.musl-"))) {
        return true;
      }
    } catch {}
  }
  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {}
  return false;
}

function resolveManifestPlatform(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const platformKey = `${platform}-${arch}`;

  if (platform === "win32" && arch === "x64") {
    return {
      supported: true,
      platformKey,
      manifestPlatform: "windows_amd64",
      archiveType: "exe",
      binaryName: "agy.exe",
    };
  }
  if (platform === "win32" && arch === "arm64") {
    return {
      supported: true,
      platformKey,
      manifestPlatform: "windows_arm64",
      archiveType: "exe",
      binaryName: "agy.exe",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      supported: true,
      platformKey,
      manifestPlatform: "darwin_arm64",
      archiveType: "tar.gz",
      binaryName: "agy",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      supported: true,
      platformKey,
      manifestPlatform: "darwin_amd64",
      archiveType: "tar.gz",
      binaryName: "agy",
    };
  }
  if (platform === "linux" && arch === "x64") {
    const isMusl =
      options.isMusl !== undefined ? Boolean(options.isMusl) : detectLinuxMusl();
    return {
      supported: true,
      platformKey,
      manifestPlatform: isMusl ? "linux_amd64_musl" : "linux_amd64",
      archiveType: "tar.gz",
      binaryName: "agy",
    };
  }
  if (platform === "linux" && arch === "arm64") {
    const isMusl =
      options.isMusl !== undefined ? Boolean(options.isMusl) : detectLinuxMusl();
    return {
      supported: true,
      platformKey,
      manifestPlatform: isMusl ? "linux_arm64_musl" : "linux_arm64",
      archiveType: "tar.gz",
      binaryName: "agy",
    };
  }
  return {
    supported: false,
    platformKey,
    manifestPlatform: null,
    archiveType: null,
    binaryName: null,
    unsupportedReason: `暂不支持当前平台架构（${platformKey}）的 Antigravity 自动托管安装`,
  };
}

/**
 * 校验请求 URL 是否在允许白名单内（含重定向每一跳）。
 * 默认严格锁定官方域名与下载路径前缀；仅测试可显式传入 options.allowedHosts。
 */
function assertAllowedUrl(rawUrl, kind, options = {}) {
  let parsed;
  try {
    parsed = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
  } catch {
    throw new Error(`无效的下载链接：${String(rawUrl)}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (Array.isArray(options.allowedHosts) && options.allowedHosts.length > 0) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`不支持的协议：${parsed.protocol}`);
    }
    const allowed = new Set(
      options.allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean),
    );
    if (!allowed.has(host)) {
      throw new Error(`拒绝访问不在白名单内的域名：${host}`);
    }
    return parsed;
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`拒绝非 HTTPS 下载链接：${parsed.protocol}//${host}`);
  }
  if (kind === "manifest") {
    if (host !== DEFAULT_MANIFEST_HOST) {
      throw new Error(`拒绝访问非官方 Manifest 域名：${host}`);
    }
    return parsed;
  }
  if (
    host !== DEFAULT_DOWNLOAD_HOST ||
    !parsed.pathname.startsWith(DEFAULT_DOWNLOAD_PATH_PREFIX)
  ) {
    throw new Error(
      `拒绝访问非官方下载源：${host}${parsed.pathname}`,
    );
  }
  return parsed;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function shouldBypassProxy(hostname, envObj) {
  if (isLoopbackHost(hostname)) return true;
  const noProxy =
    getEnvValue(envObj, "NO_PROXY") || getEnvValue(envObj, "no_proxy") || "";
  if (!noProxy.trim()) return false;
  const target = hostname.toLowerCase();
  for (const rawRule of noProxy.split(",")) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    const hostOnly = rule.replace(/:\d+$/, "");
    if (hostOnly.startsWith(".")) {
      if (target.endsWith(hostOnly) || target === hostOnly.slice(1)) {
        return true;
      }
    } else if (target === hostOnly || target.endsWith(`.${hostOnly}`)) {
      return true;
    }
  }
  return false;
}

function parseEnvProxyUrl(rawProxy) {
  const trimmed = String(rawProxy || "").trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const proto = parsed.protocol.toLowerCase();
  const host = parsed.hostname;
  if (!host) return null;
  const port = Number(parsed.port) || (proto === "https:" ? 443 : 80);
  if (proto === "http:") return { type: "http", host, port };
  if (proto === "https:") return { type: "https", host, port };
  if (proto === "socks5:" || proto === "socks5h:" || proto === "socks:") {
    return { type: "socks5", host, port };
  }
  return null;
}

async function resolveHttpAgent(targetUrl, options = {}) {
  const envObj = options.customEnv || process.env;
  if (shouldBypassProxy(targetUrl.hostname, envObj)) {
    return undefined;
  }
  const secure = targetUrl.protocol === "https:";
  if (typeof options.resolveProxy === "function") {
    try {
      const spec = await options.resolveProxy(targetUrl.toString());
      const proxies = parseProxyList(spec);
      const agent = createProxyAgent(proxies, { secure, timeoutMs: 20_000 });
      if (agent) return agent;
    } catch {}
  }
  const rawProxy = secure
    ? getEnvValue(envObj, "HTTPS_PROXY") ||
      getEnvValue(envObj, "https_proxy") ||
      getEnvValue(envObj, "ALL_PROXY") ||
      getEnvValue(envObj, "all_proxy")
    : getEnvValue(envObj, "HTTP_PROXY") ||
      getEnvValue(envObj, "http_proxy") ||
      getEnvValue(envObj, "ALL_PROXY") ||
      getEnvValue(envObj, "all_proxy");
  const parsed = parseEnvProxyUrl(rawProxy);
  if (!parsed) return undefined;
  return createProxyAgent([parsed], { secure, timeoutMs: 20_000 });
}

function makeAbortError(message = "已取消") {
  const err = new Error(message);
  err.name = "AbortError";
  err.cancelled = true;
  return err;
}

/**
 * 发起受控 HTTP/HTTPS GET 请求：
 * - 手动跟随 ≤5 跳重定向且每一跳复验白名单；
 * - 复用 proxy.js 代理支持；
 * - 完整支持 AbortSignal 取消与响应超时。
 */
async function openAllowedHttpResponse(initialUrl, kind, options = {}) {
  const signal = options.signal || null;
  const timeoutMs = Number(options.timeoutMs) || 30_000;
  let currentUrl = assertAllowedUrl(initialUrl, kind, options);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (signal?.aborted) throw makeAbortError("已取消安装");
    const agent = await resolveHttpAgent(currentUrl, options);
    const lib = currentUrl.protocol === "http:" ? http : https;

    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, res) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(res);
      };
      const req = lib.request(
        currentUrl,
        {
          method: "GET",
          agent,
          headers: {
            "User-Agent": "ChisaBot-Antigravity-Installer/1.0",
            Accept:
              kind === "manifest"
                ? "application/json"
                : "application/octet-stream,*/*",
          },
        },
        (res) => done(null, res),
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
      });
      req.on("error", (err) => done(err));
      const onAbort = () => {
        const abortErr = makeAbortError("已取消安装");
        req.destroy(abortErr);
        done(abortErr);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      req.end();
    });

    const status = response.statusCode || 0;
    if (
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
    ) {
      const location = response.headers.location;
      response.resume();
      if (!location) {
        throw new Error(`下载重定向缺少 Location 头（HTTP ${status}）`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`下载重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
      }
      const nextUrl = new URL(location, currentUrl);
      currentUrl = assertAllowedUrl(nextUrl, kind, options);
      continue;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`下载请求失败（HTTP ${status}）`);
    }

    return { response, finalUrl: currentUrl.toString() };
  }

  throw new Error(`下载重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
}

async function fetchAntigravityManifest(options = {}) {
  const platformSpec = resolveManifestPlatform(options);
  if (!platformSpec.supported) {
    throw new Error(platformSpec.unsupportedReason);
  }
  const baseUrl = String(
    options.manifestBaseUrl || DEFAULT_MANIFEST_BASE_URL,
  ).replace(/\/+$/, "");
  const manifestUrl = `${baseUrl}/manifests/${platformSpec.manifestPlatform}.json`;
  const { response } = await openAllowedHttpResponse(manifestUrl, "manifest", {
    ...options,
    timeoutMs: options.manifestTimeoutMs || 15_000,
  });

  const chunks = [];
  let total = 0;
  const maxBytes = 256 * 1024;
  await new Promise((resolve, reject) => {
    const signal = options.signal || null;
    const onAbort = () => {
      response.destroy(makeAbortError("已取消安装"));
      reject(makeAbortError("已取消安装"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    response.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy(new Error("Manifest 响应体积过大"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      cleanup();
      resolve();
    });
    response.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Antigravity Manifest JSON 格式无效");
  }
  const version =
    typeof parsed?.version === "string" ? parsed.version.trim() : "";
  const url = typeof parsed?.url === "string" ? parsed.url.trim() : "";
  const sha512 =
    typeof parsed?.sha512 === "string" ? parsed.sha512.trim().toLowerCase() : "";

  if (!version || !/^[A-Za-z0-9._+-]+$/.test(version) || version.includes("..")) {
    throw new Error(`Antigravity Manifest 版本号非法：${version || "(空)"}`);
  }
  if (!url) {
    throw new Error("Antigravity Manifest 缺少下载地址");
  }
  assertAllowedUrl(url, "download", options);
  if (!/^[0-9a-f]{128}$/.test(sha512)) {
    throw new Error("Antigravity Manifest 缺少合法的 SHA-512 校验值");
  }

  return {
    version,
    url,
    sha512,
    manifestUrl,
    platformSpec,
  };
}

function findNearestExistingDir(targetPath) {
  let current = path.resolve(targetPath);
  for (let i = 0; i < 64; i += 1) {
    try {
      if (fs.existsSync(current)) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return os.tmpdir();
}

function checkFreeDiskSpace(targetDir, minBytes = MIN_FREE_DISK_BYTES) {
  if (typeof fs.statfsSync !== "function") return;
  const checkPath = findNearestExistingDir(targetDir);
  let stats;
  try {
    stats = fs.statfsSync(checkPath);
  } catch {
    return;
  }
  const bavail = Number(stats?.bavail);
  const bsize = Number(stats?.bsize);
  if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0) {
    return;
  }
  const availableBytes = bavail * bsize;
  if (availableBytes >= 0 && availableBytes < minBytes) {
    const availMiB = Math.round(availableBytes / (1024 * 1024));
    const reqMiB = Math.round(minBytes / (1024 * 1024));
    throw new Error(
      `目标磁盘剩余空间不足（当前约 ${availMiB} MiB，至少需要 ${reqMiB} MiB），已中止安装。`,
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removePathWithRetry(targetPath, { recursive = true, attempts = 6, delayMs = 200 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsp.rm(targetPath, { recursive, force: true });
      return true;
    } catch (err) {
      const code = err?.code;
      if (code === "ENOENT") return true;
      if (
        i + 1 < attempts &&
        (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")
      ) {
        await sleep(delayMs * (i + 1));
        continue;
      }
      return false;
    }
  }
  return false;
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

/**
 * 审计 tar -tvzf / tar -tzf 输出：
 * 严格拒绝绝对路径、.. 路径穿越、symlink、hardlink 及非普通文件，仅返回白名单条目名。
 */
function auditTarListing(verboseOutput, listOutput, expectedFileName = "antigravity") {
  const verboseLines = String(verboseOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of verboseLines) {
    const typeChar = line[0];
    if (typeChar !== "-" && typeChar !== "d") {
      throw new Error(`tar 压缩包包含不安全的非普通文件条目：${line.slice(0, 120)}`);
    }
    if (line.includes(" -> ") || /\slink to\s/i.test(line)) {
      throw new Error(`tar 压缩包包含被禁止的符号链接或硬链接：${line.slice(0, 120)}`);
    }
  }

  const listLines = String(listOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (listLines.length === 0) {
    throw new Error("tar 压缩包为空");
  }

  let matchedEntry = null;
  for (const entry of listLines) {
    if (
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      /^[a-zA-Z]:/.test(entry)
    ) {
      throw new Error(`tar 压缩包包含非法绝对路径条目：${entry}`);
    }
    const normalized = entry.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
    if (segments.includes("..")) {
      throw new Error(`tar 压缩包包含路径穿越条目：${entry}`);
    }
    if (segments.length === 1 && segments[0] === expectedFileName) {
      matchedEntry = entry;
    }
  }

  if (!matchedEntry) {
    throw new Error(`tar 压缩包中未找到预期的 ${expectedFileName} 可执行文件`);
  }
  return matchedEntry;
}

async function extractTarGzBinary(archivePath, extractDir, expectedFileName = "antigravity") {
  await fsp.mkdir(extractDir, { recursive: true });
  const verboseRes = await execFilePromise("tar", ["-tvzf", archivePath]);
  const listRes = await execFilePromise("tar", ["-tzf", archivePath]);
  const matchedEntry = auditTarListing(
    verboseRes.stdout,
    listRes.stdout,
    expectedFileName,
  );

  await execFilePromise("tar", [
    "-xzf",
    archivePath,
    "-C",
    extractDir,
    "--",
    matchedEntry,
  ]);

  const extractedPath = path.resolve(extractDir, matchedEntry);
  if (!isInsideDir(extractedPath, extractDir)) {
    throw new Error("解压结果路径逃逸出暂存目录，已中止安装");
  }
  const stat = fs.lstatSync(extractedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("解压目标不是普通文件（拒绝符号链接），已中止安装");
  }
  return extractedPath;
}

function moveFileAtomicOrCopy(srcPath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpDest = `${destPath}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  try {
    try {
      fs.renameSync(srcPath, tmpDest);
    } catch (err) {
      if (err?.code === "EXDEV") {
        fs.copyFileSync(srcPath, tmpDest);
        fs.unlinkSync(srcPath);
      } else {
        throw err;
      }
    }
    fs.renameSync(tmpDest, destPath);
  } catch (err) {
    try {
      fs.rmSync(tmpDest, { force: true });
    } catch {}
    if (err?.code === "EBUSY" || err?.code === "EPERM") {
      throw new Error(
        "目标 Antigravity 可执行文件正被占用，请先停止正在运行的 Antigravity 任务后重试。",
      );
    }
    throw err;
  }
}

async function pruneOldManagedVersions(toolsDir, activeVersion) {
  const versionsDir = path.join(toolsDir, "versions");
  let entries;
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(versionsDir, entry.name);
    let mtimeMs = 0;
    try {
      const stat = await fsp.stat(full);
      mtimeMs = stat.mtimeMs;
    } catch {}
    dirs.push({ name: entry.name, full, mtimeMs });
  }
  const others = dirs
    .filter((d) => d.name !== activeVersion)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepOthersCount = Math.max(0, MAX_RETAINED_VERSIONS - 1);
  const toDelete = others.slice(keepOthersCount);
  for (const item of toDelete) {
    await removePathWithRetry(item.full, { recursive: true, attempts: 4, delayMs: 200 });
  }
}

/**
 * 读取 ChisaBot 托管 Antigravity 的当前活动版本信息。
 */
function readManagedAntigravityInfo(customEnv, options = {}) {
  const toolsDir = resolveAntigravityToolsDir(customEnv, options);
  const activePath = path.join(toolsDir, "active.json");
  let parsed;
  try {
    const raw = fs.readFileSync(activePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const version =
    typeof parsed.version === "string" ? parsed.version.trim() : "";
  const binaryRelPath =
    typeof parsed.binaryRelPath === "string" ? parsed.binaryRelPath.trim() : "";
  if (
    !version ||
    !binaryRelPath ||
    path.isAbsolute(binaryRelPath) ||
    binaryRelPath.includes("..")
  ) {
    return null;
  }
  const binaryPath = path.resolve(toolsDir, binaryRelPath);
  if (!isInsideDir(binaryPath, toolsDir)) return null;
  try {
    const lstat = fs.lstatSync(binaryPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
  } catch {
    return null;
  }
  return {
    version,
    binaryPath,
    binaryRelPath,
    sha512: typeof parsed.sha512 === "string" ? parsed.sha512 : null,
    installedAt:
      typeof parsed.installedAt === "string" ? parsed.installedAt : null,
    sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : null,
    toolsDir,
  };
}

function readManagedAntigravityBinary(customEnv, options = {}) {
  const info = readManagedAntigravityInfo(customEnv, options);
  return info ? info.binaryPath : null;
}

function compareVersions(a, b) {
  const pa = String(a || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const pb = String(b || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return String(a || "") === String(b || "") ? 0 : 1;
}

/**
 * 获取当前宿主上的 Antigravity 运行时托管与系统安装状态。
 */
async function getAntigravityRuntimeStatus(options = {}) {
  const customEnv = options.customEnv || process.env;
  const platformSpec = resolveManifestPlatform(options);
  const toolsDir = resolveAntigravityToolsDir(customEnv, options);
  const managed = readManagedAntigravityInfo(customEnv, options);
  const systemBinaryPath =
    typeof options.findSystemBinary === "function"
      ? options.findSystemBinary(customEnv) || null
      : null;

  let source = "missing";
  let activeBinaryPath = null;
  let activeVersion = null;
  if (managed) {
    source = "managed";
    activeBinaryPath = managed.binaryPath;
    activeVersion = managed.version;
  } else if (systemBinaryPath) {
    source = "system";
    activeBinaryPath = systemBinaryPath;
    if (typeof options.probeVersion === "function") {
      try {
        activeVersion = (await options.probeVersion(systemBinaryPath)) || null;
      } catch {
        activeVersion = null;
      }
    }
  }

  let latestVersion = null;
  let updateAvailable = false;
  if (options.checkLatest && platformSpec.supported) {
    try {
      const manifest = await fetchAntigravityManifest({
        ...options,
        manifestTimeoutMs: options.manifestTimeoutMs || 8_000,
      });
      latestVersion = manifest.version;
      if (managed?.version && latestVersion) {
        updateAvailable = compareVersions(latestVersion, managed.version) > 0;
      }
    } catch {
      latestVersion = null;
      updateAvailable = false;
    }
  }

  return {
    installed: Boolean(activeBinaryPath),
    source,
    managedInstalled: Boolean(managed),
    managedVersion: managed ? managed.version : null,
    managedBinaryPath: managed ? managed.binaryPath : null,
    systemBinaryPath,
    activeBinaryPath,
    activeVersion,
    platformKey: platformSpec.platformKey,
    toolsDir,
    ...(options.checkLatest
      ? { latestVersion, updateAvailable }
      : {}),
    supported: platformSpec.supported,
    unsupportedReason: platformSpec.unsupportedReason || null,
  };
}

/**
 * 一键托管安装 / 更新 Antigravity 官方 CLI：
 * - Manifest 校验 + 目标卷剩余空间检查 + 流式下载与 SHA-512 校验；
 * - Windows 直落盘 agy.exe + 清 Zone.Identifier；macOS/Linux tar 审计定向解压 + chmod 0755；
 * - 原子写 active.json + 保留最近 2 个版本 + finally 强制清理 staging/<jobId>/。
 */
async function installManagedAntigravity(options = {}) {
  const customEnv = options.customEnv || process.env;
  const signal = options.signal || null;
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : () => {};
  const jobId = sanitizeVersionOrJobSegment(
    options.jobId || crypto.randomUUID(),
    "install",
  );
  const platformSpec = resolveManifestPlatform(options);
  if (!platformSpec.supported) {
    throw new Error(platformSpec.unsupportedReason);
  }
  if (signal?.aborted) throw makeAbortError("已取消安装");

  const toolsDir = resolveAntigravityToolsDir(customEnv, options);
  const stagingJobDir = path.join(toolsDir, "staging", jobId);
  const activeTmpPath = path.join(toolsDir, `active.json.tmp.${jobId}`);

  onProgress({
    stage: "checking",
    percent: null,
    downloadedBytes: 0,
    totalBytes: null,
    message: "正在检查磁盘空间与官方版本清单…",
  });

  checkFreeDiskSpace(
    toolsDir,
    options.minFreeDiskBytes ?? MIN_FREE_DISK_BYTES,
  );

  const manifest = await fetchAntigravityManifest(options);
  if (signal?.aborted) throw makeAbortError("已取消安装");

  const existing = readManagedAntigravityInfo(customEnv, options);
  if (!options.force && existing && existing.version === manifest.version) {
    return {
      ok: true,
      version: existing.version,
      binaryPath: existing.binaryPath,
      toolsDir,
      alreadyInstalled: true,
    };
  }

  try {
    await fsp.mkdir(stagingJobDir, { recursive: true });
    const payloadPath = path.join(stagingJobDir, "payload");

    onProgress({
      stage: "downloading",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: `正在下载 Antigravity ${manifest.version}…`,
    });

    const { response, finalUrl } = await openAllowedHttpResponse(
      manifest.url,
      "download",
      {
        ...options,
        timeoutMs: options.downloadTimeoutMs || 60_000,
      },
    );

    const contentLengthHeader = Number(response.headers["content-length"]);
    const totalBytes =
      Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
        ? contentLengthHeader
        : null;
    let downloadedBytes = 0;
    let lastProgressAt = 0;

    const hash = crypto.createHash("sha512");
    const fileStream = fs.createWriteStream(payloadPath);

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) {
          response.destroy();
          fileStream.destroy();
          reject(err);
        } else {
          resolve();
        }
      };

      const onAbort = () => {
        finish(makeAbortError("已取消安装"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      response.on("data", (chunk) => {
        if (settled) return;
        hash.update(chunk);
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now;
          const percent = totalBytes
            ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
            : null;
          onProgress({
            stage: "downloading",
            percent,
            downloadedBytes,
            totalBytes,
            message:
              percent !== null
                ? `正在下载 Antigravity ${manifest.version}（${percent}%）…`
                : `正在下载 Antigravity ${manifest.version}…`,
          });
        }
        if (!fileStream.write(chunk)) {
          response.pause();
          fileStream.once("drain", () => {
            if (!settled) response.resume();
          });
        }
      });

      response.on("error", (err) => finish(err));
      fileStream.on("error", (err) => finish(err));
      response.on("end", () => {
        if (settled) return;
        fileStream.end();
      });
      fileStream.on("finish", () => {
        onProgress({
          stage: "downloading",
          percent: totalBytes ? 100 : null,
          downloadedBytes,
          totalBytes,
          message: `下载完成（${Math.round(downloadedBytes / (1024 * 1024))} MiB）`,
        });
        finish(null);
      });
    });

    if (signal?.aborted) throw makeAbortError("已取消安装");

    onProgress({
      stage: "verifying",
      percent: 100,
      downloadedBytes,
      totalBytes,
      message: "正在校验 SHA-512 完整性…",
    });

    const actualSha512 = hash.digest("hex").toLowerCase();
    if (actualSha512 !== manifest.sha512.toLowerCase()) {
      throw new Error(
        "Antigravity 安装包 SHA-512 校验失败（文件可能已损坏或被篡改），已中止安装。",
      );
    }

    if (signal?.aborted) throw makeAbortError("已取消安装");

    onProgress({
      stage: "extracting",
      percent: null,
      downloadedBytes,
      totalBytes,
      message:
        platformSpec.archiveType === "exe"
          ? "正在准备 Antigravity 可执行文件…"
          : "正在安全校验并解压安装包…",
    });

    const safeVerDirName = sanitizeVersionOrJobSegment(manifest.version, "ver");
    const versionDir = path.join(toolsDir, "versions", safeVerDirName);
    await fsp.mkdir(versionDir, { recursive: true });
    const finalBinaryPath = path.join(versionDir, platformSpec.binaryName);

    if (platformSpec.archiveType === "exe") {
      moveFileAtomicOrCopy(payloadPath, finalBinaryPath);
      try {
        fs.unlinkSync(`${finalBinaryPath}:Zone.Identifier`);
      } catch {}
    } else {
      const extractDir = path.join(stagingJobDir, "extracted");
      const extractedBinary = await extractTarGzBinary(
        payloadPath,
        extractDir,
        "antigravity",
      );
      if (signal?.aborted) throw makeAbortError("已取消安装");
      moveFileAtomicOrCopy(extractedBinary, finalBinaryPath);
      fs.chmodSync(finalBinaryPath, 0o755);
      if ((options.platform || process.platform) === "darwin") {
        await execFilePromise("xattr", [
          "-d",
          "com.apple.quarantine",
          finalBinaryPath,
        ]).catch(() => {});
      }
    }

    if (signal?.aborted) throw makeAbortError("已取消安装");

    onProgress({
      stage: "activating",
      percent: 100,
      downloadedBytes,
      totalBytes,
      message: `正在启用 Antigravity ${manifest.version}…`,
    });

    const binaryRelPath = path.posix.join(
      "versions",
      safeVerDirName,
      platformSpec.binaryName,
    );
    const activePayload = {
      version: manifest.version,
      binaryRelPath,
      sha512: actualSha512,
      installedAt: new Date().toISOString(),
      sourceUrl: finalUrl,
    };
    fs.writeFileSync(activeTmpPath, `${JSON.stringify(activePayload, null, 2)}\n`, "utf8");
    fs.renameSync(activeTmpPath, path.join(toolsDir, "active.json"));

    await pruneOldManagedVersions(toolsDir, safeVerDirName);

    return {
      ok: true,
      version: manifest.version,
      binaryPath: finalBinaryPath,
      toolsDir,
      alreadyInstalled: false,
    };
  } finally {
    await removePathWithRetry(stagingJobDir, {
      recursive: true,
      attempts: 6,
      delayMs: 200,
    });
    await removePathWithRetry(activeTmpPath, {
      recursive: false,
      attempts: 3,
      delayMs: 100,
    });
  }
}

function sanitizeLoginErrorText(text) {
  return String(text || "")
    .replace(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/gi, "[OAuth URL 已隐藏]")
    .replace(/([?&](?:code|state|code_challenge|access_token|refresh_token)=)[^&\s]+/gi, "$1[已隐藏]")
    .trim()
    .slice(-400);
}

function extractOAuthUrl(text) {
  const match = OAUTH_URL_RE.exec(String(text || ""));
  if (!match) return null;
  return match[0].replace(/[)\]>.,'"]+$/, "");
}

function extractLoggedInEmail(text) {
  const str = String(text || "");
  const m1 = LOGGED_IN_EMAIL_RE.exec(str);
  if (m1?.[1]) return m1[1].trim();
  const m2 = LOGGED_IN_FALLBACK_RE.exec(str);
  if (m2?.[1]) {
    const candidate = m2[1].trim().replace(/[.!。！]+$/, "");
    if (candidate && candidate.length <= 160) return candidate;
  }
  return null;
}

/**
 * 创建管理独立 OOB 登录会话的管理器（每个 AgentRuntime 独立一份，同时提供模块级默认实例）。
 */
function createAntigravityLoginManager() {
  const sessions = new Map();

  function startLogin({
    sessionId,
    binaryPath,
    instance = {},
    baseEnv = process.env,
    onEvent,
    onResult,
    timeoutMs = LOGIN_TIMEOUT_MS,
  }) {
    const sid = String(sessionId || crypto.randomUUID());
    const iso = resolveAntigravityIsolation(instance, baseEnv);
    ensureAntigravityHomeDirs(iso);

    if (sessions.has(sid)) {
      cancelLogin(sid);
    }

    onEvent?.({
      stage: "starting",
      authUrl: null,
      userCode: null,
      message: "正在启动 Antigravity 独立账号登录流程…",
    });

    const win = process.platform === "win32";
    const loginArgs = ["acp", "--login", ...iso.acpExtraArgs];
    const loginEnv = {
      ...iso.env,
      ANTIGRAVITY_REMOTE_OOB_AUTH: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };

    let child;
    try {
      child = spawnCommand(binaryPath, loginArgs, {
        env: loginEnv,
        windowsHide: true,
        detached: !win,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const result = {
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error: `无法启动 Antigravity 登录进程：${err?.message || String(err)}`,
        cancelled: false,
      };
      onResult?.(result);
      return {
        sessionId: sid,
        homePath: iso.homeDir,
        submitCode: () => ({ ok: false, error: "登录进程未启动" }),
        cancel: () => false,
        done: Promise.resolve(result),
      };
    }

    let settled = false;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const state = {
      sessionId: sid,
      child,
      homePath: iso.homeDir,
      geminiDir: iso.geminiDir,
      authUrl: null,
      outputText: "",
      stderrText: "",
      cancelled: false,
      timer: null,
      onEvent,
      onResult,
      finish(result) {
        if (settled) return;
        settled = true;
        if (state.timer) clearTimeout(state.timer);
        sessions.delete(sid);
        onResult?.(result);
        resolveDone(result);
      },
      disposeSilent() {
        if (settled) return;
        settled = true;
        if (state.timer) clearTimeout(state.timer);
        sessions.delete(sid);
        killTree(child);
        resolveDone(null);
      },
    };
    sessions.set(sid, state);

    state.timer = setTimeout(() => {
      if (settled) return;
      killTree(child);
      state.finish({
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error: "登录超时（超过 10 分钟未完成），已自动中止。",
        cancelled: false,
      });
    }, timeoutMs);

    const handleChunk = (chunk, isStderr) => {
      const text = String(chunk || "");
      if (!text) return;
      if (state.outputText.length < 32_000) {
        state.outputText += text;
      }
      if (isStderr && state.stderrText.length < 8_000) {
        state.stderrText += text;
      }
      if (!state.authUrl) {
        const url = extractOAuthUrl(state.outputText);
        if (url) {
          state.authUrl = url;
          onEvent?.({
            stage: "awaiting_auth",
            authUrl: url,
            userCode: null,
            message:
              "请在浏览器中打开下方 Google 授权链接，完成后复制授权码或回调链接并提交。",
          });
        }
      }
    };

    child.stdout?.on("data", (d) => handleChunk(d, false));
    child.stderr?.on("data", (d) => handleChunk(d, true));

    child.on("error", (err) => {
      state.finish({
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error: `登录进程异常：${err?.message || String(err)}`,
        cancelled: state.cancelled,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      if (state.cancelled) {
        state.finish({
          ok: false,
          authenticated: false,
          authLabel: null,
          email: null,
          homePath: iso.homeDir,
          error: "已取消登录",
          cancelled: true,
        });
        return;
      }
      if (code === 0) {
        onEvent?.({
          stage: "verifying",
          authUrl: state.authUrl,
          userCode: null,
          message: "正在写入隔离账号状态…",
        });
        const email = extractLoggedInEmail(state.outputText);
        const metaDir = path.join(iso.geminiDir, "antigravity-cli");
        try {
          fs.mkdirSync(metaDir, { recursive: true });
          const metaPayload = {
            email: email || null,
            loggedInAt: new Date().toISOString(),
            method: "oauth-oob",
          };
          const metaPath = path.join(metaDir, AUTH_METADATA_FILENAME);
          const tmpMeta = `${metaPath}.tmp.${crypto.randomBytes(4).toString("hex")}`;
          fs.writeFileSync(
            tmpMeta,
            `${JSON.stringify(metaPayload, null, 2)}\n`,
            "utf8",
          );
          fs.renameSync(tmpMeta, metaPath);
        } catch {}
        const authLabel = email ? `Google · ${email}` : "Google 账号";
        state.finish({
          ok: true,
          authenticated: true,
          authLabel,
          email: email || null,
          homePath: iso.homeDir,
          error: null,
          cancelled: false,
        });
        return;
      }

      const detail = sanitizeLoginErrorText(state.stderrText || state.outputText);
      state.finish({
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: iso.homeDir,
        error:
          detail || `Antigravity 登录未成功（退出码 ${code ?? "null"}）`,
        cancelled: false,
      });
    });

    return {
      sessionId: sid,
      homePath: iso.homeDir,
      submitCode: (code) => submitCode(sid, code),
      cancel: () => cancelLogin(sid),
      done,
    };
  }

  function submitCode(sessionId, code) {
    const state = sessions.get(String(sessionId || ""));
    if (!state) {
      return { ok: false, error: "登录会话不存在或已结束", homePath: null };
    }
    const trimmed = typeof code === "string" ? code.trim() : "";
    if (!trimmed) {
      return {
        ok: false,
        error: "请输入授权码或完整回调链接",
        homePath: state.homePath,
      };
    }
    if (!state.child?.stdin || state.child.stdin.destroyed) {
      killTree(state.child);
      state.finish({
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: state.homePath,
        error: "登录进程输入通道已关闭",
        cancelled: false,
      });
      return {
        ok: false,
        error: "登录进程输入通道已关闭",
        homePath: state.homePath,
        finished: true,
      };
    }
    try {
      state.child.stdin.write(`${trimmed}\n`);
    } catch (err) {
      const errorMsg = `提交授权码失败：${err?.message || String(err)}`;
      killTree(state.child);
      state.finish({
        ok: false,
        authenticated: false,
        authLabel: null,
        email: null,
        homePath: state.homePath,
        error: errorMsg,
        cancelled: false,
      });
      return {
        ok: false,
        error: errorMsg,
        homePath: state.homePath,
        finished: true,
      };
    }
    state.onEvent?.({
      stage: "submitting",
      authUrl: state.authUrl,
      userCode: null,
      message: "已提交授权码，正在完成登录校验…",
    });
    return { ok: true };
  }

  function disposeLoginSilent(sessionId) {
    const state = sessions.get(String(sessionId || ""));
    if (!state) return false;
    state.disposeSilent();
    return true;
  }

  function cancelLogin(sessionId) {
    const state = sessions.get(String(sessionId || ""));
    if (!state) return false;
    state.cancelled = true;
    killTree(state.child);
    state.finish({
      ok: false,
      authenticated: false,
      authLabel: null,
      email: null,
      homePath: state.homePath,
      error: "已取消登录",
      cancelled: true,
    });
    return true;
  }

  function stopAll() {
    for (const sid of [...sessions.keys()]) {
      cancelLogin(sid);
    }
  }

  return {
    startLogin,
    submitCode,
    cancelLogin,
    disposeLoginSilent,
    stopAll,
    get activeCount() {
      return sessions.size;
    },
  };
}

const defaultLoginManager = createAntigravityLoginManager();

function startAntigravityLogin(params) {
  return defaultLoginManager.startLogin(params);
}

function submitCode(sessionId, code) {
  return defaultLoginManager.submitCode(sessionId, code);
}

function cancelAntigravityLogin(sessionId) {
  return defaultLoginManager.cancelLogin(sessionId);
}

function isWhitelistedCredentialFile(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower === AUTH_METADATA_FILENAME) return true;
  if (KNOWN_TOKEN_FILENAMES.has(lower)) return true;
  return TOKEN_FILENAME_PATTERN.test(lower);
}

/**
 * 退出登录：只删除该实例隔离目录 <homeDir>/.gemini/ 内的白名单凭据文件与 chisabot-auth.json，
 * 绝不触碰宿主全局 ~/.gemini，并带短重试防 Windows WAL 句柄占用。
 */
async function logoutAntigravityInstance({
  instance = {},
  baseEnv = process.env,
} = {}) {
  const iso = resolveAntigravityIsolation(instance, baseEnv);
  const subDirs = [
    path.join(iso.geminiDir, "antigravity-cli"),
    path.join(iso.geminiDir, "antigravity-acp"),
    path.join(iso.geminiDir, "config"),
    iso.geminiDir,
  ];
  const targets = new Set();

  for (const dir of subDirs) {
    if (!isInsideDir(dir, iso.geminiDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isWhitelistedCredentialFile(entry.name)) continue;
      const fullPath = path.resolve(dir, entry.name);
      if (!isInsideDir(fullPath, iso.geminiDir)) continue;
      try {
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isSymbolicLink() || !lstat.isFile()) continue;
      } catch {
        continue;
      }
      targets.add(fullPath);
    }
  }

  let removedCount = 0;
  for (const target of targets) {
    const ok = await removePathWithRetry(target, {
      recursive: false,
      attempts: 5,
      delayMs: 250,
    });
    if (ok) removedCount += 1;
  }

  return {
    ok: true,
    homePath: iso.homeDir,
    removedCount,
    message:
      removedCount > 0
        ? "已清除该实例的 Antigravity 登录凭据"
        : "该实例隔离目录中无残留登录凭据",
  };
}

function mapAntigravityAuthTypeLabel(authType) {
  switch (String(authType || "").trim().toLowerCase()) {
    case "oauth-personal":
      return "Google 账号";
    case "oauth-business":
      return "Gemini 企业账号";
    case "gemini-api-key":
      return "已配置 API Key";
    case "agent-platform":
      return "Agent Platform";
    default:
      return "Google 账号";
  }
}

function isValidTokenFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (stat.size <= 2 || stat.size >= 1024 * 1024) return false;

  if (filePath.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Boolean(
        parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length > 0,
      );
    } catch {
      return false;
    }
  }
  return stat.size > 16;
}

/**
 * 隔离凭据无副作用探测：
 * 1) 优先检查 GEMINI_API_KEY / GOOGLE_API_KEY；
 * 2) 仅检查该实例隔离目录 <homeDir>/.gemini/ 内的 chisabot-auth.json 与文件型 token 存储，
 *    绝不读取宿主全局 ~/.gemini 或系统 Keyring / Windows Credential Manager。
 */
function inspectManagedAntigravityAuth(instance = {}, mergedEnv = {}) {
  const effectiveEnv =
    mergedEnv && typeof mergedEnv === "object" ? mergedEnv : {};
  const iso = resolveAntigravityIsolation(instance, effectiveEnv);

  const mergedCheckEnv = { ...effectiveEnv, ...(instance?.env || {}) };
  const apiKey =
    getEnvValue(mergedCheckEnv, "GEMINI_API_KEY") ||
    getEnvValue(mergedCheckEnv, "GOOGLE_API_KEY");
  if (apiKey?.trim()) {
    return {
      authenticated: true,
      authLabel: "已配置 API Key",
      email: null,
      homePath: iso.homeDir,
    };
  }

  // 1. 检查 ChisaBot 写入的非敏感 OOB 登录元数据
  const metaPath = path.join(
    iso.geminiDir,
    "antigravity-cli",
    AUTH_METADATA_FILENAME,
  );
  try {
    const stat = fs.lstatSync(metaPath);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.size > 2 && stat.size < 65_536) {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.loggedInAt || parsed.email || parsed.method)
      ) {
        const email =
          typeof parsed.email === "string" && parsed.email.trim()
            ? parsed.email.trim()
            : null;
        return {
          authenticated: true,
          authLabel: email ? `Google · ${email}` : "Google 账号",
          email,
          homePath: iso.homeDir,
        };
      }
    }
  } catch {}

  // 2. 检查隔离目录内的 Antigravity 文件型 token 存储文件
  const tokenDirs = [
    path.join(iso.geminiDir, "antigravity-cli"),
    path.join(iso.geminiDir, "antigravity-acp"),
    path.join(iso.geminiDir, "config"),
  ];
  let hasValidToken = false;
  for (const dir of tokenDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (lower === AUTH_METADATA_FILENAME || lower === "settings.json") {
        continue;
      }
      if (!isWhitelistedCredentialFile(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (isValidTokenFile(fullPath)) {
        hasValidToken = true;
        break;
      }
    }
    if (hasValidToken) break;
  }

  if (!hasValidToken) {
    return {
      authenticated: null,
      authLabel: null,
      email: null,
      homePath: iso.homeDir,
    };
  }

  let authType = null;
  for (const settingsPath of [
    path.join(iso.geminiDir, "antigravity-cli", "settings.json"),
    path.join(iso.geminiDir, "antigravity-acp", "settings.json"),
  ]) {
    try {
      const stat = fs.lstatSync(settingsPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65_536) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (typeof parsed?.auth?.type === "string" && parsed.auth.type.trim()) {
        authType = parsed.auth.type.trim();
        break;
      }
    } catch {}
  }

  return {
    authenticated: true,
    authLabel: mapAntigravityAuthTypeLabel(authType),
    email: null,
    homePath: iso.homeDir,
  };
}

module.exports = {
  DEFAULT_MANIFEST_BASE_URL,
  DEFAULT_MANIFEST_HOST,
  DEFAULT_DOWNLOAD_HOST,
  DEFAULT_DOWNLOAD_PATH_PREFIX,
  AUTH_METADATA_FILENAME,
  resolveChisabotDataDir,
  getPlatformKey,
  resolveAntigravityToolsDir,
  resolveAntigravityHomeDir,
  resolveAntigravityIsolation,
  ensureAntigravityHomeDirs,
  resolveManifestPlatform,
  assertAllowedUrl,
  auditTarListing,
  fetchAntigravityManifest,
  readManagedAntigravityInfo,
  readManagedAntigravityBinary,
  getAntigravityRuntimeStatus,
  installManagedAntigravity,
  createAntigravityLoginManager,
  startAntigravityLogin,
  submitCode,
  cancelAntigravityLogin,
  logoutAntigravityInstance,
  inspectManagedAntigravityAuth,
};
