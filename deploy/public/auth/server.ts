import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";

const COOKIE = "__Host-openbot_session";
const SHORT_LIFETIME = 12 * 3600;
const LONG_LIFETIME = 30 * 24 * 3600;
const WINDOW = 15 * 60 * 1000;
const BASE = "https://openbot.invalid";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only relative destinations in the workspace are valid after sign-in. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "/";
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(decoded)) return "/";
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { return "/"; }
  }
  if (/%(?:2f|5c|25)/i.test(decoded)) return "/";
  const url = new URL(decoded, BASE);
  if (url.origin !== BASE || /^\/(?:login|sign|auth|_openbot|_internal)(?:\/|$)/.test(url.pathname)) return "/";
  return value;
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") || "";
  if (cookie.length > 8192) return null;
  const matches = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(COOKIE + "="));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function cookieHeader(token: string, lifetime?: number): string {
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax${lifetime === undefined ? "" : `; Max-Age=${lifetime}`}`;
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}
const unauthorized = () => json({ ok: false, error: "请先登录。", openbotAuthRequired: true }, 401);

const STARTUP_EVENTS = new Set(["shell", "entry-loaded", "entry-executing", "react-mounted", "error", "timeout"]);
const STARTUP_CATEGORIES = new Set(["resource", "syntax", "runtime", "promise", "unknown"]);
const STARTUP_ERROR_NAMES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "SecurityError", "AbortError"]);
type StartupReport = { id: string; event: string; stage: string; resource?: string; category?: string; name?: string; line?: number; column?: number; at: number; browser: string };
function startupMetadata(value: unknown): Omit<StartupReport, "at" | "browser"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["id", "event", "stage", "resource", "category", "name", "line", "column"].includes(key))) return null;
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(body.id)) return null;
  if (typeof body.event !== "string" || !STARTUP_EVENTS.has(body.event) || typeof body.stage !== "string" || !STARTUP_EVENTS.has(body.stage)) return null;
  if (body.resource !== undefined && (typeof body.resource !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(body.resource))) return null;
  if (body.category !== undefined && (typeof body.category !== "string" || !STARTUP_CATEGORIES.has(body.category))) return null;
  if (body.name !== undefined && (typeof body.name !== "string" || !STARTUP_ERROR_NAMES.has(body.name))) return null;
  for (const key of ["line", "column"]) if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isInteger(body[key]) || (body[key] as number) < 0 || (body[key] as number) > 10_000_000)) return null;
  return { id: body.id, event: body.event, stage: body.stage, ...(body.resource ? { resource: body.resource as string } : {}), ...(body.category ? { category: body.category as string } : {}), ...(body.name ? { name: body.name as string } : {}), ...(body.line !== undefined ? { line: body.line as number } : {}), ...(body.column !== undefined ? { column: body.column as number } : {}) };
}
function startupBrowser(agent: string): string {
  for (const [pattern, name] of [[/Edg\/(\d{1,3})\./, "Edge"], [/Chrome\/(\d{1,3})\./, "Chrome"], [/Firefox\/(\d{1,3})\./, "Firefox"], [/Version\/(\d{1,3})\..*Safari\//, "Safari"]] as const) {
    const match = agent.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return "Other";
}

export type AuthConfig = {
  databasePath: string;
  username: string;
  passwordHash: string;
  publicOrigin: string;
  now?: () => number;
  /**
   * 应用服务的本机地址（手机扫码绑定用，DESIGN.md §33）：网关用它校验手机的设备令牌、定期确认手机没被撤销。
   * 默认 http://127.0.0.1:3001；必须是直连，不能经过公网 Nginx（带 X-Forwarded-For 会被 404）。
   * 多账号时还要在请求头带 X-ChisaBot-Local-Caller = identitySecret（应用侧 CR-P1-02）。
   */
  appUrl?: string;
  /** 测试注入用。 */
  appFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * 多账号（CB-040，docs/adr/0010-gateway-accounts.md）：配了它（≥32 字符）就启用朋友账号、邀请链接和
   * 签名身份头 X-ChisaBot-Identity（应用里 CHISABOT_GATEWAY_SECRET 填同一个值）。不配 = 以前的单账号。
   */
  identitySecret?: string;
  /**
   * 开放新朋友账号（邀请链接、管理员直接建账号）。默认关（2026-10-15：多用户以后再做，先隐藏）；
   * 关着时已有朋友账号照常登录、可重置密码 / 停用 / 删除，只是不能再加人，未用的邀请链接也打不开。
   */
  invites?: boolean;
  /** config.json 里那个账号在应用里的用户 id（以前单用户时的数据都在它名下）。 */
  adminUserId?: string;
  /** 测试用：不问应用是否认得签名身份。 */
  skipAppIdentityCheck?: boolean;
  /** 测试用：降低 Argon2 成本。 */
  hashOptions?: { memoryCost?: number; timeCost?: number };
};

export type Principal = { id: string; username: string; name: string; role: "admin" | "user"; builtin: boolean };

/** 签名身份（应用 server/src/auth/gateway-identity.ts 里有对应的验签；格式改动要两边一起改）。 */
export function signIdentity(secret: string, principal: { id: string; name: string; role: "admin" | "user" }, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: principal.id, n: principal.name, r: principal.role, t: now })).toString("base64url");
  const body = `v1.${payload}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const USERNAME = /^[\p{L}\p{N}_.-]{2,32}$/u;
const INVITE_TOKEN = /^cbi_[A-Za-z0-9_-]{43}$/;
function cleanName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) : "";
  return text || fallback;
}

/** 手机会话每隔这么久向应用确认一次设备仍有效；应用暂时连不上时，最多沿用上次结果这么久。 */
const DEVICE_RECHECK_MS = 30_000;
const DEVICE_GRACE_MS = 10 * 60_000;

export function createAuthApp(config: AuthConfig) {
  if (!config.username || !config.passwordHash.startsWith("$argon2id$") || new URL(config.publicOrigin).protocol !== "https:") throw new Error("Invalid authentication configuration");
  if (config.identitySecret !== undefined && (typeof config.identitySecret !== "string" || config.identitySecret.length < 32)) throw new Error("identitySecret must be at least 32 characters");
  const multi = typeof config.identitySecret === "string";
  const invitesOpen = config.invites === true;
  const invitesClosed = () => json({ ok: false, error: "邀请新朋友目前已关闭。", invitesEnabled: false }, 403);
  const adminUserId = config.adminUserId || "dev-local-user";
  const now = config.now || Date.now;
  const appUrl = (config.appUrl || "http://127.0.0.1:3001").replace(/\/+$/, "");
  // globalThis.fetch：下面的请求处理函数也叫 fetch，直接写 fetch 会调用到它自己。
  const appFetch = config.appFetch || ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const credentialKey = digest(config.username + "\0" + config.passwordHash);
  const accountKey = (id: string, hash: string) => digest("account\0" + id + "\0" + hash);
  const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: "argon2id", ...(config.hashOptions || {}) });
  const db = new Database(config.databasePath, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, credential_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS attempts (
    client_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
  // 手机扫码绑定的会话：记下设备 id 和最后一次确认时间；多账号：会话属于哪个账号（NULL = config.json 的管理员）。
  const columns = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name));
  if (!columns.has("device_id")) db.exec("ALTER TABLE sessions ADD COLUMN device_id TEXT");
  if (!columns.has("verified_at")) db.exec("ALTER TABLE sessions ADD COLUMN verified_at INTEGER");
  if (!columns.has("user_id")) db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT");
  // 朋友账号与邀请（CB-040）。管理员仍然只在 config.json 里，不进这张表。
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER
  ); CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invite','reset')), account_id TEXT,
    role TEXT NOT NULL DEFAULT 'user', note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT
  );`);
  if (config.databasePath !== ":memory:") chmodSync(config.databasePath, 0o600);
  let inFlight = 0;
  let cleanedAt = -Infinity;
  // Brief, bounded diagnostics stay on this server. No messages, URLs, credentials or full UA.
  const startupReports: StartupReport[] = [];
  const startupCounts = new Map<string, { count: number; at: number }>();
  function cleanStartupReports() {
    const cutoff = now() - 20 * 60_000;
    while (startupReports.length && startupReports[0]!.at <= cutoff) startupReports.shift();
    for (const [key, value] of startupCounts) if (value.at <= cutoff) startupCounts.delete(key);
  }
  function clean(force = false) {
    const time = now();
    if (!force && time - cleanedAt < 60_000) return;
    db.query("DELETE FROM sessions WHERE expires_at <= ? OR (user_id IS NULL AND credential_key <> ?)").run(time, credentialKey);
    // 停用 / 删除的账号：会话立刻作废（查会话时也逐条核对密码指纹，见 authenticated）。
    db.query("DELETE FROM sessions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM accounts WHERE disabled = 0)").run();
    db.query("DELETE FROM attempts WHERE expires_at <= ?").run(time);
    db.query("DELETE FROM invites WHERE expires_at <= ? AND used_at IS NULL").run(time - 7 * 24 * 3600_000);
    cleanedAt = time;
  }
  type AccountRow = { id: string; username: string; display_name: string; password_hash: string; role: "admin" | "user"; disabled: number; created_at: number; updated_at: number; last_login_at: number | null };
  const adminPrincipal = (): Principal => ({ id: adminUserId, username: config.username, name: config.username, role: "admin", builtin: true });
  const accountPrincipal = (row: AccountRow): Principal => ({ id: row.id, username: row.username, name: row.display_name, role: row.role, builtin: false });
  function account(id: string): AccountRow | null {
    return db.query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
  }
  /** 问应用：这台手机还有效吗？true / false；连不上或回答异常 = null。 */
  async function deviceActive(deviceId: string): Promise<boolean | null> {
    try {
      const response = await appFetch(`${appUrl}/api/devices/agent/state/${encodeURIComponent(deviceId)}`, {
        headers: {
          Accept: "application/json",
          // CR-P1-02：应用不再把「没有代理头」当成受信；多账号时本机探测要带同一把密钥。
          ...(multi && config.identitySecret ? { "X-ChisaBot-Local-Caller": config.identitySecret } : {}),
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { active?: unknown };
      return typeof body.active === "boolean" ? body.active : null;
    } catch { return null; }
  }
  /**
   * 应用认得签名身份吗（CB-040）？旧版本的应用（例如被回滚到多账号之前的镜像）会把所有请求都当成管理员，
   * 这时绝不能放朋友账号进去。问应用 /api/version 的 gatewayIdentity：明确没有 → 拒绝朋友（管理员照常）；
   * 连不上（正在部署 / 重启）→ 沿用上次结果最多 10 分钟，从没确认过就拒绝。
   */
  let identityKnown: { ok: boolean; at: number } | null = null;
  async function appUnderstandsIdentity(): Promise<boolean> {
    if (config.skipAppIdentityCheck) return true;
    if (identityKnown && now() - identityKnown.at < (identityKnown.ok ? 30_000 : 5_000)) return identityKnown.ok;
    try {
      const response = await appFetch(`${appUrl}/api/version`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { gatewayIdentity?: unknown } | null;
        if (body) {
          identityKnown = { ok: body.gatewayIdentity === true, at: now() };
          return identityKnown.ok;
        }
      }
    } catch { /* 下面按上次结果 */ }
    return identityKnown !== null && identityKnown.ok && now() - identityKnown.at < DEVICE_GRACE_MS;
  }
  /** 这个请求是谁（会话有效时）；否则 null。 */
  async function authenticated(request: Request): Promise<Principal | null> {
    clean();
    const token = sessionToken(request);
    if (!token) return null;
    const hash = digest(token);
    const row = db.query("SELECT credential_key, device_id, verified_at, user_id FROM sessions WHERE token_hash = ? AND expires_at > ?").get(hash, now()) as { credential_key: string; device_id: string | null; verified_at: number | null; user_id: string | null } | null;
    if (!row) return null;
    let principal: Principal;
    if (row.user_id === null) {
      if (row.credential_key !== credentialKey) return null;
      principal = adminPrincipal();
    } else {
      if (!multi) return null;
      const found = account(row.user_id);
      // 停用、删除或改过密码（重置）的账号：旧会话一律失效。
      if (!found || found.disabled || accountKey(found.id, found.password_hash) !== row.credential_key) return null;
      if (!(await appUnderstandsIdentity())) return null;
      principal = accountPrincipal(found);
    }
    if (!row.device_id) return principal;
    // 手机会话：撤销 / 删除设备后，最迟约 30 秒失效。
    const verifiedAt = row.verified_at || 0;
    if (now() - verifiedAt < DEVICE_RECHECK_MS) return principal;
    const active = await deviceActive(row.device_id);
    if (active === true) {
      db.query("UPDATE sessions SET verified_at = ? WHERE token_hash = ?").run(now(), hash);
      return principal;
    }
    if (active === false) {
      db.query("DELETE FROM sessions WHERE device_id = ?").run(row.device_id);
      return null;
    }
    return now() - verifiedAt < DEVICE_GRACE_MS ? principal : null;
  }
  function revoke(request: Request) {
    const token = sessionToken(request);
    if (token) db.query("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
  }
  function attempt(key: string) {
    db.query(`INSERT INTO attempts (client_key, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(client_key) DO UPDATE SET count = count + 1`).run(key, now() + WINDOW);
  }
  /** 签发会话：principal 是管理员（config.json）还是朋友账号，决定 user_id 与凭据指纹。 */
  function issueSession(request: Request, principal: Principal, lifetime: number, deviceId: string | null = null): string {
    const token = randomBytes(32).toString("base64url");
    let key = credentialKey;
    let userId: string | null = null;
    if (!principal.builtin) {
      const row = account(principal.id)!;
      key = accountKey(row.id, row.password_hash);
      userId = row.id;
      db.query("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(now(), row.id);
    }
    db.transaction(() => {
      revoke(request);
      db.query("INSERT INTO sessions (token_hash, credential_key, expires_at, created_at, device_id, verified_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(digest(token), key, now() + lifetime * 1000, now(), deviceId, deviceId ? now() : null, userId);
      db.query("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT -1 OFFSET 300)").run();
    })();
    return token;
  }
  function tooMany(clientKey: string): Response | null {
    const failures = db.query("SELECT count, expires_at FROM attempts WHERE client_key = ? AND expires_at > ?").get(clientKey, now()) as { count: number; expires_at: number } | null;
    const global = db.query("SELECT count, expires_at FROM attempts WHERE client_key = 'global' AND expires_at > ?").get(now()) as { count: number; expires_at: number } | null;
    if ((failures?.count || 0) >= 10 || (global?.count || 0) >= 1000 || inFlight >= 2) {
      const retry = inFlight >= 2 ? 2 : Math.max(1, Math.ceil(((failures?.expires_at || global?.expires_at || now() + WINDOW) - now()) / 1000));
      return json({ ok: false, error: "尝试次数过多，请稍后再试。" }, 429, { "Retry-After": String(retry) });
    }
    return null;
  }
  async function readJson(request: Request, limit = 4096): Promise<Record<string, unknown> | Response> {
    const contentType = (request.headers.get("Content-Type") || "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return json({ ok: false, error: "请求格式无效，请刷新页面重试。" }, 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > limit) return json({ ok: false, error: "请求过长。" }, 413);
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body as Record<string, unknown>;
    } catch { return json({ ok: false, error: "请求格式无效。" }, 400); }
  }
  /**
   * 手机扫码绑定后的登录（DESIGN.md §33）：手机带着设备令牌（X-Device-Token）来换网关会话。
   * 网关把令牌交给应用 /api/devices/agent/session 校验（只认未撤销的手机设备），通过就签发 30 天会话，
   * 会话上记下设备 id 和设备主人（多账号时）；之后每 30 秒左右确认一次设备仍有效，撤销即失效。和密码登录共用失败限速。
   */
  async function deviceSession(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, error: "请求方法不支持。" }, 405, { Allow: "POST" });
    if (request.headers.get("Origin") !== config.publicOrigin) return json({ ok: false, error: "登录请求来源无效，请确认服务器地址。" }, 403);
    clean();
    const clientKey = digest(`client:${request.headers.get("X-OpenBot-Client") || "unknown"}`);
    const failures = db.query("SELECT count FROM attempts WHERE client_key = ? AND expires_at > ?").get(clientKey, now()) as { count: number } | null;
    if ((failures?.count || 0) >= 10) return json({ ok: false, error: "尝试次数过多，请稍后再试。" }, 429, { "Retry-After": "60" });
    const deviceToken = (request.headers.get("X-Device-Token") || "").trim();
    if (!/^cbd_[A-Za-z0-9_-]{43}$/.test(deviceToken)) {
      attempt(clientKey);
      return json({ ok: false, error: "设备令牌无效，请重新扫码绑定。" }, 401);
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024) return json({ ok: false, error: "请求过长。" }, 413);
    let facts: Record<string, unknown> = {};
    try { const parsed = text ? JSON.parse(text) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) facts = parsed; } catch { /* 附带信息可选 */ }
    let reply: Response;
    try {
      reply = await appFetch(`${appUrl}/api/devices/agent/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Device-Token": deviceToken },
        body: JSON.stringify({ clientVersion: facts.clientVersion, osVersion: facts.osVersion }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { return json({ ok: false, error: "服务器暂时不可用，请稍后重试。" }, 503); }
    if (reply.status === 401 || reply.status === 403) {
      attempt(clientKey);
      const body = (await reply.json().catch(() => ({}))) as { revoked?: unknown };
      return json({ ok: false, revoked: body.revoked === true, error: body.revoked === true ? "这台手机已在网页上被撤销，请重新扫码绑定。" : "设备令牌无效，请重新扫码绑定。" }, 401);
    }
    if (!reply.ok) return json({ ok: false, error: "服务器暂时不可用，请稍后重试。" }, 503);
    const body = (await reply.json().catch(() => null)) as { device?: { id?: unknown; name?: unknown; ownerUserId?: unknown } } | null;
    const deviceId = typeof body?.device?.id === "string" ? body.device.id : null;
    if (!deviceId) return json({ ok: false, error: "服务器暂时不可用，请稍后重试。" }, 503);
    // 多账号：手机属于谁，会话就是谁的。主人是停用 / 不存在的账号时不给会话。
    let principal = adminPrincipal();
    if (multi) {
      const owner = typeof body?.device?.ownerUserId === "string" ? body.device.ownerUserId : adminUserId;
      if (owner !== adminUserId) {
        const found = account(owner);
        if (!found || found.disabled) {
          attempt(clientKey);
          return json({ ok: false, error: "这个账号已停用，请联系管理员。" }, 401);
        }
        principal = accountPrincipal(found);
      }
    }
    db.query("DELETE FROM attempts WHERE client_key = ?").run(clientKey);
    const token = issueSession(request, principal, LONG_LIFETIME, deviceId);
    return json({ ok: true, device: { id: deviceId, name: typeof body?.device?.name === "string" ? body.device.name : null } }, 200, { "Set-Cookie": cookieHeader(token, LONG_LIFETIME) });
  }

  // ---- 账号管理（仅管理员，DESIGN.md 账号一节）----
  const accountView = (row: AccountRow) => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: !!row.disabled, builtin: false, createdAt: row.created_at, lastLoginAt: row.last_login_at });
  function inviteUrl(token: string) { return `${config.publicOrigin}/login?invite=${token}`; }
  function newInvite(kind: "invite" | "reset", hours: number, note: string | null, accountId: string | null): { id: string; url: string; expiresAt: number } {
    const token = "cbi_" + randomBytes(32).toString("base64url");
    const expiresAt = now() + hours * 3600_000;
    db.query("INSERT INTO invites (token_hash, kind, account_id, role, note, created_at, expires_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").run(digest(token), kind, accountId, note, now(), expiresAt);
    return { id: digest(token).slice(0, 16), url: inviteUrl(token), expiresAt };
  }
  function usernameProblem(username: string, exceptId: string | null = null): string | null {
    if (!USERNAME.test(username)) return "账号名 2–32 个字符，只能用中英文、数字和 _ . -。";
    const key = username.toLowerCase();
    if (key === config.username.toLowerCase()) return "这个账号名已被使用。";
    const taken = db.query("SELECT id FROM accounts WHERE username_key = ?").get(key) as { id: string } | null;
    if (taken && taken.id !== exceptId) return "这个账号名已被使用。";
    return null;
  }
  function passwordProblem(password: unknown): string | null {
    if (typeof password !== "string" || password.length < 8) return "密码至少 8 位。";
    if (password.length > 1024) return "密码太长。";
    return null;
  }
  async function admin(request: Request, path: string): Promise<Response> {
    if (!multi) return json({ ok: false, error: "这个部署没有开启多账号。", multiAccount: false }, 404);
    const principal = await authenticated(request);
    if (!principal) return unauthorized();
    if (principal.role !== "admin") return json({ ok: false, error: "只有管理员可以管理账号。" }, 403);
    const method = request.method;
    if (method !== "GET" && request.headers.get("Origin") !== config.publicOrigin) return json({ ok: false, error: "请求来源无效，请刷新页面重试。" }, 403);
    const rest = path.slice("/auth/admin/".length).split("/");
    if (rest[0] === "accounts" && rest.length === 1) {
      if (method === "GET") {
        clean(true);
        const rows = db.query("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[];
        const invites = (db.query("SELECT token_hash, kind, account_id, note, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now()) as { token_hash: string; kind: string; account_id: string | null; note: string | null; created_at: number; expires_at: number }[])
          .map((row) => ({ id: row.token_hash.slice(0, 16), kind: row.kind, accountId: row.account_id, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at }));
        return json({
          ok: true,
          me: principal.id,
          invitesEnabled: invitesOpen,
          accounts: [{ id: adminUserId, username: config.username, displayName: config.username, role: "admin", disabled: false, builtin: true, createdAt: null, lastLoginAt: null }, ...rows.map(accountView)],
          invites,
        });
      }
      if (method === "POST") {
        if (!invitesOpen) return invitesClosed();
        const body = await readJson(request);
        if (body instanceof Response) return body;
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const problem = usernameProblem(username) || passwordProblem(body.password);
        if (problem) return json({ ok: false, error: problem }, 400);
        if (inFlight >= 2) return json({ ok: false, error: "服务器忙，请稍后再试。" }, 429, { "Retry-After": "2" });
        inFlight++;
        let hash: string;
        try { hash = await hashPassword(body.password as string); } finally { inFlight--; }
        const id = "u_" + randomBytes(9).toString("base64url");
        db.query("INSERT INTO accounts (id, username, username_key, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)").run(id, username, username.toLowerCase(), cleanName(body.displayName, username), hash, now(), now());
        return json({ ok: true, account: accountView(account(id)!) }, 201);
      }
      return json({ ok: false, error: "请求方法不支持。" }, 405);
    }
    if (rest[0] === "invites" && rest.length === 1 && method === "POST") {
      if (!invitesOpen) return invitesClosed();
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const hours = typeof body.hours === "number" && Number.isFinite(body.hours) ? Math.min(168, Math.max(1, Math.round(body.hours))) : 72;
      const note = typeof body.note === "string" && body.note.trim() ? cleanName(body.note, "") : null;
      const pending = (db.query("SELECT count(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?").get(now()) as { n: number }).n;
      if (pending >= 20) return json({ ok: false, error: "未使用的邀请太多了，先撤销一些。" }, 429);
      return json({ ok: true, invite: newInvite("invite", hours, note, null) }, 201);
    }
    if (rest[0] === "invites" && rest.length === 2 && method === "DELETE") {
      const id = rest[1] || "";
      if (!/^[0-9a-f]{16}$/.test(id)) return json({ ok: false, error: "邀请不存在。" }, 404);
      db.query("DELETE FROM invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL").run(id);
      return json({ ok: true });
    }
    if (rest[0] === "accounts" && rest.length >= 2) {
      const id = rest[1] || "";
      if (id === adminUserId) return json({ ok: false, error: "内置管理员账号在服务器配置里管理，这里不能改。" }, 400);
      const row = /^u_[A-Za-z0-9_-]{12}$/.test(id) ? account(id) : null;
      if (!row) return json({ ok: false, error: "账号不存在。" }, 404);
      if (rest.length === 2 && method === "PATCH") {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        if (body.disabled !== undefined) {
          if (typeof body.disabled !== "boolean") return json({ ok: false, error: "disabled 必须是 true / false。" }, 400);
          db.query("UPDATE accounts SET disabled = ?, updated_at = ? WHERE id = ?").run(body.disabled ? 1 : 0, now(), id);
          if (body.disabled) db.query("DELETE FROM sessions WHERE user_id = ?").run(id);
        }
        if (body.displayName !== undefined) db.query("UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?").run(cleanName(body.displayName, row.username), now(), id);
        return json({ ok: true, account: accountView(account(id)!) });
      }
      if (rest.length === 2 && method === "DELETE") {
        db.transaction(() => {
          db.query("DELETE FROM sessions WHERE user_id = ?").run(id);
          db.query("DELETE FROM invites WHERE account_id = ?").run(id);
          db.query("DELETE FROM accounts WHERE id = ?").run(id);
        })();
        return json({ ok: true });
      }
      if (rest.length === 3 && rest[2] === "reset" && method === "POST") {
        db.query("DELETE FROM invites WHERE account_id = ? AND used_at IS NULL").run(id);
        return json({ ok: true, invite: newInvite("reset", 24, null, id) }, 201);
      }
    }
    return json({ ok: false, error: "页面不存在。" }, 404);
  }

  // ---- 邀请 / 重置密码链接（公开，凭链接里的一次性令牌）----
  type InviteRow = { token_hash: string; kind: "invite" | "reset"; account_id: string | null; expires_at: number; used_at: number | null };
  function findInvite(token: unknown): InviteRow | null {
    if (typeof token !== "string" || !INVITE_TOKEN.test(token)) return null;
    const row = db.query("SELECT token_hash, kind, account_id, expires_at, used_at FROM invites WHERE token_hash = ?").get(digest(token)) as InviteRow | null;
    if (!row || row.used_at !== null || row.expires_at <= now()) return null;
    if (row.kind === "invite" && !invitesOpen) return null;
    if (row.kind === "reset") {
      const target = row.account_id ? account(row.account_id) : null;
      if (!target || target.disabled) return null;
    }
    return row;
  }
  async function invite(request: Request): Promise<Response> {
    if (!multi) return json({ ok: false, error: "这个链接无效。" }, 404);
    clean();
    const clientKey = digest("client:" + (request.headers.get("X-OpenBot-Client") || "unknown"));
    if (request.method === "GET") {
      const limited = tooMany(clientKey);
      if (limited) return limited;
      const token = new URL(request.url).searchParams.get("token");
      const row = findInvite(token);
      if (!row) {
        attempt(clientKey);
        return json({ ok: false, error: "邀请链接无效或已过期，请向管理员要一个新的。" }, 404);
      }
      const target = row.kind === "reset" && row.account_id ? account(row.account_id) : null;
      return json({ ok: true, kind: row.kind, expiresAt: row.expires_at, ...(target ? { username: target.username, displayName: target.display_name } : {}) });
    }
    if (request.method !== "POST") return json({ ok: false, error: "请求方法不支持。" }, 405, { Allow: "GET, POST" });
    if (request.headers.get("Origin") !== config.publicOrigin) return json({ ok: false, error: "请求来源无效，请刷新页面重试。" }, 403);
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const limited = tooMany(clientKey);
    if (limited) return limited;
    const row = findInvite(body.token);
    if (!row) {
      attempt(clientKey);
      return json({ ok: false, error: "邀请链接无效或已过期，请向管理员要一个新的。" }, 404);
    }
    const passwordIssue = passwordProblem(body.password);
    if (passwordIssue) return json({ ok: false, error: passwordIssue }, 400);
    let username = "";
    if (row.kind === "invite") {
      username = typeof body.username === "string" ? body.username.trim() : "";
      const problem = usernameProblem(username);
      if (problem) return json({ ok: false, error: problem }, 400);
    }
    inFlight++;
    let hash: string;
    try { hash = await hashPassword(body.password as string); } finally { inFlight--; }
    // 一次性：用 used_at IS NULL 条件抢占，两个并发请求只有一个成功。
    let accountId: string | null = null;
    db.transaction(() => {
      const claimed = db.query("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").run(now(), row.token_hash, now());
      if (claimed.changes !== 1) return;
      if (row.kind === "invite") {
        if (db.query("SELECT id FROM accounts WHERE username_key = ?").get(username.toLowerCase())) {
          db.query("UPDATE invites SET used_at = NULL WHERE token_hash = ?").run(row.token_hash);
          return;
        }
        accountId = "u_" + randomBytes(9).toString("base64url");
        db.query("INSERT INTO accounts (id, username, username_key, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)").run(accountId, username, username.toLowerCase(), cleanName(body.displayName, username), hash, now(), now());
      } else {
        accountId = row.account_id;
        db.query("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, now(), accountId);
        db.query("DELETE FROM sessions WHERE user_id = ?").run(accountId);
      }
      db.query("UPDATE invites SET used_by = ? WHERE token_hash = ?").run(accountId, row.token_hash);
    })();
    if (!accountId) return json({ ok: false, error: row.kind === "invite" ? "这个账号名已被使用。" : "邀请链接无效或已过期，请向管理员要一个新的。" }, 409);
    const principal = accountPrincipal(account(accountId)!);
    const remember = body.remember === true;
    const token = issueSession(request, principal, remember ? LONG_LIFETIME : SHORT_LIFETIME);
    return json({ ok: true, next: "/" }, 200, { "Set-Cookie": cookieHeader(token, remember ? LONG_LIFETIME : undefined) });
  }

  async function fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/_internal/health" && request.method === "GET") return json({ ok: true });
      // The auth listener is loopback-only; Nginx rejects every public /_internal/ path.
      if (path === "/_internal/startup-reports" && request.method === "GET") {
        cleanStartupReports();
        return json({ reports: startupReports });
      }
      if (path === "/_internal/check" && request.method === "GET") {
        const principal = await authenticated(request);
        if (!principal) return unauthorized();
        // Magpie 等只给管理员的入口：nginx 在 auth_request 上加 X-ChisaBot-Require-Role: admin。
        if (request.headers.get("X-ChisaBot-Require-Role") === "admin" && principal.role !== "admin") return json({ ok: false, error: "只有管理员可以访问。" }, 403);
        return json({ ok: true }, 200, multi ? { "X-ChisaBot-Identity": signIdentity(config.identitySecret!, principal, now()) } : {});
      }
      if (path === "/_internal/unauthorized") {
        const original = request.headers.get("X-Original-URI") || "/";
        const method = request.headers.get("X-Original-Method");
        const navigate = request.headers.get("X-Original-Fetch-Mode") === "navigate" || (request.headers.get("Accept") || "").includes("text/html");
        if ((method === "GET" || method === "HEAD") && navigate && !/^\/(?:api|health)(?:\/|\?|$)/.test(original)) {
          return new Response(null, { status: 302, headers: { Location: "/login?next=" + encodeURIComponent(safeNext(original)), "Cache-Control": "no-store" } });
        }
        return unauthorized();
      }
      if (path === "/auth/session" && request.method === "GET") {
        const principal = await authenticated(request);
        return json(principal ? { authenticated: true, username: principal.username, displayName: principal.name, role: principal.role, userId: principal.id, ...(multi ? { multiAccount: true } : {}) } : { authenticated: false, ...(multi ? { multiAccount: true } : {}) });
      }
      if (path === "/auth/startup-report") {
        if (request.method !== "POST") return json({ ok: false }, 405, { Allow: "POST" });
        if (request.headers.get("Origin") !== config.publicOrigin) return json({ ok: false }, 403);
        // A diagnostic refusal must not activate the workspace's login redirect interceptor.
        if (!(await authenticated(request))) return json({ ok: false }, 401);
        if ((request.headers.get("Content-Type") || "").split(";")[0]?.trim().toLowerCase() !== "application/json") return json({ ok: false }, 415);
        const text = await request.text();
        if (Buffer.byteLength(text) > 512) return json({ ok: false }, 413);
        let body: unknown;
        try { body = JSON.parse(text); } catch { return json({ ok: false }, 400); }
        const report = startupMetadata(body);
        if (!report) return json({ ok: false }, 400);
        cleanStartupReports();
        const key = digest(sessionToken(request)! + ":" + report.id);
        const count = startupCounts.get(key);
        if (count && count.count >= 8) return json({ ok: false }, 429);
        startupCounts.set(key, { count: (count?.count || 0) + 1, at: now() });
        while (startupCounts.size > 100) startupCounts.delete(startupCounts.keys().next().value!);
        startupReports.push({ ...report, at: now(), browser: startupBrowser(request.headers.get("User-Agent") || "") });
        while (startupReports.length > 100) startupReports.shift();
        return json({ ok: true }, 202);
      }
      if (path === "/auth/device-session") return await deviceSession(request);
      if (path.startsWith("/auth/admin/")) return await admin(request, path);
      if (path === "/auth/invite") return await invite(request);
      if (path !== "/auth/login" && path !== "/auth/logout") return json({ ok: false, error: "页面不存在。" }, 404);
      if (request.method !== "POST") return json({ ok: false, error: "请求方法不支持。" }, 405, { Allow: "POST" });
      if (request.headers.get("Origin") !== config.publicOrigin) return json({ ok: false, error: "登录请求来源无效，请刷新页面重试。" }, 403);
      const contentType = (request.headers.get("Content-Type") || "").split(";")[0]?.trim().toLowerCase();
      // The app's existing sign-out request has no body or Content-Type.
      // Origin validation remains mandatory for both logout entry points.
      if (contentType !== "application/json" && !(path === "/auth/logout" && !contentType)) return json({ ok: false, error: "请求格式无效，请刷新页面重试。" }, 415);
      if (path === "/auth/logout") {
        revoke(request);
        return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("", 0) });
      }
      clean();
      const text = await request.text();
      if (Buffer.byteLength(text) > 4096) return json({ ok: false, error: "请求过长。" }, 413);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      } catch { return json({ ok: false, error: "请求格式无效。" }, 400); }
      const clientKey = digest("client:" + (request.headers.get("X-OpenBot-Client") || "unknown"));
      const limited = tooMany(clientKey);
      if (limited) return limited;
      const validInput = typeof body.username === "string" && body.username.length <= 64 && typeof body.password === "string" && body.password.length > 0 && body.password.length <= 1024;
      let principal: Principal | null = null;
      if (validInput) {
        const username = body.username as string;
        // 账号名都不分大小写（内置管理员也是：登录页不再预填，Ayase / ayase 都认）；朋友账号不能取和管理员同名（不分大小写）。
        // 找不到也照样做一次 Argon2 校验，不让响应时间泄露账号是否存在。
        const isAdminName = username.trim().toLowerCase() === config.username.toLowerCase();
        const row = multi && !isAdminName
          ? (db.query("SELECT * FROM accounts WHERE username_key = ? AND disabled = 0").get(username.trim().toLowerCase()) as AccountRow | null)
          : null;
        inFlight++;
        try {
          if (row) {
            if (await Bun.password.verify(body.password as string, row.password_hash)) principal = accountPrincipal(row);
          } else {
            const ok = await Bun.password.verify(body.password as string, config.passwordHash);
            if (ok && isAdminName) principal = adminPrincipal();
          }
        } finally { inFlight--; }
      }
      if (!principal) {
        attempt(clientKey); attempt("global");
        return json({ ok: false, error: "账号或密码不正确，请重试。" }, 401);
      }
      db.query("DELETE FROM attempts WHERE client_key = ?").run(clientKey);
      const lifetime = body.remember === true ? LONG_LIFETIME : SHORT_LIFETIME;
      const token = issueSession(request, principal, lifetime);
      return json({ ok: true, next: safeNext(body.next) }, 200, { "Set-Cookie": cookieHeader(token, body.remember === true ? lifetime : undefined) });
    } catch {
      // Never log request bodies, password hashes, cookies, or session tokens.
      return json({ ok: false, error: "登录服务暂时不可用，请稍后重试。" }, 503);
    }
  }
  return { fetch, close: () => db.close() };
}

if (import.meta.main) {
  process.umask(0o077);
  const stored = await Bun.file(process.env.OPENBOT_AUTH_CONFIG || "/auth/config.json").json();
  const app = createAuthApp({ ...stored, databasePath: process.env.OPENBOT_AUTH_DB || "/auth-data/sessions.sqlite", ...(process.env.OPENBOT_AUTH_APP_URL ? { appUrl: process.env.OPENBOT_AUTH_APP_URL } : {}) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.OPENBOT_AUTH_PORT || 3002), maxRequestBodySize: 4096, fetch: app.fetch });
  console.log("ChisaBot web authentication listening on loopback");
  const stop = () => { server.stop(true); app.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
