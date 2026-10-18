import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { signIdentity } from "../../deploy/public/auth/server";
import {
  createGatewayRequireUser,
  gatewaySecretFromEnvironment,
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

describe("gateway identity signing", () => {
  test("app and gateway implementations agree", () => {
    const now = 1_700_000_000_000;
    const fromGateway = signIdentity(secret, { id: "u_abcdefghijkl", name: "小明", role: "user" }, now);
    expect(verifyGatewayIdentity(secret, fromGateway, now)).toEqual({ id: "u_abcdefghijkl", name: "小明", role: "user", issuedAt: now });
    const fromApp = signGatewayIdentity(secret, { id: "u_abcdefghijkl", name: "小明", role: "user" }, now);
    expect(fromApp).toBe(fromGateway);
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
