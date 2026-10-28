import { beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthApp, signIdentity } from "./server";

// 多账号（CB-040）：朋友账号、邀请、重置、停用、签名身份、手机会话归属、Magpie 仅管理员。
const origin = "https://chisabot.example.com:8443";
const secret = "test-identity-secret-0123456789abcdef";
const adminPassword = "admin-password-only-for-tests";
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await Bun.password.hash(adminPassword, { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 });
});

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
function app(options: { multi?: boolean; now?: () => number; appFetch?: Fetcher; checkApp?: boolean; invites?: boolean } = {}) {
  return createAuthApp({
    databasePath: ":memory:",
    username: "Ayase",
    passwordHash,
    publicOrigin: origin,
    hashOptions: { memoryCost: 4096, timeCost: 1 },
    skipAppIdentityCheck: !options.checkApp,
    invites: options.invites ?? true,
    ...(options.multi === false ? {} : { identitySecret: secret }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.appFetch ? { appFetch: options.appFetch } : {}),
  });
}
function req(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; origin?: string | null } = {}) {
  const method = init.method || (init.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { ...(init.headers || {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && init.origin !== null) headers.Origin = init.origin || origin;
  if (init.cookie) headers.Cookie = init.cookie;
  const request = new Request(origin + path, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  // Hermetic guard: a DOM shim (happy-dom) left registered by another file replaces the global Request and silently drops Origin, which turns every login here into a 403.
  if (headers.Origin && request.headers.get("Origin") !== headers.Origin) throw new Error("global Request dropped the Origin header; a DOM shim from another test file is still registered");
  return request;
}
const cookieOf = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0]!;
async function adminCookie(service: ReturnType<typeof app>) {
  const response = await service.fetch(req("/auth/login", { body: { username: "Ayase", password: adminPassword } }));
  expect(response.status).toBe(200);
  return cookieOf(response);
}
function decode(identity: string) {
  const [, payload] = identity.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}
async function invite(service: ReturnType<typeof app>, admin: string) {
  const response = await service.fetch(req("/auth/admin/invites", { body: { note: "朋友", hours: 24 }, cookie: admin }));
  expect(response.status).toBe(201);
  const { invite } = await response.json();
  return new URL(invite.url).searchParams.get("invite")!;
}
async function friend(service: ReturnType<typeof app>, admin: string, username = "friend1", password = "friend-password-1") {
  const token = await invite(service, admin);
  const response = await service.fetch(req("/auth/invite", { body: { token, username, displayName: "小明", password } }));
  expect(response.status).toBe(200);
  return { cookie: cookieOf(response), token };
}

describe("signed identity", () => {
  test("format matches the app's verifier: v1.payload.hmac", () => {
    const value = signIdentity(secret, { id: "u_abc", name: "小明", role: "user" }, 1000);
    const [v, payload, mac] = value.split(".");
    expect(v).toBe("v1");
    expect(mac).toBe(createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url"));
    expect(decode(value)).toEqual({ u: "u_abc", n: "小明", r: "user", t: 1000 });
  });
  test("admin check carries the built-in admin identity (dev-local-user)", async () => {
    const service = app();
    const admin = await adminCookie(service);
    const check = await service.fetch(req("/_internal/check", { cookie: admin }));
    expect(check.status).toBe(200);
    expect(decode(check.headers.get("X-ChisaBot-Identity")!)).toMatchObject({ u: "dev-local-user", r: "admin" });
    service.close();
  });
  test("single-account deployments (no identitySecret) send no identity and have no admin API", async () => {
    const service = app({ multi: false });
    const admin = await adminCookie(service);
    const check = await service.fetch(req("/_internal/check", { cookie: admin }));
    expect(check.status).toBe(200);
    expect(check.headers.get("X-ChisaBot-Identity")).toBeNull();
    expect((await service.fetch(req("/auth/admin/accounts", { cookie: admin }))).status).toBe(404);
    service.close();
  });
  test("rejects a short identitySecret", () => {
    expect(() => createAuthApp({ databasePath: ":memory:", username: "a", passwordHash, publicOrigin: origin, identitySecret: "short" })).toThrow();
  });
});

describe("invites closed (default since 2026-10-15)", () => {
  test("no new invites or accounts; existing friends keep working; old invite links stop opening", async () => {
    const open = app();
    const admin = await adminCookie(open);
    const token = await invite(open, admin);
    const { cookie } = await friend(open, admin, "friend9", "friend-password-9");
    open.close();
    // 同一份配置但不开 invites：新起一个服务看不到上面的库（:memory:），所以在同一个服务里模拟要用文件库。
    const dir = mkdtempSync(join(tmpdir(), "cb-invites-"));
    const file = join(dir, "s.sqlite");
    const base = { databasePath: file, username: "Ayase", passwordHash, publicOrigin: origin, identitySecret: secret, skipAppIdentityCheck: true, hashOptions: { memoryCost: 4096, timeCost: 1 } };
    let service = createAuthApp({ ...base, invites: true });
    const admin2 = await adminCookie(service);
    const pending = await invite(service, admin2);
    const made = await friend(service, admin2, "friend8", "friend-password-8");
    service.close();
    service = createAuthApp(base);
    const list = await (await service.fetch(req("/auth/admin/accounts", { cookie: admin2 }))).json();
    expect(list.invitesEnabled).toBe(false);
    expect(list.accounts.length).toBe(2);
    expect((await service.fetch(req("/auth/admin/invites", { body: { hours: 24 }, cookie: admin2 }))).status).toBe(403);
    expect((await service.fetch(req("/auth/admin/accounts", { body: { username: "direct1", password: "password-123" }, cookie: admin2 }))).status).toBe(403);
    expect((await service.fetch(req("/auth/invite?token=" + pending))).status).toBe(404);
    // 已有的朋友照常用。
    expect((await service.fetch(req("/_internal/check", { cookie: made.cookie }))).status).toBe(200);
    expect((await service.fetch(req("/auth/login", { body: { username: "friend8", password: "friend-password-8" } }))).status).toBe(200);
    service.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    expect(token && cookie).toBeTruthy();
  });
});

describe("invites and friend accounts", () => {
  test("invite → friend sets name+password → signed in as a distinct user", async () => {
    const service = app();
    const admin = await adminCookie(service);
    const token = await invite(service, admin);
    const peek = await service.fetch(req(`/auth/invite?token=${token}`));
    expect(peek.status).toBe(200);
    expect((await peek.json()).kind).toBe("invite");
    const accept = await service.fetch(req("/auth/invite", { body: { token, username: "friend1", displayName: "小明", password: "friend-password-1" } }));
    expect(accept.status).toBe(200);
    const cookie = cookieOf(accept);
    const check = await service.fetch(req("/_internal/check", { cookie }));
    const identity = decode(check.headers.get("X-ChisaBot-Identity")!);
    expect(identity.u).toMatch(/^u_[A-Za-z0-9_-]{12}$/);
    expect(identity).toMatchObject({ n: "小明", r: "user" });
    const session = await (await service.fetch(req("/auth/session", { cookie }))).json();
    expect(session).toMatchObject({ authenticated: true, username: "friend1", role: "user", multiAccount: true });
    // 一次性：再用同一个链接不行。
    const again = await service.fetch(req("/auth/invite", { body: { token, username: "friend2", password: "friend-password-2" } }));
    expect(again.status).toBe(404);
    // 之后用账号密码登录（不分大小写）。
    const login = await service.fetch(req("/auth/login", { body: { username: "FRIEND1", password: "friend-password-1" } }));
    expect(login.status).toBe(200);
    service.close();
  });
  test("invite validation: bad token, expired, weak password, taken / admin username", async () => {
    let time = 1_000_000;
    const service = app({ now: () => time });
    const admin = await adminCookie(service);
    expect((await service.fetch(req("/auth/invite?token=cbi_nope"))).status).toBe(404);
    const token = await invite(service, admin);
    expect((await service.fetch(req("/auth/invite", { body: { token, username: "ok_name", password: "short" } }))).status).toBe(400);
    expect((await service.fetch(req("/auth/invite", { body: { token, username: "ayase", password: "long-enough-pw" } }))).status).toBe(400);
    expect((await service.fetch(req("/auth/invite", { body: { token, username: "a b", password: "long-enough-pw" } }))).status).toBe(400);
    expect((await service.fetch(req("/auth/invite", { body: { token, username: "ok_name", password: "long-enough-pw" }, origin: "https://evil.example" }))).status).toBe(403);
    time += 25 * 3600_000;
    expect((await service.fetch(req("/auth/invite", { body: { token, username: "ok_name", password: "long-enough-pw" } }))).status).toBe(404);
    service.close();
  });
  test("friend cannot use the admin API; admin can list, disable, reset, delete", async () => {
    const service = app();
    const admin = await adminCookie(service);
    const { cookie } = await friend(service, admin);
    expect((await service.fetch(req("/auth/admin/accounts", { cookie }))).status).toBe(403);
    expect((await service.fetch(req("/auth/admin/invites", { body: {}, cookie }))).status).toBe(403);
    expect((await service.fetch(req("/auth/admin/accounts"))).status).toBe(401);
    const list = await (await service.fetch(req("/auth/admin/accounts", { cookie: admin }))).json();
    expect(list.accounts.map((a: { username: string }) => a.username)).toEqual(["Ayase", "friend1"]);
    const id = list.accounts[1].id as string;
    // 管理员写操作必须同源。
    expect((await service.fetch(req(`/auth/admin/accounts/${id}`, { method: "PATCH", body: { disabled: true }, cookie: admin, origin: "https://evil.example" }))).status).toBe(403);
    // 内置管理员不能在这里改。
    expect((await service.fetch(req("/auth/admin/accounts/dev-local-user", { method: "PATCH", body: { disabled: true }, cookie: admin }))).status).toBe(400);
    // 停用：会话立刻失效，也不能再登录。
    expect((await service.fetch(req(`/auth/admin/accounts/${id}`, { method: "PATCH", body: { disabled: true }, cookie: admin }))).status).toBe(200);
    expect((await service.fetch(req("/_internal/check", { cookie }))).status).toBe(401);
    expect((await service.fetch(req("/auth/login", { body: { username: "friend1", password: "friend-password-1" } }))).status).toBe(401);
    // 恢复 + 重置密码：旧密码 / 旧会话失效，新密码可用。
    await service.fetch(req(`/auth/admin/accounts/${id}`, { method: "PATCH", body: { disabled: false }, cookie: admin }));
    const loggedIn = cookieOf(await service.fetch(req("/auth/login", { body: { username: "friend1", password: "friend-password-1" } })));
    const reset = await (await service.fetch(req(`/auth/admin/accounts/${id}/reset`, { body: {}, cookie: admin }))).json();
    const resetToken = new URL(reset.invite.url).searchParams.get("invite")!;
    const peek = await (await service.fetch(req(`/auth/invite?token=${resetToken}`))).json();
    expect(peek).toMatchObject({ kind: "reset", username: "friend1" });
    expect((await service.fetch(req("/auth/invite", { body: { token: resetToken, password: "new-password-xyz" } }))).status).toBe(200);
    expect((await service.fetch(req("/_internal/check", { cookie: loggedIn }))).status).toBe(401);
    expect((await service.fetch(req("/auth/login", { body: { username: "friend1", password: "friend-password-1" } }))).status).toBe(401);
    expect((await service.fetch(req("/auth/login", { body: { username: "friend1", password: "new-password-xyz" } }))).status).toBe(200);
    // 删除。
    expect((await service.fetch(req(`/auth/admin/accounts/${id}`, { method: "DELETE", cookie: admin }))).status).toBe(200);
    expect((await service.fetch(req("/auth/login", { body: { username: "friend1", password: "new-password-xyz" } }))).status).toBe(401);
    service.close();
  });
  test("admin creates an account directly; revokes a pending invite", async () => {
    const service = app();
    const admin = await adminCookie(service);
    const created = await service.fetch(req("/auth/admin/accounts", { body: { username: "direct", password: "direct-password", displayName: "直建" }, cookie: admin }));
    expect(created.status).toBe(201);
    expect((await service.fetch(req("/auth/admin/accounts", { body: { username: "Direct", password: "direct-password" }, cookie: admin }))).status).toBe(400);
    expect((await service.fetch(req("/auth/login", { body: { username: "direct", password: "direct-password" } }))).status).toBe(200);
    const token = await invite(service, admin);
    const list = await (await service.fetch(req("/auth/admin/accounts", { cookie: admin }))).json();
    expect(list.invites).toHaveLength(1);
    expect((await service.fetch(req(`/auth/admin/invites/${list.invites[0].id}`, { method: "DELETE", cookie: admin }))).status).toBe(200);
    expect((await service.fetch(req(`/auth/invite?token=${token}`))).status).toBe(404);
    service.close();
  });
  test("wrong password for a friend and an unknown user get the same generic error", async () => {
    const service = app();
    const admin = await adminCookie(service);
    await friend(service, admin);
    const a = await service.fetch(req("/auth/login", { body: { username: "friend1", password: "nope-nope" } }));
    const b = await service.fetch(req("/auth/login", { body: { username: "ghost", password: "nope-nope" } }));
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
    service.close();
  });

  test("account names are case-insensitive, the built-in admin included (login page no longer prefills it)", async () => {
    for (const multi of [true, false]) {
      const service = app({ multi });
      for (const name of ["ayase", "AYASE", " Ayase "]) {
        const ok = await service.fetch(req("/auth/login", { body: { username: name, password: adminPassword } }));
        expect(ok.status).toBe(200);
        const me = await (await service.fetch(req("/auth/session", { cookie: cookieOf(ok) }))).json();
        expect(me).toMatchObject({ authenticated: true, role: "admin" });
      }
      expect((await service.fetch(req("/auth/login", { body: { username: "ayase", password: "wrong-password" } }))).status).toBe(401);
      expect((await service.fetch(req("/auth/login", { body: { username: "ayase2", password: adminPassword } }))).status).toBe(401);
      service.close();
    }
    const service = app();
    const admin = await adminCookie(service);
    await friend(service, admin, "XiaoMing", "friend-password-1");
    const f = await service.fetch(req("/auth/login", { body: { username: "xiaoming", password: "friend-password-1" } }));
    expect(f.status).toBe(200);
    expect((await (await service.fetch(req("/auth/session", { cookie: cookieOf(f) }))).json()).role).toBe("user");
    service.close();
  });
});

describe("admin-only entries and phone sessions", () => {
  test("X-ChisaBot-Require-Role: admin refuses friends (Magpie)", async () => {
    const service = app();
    const admin = await adminCookie(service);
    const { cookie } = await friend(service, admin);
    const headers = { "X-ChisaBot-Require-Role": "admin" };
    expect((await service.fetch(req("/_internal/check", { cookie, headers }))).status).toBe(403);
    expect((await service.fetch(req("/_internal/check", { cookie: admin, headers }))).status).toBe(200);
    service.close();
  });
  test("a phone owned by a friend gets that friend's session; a disabled owner gets none", async () => {
    let owner = "dev-local-user";
    const appFetch: Fetcher = async (url) => {
      if (url.endsWith("/api/devices/agent/session")) return Response.json({ device: { id: "dev_phone", name: "手机", ownerUserId: owner } });
      return Response.json({ active: true });
    };
    const service = app({ appFetch });
    const admin = await adminCookie(service);
    await friend(service, admin);
    const list = await (await service.fetch(req("/auth/admin/accounts", { cookie: admin }))).json();
    const friendId = list.accounts[1].id as string;
    const phone = (token = "cbd_" + "a".repeat(43)) => service.fetch(req("/auth/device-session", { body: {}, headers: { "X-Device-Token": token } }));
    // 管理员的手机 → 管理员身份。
    let response = await phone();
    expect(response.status).toBe(200);
    let check = await service.fetch(req("/_internal/check", { cookie: cookieOf(response) }));
    expect(decode(check.headers.get("X-ChisaBot-Identity")!).u).toBe("dev-local-user");
    // 朋友的手机 → 朋友身份。
    owner = friendId;
    response = await phone();
    const friendPhone = cookieOf(response);
    check = await service.fetch(req("/_internal/check", { cookie: friendPhone }));
    expect(decode(check.headers.get("X-ChisaBot-Identity")!)).toMatchObject({ u: friendId, r: "user" });
    // 停用朋友 → 手机会话失效，也换不到新的。
    await service.fetch(req(`/auth/admin/accounts/${friendId}`, { method: "PATCH", body: { disabled: true }, cookie: admin }));
    expect((await service.fetch(req("/_internal/check", { cookie: friendPhone }))).status).toBe(401);
    expect((await phone()).status).toBe(401);
    // 不存在的主人 → 不给会话。
    owner = "u_doesnotexist";
    expect((await phone()).status).toBe(401);
    service.close();
  });
  test("friends are refused while the app does not understand signed identity (e.g. rolled back)", async () => {
    let time = 1_000_000;
    let mode: "old" | "new" | "down" = "old";
    const appFetch: Fetcher = async (url) => {
      if (url.endsWith("/api/version")) {
        if (mode === "down") throw new Error("down");
        return Response.json(mode === "new" ? { version: "x", gatewayIdentity: true } : { version: "x" });
      }
      return Response.json({ active: true });
    };
    const service = app({ appFetch, checkApp: true, now: () => time });
    const admin = await adminCookie(service);
    const { cookie } = await friend(service, admin);
    expect((await service.fetch(req("/_internal/check", { cookie }))).status).toBe(401);
    expect((await service.fetch(req("/_internal/check", { cookie: admin }))).status).toBe(200);
    mode = "new"; time += 6_000;
    expect((await service.fetch(req("/_internal/check", { cookie }))).status).toBe(200);
    // 部署中连不上：沿用上次的「认得」。
    mode = "down"; time += 31_000;
    expect((await service.fetch(req("/_internal/check", { cookie }))).status).toBe(200);
    // 回滚到旧版本：立刻（缓存过期后）拒绝朋友。
    mode = "old"; time += 31_000;
    expect((await service.fetch(req("/_internal/check", { cookie }))).status).toBe(401);
    service.close();
  });
  test("existing admin sessions survive turning multi-account on (same credential key, user_id NULL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-accounts-"));
    const file = join(dir, "s.sqlite");
    const base = { databasePath: file, username: "Ayase", passwordHash, publicOrigin: origin };
    let service = createAuthApp(base);
    const admin = await adminCookie(service);
    service.close();
    service = createAuthApp({ ...base, identitySecret: secret });
    const check = await service.fetch(req("/_internal/check", { cookie: admin }));
    expect(check.status).toBe(200);
    expect(decode(check.headers.get("X-ChisaBot-Identity")!).u).toBe("dev-local-user");
    service.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("CB-096: admin can toggle invites-enabled at runtime, create/invite admins, and update role/password", async () => {
    const service = app({ invites: false });
    const admin = await adminCookie(service);
    // 初始 invites=false 时 invitesEnabled=false，管理员在线开启后立即生效。
    expect((await (await service.fetch(req("/auth/admin/accounts", { cookie: admin }))).json()).invitesEnabled).toBe(false);
    const toggled = await service.fetch(req("/auth/admin/invites-enabled", { method: "PUT", body: { enabled: true }, cookie: admin }));
    expect(toggled.status).toBe(200);
    expect(await toggled.json()).toMatchObject({ invitesEnabled: true });

    // 直接创建一位管理员账号 co_admin。
    const created = await service.fetch(
      req("/auth/admin/accounts", {
        body: { username: "co_admin", password: "co-admin-password", displayName: "副管理员", role: "admin" },
        cookie: admin,
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.account.role).toBe("admin");

    // 副管理员登录并拥有管理员身份与权限。
    const coLogin = await service.fetch(req("/auth/login", { body: { username: "co_admin", password: "co-admin-password" } }));
    expect(coLogin.status).toBe(200);
    const coCookie = cookieOf(coLogin);
    const coSession = await (await service.fetch(req("/auth/session", { cookie: coCookie }))).json();
    expect(coSession.role).toBe("admin");
    expect((await service.fetch(req("/_internal/check", { cookie: coCookie, headers: { "X-ChisaBot-Require-Role": "admin" } }))).status).toBe(200);

    // 邀请一位普通成员，再通过 PATCH 升级为管理员并直接修改密码。
    const { cookie: memberCookie } = await friend(service, coCookie, "member1", "old-password-123");
    const list = await (await service.fetch(req("/auth/admin/accounts", { cookie: coCookie }))).json();
    const member = list.accounts.find((a: { username: string }) => a.username === "member1");
    expect(member.role).toBe("user");

    const patchRole = await service.fetch(req(`/auth/admin/accounts/${member.id}`, { method: "PATCH", body: { role: "admin" }, cookie: admin }));
    expect(patchRole.status).toBe(200);
    expect((await patchRole.json()).account.role).toBe("admin");
    expect((await (await service.fetch(req("/auth/session", { cookie: memberCookie }))).json()).role).toBe("admin");

    // 直接修改密码会使旧会话立即失效，新密码可登录。
    const patchPass = await service.fetch(req(`/auth/admin/accounts/${member.id}`, { method: "PATCH", body: { password: "new-password-456" }, cookie: admin }));
    expect(patchPass.status).toBe(200);
    expect((await (await service.fetch(req("/auth/session", { cookie: memberCookie }))).json()).authenticated).toBe(false);
    expect((await service.fetch(req("/auth/login", { body: { username: "member1", password: "new-password-456" } }))).status).toBe(200);

    // 单个普通成员反复登录受每账号 20 会话上限约束，绝不会挤掉内置管理员的活跃会话。
    const memberCookies: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await service.fetch(req("/auth/login", { body: { username: "member1", password: "new-password-456" } }));
      expect(res.status).toBe(200);
      memberCookies.push(cookieOf(res));
    }
    expect((await service.fetch(req("/_internal/check", { cookie: admin }))).status).toBe(200);
    expect((await service.fetch(req("/_internal/check", { cookie: memberCookies[0]! }))).status).toBe(401);
    expect((await service.fetch(req("/_internal/check", { cookie: memberCookies[24]! }))).status).toBe(200);

    service.close();
  });
});
