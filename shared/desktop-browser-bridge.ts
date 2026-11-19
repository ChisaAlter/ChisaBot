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

/** 常见不可作为 Cookie 归属域或 WebAuthn rpId 的顶级/二级公共后缀及多租户托管域防线。 */
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
  // 常见多租户托管 / PaaS 公共后缀（PSL 私有段）
  "github.io",
  "gitlab.io",
  "bitbucket.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "amazonaws.com",
  "s3.amazonaws.com",
  "compute.amazonaws.com",
  "cloudfront.net",
  "azurewebsites.net",
  "fly.dev",
  "railway.app",
  "onrender.com",
  "deno.dev",
  "replit.dev",
  "ngrok.io",
  "trycloudflare.com",
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
  if (PUBLIC_MULTI_LABEL_SUFFIXES.has(lower)) {
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
 * 校验单条 Cookie 的 `domain` 是否合法匹配指定单一 `origin`（RFC 6265 域匹配 + host-only 防泄漏 + 防后缀混淆）。
 * - 无前导点视为 host-only Cookie，仅允许精确主机名匹配，绝不向子域泄漏；
 * - 仅允许单个前导点（拒绝 `..example.com`）的域 Cookie 匹配其子域，且禁止公共后缀/多租户托管域。
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
  if (
    !raw ||
    hasControlChars(raw) ||
    raw.includes("/") ||
    raw.includes(":") ||
    raw.includes("..")
  ) {
    return false;
  }
  const isDomainCookie = raw.startsWith(".");
  const normalizedDomain = isDomainCookie ? raw.slice(1) : raw;
  if (
    !normalizedDomain ||
    normalizedDomain.startsWith(".") ||
    normalizedDomain.endsWith(".")
  ) {
    return false;
  }
  if (isIpLiteral(host) || isIpLiteral(normalizedDomain)) {
    return !isDomainCookie && host === normalizedDomain;
  }
  if (isDomainCookie && isEffectivePublicSuffix(normalizedDomain)) {
    return false;
  }
  if (host === normalizedDomain) {
    return true;
  }
  if (!isDomainCookie) {
    return false;
  }
  if (isEffectivePublicSuffix(normalizedDomain)) {
    return false;
  }
  return host.endsWith(`.${normalizedDomain}`);
}

/**
 * 过滤并强校验导入的 Cookie 列表：发现越界域名、非法路径、`__Host-`/`__Secure-` 违约或非法字段时返回错误（fail-closed）。
 */
export function validateOriginCookies(
  origin: string,
  cookies: readonly ImportedBrowserCookie[],
):
  | { ok: true; cookies: ImportedBrowserCookie[] }
  | { ok: false; error: string } {
  const normalizedOrigin = normalizeSingleOrigin(origin);
  const parsedOrigin = new URL(normalizedOrigin);
  const originHost = parsedOrigin.hostname.toLowerCase();
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
    const rawPath = item.path === undefined ? "/" : String(item.path);
    const cookiePath = rawPath.trim() || "/";
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
    if (
      cookiePath.length > 1024 ||
      hasControlChars(rawPath) ||
      hasControlChars(cookiePath)
    ) {
      return {
        ok: false,
        error: `Cookie「${name}」的路径超长或包含非法控制字符。`,
      };
    }
    if (!cookieMatchesOrigin(domain, normalizedOrigin)) {
      return {
        ok: false,
        error: `Cookie「${name}」所属域「${domain}」与审批目标 ${normalizedOrigin} 不匹配，已拦截。`,
      };
    }
    const normalizedPath = cookiePath.startsWith("/")
      ? cookiePath
      : `/${cookiePath}`;
    if (item.secure && parsedOrigin.protocol !== "https:") {
      return {
        ok: false,
        error: `Secure Cookie「${name}」不可导入至非 HTTPS 源 ${normalizedOrigin}。`,
      };
    }
    if (name.startsWith("__Secure-")) {
      if (!item.secure || parsedOrigin.protocol !== "https:") {
        return {
          ok: false,
          error: `Cookie「${name}」使用 __Secure- 前缀，必须为 Secure 且目标为 HTTPS 源。`,
        };
      }
    }
    if (name.startsWith("__Host-")) {
      if (
        !item.secure ||
        parsedOrigin.protocol !== "https:" ||
        normalizedPath !== "/" ||
        domain.startsWith(".") ||
        domain.toLowerCase() !== originHost
      ) {
        return {
          ok: false,
          error: `Cookie「${name}」使用 __Host- 前缀，必须为 Secure、HTTPS、path="/" 且严格 host-only 匹配 ${originHost}。`,
        };
      }
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
      path: normalizedPath,
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

function stripBase64Padding(value: string): string {
  return value.replace(/=+$/g, "");
}

function decodeBase64UrlUtf8(raw: string): string | null {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${"=".repeat(padLen)}`;
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(padded, "base64").toString("utf8");
    }
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 强校验 WebAuthn 响应中的 `clientDataJSON`（兼容 base64url 与 JSON 字符串）：
 * - `type` 必须严格对应 `webauthn.create` 或 `webauthn.get`；
 * - `challenge` 必须与服务端下发的一次性 challenge 一致；
 * - `origin` 必须归一化后严格等于请求的 origin。
 */
export function validateWebAuthnClientDataJson(
  rawClientDataJSON: unknown,
  expected: {
    kind: WebAuthnCeremonyKind;
    origin: string;
    challenge: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (typeof rawClientDataJSON !== "string" || !rawClientDataJSON.trim()) {
    return { ok: false, reason: "WebAuthn 响应缺少有效的 clientDataJSON。" };
  }
  const trimmed = rawClientDataJSON.trim();
  const decoded = trimmed.startsWith("{")
    ? trimmed
    : decodeBase64UrlUtf8(trimmed);
  if (!decoded) {
    return { ok: false, reason: "WebAuthn clientDataJSON 解码失败。" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "WebAuthn clientDataJSON 不是合法 JSON。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "WebAuthn clientDataJSON 必须是 JSON 对象。" };
  }
  const obj = parsed as Record<string, unknown>;
  const expectedType =
    expected.kind === "create" ? "webauthn.create" : "webauthn.get";
  if (obj.type !== expectedType) {
    return {
      ok: false,
      reason: `WebAuthn clientDataJSON.type 不匹配（期望 ${expectedType}，实际 ${String(obj.type ?? "")}）。`,
    };
  }
  if (typeof obj.challenge !== "string" || !obj.challenge.trim()) {
    return { ok: false, reason: "WebAuthn clientDataJSON 缺少 challenge。" };
  }
  if (
    stripBase64Padding(obj.challenge.trim()) !==
    stripBase64Padding(expected.challenge.trim())
  ) {
    return {
      ok: false,
      reason: "WebAuthn clientDataJSON.challenge 与服务端下发挑战不一致。",
    };
  }
  if (typeof obj.origin !== "string" || !obj.origin.trim()) {
    return { ok: false, reason: "WebAuthn clientDataJSON 缺少 origin。" };
  }
  let actualOrigin: string;
  try {
    actualOrigin = normalizeSingleOrigin(obj.origin);
  } catch {
    return { ok: false, reason: "WebAuthn clientDataJSON.origin 格式非法。" };
  }
  const expectedOrigin = normalizeSingleOrigin(expected.origin);
  if (actualOrigin !== expectedOrigin) {
    return {
      ok: false,
      reason: `WebAuthn clientDataJSON.origin（${actualOrigin}）与请求源（${expectedOrigin}）不一致。`,
    };
  }
  return { ok: true };
}

/**
 * 强校验可选的 `optionsJson` 内嵌 `rpId` / `rp.id` 与 `challenge` 是否与外层声明一致，防止钓鱼弹窗参数不一致。
 */
export function validateWebAuthnOptionsJson(
  rawOptionsJson: unknown,
  expected: { rpId: string; challenge: string },
): { ok: true } | { ok: false; reason: string } {
  if (
    rawOptionsJson === undefined ||
    rawOptionsJson === null ||
    rawOptionsJson === ""
  ) {
    return { ok: true };
  }
  if (typeof rawOptionsJson !== "string") {
    return { ok: false, reason: "WebAuthn optionsJson 必须是 JSON 字符串。" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOptionsJson);
  } catch {
    return { ok: false, reason: "WebAuthn optionsJson 不是合法 JSON。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "WebAuthn optionsJson 必须是 JSON 对象。" };
  }
  const root = parsed as Record<string, unknown>;
  const inner =
    root.publicKey &&
    typeof root.publicKey === "object" &&
    !Array.isArray(root.publicKey)
      ? (root.publicKey as Record<string, unknown>)
      : root;
  const rpObj =
    inner.rp && typeof inner.rp === "object" && !Array.isArray(inner.rp)
      ? (inner.rp as Record<string, unknown>)
      : root.rp && typeof root.rp === "object" && !Array.isArray(root.rp)
        ? (root.rp as Record<string, unknown>)
        : null;
  const embeddedRpIds = [inner.rpId, root.rpId, rpObj?.id].filter(
    (v) => v !== undefined && v !== null,
  );
  for (const candidate of embeddedRpIds) {
    if (
      typeof candidate !== "string" ||
      candidate.trim().toLowerCase() !== expected.rpId.toLowerCase()
    ) {
      return {
        ok: false,
        reason: `WebAuthn optionsJson 内嵌 rpId 与外层 rpId（${expected.rpId}）不一致。`,
      };
    }
  }
  const embeddedChallenges = [inner.challenge, root.challenge].filter(
    (v) => v !== undefined && v !== null,
  );
  for (const candidate of embeddedChallenges) {
    if (
      typeof candidate !== "string" ||
      stripBase64Padding(candidate.trim()) !==
        stripBase64Padding(expected.challenge.trim())
    ) {
      return {
        ok: false,
        reason: "WebAuthn optionsJson 内嵌 challenge 与外层 challenge 不一致。",
      };
    }
  }
  return { ok: true };
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
