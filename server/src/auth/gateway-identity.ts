import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { DEV_ACTOR } from "./dev-actor";
import type { AppVariables, AuthenticatedActor } from "./guards";
import type { OpenBotRole } from "./roles";

/**
 * 登录网关传来的签名身份（多账号，CB-040，docs/adr/0009-gateway-accounts.md）。
 *
 * 公网只经过 nginx 网关：网关的登录服务（deploy/public/auth/server.ts）认证会话后，在
 * `/_internal/check` 的响应头里给出 `X-ChisaBot-Identity`，nginx 用 `auth_request_set` 把它原样转给应用。
 * 格式：`v1.<base64url(JSON {u, n, r, t})>.<base64url(HMAC-SHA256(secret, "v1." + payload))>`
 *   u = 用户 id（管理员固定为 dev-local-user，和以前单用户时的数据是同一个人）；n = 显示名；
 *   r = admin | user；t = 签发时间（毫秒）。只在 ±2 分钟内有效（网关每个请求现签）。
 *
 * 判定（只在 OPENBOT_SINGLE_USER + 配了密钥时启用）：
 *  - 有身份头且验签通过 → 这个人；
 *  - 有身份头但无效 → 401；
 *  - 没有身份头、但请求经过了网关（带 X-Forwarded-For / X-Real-IP，nginx 每个转发都会设）→ 401；
 *  - 没有身份头、带 {@link LOCAL_CALLER_HEADER}（值 = 网关密钥，常量时间比较）→ 管理员
 *    （发布脚本、自检、更新器、登录网关对本机的设备状态探测）。**不再**把「没有代理头」当成受信：
 *    容器挂在共享 Docker 网络上时，兄弟容器直连 :3001 也不会带这些头（CR-P1-02）。
 *  - Local-Caller **绑定**：仅接受「非网关直连」（无 X-Forwarded-For / X-Real-IP）。公网 nginx
 *    必须清空该头（deploy/public/nginx.conf）；经网关带 Local-Caller 一律 refuse。刮数只用
 *    `127.0.0.1:3001` + Local-Caller（见 docs/ops/trust-boundary.md）。
 *  - 都没有 → 401。紧急逃生：环境变量 CHISABOT_TRUST_UNSIGNED_LOCAL=1（不安全，见 pipeline-run）。
 */

export const GATEWAY_IDENTITY_HEADER = "x-chisabot-identity";
/** 本机受信调用方证明（值 = CHISABOT_GATEWAY_SECRET）。没有身份头时必须带这个，才能当管理员。 */
export const LOCAL_CALLER_HEADER = "x-chisabot-local-caller";
const MAX_SKEW_MS = 2 * 60_000;

export type GatewayIdentity = { id: string; name: string; role: OpenBotRole; issuedAt: number };

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/** 签一个身份（网关里有一份同样的实现；测试里互相校验）。 */
export function signGatewayIdentity(
  secret: string,
  identity: { id: string; name: string; role: OpenBotRole },
  now = Date.now(),
): string {
  const payload = b64(JSON.stringify({ u: identity.id, n: identity.name, r: identity.role, t: now }));
  const body = `v1.${payload}`;
  return `${body}.${b64(mac(secret, body))}`;
}

const USER_ID = /^[A-Za-z0-9_-]{3,64}$/;

/** 验签；任何不对（格式、签名、过期、字段）都返回 null。 */
export function verifyGatewayIdentity(
  secret: string,
  header: string | null | undefined,
  now = Date.now(),
): GatewayIdentity | null {
  if (!secret || typeof header !== "string" || header.length > 1024) return null;
  const parts = header.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const body = `v1.${parts[1]}`;
  const expected = mac(secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2]!, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { u, n, r, t } = parsed as Record<string, unknown>;
  if (typeof u !== "string" || !USER_ID.test(u)) return null;
  if (r !== "admin" && r !== "user") return null;
  if (typeof t !== "number" || !Number.isFinite(t) || Math.abs(now - t) > MAX_SKEW_MS) return null;
  const name = typeof n === "string" && n.trim() ? n.trim().slice(0, 64) : u;
  return { id: u, name, role: r, issuedAt: t };
}

/** 读密钥：CHISABOT_GATEWAY_SECRET 或 CHISABOT_GATEWAY_SECRET_FILE（≥32 字符）；没配 = 不启用。 */
export function gatewaySecretFromEnvironment(environment: Record<string, string | undefined>): string | undefined {
  let secret = environment.CHISABOT_GATEWAY_SECRET?.trim();
  const file = environment.CHISABOT_GATEWAY_SECRET_FILE?.trim();
  if (!secret && file) {
    try {
      secret = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`CHISABOT_GATEWAY_SECRET_FILE ${file} 读不到。`);
    }
  }
  if (!secret) return undefined;
  if (secret.length < 32) throw new Error("CHISABOT_GATEWAY_SECRET 至少 32 个字符。");
  return secret;
}

/** 请求是不是经过了公网网关（nginx 对每个转发到应用的请求都设 X-Forwarded-For）。 */
function viaGateway(headers: Headers): boolean {
  return Boolean(headers.get("x-forwarded-for") || headers.get("x-real-ip"));
}

/** 本机调用方是否出示了与网关密钥匹配的 {@link LOCAL_CALLER_HEADER}（常量时间比较）。 */
export function localCallerAuthorized(secret: string, headers: Headers): boolean {
  if (!secret) return false;
  const given = headers.get(LOCAL_CALLER_HEADER);
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 紧急：允许没有身份头、也没有本机证明的直连当管理员（默认关）。 */
export function trustUnsignedLocal(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.CHISABOT_TRUST_UNSIGNED_LOCAL?.trim() === "1";
}

export type GatewayResolution =
  | { kind: "actor"; actor: AuthenticatedActor }
  | { kind: "refuse" };

/** 网关账号对应到应用里的人。管理员 = DEV_ACTOR（同一个 id / 邮箱，原有数据不变）。 */
export function actorForIdentity(identity: GatewayIdentity): AuthenticatedActor {
  if (identity.id === DEV_ACTOR.id) return { ...DEV_ACTOR, role: "admin" };
  return {
    id: identity.id,
    email: gatewayUserEmail(identity.id),
    name: identity.name,
    role: identity.role,
  };
}

/** 朋友账号在 users 表里的邮箱（只是唯一键，不发邮件）。 */
export function gatewayUserEmail(id: string): string {
  return `${id}@accounts.chisabot.local`;
}

export function resolveGatewayRequest(
  secret: string,
  headers: Headers,
  now = Date.now(),
  environment: Record<string, string | undefined> = process.env,
): GatewayResolution {
  const header = headers.get(GATEWAY_IDENTITY_HEADER);
  if (header) {
    const identity = verifyGatewayIdentity(secret, header, now);
    return identity ? { kind: "actor", actor: actorForIdentity(identity) } : { kind: "refuse" };
  }
  if (viaGateway(headers)) return { kind: "refuse" };
  if (localCallerAuthorized(secret, headers)) return { kind: "actor", actor: DEV_ACTOR };
  if (trustUnsignedLocal(environment)) return { kind: "actor", actor: DEV_ACTOR };
  return { kind: "refuse" };
}

export type ProvisionUser = (actor: AuthenticatedActor) => Promise<void>;

/**
 * 网关身份模式的 requireUser：认出是谁，第一次见到的朋友账号自动在 users / user_roles 建行（provision）。
 * 401 带 openbotAuthRequired，网页里的 workspace.js 会据此跳回登录页。
 */
export function createGatewayRequireUser(
  secret: string,
  provision: ProvisionUser,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const resolved = resolveGatewayRequest(secret, context.req.raw.headers);
    if (resolved.kind === "refuse") {
      return context.json({ ok: false, error: "请先登录。", openbotAuthRequired: true }, 401);
    }
    await provision(resolved.actor);
    context.set("actor", resolved.actor);
    await next();
  };
}
