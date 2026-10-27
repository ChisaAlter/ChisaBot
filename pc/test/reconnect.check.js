"use strict";
/**
 * 节点重连（2026-10-13「我在用桌面端，但是显示离线」）：服务器重启后重连、长时间静默判死重连、
 * reconnectNow 跳过退避、经 HTTP CONNECT / SOCKS5 代理连接、离线原因写进状态。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const { createNodeAgent } = require("../src/agent/core");
const { parseProxyList, createProxyAgent } = require("../src/agent/proxy");

const device = { id: "dev_r", name: "重连测试", paused: false, allowedRoots: [], capabilities: {} };
const ops = { platform: "linux", run: async () => ({}) };

function server(port = 0) {
  const wss = new WebSocketServer({ port });
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.send(JSON.stringify({ type: "welcome", device }));
  });
  return { wss, port: () => wss.address().port, connections: () => connections };
}

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

test("parseProxyList understands Chromium's resolveProxy answers", () => {
  assert.deepEqual(parseProxyList("DIRECT"), [{ type: "direct" }]);
  assert.deepEqual(parseProxyList("PROXY 127.0.0.1:7890; DIRECT"), [{ type: "http", host: "127.0.0.1", port: 7890 }, { type: "direct" }]);
  assert.deepEqual(parseProxyList("SOCKS5 127.0.0.1:7891"), [{ type: "socks5", host: "127.0.0.1", port: 7891 }]);
  assert.deepEqual(parseProxyList("HTTPS proxy.example:443"), [{ type: "https", host: "proxy.example", port: 443 }]);
  assert.deepEqual(parseProxyList(""), [{ type: "direct" }]);
  assert.equal(createProxyAgent([{ type: "direct" }]), undefined);
});

test("reconnects after the server restarts on the same port", async (t) => {
  const first = server();
  const port = first.port();
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${port}`, getToken: () => "cbd_r", ops, WebSocket, unrefTimers: false });
  t.after(() => agent.stop());
  agent.start();
  await until(() => agent.state === "online");
  // 模拟容器重启：断开所有连接、关掉端口，过一会儿在同一端口重新监听。
  for (const c of first.wss.clients) c.terminate();
  await new Promise((r) => first.wss.close(r));
  await until(() => agent.state === "offline");
  const second = server(port);
  t.after(() => second.wss.close());
  agent.reconnectNow();
  await until(() => agent.state === "online", 8000);
  assert.equal(second.connections(), 1);
});

test("a silent connection is declared dead and replaced", async (t) => {
  const s = server();
  t.after(() => s.wss.close());
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${s.port()}`, getToken: () => "cbd_r", ops, WebSocket, silenceMs: 300 });
  t.after(() => agent.stop());
  const states = [];
  agent.events.on("state", (e) => states.push(e));
  agent.start();
  await until(() => s.connections() >= 2, 6000);
  assert.ok(states.some((e) => e.state === "offline" && /没有收到服务器消息/.test(e.detail || "")));
});

test("offline detail carries the real reason", async (t) => {
  const blocker = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end("blocked");
  });
  await new Promise((r) => blocker.listen(0, r));
  t.after(() => blocker.close());
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${blocker.address().port}`, getToken: () => "cbd_r", ops, WebSocket });
  t.after(() => agent.stop());
  agent.events.on("error", () => {}); // main.js 也挂了；没有监听时 EventEmitter 会把 error 抛出
  const states = [];
  agent.events.on("state", (e) => states.push(e));
  agent.start();
  await until(() => states.some((e) => e.state === "offline"));
  await until(() => agent.lastError !== "");
  assert.match(agent.lastError, /403/);
});

function connectProxy() {
  const proxy = http.createServer();
  let tunnels = 0;
  proxy.on("connect", (req, client, head) => {
    tunnels++;
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  return { proxy, tunnels: () => tunnels };
}

function socks5Proxy() {
  let tunnels = 0;
  const proxy = net.createServer((client) => {
    client.once("data", () => {
      client.write(Buffer.from([0x05, 0x00]));
      client.once("data", (req) => {
        const len = req[4];
        const host = req.subarray(5, 5 + len).toString();
        const port = req.readUInt16BE(5 + len);
        const upstream = net.connect(port, host, () => {
          tunnels++;
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
      });
    });
  });
  return { proxy, tunnels: () => tunnels };
}

for (const [name, make, type] of [["HTTP CONNECT", connectProxy, "PROXY"], ["SOCKS5", socks5Proxy, "SOCKS5"]]) {
  test(`connects through a ${name} proxy (system proxy honoured)`, async (t) => {
    const s = server();
    t.after(() => s.wss.close());
    const p = make();
    await new Promise((r) => p.proxy.listen(0, "127.0.0.1", r));
    t.after(() => p.proxy.close());
    const list = parseProxyList(`${type} 127.0.0.1:${p.proxy.address().port}; DIRECT`);
    const agent = createNodeAgent({
      // 用 localhost 主机名：隧道里由代理解析域名。
      serverUrl: `http://localhost:${s.port()}`,
      getToken: () => "cbd_r",
      ops,
      WebSocket,
      getAgent: async () => createProxyAgent(list, { secure: false }),
    });
    t.after(() => agent.stop());
    agent.start();
    await until(() => agent.state === "online");
    assert.equal(p.tunnels(), 1);
  });
}

test("falls back to DIRECT when the proxy is down", async (t) => {
  const s = server();
  t.after(() => s.wss.close());
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const list = parseProxyList(`PROXY 127.0.0.1:${deadPort}; DIRECT`);
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${s.port()}`, getToken: () => "cbd_r", ops, WebSocket, getAgent: async () => createProxyAgent(list, { secure: false }) });
  t.after(() => agent.stop());
  agent.start();
  await until(() => agent.state === "online");
});

test("stop() during the handshake does not raise an async error (no error listener)", async (t) => {
  const s = server();
  t.after(() => s.wss.close());
  await new Promise((r) => (s.wss.address() ? r() : s.wss.once("listening", r)));
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${s.port()}`, getToken: () => "cbd_r", ops, WebSocket, unrefTimers: false });
  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));
  agent.start();
  await new Promise((r) => setImmediate(r));
  agent.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.equal(agent.state, "stopped");
});
