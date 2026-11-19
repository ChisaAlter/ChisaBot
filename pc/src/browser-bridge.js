"use strict";
/**
 * 本机 Chrome / Edge 登录态按单域名审批导入（Cookie Origin Approval）+ WebAuthn/Passkey 跨端转发桥。
 *
 * 安全设计：
 * - 不信任任何自报 `platform: "desktop"`，由调用方传入已验签设备 scope（必须包含 `browser_bridge` / `passkey_forward`）；
 * - Cookie 提取严格限定单一 `origin`，对所有候选 Cookie 二次域匹配，禁止通配符或跨站泄漏；
 * - 每次导入与每次 Passkey 签名都必须经本机显式用户确认（Electron 原生确认窗 / 渲染进程确认卡）；
 * - 针对 Windows DPAPI / macOS Keychain / Linux Secret Service 加密存储提供清晰跨平台降级提示。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PUBLIC_MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.au",
  "net.au",
  "org.au",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.br",
  "co.kr",
  "co.in",
]);

function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizePathSlashes(rawPath) {
  return String(rawPath || "")
    .split(path.sep)
    .join("/")
    .split("\\")
    .join("/");
}

function isIpLiteral(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":");
}

function isPublicSuffix(domain) {
  const clean = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!clean) return true;
  if (clean === "localhost") return false;
  const labels = clean.split(".");
  if (labels.length < 2) return true;
  return labels.length === 2 && PUBLIC_MULTI_LABEL_SUFFIXES.has(clean);
}

/** 严格归一化单一 origin（拒绝通配符、多域名、路径、查询串与非 http(s) 协议）。 */
function normalizeSingleOrigin(raw) {
  if (typeof raw !== "string") throw new Error("origin 必须是非空字符串。");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || hasControlChar(trimmed)) {
    throw new Error("origin 格式非法。");
  }
  if (trimmed.includes("*") || trimmed.includes(",") || /\s/.test(trimmed)) {
    throw new Error("仅允许单一精确 origin，不支持通配符或多域名。");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 origin：${trimmed}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("origin 仅支持 http 或 https 协议。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("origin 不允许携带用户名或密码。");
  }
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("origin 不允许携带路径、查询串或片段。");
  }
  return parsed.origin;
}

/** 校验单条 Cookie 的 domain 是否属于指定单一 origin。 */
function cookieMatchesOrigin(rawCookieDomain, rawOrigin) {
  let origin;
  try {
    origin = normalizeSingleOrigin(rawOrigin);
  } catch {
    return false;
  }
  const host = new URL(origin).hostname.toLowerCase();
  const raw = String(rawCookieDomain || "")
    .trim()
    .toLowerCase();
  if (!raw || hasControlChar(raw) || raw.includes("/") || raw.includes(":")) {
    return false;
  }
  const isDomain = raw.startsWith(".");
  const normalized = raw.replace(/^\.+/, "");
  if (!normalized || normalized.endsWith(".")) return false;
  if (isIpLiteral(host) || isIpLiteral(normalized)) {
    return !isDomain && host === normalized;
  }
  if (host === normalized) return true;
  if (isPublicSuffix(normalized)) return false;
  return host.endsWith(`.${normalized}`);
}

/** 校验 WebAuthn rpId 与 origin 绑定关系。 */
function validateWebAuthnRpId(rawRpId, rawOrigin) {
  let origin;
  try {
    origin = normalizeSingleOrigin(rawOrigin);
  } catch (error) {
    return { ok: false, reason: error?.message || "origin 无效。" };
  }
  const parsed = new URL(origin);
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol !== "https:" && !isLoopback) {
    return {
      ok: false,
      reason: "WebAuthn 仅允许在 https 安全源或本机 localhost 执行。",
    };
  }
  const rpId = String(rawRpId || "")
    .trim()
    .toLowerCase();
  if (
    !rpId ||
    rpId.length > 253 ||
    hasControlChar(rpId) ||
    !/^[a-z0-9.-]+$/.test(rpId) ||
    rpId.startsWith(".") ||
    rpId.endsWith(".")
  ) {
    return { ok: false, reason: `无效的 rpId：${rpId}` };
  }
  if (isIpLiteral(host) || isIpLiteral(rpId)) {
    return { ok: false, reason: "WebAuthn rpId 不能是裸 IP 地址。" };
  }
  if (rpId === host) return { ok: true, rpId, origin };
  if (isPublicSuffix(rpId)) {
    return { ok: false, reason: `rpId 不能为公共后缀：${rpId}` };
  }
  if (host.endsWith(`.${rpId}`)) return { ok: true, rpId, origin };
  return { ok: false, reason: `rpId「${rpId}」与 origin「${host}」不匹配。` };
}

/**
 * 列出跨平台 Chrome / Edge 本地 User Data 候选路径。
 */
function browserUserDataCandidates({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const candidates = [];
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    candidates.push(
      {
        browser: "chrome",
        label: "Google Chrome",
        userDataDir: path.join(localAppData, "Google", "Chrome", "User Data"),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        userDataDir: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      },
    );
  } else if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    candidates.push(
      {
        browser: "chrome",
        label: "Google Chrome",
        userDataDir: path.join(appSupport, "Google", "Chrome"),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        userDataDir: path.join(appSupport, "Microsoft Edge"),
      },
    );
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    candidates.push(
      {
        browser: "chrome",
        label: "Google Chrome",
        userDataDir: path.join(configHome, "google-chrome"),
      },
      {
        browser: "chromium",
        label: "Chromium",
        userDataDir: path.join(configHome, "chromium"),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        userDataDir: path.join(configHome, "microsoft-edge"),
      },
    );
  }
  return candidates;
}

/**
 * 发现本机已安装的 Chrome / Edge Profile 及对应 Cookie 数据库路径。
 */
async function discoverBrowserProfiles(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = browserUserDataCandidates(options);
  const profiles = [];

  for (const item of candidates) {
    const exists = fs.existsSync(item.userDataDir);
    if (!exists) continue;
    let infoCache = {};
    const localStatePath = path.join(item.userDataDir, "Local State");
    try {
      const raw = await fsp.readFile(localStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed?.profile?.info_cache &&
        typeof parsed.profile.info_cache === "object"
      ) {
        infoCache = parsed.profile.info_cache;
      }
    } catch {}

    let entries = [];
    try {
      entries = await fsp.readdir(item.userDataDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== "Default" && !/^Profile \d+$/i.test(entry.name))
        continue;
      const profileDir = path.join(item.userDataDir, entry.name);
      const networkCookies = path.join(profileDir, "Network", "Cookies");
      const legacyCookies = path.join(profileDir, "Cookies");
      const cookieDbPath = fs.existsSync(networkCookies)
        ? networkCookies
        : fs.existsSync(legacyCookies)
          ? legacyCookies
          : null;
      const meta = infoCache[entry.name] || {};
      profiles.push({
        id: `${item.browser}:${entry.name}`,
        browser: item.browser,
        browserLabel: item.label,
        profileDirName: entry.name,
        displayName: String(meta.name || meta.shortcut_name || entry.name),
        userDataDir: normalizePathSlashes(item.userDataDir),
        profileDir: normalizePathSlashes(profileDir),
        cookieDbPath: cookieDbPath ? normalizePathSlashes(cookieDbPath) : null,
        platform,
      });
    }
  }
  return profiles;
}

function platformDecryptionHint(platform = process.platform) {
  if (platform === "win32") {
    return "Windows 上 Chrome/Edge 使用 DPAPI 与 App-Bound 加密存储 Cookie；请确保在当前登录用户上下文运行，或在浏览器关闭/使用内置会话导入助手后重试。";
  }
  if (platform === "darwin") {
    return "macOS 上 Chrome/Edge Cookie 密钥位于「钥匙串访问（Keychain）」的 Chrome Safe Storage；如系统弹窗请求访问钥匙串，请选择「允许」，或改用 ChisaBot 浏览器登录。";
  }
  return "Linux 上 Chrome/Edge Cookie 由 Secret Service（GNOME Keyring / KWallet）加密；如无桌面密钥环服务，请在云端浏览器内手动登录。";
}

/**
 * 过滤并强校验指定 origin 的 Cookie 列表。
 */
function filterAndVerifyOriginCookies(origin, rawCookies) {
  const normalizedOrigin = normalizeSingleOrigin(origin);
  const parsedOrigin = new URL(normalizedOrigin);
  if (!Array.isArray(rawCookies)) return [];
  const clean = [];
  for (const cookie of rawCookies) {
    if (!cookie || typeof cookie !== "object") continue;
    const name = String(cookie.name || "").trim();
    const value = String(cookie.value ?? "");
    const domain = String(cookie.domain || "").trim();
    const cookiePath = String(cookie.path || "/").trim() || "/";
    if (!name || hasControlChar(name) || hasControlChar(value)) continue;
    if (!cookieMatchesOrigin(domain, normalizedOrigin)) continue;
    if (cookie.secure && parsedOrigin.protocol !== "https:") continue;
    clean.push({
      name,
      value,
      domain,
      path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
      ...(typeof cookie.expires === "number" && Number.isFinite(cookie.expires)
        ? { expires: cookie.expires }
        : {}),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      ...(cookie.sameSite === "Strict" ||
      cookie.sameSite === "Lax" ||
      cookie.sameSite === "None"
        ? { sameSite: cookie.sameSite }
        : {}),
    });
  }
  return clean;
}

/**
 * 创建本机桌面浏览器桥（处理单域名 Cookie 审批导入 + WebAuthn/Passkey 跨端转发）。
 *
 * @param {object} options
 * @param {() => string[]} [options.getGrantedScopes] 返回设备配对签发的 scope 列表（必须含 browser_bridge）
 * @param {(req: object) => Promise<boolean>} [options.confirmApproval] 弹出原生/渲染进程显式确认弹窗
 * @param {(input: { origin: string, profile: object }) => Promise<Array>} [options.readCookies] 自定义 Cookie 读取器
 * @param {(ceremony: object) => Promise<object>} [options.signWebAuthn] 本机 Passkey 签名器
 * @param {string} [options.platform]
 * @param {(entry: object) => void} [options.log]
 */
function createDesktopBrowserBridgeClient(options = {}) {
  const platform = options.platform || process.platform;
  const log = options.log || (() => {});

  function hasScope(requiredScope) {
    if (typeof options.getGrantedScopes !== "function") return false;
    const scopes = options.getGrantedScopes() || [];
    return Array.isArray(scopes) && scopes.includes(requiredScope);
  }

  async function handleCookieApprovalRequest(request) {
    if (!hasScope("browser_bridge")) {
      return {
        approved: false,
        reason:
          "本机设备尚未获得「browser_bridge」能力授权，请在设备设置中显式开启。",
      };
    }
    let origin;
    try {
      origin = normalizeSingleOrigin(request?.origin);
    } catch (error) {
      return { approved: false, reason: error?.message || "无效的 origin。" };
    }

    const profiles = options.listProfiles
      ? await options.listProfiles()
      : await discoverBrowserProfiles({ platform });
    const picked =
      (request.profileHint &&
        profiles.find(
          (p) =>
            p.id === request.profileHint ||
            p.displayName === request.profileHint,
        )) ||
      profiles[0] ||
      null;

    if (typeof options.confirmApproval !== "function") {
      return {
        approved: false,
        reason: "缺少本机显式审批确认弹窗回调，拒绝静默导出 Cookie。",
      };
    }

    const confirmed = await options.confirmApproval({
      kind: "cookie_import",
      requestId: request.requestId,
      origin,
      botId: request.botId,
      reason: request.reason || "",
      profileLabel: picked
        ? `${picked.browserLabel}（${picked.displayName}）`
        : "本机浏览器",
    });
    if (!confirmed) {
      log({ category: "bridge", event: "cookie_import_denied", origin });
      return { approved: false, reason: "用户拒绝了本次登录态导入请求。" };
    }

    if (typeof options.readCookies !== "function") {
      return {
        approved: false,
        degraded: true,
        reason: picked
          ? `已定位浏览器配置「${picked.browserLabel} · ${picked.displayName}」，但当前环境未启用原生 Cookie 解密器。${platformDecryptionHint(platform)}`
          : `未在本机检测到可用的 Chrome / Edge 配置目录。${platformDecryptionHint(platform)}`,
      };
    }

    const rawCookies = await options.readCookies({ origin, profile: picked });
    const verified = filterAndVerifyOriginCookies(origin, rawCookies);
    log({
      category: "bridge",
      event: "cookie_import_approved",
      origin,
      count: verified.length,
    });
    return {
      approved: true,
      profileId: picked?.id,
      cookies: verified,
    };
  }

  async function handleWebAuthnRequest(request) {
    if (!hasScope("browser_bridge") && !hasScope("passkey_forward")) {
      return {
        ok: false,
        denied: true,
        error:
          "本机设备尚未获得 Passkey 转发授权 scope（browser_bridge / passkey_forward）。",
      };
    }
    const rpCheck = validateWebAuthnRpId(request?.rpId, request?.origin);
    if (!rpCheck.ok) {
      return { ok: false, denied: true, error: rpCheck.reason };
    }
    if (request?.kind !== "create" && request?.kind !== "get") {
      return {
        ok: false,
        denied: true,
        error: "WebAuthn 操作类型仅支持 create 或 get。",
      };
    }
    if (typeof options.confirmApproval !== "function") {
      return {
        ok: false,
        denied: true,
        error: "缺少本机显式确认弹窗，已拒绝 Passkey 转发。",
      };
    }
    const confirmed = await options.confirmApproval({
      kind: "passkey_forward",
      requestId: request.requestId,
      ceremonyKind: request.kind,
      origin: rpCheck.origin,
      rpId: rpCheck.rpId,
      botId: request.botId,
    });
    if (!confirmed) {
      log({ category: "bridge", event: "passkey_denied", rpId: rpCheck.rpId });
      return { ok: false, denied: true, error: "用户取消了本机通行密钥验证。" };
    }
    if (typeof options.signWebAuthn !== "function") {
      const hint =
        platform === "win32"
          ? "Windows Hello / WebAuthn 原生签名器当前不可用，请确认已启用 Windows Hello 或使用外部安全密钥。"
          : platform === "darwin"
            ? "macOS Touch ID / AuthenticationServices 原生签名器当前不可用，请确认在已签名的桌面包中运行。"
            : "Linux 桌面端暂不支持原生平台 Passkey 签名器，请改用 FIDO2 硬件密钥或在云端手动登录。";
      return { ok: false, degraded: true, error: hint };
    }
    try {
      const signed = await options.signWebAuthn({
        kind: request.kind,
        origin: rpCheck.origin,
        rpId: rpCheck.rpId,
        challenge: request.challenge,
        optionsJson: request.optionsJson,
      });
      log({
        category: "bridge",
        event: "passkey_completed",
        rpId: rpCheck.rpId,
        kind: request.kind,
      });
      return { ok: true, ...signed };
    } catch (error) {
      return {
        ok: false,
        error: error?.message ? error.message : String(error),
      };
    }
  }

  return {
    discoverProfiles: () => discoverBrowserProfiles({ platform }),
    handleCookieApprovalRequest,
    handleWebAuthnRequest,
  };
}

module.exports = {
  normalizeSingleOrigin,
  cookieMatchesOrigin,
  validateWebAuthnRpId,
  browserUserDataCandidates,
  discoverBrowserProfiles,
  filterAndVerifyOriginCookies,
  platformDecryptionHint,
  createDesktopBrowserBridgeClient,
};
