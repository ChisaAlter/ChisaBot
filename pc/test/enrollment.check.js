"use strict";
/**
 * 已登录却没登记（2026-10-13 用户报告「安装了 Windows 端，但是 bot 还是识别不到我的电脑」）：
 * 会话有效、本机没有设备令牌时，客户端要自己用会话补登记，而不是永远不连。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ensureEnrolled } = require("../src/agent/enrollment");

function memoryConfig(initial = {}) {
  let data = { serverUrl: "https://chat.example.com", deviceName: "", ...initial };
  let token = initial.token ?? null;
  return {
    get: () => ({ ...data }),
    set: (patch) => (data = { ...data, ...patch }),
    getToken: () => token,
    setToken: (next) => (token = next || null),
  };
}

function deps(config, overrides = {}) {
  const calls = { enroll: [], checkToken: [] };
  return {
    calls,
    input: {
      config,
      sessionStatus: async () => "ok",
      cookieHeader: async () => "chisabot_session=abc",
      enroll: async (input) => {
        calls.enroll.push(input);
        return { token: "cbd_new", device: { id: "dev_new", name: "AYASE" } };
      },
      checkToken: async (input) => {
        calls.checkToken.push(input);
        return { ok: false, invalid: true };
      },
      info: { clientVersion: "0.1.1", platform: "win32", hostname: "AYASE", name: "AYASE" },
      ...overrides,
    },
  };
}

test("logged in (session cookie still valid) but no device token: enrolls with the session and saves the token", async () => {
  const config = memoryConfig();
  const { calls, input } = deps(config);
  const result = await ensureEnrolled(input);
  assert.equal(result.status, "enrolled");
  assert.equal(config.getToken(), "cbd_new");
  assert.equal(config.get().deviceId, "dev_new");
  assert.equal(calls.enroll.length, 1);
  assert.equal(calls.enroll[0].cookieHeader, "chisabot_session=abc");
  assert.equal(calls.enroll[0].serverUrl, "https://chat.example.com");
});

test("the automatic path never replaces an existing token (a revoked device stays revoked)", async () => {
  const config = memoryConfig({ token: "cbd_revoked" });
  const { calls, input } = deps(config);
  const result = await ensureEnrolled(input);
  assert.equal(result.status, "already");
  assert.equal(config.getToken(), "cbd_revoked");
  assert.equal(calls.enroll.length, 0);
  assert.equal(calls.checkToken.length, 0);
});

test("re-enrol on request: a token that still works is kept (no duplicate device)", async () => {
  const config = memoryConfig({ token: "cbd_ok" });
  const { calls, input } = deps(config, { checkToken: async () => ({ ok: true }) });
  const result = await ensureEnrolled({ ...input, force: true });
  assert.equal(result.status, "already");
  assert.equal(config.getToken(), "cbd_ok");
  assert.equal(calls.enroll.length, 0);
});

test("re-enrol on request: an invalid or revoked token is replaced", async () => {
  for (const verdict of [{ ok: false, invalid: true }, { ok: false, revoked: true }]) {
    const config = memoryConfig({ token: "cbd_old" });
    const { input } = deps(config, { checkToken: async () => verdict });
    const result = await ensureEnrolled({ ...input, force: true });
    assert.equal(result.status, "enrolled");
    assert.equal(config.getToken(), "cbd_new");
  }
});

test("re-enrol on request while the server is unreachable: keeps the token, reports offline", async () => {
  const config = memoryConfig({ token: "cbd_old" });
  const { calls, input } = deps(config, { checkToken: async () => ({ ok: false, status: 502 }) });
  const result = await ensureEnrolled({ ...input, force: true });
  assert.equal(result.status, "offline");
  assert.equal(config.getToken(), "cbd_old");
  assert.equal(calls.enroll.length, 0);
});

test("expired session or no network: nothing is enrolled, and the reason is plain", async () => {
  for (const [session, status] of [["login", "login"], ["offline", "offline"]]) {
    const config = memoryConfig();
    const { calls, input } = deps(config, { sessionStatus: async () => session });
    const result = await ensureEnrolled(input);
    assert.equal(result.status, status);
    assert.match(result.message, /登录|连不上/);
    assert.equal(calls.enroll.length, 0);
    assert.equal(config.getToken(), null);
  }
});

test("enrolment refused by the server: reported, token untouched", async () => {
  const config = memoryConfig();
  const { input } = deps(config, {
    enroll: async () => {
      throw new Error("这台服务器的 ChisaBot 版本还不支持 PC 设备，请先升级服务器。");
    },
  });
  const result = await ensureEnrolled(input);
  assert.equal(result.status, "failed");
  assert.match(result.message, /没能登记/);
  assert.equal(config.getToken(), null);
});

test("no server configured: nothing to do", async () => {
  const config = memoryConfig({ serverUrl: "" });
  const { input } = deps(config);
  assert.equal((await ensureEnrolled(input)).status, "no-server");
});

test("main.js repairs on startup when logged in without a token, and offers 重新登记 in the tray and to the web page", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  assert.match(main, /if \(config\.getToken\(\)\) startAgent\(\);\s*\/\/[^\n]*\n\s*else void repairDevice\(\);/);
  assert.ok(main.includes('label: "重新登记这台电脑"'));
  assert.ok(main.includes('handleWeb("pc:enroll"'));
  // 被撤销的设备从网页重新登记要先本机确认。
  assert.match(main, /handleWeb\("pc:enroll"[\s\S]{0,400}confirmLocal\(/);
  const preload = fs.readFileSync(path.join(__dirname, "../src/web-preload.js"), "utf8");
  assert.ok(preload.includes('ipcRenderer.invoke("pc:enroll")'));
  // 托盘不再在「已登录但没登记」时写「未登录」。
  assert.ok(main.includes("已登录，但这台电脑还没登记为设备"));
});
