"use strict";
/* 本机登录页：地址规范化、探测、直接请求登录网关、错误分类；Android 用的是同一份登录页。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const auth = require("../src/agent/auth");

function res(status, body, headers = {}) {
  const h = new Headers(headers);
  if (headers["set-cookie"]) h.getSetCookie = () => [].concat(headers["set-cookie"]);
  return { status, ok: status >= 200 && status < 300, headers: h, json: async () => (typeof body === "string" ? JSON.parse(body) : body) };
}

test("normalizeServerUrl adds https:// and strips the trailing slash / path", () => {
  assert.equal(auth.normalizeServerUrl("ayase.example:8443/"), "https://ayase.example:8443");
  assert.equal(auth.normalizeServerUrl(" https://x.example/chat/// "), "https://x.example");
  assert.throws(() => auth.normalizeServerUrl("http://x.example"), /https/);
  assert.throws(() => auth.normalizeServerUrl(""), /服务器地址/);
});

test("probe: gateway /auth/session reachable without login", async () => {
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), res(200, { authenticated: false }));
  const r = await auth.probe({ serverUrl: "x.example", fetchImpl });
  assert.deepEqual(r, { origin: "https://x.example", gateway: true, authenticated: false });
  assert.equal(calls[0], "https://x.example/auth/session");
});

test("probe: non-gateway server answers /health or a 401 on /api/version", async () => {
  const fetchImpl = async (url) => (url.endsWith("/auth/session") ? res(404, {}) : url.endsWith("/health") ? res(404, {}) : res(401, {}));
  const r = await auth.probe({ serverUrl: "https://x.example", fetchImpl });
  assert.equal(r.gateway, false);
});

test("probe: DNS failure → 地址无法连接, TLS failure → 证书错误", async () => {
  const dns = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  await assert.rejects(auth.probe({ serverUrl: "nope.example", fetchImpl: dns }), (e) => e.kind === "unreachable" && /地址无法连接/.test(e.message));
  const tls = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } });
  };
  await assert.rejects(auth.probe({ serverUrl: "old.example", fetchImpl: tls }), (e) => e.kind === "cert" && /证书错误/.test(e.message));
});

test("login posts exactly what the gateway's web form posts, with Origin and the remember flag", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return res(200, { ok: true, next: "/" }, { "set-cookie": "__Host-chisabot_session=abc; Path=/; Secure; HttpOnly; SameSite=Lax" });
  };
  const r = await auth.login({ serverUrl: "x.example", username: "me", password: "pw", remember: false, fetchImpl });
  assert.equal(seen.url, "https://x.example/auth/login");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Origin, "https://x.example");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.init.body), { username: "me", password: "pw", remember: false });
  assert.equal(r.cookies[0].name, "__Host-chisabot_session");
  assert.equal(r.cookies[0].maxAge, undefined, "没勾记住登录 = 会话 Cookie");
});

test("login: 401 → 账号或密码错误, 429 → 尝试次数过多", async () => {
  await assert.rejects(auth.login({ serverUrl: "x.example", username: "a", password: "b", fetchImpl: async () => res(401, {}) }), (e) => e.kind === "auth" && e.message === "账号或密码错误。");
  await assert.rejects(auth.login({ serverUrl: "x.example", username: "a", password: "b", fetchImpl: async () => res(429, {}) }), (e) => e.kind === "rate");
});

test("login page: CSP-clean, has the four fields", () => {
  const UI = path.join(__dirname, "..", "src", "ui");
  const html = fs.readFileSync(path.join(UI, "login.html"), "utf8");
  for (const id of ['id="server"', 'id="user"', 'id="pass"', 'id="remember"', 'id="toggle"', 'id="history"']) assert.ok(html.includes(id), id);
  assert.ok(!html.includes("../../assets"), "不能引用 PC 专有路径");
  // Android 0.1.13 起是原生登录页（Compose，DESIGN §80），不再拷这份网页登录页。
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "..", "android", "app", "src", "main", "assets", "login")), "Android 不再带网页登录页");
});

test("main process: no setup wizard left, login channels go through the local-page check", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(!main.includes("setup.html") && !main.includes("openSetup"));
  for (const ch of ["login:probe", "login:submit", "login:forget", "login:open"]) assert.ok(main.includes(`handleLocal("${ch}"`), ch);
  assert.ok(main.includes('"will-redirect"') && main.includes("sessionExpired"), "会话过期时换本机登录页");
  assert.ok(main.includes("切换服务器") && main.includes("退出登录"), "托盘菜单");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  assert.ok(!preload.includes("setup:"));
});

for (const username of ["first-user", "second-user"]) {
  test(`desktop login binds the node to the logged-in account: ${username}`, async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const submit = source.slice(source.indexOf("async function submitLogin(input) {"), source.indexOf("\nasync function setLocal("));
    let state = { serverUrl: "https://login.example.com", username: "first-user", deviceName: "old-device" };
    let token = "old-token";
    let drops = 0;
    let clears = 0;
    let enrolls = 0;
    const context = {
      auth: {
        normalizeServerUrl: auth.normalizeServerUrl,
        login: async () => ({ cookies: [], cookieHeader: "session=new" }),
        checkToken: async ({ token: checked }) => {
          assert.equal(checked, "old-token");
          return { ok: true, device: { id: "old-id" } };
        },
        enroll: async () => { enrolls++; return { token: "new-token", device: { id: "new-id", name: "new-device" } }; },
      },
      config: {
        get: () => state,
        getToken: () => token,
        set: (patch) => { state = { ...state, ...patch }; },
        setToken: (value) => { token = value; },
        appendAudit: () => {},
      },
      session: { fromPartition: () => ({ clearStorageData: async () => { clears++; } }) },
      PARTITION: "test",
      netFetch: () => {},
      dropDevice: async () => { drops++; token = null; },
      windows: { chat: null },
      injectCookies: async () => {},
      clientInfo: () => ({}),
      os: { hostname: () => "test-device" },
      clearTimeout,
      enrollRetryTimer: null,
      startAgent: () => {},
    };
    const submitLogin = vm.runInNewContext(`${submit}\nsubmitLogin`, context);
    const result = await submitLogin({ serverUrl: state.serverUrl, username, remember: true });
    const changed = username !== "first-user";
    assert.equal(drops, Number(changed));
    assert.equal(clears, Number(changed));
    assert.equal(enrolls, Number(changed));
    assert.equal(result.device.id, changed ? "new-id" : "old-id");
    assert.equal(token, changed ? "new-token" : "old-token");
  });
}
