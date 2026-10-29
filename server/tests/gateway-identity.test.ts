import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { signIdentity } from "../../deploy/public/auth/server";
import {
  createGatewayRequireUser,
  GatewayReplayCache,
  gatewaySecretFromEnvironment,
  isReplayedGatewayIdentity,
  LOCAL_CALLER_HEADER,
  localCallerAuthorized,
  resolveGatewayRequest,
  signGatewayIdentity,
  verifyGatewayIdentity,
} from "../src/auth/gateway-identity";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

// 多账号（CB-040）：登录网关签名的身份头。
const secret = "unit-test-secret-0123456789abcdef-xyz";

/** 升级前网关的旧格式（没有 j）。 */
function legacyHeader(now: number): string {
  const body = `v1.${Buffer.from(JSON.stringify({ u: "u_abcdefghijkl", n: "x", r: "user", t: now })).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const withIdentity = (header: string) => new Headers({ "x-chisabot-identity": header, "x-forwarded-for": "203.0.113.9" });

describe("gateway identity replay (audit #5)", () => {
  const now = 1_700_000_000_000;
  test("first use passes, the same header again is a replay", () => {
    const cache = new GatewayReplayCache();
    const header = signIdentity(secret, { id: "u_abcdefghijkl", name: "x", role: "user" }, now);
    expect(isReplayedGatewayIdentity(secret, withIdentity(header), cache, now)).toBe(false);
    expect(isReplayedGatewayIdentity(secret, withIdentity(header), cache, now + 1_000)).toBe(true);
    // 同一个人的下一个请求是新签的头，照常通过。
    const next = signIdentity(secret, { id: "u_abcdefghijkl", name: "x", role: "user" }, now);
    expect(isReplayedGatewayIdentity(secret, withIdentity(next), cache, now + 1_000)).toBe(false);
  });
  test("an expired header is refused by verification, not remembered", () => {
    const cache = new GatewayReplayCache();
    const header = signIdentity(secret, { id: "u_abcdefghijkl", name: "x", role: "user" }, now);
    const later = now + 2 * 60_000 + 1;
    expect(isReplayedGatewayIdentity(secret, withIdentity(header), cache, later)).toBe(false);
    expect(cache.size).toBe(0);
    expect(resolveGatewayRequest(secret, withIdentity(header), later).kind).toBe("refuse");
  });
  test("legacy headers without a nonce stay accepted (rolling upgrade)", () => {
    const cache = new GatewayReplayCache();
    const header = legacyHeader(now);
    expect(isReplayedGatewayIdentity(secret, withIdentity(header), cache, now)).toBe(false);
    expect(isReplayedGatewayIdentity(secret, withIdentity(header), cache, now)).toBe(false);
    expect(resolveGatewayRequest(secret, withIdentity(header), now).kind).toBe("actor");
  });
  test("invalid or missing headers are left to resolveGatewayRequest", () => {
    const cache = new GatewayReplayCache();
    expect(isReplayedGatewayIdentity(secret, new Headers(), cache, now)).toBe(false);
    expect(isReplayedGatewayIdentity(secret, withIdentity("garbage"), cache, now)).toBe(false);
    expect(cache.size).toBe(0);
  });
  test("cleanup: expired entries are swept and capacity is capped", () => {
    const cache = new GatewayReplayCache(3);
    expect(cache.consume("a", now + 10, now)).toBe(true);
    expect(cache.consume("b", now + 10, now)).toBe(true);
    expect(cache.consume("c", now + 1_000, now)).toBe(true);
    expect(cache.consume("a", now + 10, now + 5)).toBe(false);
    // 满了：先清过期（a、b），c 还在。
    expect(cache.consume("d", now + 1_000, now + 20)).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.consume("c", now + 1_000, now + 20)).toBe(false);
    // 过期后同一个键可再记（verify 早已拒绝过期头，这里只验证不会永远占着）。
    expect(cache.consume("a", now + 1_000, now + 20)).toBe(true);
    // 都没过期还满：丢最早的，不超过上限。
    expect(cache.consume("e", now + 1_000, now + 20)).toBe(true);
    expect(cache.size).toBe(3);
    expect(cache.consume("c", now + 1_000, now + 20)).toBe(true);
    cache.sweep(now + 2_000);
    expect(cache.size).toBe(0);
  });
});

describe("gateway identity signing", () => {
  test("app and gateway implementations agree", () => {
    const now = 1_700_000_000_000;
    const fromGateway = signIdentity(secret, { id: "u_abcdefghijkl", name: "小明", role: "user" }, now);
    const want = { id: "u_abcdefghijkl", name: "小明", role: "user", issuedAt: now, nonce: expect.any(String) };
    expect(verifyGatewayIdentity(secret, fromGateway, now)).toEqual(want);
    const fromApp = signGatewayIdentity(secret, { id: "u_abcdefghijkl", name: "小明", role: "user" }, now);
    expect(verifyGatewayIdentity(secret, fromApp, now)).toEqual(want);
    // 每次签名都带新的一次性随机数（审计 #5），同一毫秒签两次也不相同。
    expect(fromApp).not.toBe(fromGateway);
    expect(signIdentity(secret, { id: "u_abcdefghijkl", name: "小明", role: "user" }, now)).not.toBe(fromGateway);
  });
  test("rejects tampering, wrong secret, expiry, bad fields", () => {
    const now = 1_700_000_000_000;
    const good = signGatewayIdentity(secret, { id: "u_abcdefghijkl", name: "x", role: "user" }, now);
    const [v, payload, mac] = good.split(".");
    // 把 role 改成 admin、签名不变。
    const forged = Buffer.from(JSON.stringify({ u: "u_abcdefghijkl", n: "x", r: "admin", t: now })).toString("base64url");
    expect(verifyGatewayIdentity(secret, `${v}.${forged}.${mac}`, now)).toBeNull();
    expect(verifyGatewayIdentity("another-secret-0123456789abcdef-xyz", good, now)).toBeNull();
    expect(verifyGatewayIdentity(secret, good, now + 3 * 60_000)).toBeNull();
    expect(verifyGatewayIdentity(secret, good, now - 3 * 60_000)).toBeNull();
    expect(verifyGatewayIdentity(secret, `v2.${payload}.${mac}`, now)).toBeNull();
    expect(verifyGatewayIdentity(secret, "", now)).toBeNull();
    expect(verifyGatewayIdentity(secret, "garbage", now)).toBeNull();
    expect(verifyGatewayIdentity(secret, signGatewayIdentity(secret, { id: "bad id!", name: "x", role: "user" }, now), now)).toBeNull();
    expect(verifyGatewayIdentity(secret, signGatewayIdentity(secret, { id: "u_ok_ok", name: "x", role: "root" as never }, now), now)).toBeNull();
    expect(verifyGatewayIdentity("", good, now)).toBeNull();
  });
  test("secret from environment: unset = off, short = refuse to start", () => {
    expect(gatewaySecretFromEnvironment({})).toBeUndefined();
    expect(() => gatewaySecretFromEnvironment({ CHISABOT_GATEWAY_SECRET: "short" })).toThrow();
    expect(gatewaySecretFromEnvironment({ CHISABOT_GATEWAY_SECRET: ` ${secret} ` })).toBe(secret);
  });
});

describe("who is asking", () => {
  const signed = (id: string, role: "admin" | "user" = "user") => signGatewayIdentity(secret, { id, name: "名字", role });
  test("valid header → that person; admin id → the original single-user admin", () => {
    const friend = resolveGatewayRequest(secret, new Headers({ "x-chisabot-identity": signed("u_friend00001"), "x-forwarded-for": "1.2.3.4" }));
    expect(friend).toEqual({ kind: "actor", actor: { id: "u_friend00001", email: "u_friend00001@accounts.chisabot.local", name: "名字", role: "user" } });
    const admin = resolveGatewayRequest(secret, new Headers({ "x-chisabot-identity": signed(DEV_ACTOR.id, "admin"), "x-forwarded-for": "1.2.3.4" }));
    expect(admin).toEqual({ kind: "actor", actor: { ...DEV_ACTOR, role: "admin" } });
  });
  test("through the gateway without identity, or with a bad one → refused", () => {
    expect(resolveGatewayRequest(secret, new Headers({ "x-forwarded-for": "1.2.3.4" })).kind).toBe("refuse");
    expect(resolveGatewayRequest(secret, new Headers({ "x-real-ip": "1.2.3.4" })).kind).toBe("refuse");
    expect(resolveGatewayRequest(secret, new Headers({ "x-chisabot-identity": "v1.x.y" })).kind).toBe("refuse");
  });
  test("bare request without identity or local-caller proof → refused (CR-P1-02)", () => {
    expect(resolveGatewayRequest(secret, new Headers(), Date.now(), {})).toEqual({ kind: "refuse" });
  });
  test("local-caller header with gateway secret → admin (deploy scripts, updater, auth probe)", () => {
    const headers = new Headers({ [LOCAL_CALLER_HEADER]: secret });
    expect(localCallerAuthorized(secret, headers)).toBe(true);
    expect(resolveGatewayRequest(secret, headers, Date.now(), {})).toEqual({ kind: "actor", actor: DEV_ACTOR });
  });
  test("wrong local-caller secret → refused", () => {
    const headers = new Headers({ [LOCAL_CALLER_HEADER]: "not-the-gateway-secret-0123456789ab" });
    expect(resolveGatewayRequest(secret, headers, Date.now(), {})).toEqual({ kind: "refuse" });
  });
  test("CHISABOT_TRUST_UNSIGNED_LOCAL=1 emergency escape → admin", () => {
    expect(resolveGatewayRequest(secret, new Headers(), Date.now(), { CHISABOT_TRUST_UNSIGNED_LOCAL: "1" })).toEqual({
      kind: "actor",
      actor: DEV_ACTOR,
    });
  });
  test("middleware: 401 with openbotAuthRequired, provisions friends once per request", async () => {
    const provisioned: AuthenticatedActor[] = [];
    const app = new Hono<{ Variables: AppVariables }>();
    app.get("/me", createGatewayRequireUser(secret, async (actor) => void provisioned.push(actor)), (c) => c.json(c.var.actor));
    const refused = await app.request("/me", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(refused.status).toBe(401);
    expect((await refused.json()).openbotAuthRequired).toBe(true);
    const ok = await app.request("/me", { headers: { "x-forwarded-for": "1.1.1.1", "x-chisabot-identity": signed("u_friend00002") } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe("u_friend00002");
    expect(provisioned.map((a) => a.id)).toEqual(["u_friend00002"]);
  });
});
