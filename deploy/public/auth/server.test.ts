import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuthApp, safeNext } from "./server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = "https://chisabot.example.com:8443";
const password = "test-password-only-not-a-real-credential";
let passwordHash: string;
const directory = mkdtempSync(join(tmpdir(), "chisabot-auth-test-"));
beforeAll(async () => {
  passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function app(file = ":memory:", now?: () => number) {
  return createAuthApp({ databasePath: file, username: "admin", passwordHash, publicOrigin: origin, now });
}
function request(path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookie(response: Response) { return response.headers.get("Set-Cookie")!.split(";")[0]!; }
async function login(service: ReturnType<typeof app>, remember = false, previous?: string) {
  return service.fetch(request("/auth/login", { username: "admin", password, remember, next: "/channel/demo?hello=1" }, previous));
}

describe("public cookie login", () => {
  test("anonymous API denies access without a browser challenge", async () => {
    const service = app();
    const response = await service.fetch(request("/_internal/check"));
    expect(response.status).toBe(401);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect((await response.json()).openbotAuthRequired).toBe(true);
    expect((await (await service.fetch(request("/auth/session"))).json()).authenticated).toBe(false);
    service.close();
  });
  test("wrong username and password receive the same generic error", async () => {
    const service = app();
    const a = await service.fetch(request("/auth/login", { username: "admin", password: "incorrect" }));
    const b = await service.fetch(request("/auth/login", { username: "someone", password }));
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
    expect(a.headers.has("Set-Cookie")).toBe(false);
    service.close();
  });
  test("login sets safe session cookie and returns original relative destination", async () => {
    const service = app();
    const response = await login(service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, next: "/channel/demo?hello=1" });
    const header = response.headers.get("Set-Cookie")!;
    expect(header).toMatch(/^__Host-openbot_session=[A-Za-z0-9_-]{43};/);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(header).toContain(attribute);
    expect(header).not.toContain("Domain="); expect(header).not.toContain("Max-Age=");
    const token = cookie(response);
    expect((await service.fetch(request("/_internal/check", undefined, token))).status).toBe(200);
    expect(await (await service.fetch(request("/auth/session", undefined, token))).json()).toMatchObject({ authenticated: true, username: "admin" });
    service.close();
  });
  test("remember login survives restart, expires after30days, and logout revokes copied cookie", async () => {
    let time = 1_000_000;
    const file = join(directory, "persist.sqlite");
    let service = app(file, () => time);
    const response = await login(service, true);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    const token = cookie(response); service.close();
    service = app(file, () => time);
    expect((await service.fetch(request("/_internal/check", undefined, token))).status).toBe(200);
    const logout = await service.fetch(request("/auth/logout", {}, token));
    expect(logout.status).toBe(200); expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await service.fetch(request("/_internal/check", undefined, token))).status).toBe(401);
    const again = cookie(await login(service, true));
    time += 30 * 24 * 3600 * 1000 + 1;
    expect((await service.fetch(request("/_internal/check", undefined, again))).status).toBe(401);
    service.close();
  });
  test("default expiry is12hours and login rotates previous token", async () => {
    let time = 1_000_000; const service = app(":memory:", () => time);
    const first = cookie(await login(service)); const second = cookie(await login(service, false, first));
    expect(second).not.toBe(first);
    expect((await service.fetch(request("/_internal/check", undefined, first))).status).toBe(401);
    time += 12 * 3600 * 1000 + 1;
    expect((await service.fetch(request("/_internal/check", undefined, second))).status).toBe(401);
    service.close();
  });
  test("login and logout reject cross-site, missing Origin, and nonJSON requests", async () => {
    const service = app();
    for (const path of ["/auth/login", "/auth/logout"]) {
      for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "" }, { "Content-Type": "text/plain" }]) {
        const response = await service.fetch(request(path, { username: "admin", password }, undefined, headers));
        expect([403, 415]).toContain(response.status);
        expect(response.headers.has("Set-Cookie")).toBe(false);
      }
    }
    service.close();
  });
  test("failed logins throttle a client and recover after15minutes", async () => {
    let time = 100_000; const service = app(":memory:", () => time);
    for (let i = 0; i < 10; i++) expect((await service.fetch(request("/auth/login", { username: "admin", password: "wrong" }))).status).toBe(401);
    const blocked = await login(service); expect(blocked.status).toBe(429);
    expect(blocked.headers.has("Retry-After")).toBe(true);
    time += 15 * 60 * 1000 + 1;
    expect((await login(service)).status).toBe(200);
    service.close();
  });
  test("existing app's empty-body logout still revokes the gateway session", async () => {
    const service = app(); const token = cookie(await login(service));
    const response = await service.fetch(new Request(origin + "/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: token } }));
    expect(response.status).toBe(200);
    expect((await service.fetch(request("/_internal/check", undefined, token))).status).toBe(401);
    service.close();
  });
  test("tampered cookies, duplicate session names, and credential changes do not authenticate", async () => {
    const file = join(directory, "change.sqlite"); let service = app(file);
    const token = cookie(await login(service));
    expect((await service.fetch(request("/_internal/check", undefined, token + "x"))).status).toBe(401);
    expect((await service.fetch(request("/_internal/check", undefined, token + "; " + token))).status).toBe(401);
    service.close();
    service = createAuthApp({ databasePath: file, username: "admin", publicOrigin: origin, passwordHash: await Bun.password.hash("changed", { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 }) });
    expect((await service.fetch(request("/_internal/check", undefined, token))).status).toBe(401);
    service.close();
  });
  test("redirects cannot leave the site or return to an auth route", () => {
    for (const target of ["https://evil.example", "//evil.example", "/\\evil", "/%2f%2fevil", "/%252f%252fevil", "/%5cevil", "/foo\nbar", "/login", "/auth/logout", "/x/../login", "/sign", null]) expect(safeNext(target)).toBe("/");
    expect(safeNext("/channel/a?hello=1#message")).toBe("/channel/a?hello=1#message");
  });
  test("anonymous navigation has encoded safe return path while API stays JSON401", async () => {
    const service = app();
    const nav = await service.fetch(request("/_internal/unauthorized", undefined, undefined, { Accept: "text/html", "X-Original-URI": "/channel/a?hello=1", "X-Original-Method": "GET", "X-Original-Fetch-Mode": "navigate" }));
    expect(nav.status).toBe(302); expect(nav.headers.get("Location")).toBe("/login?next=%2Fchannel%2Fa%3Fhello%3D1");
    const api = await service.fetch(request("/_internal/unauthorized", undefined, undefined, { "X-Original-URI": "/api/me", "X-Original-Method": "GET" }));
    expect(api.status).toBe(401); expect((await api.json()).openbotAuthRequired).toBe(true);
    service.close();
  });
});

describe("phone device sessions (QR pairing, DESIGN.md §33)", () => {
  const phoneToken = `cbd_${"a".repeat(43)}`;
  function phoneApp(state: { active: boolean | "down"; sessionStatus?: number; revoked?: boolean }, now?: () => number, file = ":memory:") {
    const calls: string[] = [];
    const service = createAuthApp({
      databasePath: file, username: "admin", passwordHash, publicOrigin: origin, now, appUrl: "http://app.internal:3001/",
      appFetch: async (url, init) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.endsWith("/api/devices/agent/session")) {
          const headers = new Headers(init?.headers);
          if (headers.get("X-Device-Token") !== phoneToken || state.sessionStatus) return Response.json({ revoked: state.revoked === true }, { status: state.sessionStatus || 401 });
          return Response.json({ device: { id: "dev_phone", name: "Pixel 8", ownerUserId: "u1" } });
        }
        if (url.includes("/api/devices/agent/state/")) {
          if (state.active === "down") throw new Error("connection refused");
          return Response.json({ active: state.active });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { service, calls };
  }
  const exchange = (service: ReturnType<typeof app>, token = phoneToken, extra: Record<string, string> = {}) =>
    service.fetch(new Request(`${origin}/auth/device-session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Device-Token": token, ...extra }, body: JSON.stringify({ clientVersion: "0.1.2" }) }));

  test("a valid phone token gets a 30-day session tied to the device", async () => {
    const { service, calls } = phoneApp({ active: true });
    const response = await exchange(service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, device: { id: "dev_phone", name: "Pixel 8" } });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    expect(calls[0]).toBe("POST http://app.internal:3001/api/devices/agent/session");
    const session = cookie(response);
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(200);
    service.close();
  });

  test("revoking the device on the web logs the phone out within the recheck window", async () => {
    let time = 1_000_000;
    const state = { active: true as boolean | "down" };
    const { service, calls } = phoneApp(state, () => time);
    const session = cookie(await exchange(service));
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(200);
    expect(calls.filter((call) => call.includes("/state/")).length).toBe(0); // 刚校验过，不再问
    time += 31_000;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(200);
    expect(calls.filter((call) => call.includes("/state/dev_phone")).length).toBe(1);
    state.active = false;
    time += 31_000;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(401);
    // 会话已删除：即使设备「恢复」也不再有效。
    state.active = true;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(401);
    expect(await (await service.fetch(request("/auth/session", undefined, session))).json()).toEqual({ authenticated: false });
    service.close();
  });

  test("app briefly unreachable keeps the phone signed in only within the grace period", async () => {
    let time = 1_000_000;
    const state = { active: "down" as boolean | "down" };
    const { service } = phoneApp(state, () => time);
    const session = cookie(await exchange(service));
    time += 5 * 60_000;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(200);
    time += 6 * 60_000;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(401);
    service.close();
  });

  test("bad, revoked or cross-origin tokens get no session and count as failures", async () => {
    const { service } = phoneApp({ active: true });
    const malformed = await exchange(service, "cbd_short");
    expect(malformed.status).toBe(401); expect(malformed.headers.has("Set-Cookie")).toBe(false);
    const unknown = await exchange(service, `cbd_${"b".repeat(43)}`);
    expect(unknown.status).toBe(401);
    const cross = await exchange(service, phoneToken, { Origin: "https://evil.example" });
    expect(cross.status).toBe(403); expect(cross.headers.has("Set-Cookie")).toBe(false);
    for (let i = 0; i < 10; i++) await exchange(service, "cbd_short", { "X-ChisaBot-Client": "198.51.100.7" });
    expect((await exchange(service, phoneToken, { "X-ChisaBot-Client": "198.51.100.7" })).status).toBe(429);
    service.close();
    const revoked = phoneApp({ active: false, sessionStatus: 401, revoked: true });
    const response = await exchange(revoked.service);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, revoked: true });
    revoked.service.close();
  });

  test("old session databases gain the device columns in place; password sessions are unaffected", async () => {
    const file = join(directory, "legacy.sqlite");
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(file, { create: true });
    legacy.exec("CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, credential_key TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE attempts (client_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);");
    legacy.close();
    const { service, calls } = phoneApp({ active: false }, undefined, file);
    const password = cookie(await login(service));
    expect((await service.fetch(request("/_internal/check", undefined, password))).status).toBe(200);
    expect(calls.length).toBe(0);
    expect((await exchange(service)).status).toBe(200);
    service.close();
  });
});

describe("phone sessions against a real HTTP app", () => {
  test("the default app client reaches the app over HTTP (not the gateway's own handler)", async () => {
    const appServer = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/devices/agent/session" && request.headers.get("X-Device-Token") === `cbd_${"c".repeat(43)}`) return Response.json({ device: { id: "dev_http", name: "HTTP 手机" } });
        if (url.pathname === "/api/devices/agent/state/dev_http") return Response.json({ active: false });
        return Response.json({ error: "no" }, { status: 401 });
      },
    });
    let time = 1_000_000;
    const service = createAuthApp({ databasePath: ":memory:", username: "admin", passwordHash, publicOrigin: origin, now: () => time, appUrl: `http://127.0.0.1:${appServer.port}` });
    const response = await service.fetch(new Request(`${origin}/auth/device-session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Device-Token": `cbd_${"c".repeat(43)}` }, body: "{}" }));
    expect(response.status).toBe(200);
    const session = cookie(response);
    time += 31_000;
    expect((await service.fetch(request("/_internal/check", undefined, session))).status).toBe(401);
    service.close();
    appServer.stop(true);
  });
});
