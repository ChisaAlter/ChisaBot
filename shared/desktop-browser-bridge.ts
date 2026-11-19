/**
 * 桌面浏览器登录态按单域名审批导入（Cookie Origin Approval）+ WebAuthn/Passkey 跨端转发共享协议。
 *
 * 安全红线：
 * 1. 所有高敏桥接能力按设备配对签发的显式 scope 鉴权（`DESKTOP_BRIDGE_SCOPES`），绝不信任自报 `platform: "desktop"`。
 * 2. Cookie 审批严格限定单一 `origin`（拒绝通配符 / 多域名 / 非 http(s) 协议），服务端与端侧双向核验每条 Cookie 的归属域。
 * 3. WebAuthn/Passkey 强校验 `rpId` 与 `origin` 对应关系（遵循 WebAuthn Level 2 安全上下文与可注册域后缀规则），并对一次性 `challenge` 防重放。
 */

export const DESKTOP_BRIDGE_SCOPES = [
  "browser_bridge",
  "passkey_forward",
  "accessibility_control",
] as const;

export type DesktopBridgeScope = (typeof DESKTOP_BRIDGE_SCOPES)[number];

export function isDesktopBridgeScope(
  value: unknown,
): value is DesktopBridgeScope {
  return (
    typeof value === "string" &&
    (DESKTOP_BRIDGE_SCOPES as readonly string[]).includes(value)
  );
}

export const DEFAULT_COOKIE_APPROVAL_TTL_MS = 120_000;
export const DEFAULT_WEBAUTHN_TTL_MS = 120_000;
export const DEFAULT_CHALLENGE_REPLAY_TTL_MS = 10 * 60_000;
export const MAX_COOKIES_PER_IMPORT = 200;
export const MAX_COOKIE_NAME_LEN = 256;
export const MAX_COOKIE_VALUE_LEN = 8192;

export type CookieApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export type ImportedBrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type CookieApprovalRequest = {
  requestId: string;
  ownerUserId: string;
  deviceId: string;
  botId: string;
  /** 归一化后的唯一目标 origin（例如 https://github.com）。 */
  origin: string;
  reason?: string;
  profileHint?: string;
  status: CookieApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  cookieCount?: number;
  error?: string | null;
};

export type CookieApprovalDecision =
  | {
      approved: true;
      profileId?: string;
      cookies: ImportedBrowserCookie[];
    }
  | {
      approved: false;
      reason?: string;
    };

export type WebAuthnCeremonyKind = "create" | "get";

export type WebAuthnForwardStatus =
  | "pending"
  | "completed"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed";

export type WebAuthnForwardRequest = {
  requestId: string;
  ownerUserId: string;
  deviceId: string;
  botId: string;
  kind: WebAuthnCeremonyKind;
  origin: string;
  rpId: string;
  /** Base64url 编码的一次性 challenge，用于跨端绑定与防重放。 */
  challenge: string;
  optionsJson?: string;
  status: WebAuthnForwardStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  error?: string | null;
};

export type WebAuthnForwardResponse =
  | {
      ok: true;
      credentialId: string;
      clientDataJSON: string;
      /** create 场景携带 attestationObject；get 场景携带 authenticatorData + signature。 */
      attestationObject?: string;
      authenticatorData?: string;
      signature?: string;
      userHandle?: string | null;
      transports?: string[];
    }
  | {
      ok: false;
      denied?: boolean;
      error: string;
    };

/** 常见不可作为 Cookie 归属域或 WebAuthn rpId 的顶级/二级公共后缀防线。 */
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

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":");
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isEffectivePublicSuffix(domain: string): boolean {
  const lower = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!lower) return true;
  if (lower === "localhost") return false;
  const labels = lower.split(".");
  if (labels.length < 2) return true;
  if (labels.length === 2 && PUBLIC_MULTI_LABEL_SUFFIXES.has(lower)) {
    return true;
  }
  return false;
}

/**
 * 严格校验并归一化单一 origin。
 * 拒绝通配符（*）、多域名、带用户名/密码、非 http(s) 协议、带路径或查询串。
 */
export function normalizeSingleOrigin(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("origin 必须是非空字符串。");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || hasControlChars(trimmed)) {
    throw new Error("origin 格式非法。");
  }
  if (trimmed.includes("*") || trimmed.includes(",") || /\s/.test(trimmed)) {
    throw new Error("Cookie 审批仅允许单一精确 origin，不允许通配符或多域名。");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 origin：${trimmed}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("origin 仅支持 http 或 https 协议。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("origin 不允许携带凭据信息。");
  }
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("origin 不能包含路径、查询参数或片段。");
  }
  if (!parsed.hostname) {
    throw new Error("origin 缺少主机名。");
  }
  return parsed.origin;
}

/**
 * 校验单条 Cookie 的 `domain` 是否合法匹配指定单一 `origin`（RFC 6265 域匹配 + 防后缀混淆）。
 */
export function cookieMatchesOrigin(
  rawCookieDomain: string,
  rawOrigin: string,
): boolean {
  let origin: string;
  try {
    origin = normalizeSingleOrigin(rawOrigin);
  } catch {
    return false;
  }
  const host = new URL(origin).hostname.toLowerCase();
  const raw = String(rawCookieDomain ?? "")
    .trim()
    .toLowerCase();
  if (!raw || hasControlChars(raw) || raw.includes("/") || raw.includes(":")) {
    return false;
  }
  const isDomainCookie = raw.startsWith(".");
  const normalizedDomain = raw.replace(/^\.+/, "");
  if (!normalizedDomain || normalizedDomain.endsWith(".")) {
    return false;
  }
  if (isIpLiteral(host) || isIpLiteral(normalizedDomain)) {
    return !isDomainCookie && host === normalizedDomain;
  }
  if (host === normalizedDomain) {
    return true;
  }
  if (isEffectivePublicSuffix(normalizedDomain)) {
    return false;
  }
  return host.endsWith(`.${normalizedDomain}`);
}

/**
 * 过滤并强校验导入的 Cookie 列表：发现越界域名或非法字段时返回错误（fail-closed）。
 */
export function validateOriginCookies(
  origin: string,
  cookies: readonly ImportedBrowserCookie[],
):
  | { ok: true; cookies: ImportedBrowserCookie[] }
  | { ok: false; error: string } {
  const normalizedOrigin = normalizeSingleOrigin(origin);
  const parsedOrigin = new URL(normalizedOrigin);
  if (!Array.isArray(cookies)) {
    return { ok: false, error: "cookies 必须是数组。" };
  }
  if (cookies.length > MAX_COOKIES_PER_IMPORT) {
    return {
      ok: false,
      error: `单次最多导入 ${MAX_COOKIES_PER_IMPORT} 条 Cookie。`,
    };
  }
  const clean: ImportedBrowserCookie[] = [];
  for (const item of cookies) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Cookie 条目格式无效。" };
    }
    const name = String(item.name ?? "").trim();
    const value = String(item.value ?? "");
    const domain = String(item.domain ?? "").trim();
    const cookiePath = String(item.path ?? "/").trim() || "/";
    if (
      !name ||
      name.length > MAX_COOKIE_NAME_LEN ||
      hasControlChars(name) ||
      /[;=]/.test(name)
    ) {
      return { ok: false, error: `Cookie 名称非法：${name.slice(0, 32)}` };
    }
    if (value.length > MAX_COOKIE_VALUE_LEN || hasControlChars(value)) {
      return { ok: false, error: `Cookie「${name}」的值超长或包含控制字符。` };
    }
    if (!cookieMatchesOrigin(domain, normalizedOrigin)) {
      return {
        ok: false,
        error: `Cookie「${name}」所属域「${domain}」与审批目标 ${normalizedOrigin} 不匹配，已拦截。`,
      };
    }
    if (item.secure && parsedOrigin.protocol !== "https:") {
      return {
        ok: false,
        error: `Secure Cookie「${name}」不可导入至非 HTTPS 源 ${normalizedOrigin}。`,
      };
    }
    const sameSite =
      item.sameSite === "Strict" ||
      item.sameSite === "Lax" ||
      item.sameSite === "None"
        ? item.sameSite
        : undefined;
    clean.push({
      name,
      value,
      domain,
      path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
      ...(typeof item.expires === "number" && Number.isFinite(item.expires)
        ? { expires: item.expires }
        : {}),
      httpOnly: Boolean(item.httpOnly),
      secure: Boolean(item.secure),
      ...(sameSite ? { sameSite } : {}),
    });
  }
  return { ok: true, cookies: clean };
}

/**
 * 强校验 WebAuthn `rpId` 与 `origin`（WebAuthn Level 2 安全上下文 + 域后缀绑定）。
 */
export function validateWebAuthnRpId(
  rawRpId: unknown,
  rawOrigin: unknown,
): { ok: true; rpId: string; origin: string } | { ok: false; reason: string } {
  let origin: string;
  try {
    origin = normalizeSingleOrigin(rawOrigin);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "origin 无效。",
    };
  }
  const parsed = new URL(origin);
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol !== "https:" && !isLoopback) {
    return {
      ok: false,
      reason: "WebAuthn 仅允许在 https 安全源或本机 localhost 发起。",
    };
  }

  if (typeof rawRpId !== "string") {
    return { ok: false, reason: "rpId 必须是非空字符串。" };
  }
  const rpId = rawRpId.trim().toLowerCase();
  if (
    !rpId ||
    rpId.length > 253 ||
    hasControlChars(rpId) ||
    rpId.includes("/") ||
    rpId.includes(":") ||
    rpId.includes("*") ||
    rpId.startsWith(".") ||
    rpId.endsWith(".")
  ) {
    return { ok: false, reason: `无效的 WebAuthn rpId：${rpId}` };
  }
  if (!/^[a-z0-9.-]+$/.test(rpId)) {
    return { ok: false, reason: `WebAuthn rpId 含非法字符：${rpId}` };
  }
  if (isIpLiteral(host) || isIpLiteral(rpId)) {
    return {
      ok: false,
      reason: "WebAuthn rpId 不允许使用裸 IP 地址（请使用域名或 localhost）。",
    };
  }
  if (rpId === host) {
    return { ok: true, rpId, origin };
  }
  if (isEffectivePublicSuffix(rpId)) {
    return {
      ok: false,
      reason: `WebAuthn rpId 不能是公共顶级后缀：${rpId}`,
    };
  }
  if (host.endsWith(`.${rpId}`)) {
    return { ok: true, rpId, origin };
  }
  return {
    ok: false,
    reason: `WebAuthn rpId「${rpId}」与 origin 主机「${host}」不匹配。`,
  };
}

/** 校验一次性 WebAuthn challenge（base64url，16~512 字符）。 */
export function normalizeWebAuthnChallenge(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("WebAuthn challenge 必须是非空字符串。");
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < 16 ||
    trimmed.length > 512 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)
  ) {
    throw new Error(
      "WebAuthn challenge 必须是 16-512 字符的 base64url 随机数。",
    );
  }
  return trimmed;
}

/** 生成不含任何明文值的 Cookie 审计摘要。 */
export function redactCookieSummary(
  cookies: readonly Pick<
    ImportedBrowserCookie,
    "name" | "domain" | "httpOnly" | "secure"
  >[],
): Array<{ name: string; domain: string; httpOnly: boolean; secure: boolean }> {
  return cookies.map((item) => ({
    name: item.name,
    domain: item.domain,
    httpOnly: item.httpOnly,
    secure: item.secure,
  }));
}
