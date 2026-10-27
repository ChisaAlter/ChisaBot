"use strict";
/**
 * CB-113：握手被 HTTP 拒绝后的重连。ws 遇到 unexpected-response（且有监听）时既不报 error 也不触发 close，
 * 以前 core.js 只在 close 里排重连，于是发版时网关回一次 503，这台电脑就永久离线。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const { createNodeAgent } = require("../src/agent/core");

const device = { id: "dev_h", name: "HTTP 错误测试", paused: false, allowedRoots: [], capabilities: {} };
const ops = { platform: "linux", run: async () => ({}) };

/** 前 failures 次升级请求按 reject(n) 回 HTTP，之后正常升级并发 welcome。 */
function gateway(reject, failures) {
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  let accepted = 0;
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    upgrades++;
    if (upgrades <= failures) {
      const { status, body } = reject(upgrades);
      const text = body === undefined ? "" : JSON.stringify(body);
      socket.end(`HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted++;
      ws.send(JSON.stringify({ type: "welcome", device }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        upgrades: () => upgrades,
        accepted: () => accepted,
        close: () =>
          new Promise((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}

function agentFor(port, extra = {}) {
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${port}`, getToken: () => "cbd_h", ops, WebSocket, backoffBaseMs: 20, ...extra });
  const states = [];
  const revoked = [];
  agent.events.on("state", (e) => states.push(e));
  agent.events.on("revoked", () => revoked.push(1));
  agent.events.on("error", () => {}); // 网络错误会经 error 事件上报；测试里不让它变成未处理异常
  return { agent, states, revoked };
}

for (const status of [503, 502, 500]) {
  test(`${status} three times, then the gateway recovers: reconnects on its own`, async (t) => {
    const g = await gateway(() => ({ status, body: { error: "down" } }), 3);
    t.after(() => g.close());
    const { agent, states, revoked } = agentFor(g.port);
    t.after(() => agent.stop());
    agent.start();
    await until(() => agent.state === "online");
    assert.equal(g.upgrades(), 4);
    assert.equal(g.accepted(), 1);
    assert.equal(revoked.length, 0);
    assert.ok(states.some((e) => e.state === "offline" && e.detail === `服务器返回 ${status}`));
  });
}

test("network error (nothing listening), then the server comes up: reconnects", async (t) => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const { agent, states } = agentFor(port);
  t.after(() => agent.stop());
  agent.start();
  await until(() => states.filter((e) => e.state === "offline").length >= 2);
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "welcome", device })));
  t.after(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }));
  await until(() => agent.state === "online");
});

test("401 without revoked:true: stays 'revoked', no revoked event, retries after the long interval", async (t) => {
  const g = await gateway(() => ({ status: 401, body: { error: "设备令牌无效，请重新登录。" } }), 1);
  t.after(() => g.close());
  const reconnects = [];
  const { agent, states, revoked } = agentFor(g.port, { invalidTokenRetryMs: 300 });
  agent.events.on("reconnect", (e) => reconnects.push(e));
  t.after(() => agent.stop());
  agent.start();
  await until(() => agent.state === "revoked");
  assert.equal(agent.lastError, "设备令牌无效");
  assert.ok(states.some((e) => e.state === "revoked" && e.detail === "设备令牌无效"));
  assert.deepEqual(reconnects.map((e) => [e.delay, e.invalidToken]), [[300, true]]);
  // 等待期间不该再连（不是普通退避）
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(g.upgrades(), 1);
  await until(() => agent.state === "online", 3000);
  assert.equal(g.upgrades(), 2);
  assert.equal(revoked.length, 0);
});

test("401 without revoked:true uses a 60s default interval", async (t) => {
  const g = await gateway(() => ({ status: 401 }), 1);
  t.after(() => g.close());
  const reconnects = [];
  const { agent } = agentFor(g.port, { invalidTokenRetryMs: undefined });
  agent.events.on("reconnect", (e) => reconnects.push(e));
  t.after(() => agent.stop());
  agent.start();
  await until(() => reconnects.length === 1);
  assert.equal(reconnects[0].delay, 60_000);
  assert.equal(agent.state, "revoked");
});

test("401 with revoked:true (explicitly revoked): stops for good", async (t) => {
  const g = await gateway(() => ({ status: 401, body: { error: "这台设备已被撤销，请重新登录。", revoked: true } }), 99);
  t.after(() => g.close());
  const reconnects = [];
  const { agent, states, revoked } = agentFor(g.port, { invalidTokenRetryMs: 50 });
  agent.events.on("reconnect", (e) => reconnects.push(e));
  t.after(() => agent.stop());
  agent.start();
  await until(() => revoked.length === 1);
  assert.equal(agent.state, "revoked");
  assert.ok(states.some((e) => e.state === "revoked" && e.detail === "设备已被撤销"));
  assert.equal(agent.reconnectNow(), false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(g.upgrades(), 1);
  assert.equal(reconnects.length, 0);
});

test("stop() during the backoff after a 503 cancels the retry", async (t) => {
  const g = await gateway(() => ({ status: 503 }), 99);
  t.after(() => g.close());
  const { agent } = agentFor(g.port, { backoffBaseMs: 200 });
  agent.start();
  await until(() => agent.state === "offline");
  agent.stop();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(g.upgrades(), 1);
  assert.equal(agent.state, "stopped");
});

// CB-P3：令牌无效时的后台重试是静默的——不切「connecting」（托盘不闪「正在连接…」），失败保持原提示，成功照常上线。
test("invalid-token background retry: no 'connecting' state, hint kept after a failed retry, online after success", async (t) => {
  const g = await gateway(() => ({ status: 401, body: { error: "设备令牌无效，请重新登录。" } }), 3);
  t.after(() => g.close());
  const { agent, states, revoked } = agentFor(g.port, { invalidTokenRetryMs: 80 });
  t.after(() => agent.stop());
  agent.start();
  await until(() => agent.state === "revoked");
  const firstRevoked = states.length;
  assert.deepEqual(states.map((e) => e.state), ["connecting", "revoked"]);
  // 两次静默重试都失败：状态、提示都不变，也不再发 state 事件
  await until(() => g.upgrades() === 3);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(states.length, firstRevoked);
  assert.equal(agent.state, "revoked");
  assert.equal(agent.lastError, "设备令牌无效");
  // 第 3 次重试成功：直接上线，中间没有 connecting
  await until(() => agent.state === "online", 3000);
  assert.deepEqual(states.map((e) => e.state), ["connecting", "revoked", "online"]);
  assert.equal(revoked.length, 0);
});

test("invalid-token hint states the retry interval derived from invalidTokenRetryMs", () => {
  const { invalidTokenHint, INVALID_TOKEN_DETAIL } = require("../src/agent/core");
  assert.equal(INVALID_TOKEN_DETAIL, "设备令牌无效");
  assert.equal(invalidTokenHint(60_000), "设备令牌无效，请重新登记这台电脑（每 60 秒自动重试）");
  assert.equal(invalidTokenHint(), "设备令牌无效，请重新登记这台电脑（每 60 秒自动重试）");
  assert.equal(invalidTokenHint(90_000), "设备令牌无效，请重新登记这台电脑（每 90 秒自动重试）");
  const agent = createNodeAgent({ serverUrl: "http://127.0.0.1:1", getToken: () => "", ops, WebSocket });
  assert.equal(agent.invalidTokenRetryMs, 60_000);
  assert.equal(createNodeAgent({ serverUrl: "http://127.0.0.1:1", getToken: () => "", ops, WebSocket, invalidTokenRetryMs: 5000 }).invalidTokenRetryMs, 5000);
});
