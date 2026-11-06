"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNodeAgent } = require("../src/agent/core");
const { createOps } = require("../src/agent/ops");

function device(overrides = {}) {
  return {
    id: "dev_1",
    name: "测试机",
    paused: false,
    allowedRoots: [],
    capabilities: { shell: "allow", files_read: "off", files_write: "off", screenshot: "off", input: "off", open: "off", clipboard: "ask" },
    ...overrides,
  };
}

function setup(t, { approve, local, ops: customOps } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const received = [];
  let server;
  let lastHeaders;
  const connected = new Promise((resolve) => {
    wss.on("connection", (ws, req) => {
      server = ws;
      lastHeaders = req.headers;
      ws.on("message", (m) => received.push(JSON.parse(String(m))));
      ws.send(JSON.stringify({ type: "welcome", device: device() }));
      resolve(ws);
    });
  });
  const ops = customOps || { platform: "linux", run: async (op, args) => (op === "shell" ? { stdout: `ran ${args.command}` } : { op }) };
  const agent = createNodeAgent({ serverUrl: `http://127.0.0.1:${port}`, getToken: () => "cbd_test", ops, WebSocket, approve, local, clientInfo: { clientVersion: "t" } });
  t.after(() => {
    agent.stop();
    wss.close();
  });
  agent.start();
  const waitFor = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const hit = received.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timeout waiting for message");
  };
  return { agent, connected, received, waitFor, getServer: () => server, headers: () => lastHeaders };
}

test("hello, token header, call → result", async (t) => {
  const s = setup(t);
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  assert.equal(s.headers()["x-device-token"], "cbd_test");
  ws.send(JSON.stringify({ type: "call", id: "c1", operation: "shell", args: { command: "dir" }, botName: "主机器人" }));
  const result = await s.waitFor((m) => m.type === "result" && m.id === "c1");
  assert.equal(result.ok, true);
  assert.equal(result.result.stdout, "ran dir");
  assert.equal(s.agent.state, "online");
});

test("capability off and local kill switch refuse locally", async (t) => {
  let paused = false;
  const s = setup(t, { local: () => ({ paused, forceLocalApproval: false }) });
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "call", id: "c2", operation: "read_file", args: { path: "x" } }));
  const off = await s.waitFor((m) => m.id === "c2");
  assert.equal(off.ok, false);
  assert.match(off.error, /关闭/);
  paused = true;
  ws.send(JSON.stringify({ type: "call", id: "c3", operation: "shell", args: { command: "x" } }));
  const stopped = await s.waitFor((m) => m.id === "c3");
  assert.match(stopped.error, /紧急停止/);
});

test("approval request answered locally; ping/pong; set_config sent", async (t) => {
  const s = setup(t, { approve: async () => "approve" });
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "approval_request", id: "a1", operation: "clipboard_read", summary: "读取剪贴板", botName: "B" }));
  const decision = await s.waitFor((m) => m.type === "approval");
  assert.equal(decision.decision, "approve");
  ws.send(JSON.stringify({ type: "ping" }));
  await s.waitFor((m) => m.type === "pong");
  s.agent.setConfig({ paused: true });
  const cfg = await s.waitFor((m) => m.type === "set_config");
  assert.equal(cfg.paused, true);
  assert.equal(s.agent.device.paused, true);
});

test("force local approval on dangerous allow", async (t) => {
  const asked = [];
  const s = setup(t, { approve: async (req) => (asked.push(req), "deny"), local: () => ({ paused: false, forceLocalApproval: true }) });
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "call", id: "c4", operation: "shell", args: { command: "rm" } }));
  const r = await s.waitFor((m) => m.id === "c4");
  assert.equal(r.ok, false);
  assert.equal(asked.length, 1);
});

test("revoked stops reconnecting", async (t) => {
  const s = setup(t);
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  const revoked = new Promise((r) => s.agent.events.once("revoked", r));
  ws.send(JSON.stringify({ type: "revoked" }));
  ws.close(4401, "revoked");
  await revoked;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.agent.state, "revoked");
});

test("reconnects after drop", async (t) => {
  const s = setup(t);
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  const again = new Promise((r) => s.agent.events.on("state", (e) => e.state === "online" && r()));
  ws.terminate();
  await again;
});

for (const action of ["cancel", "stop", "remote-pause", "disconnect"]) {
  test(`pending local approval cannot run after ${action}`, async (t) => {
    let decide;
    let asked;
    const prompted = new Promise((resolve) => (asked = resolve));
    let executions = 0;
    const s = setup(t, {
      local: () => ({ paused: false, forceLocalApproval: true }),
      approve: () => new Promise((resolve) => { decide = resolve; asked(); }),
      ops: { run: async () => { executions++; return {}; } },
    });
    const closed = [];
    const audits = [];
    s.agent.events.on("approval_closed", (entry) => closed.push(entry.id));
    s.agent.events.on("audit", (entry) => audits.push(entry));
    const ws = await s.connected;
    await s.waitFor((m) => m.type === "hello");
    ws.send(JSON.stringify({ type: "call", id: "pending", operation: "shell", args: { command: "ignored" } }));
    await prompted;
    const cancelled = new Promise((resolve) => s.agent.events.once("approval_closed", resolve));
    if (action === "cancel") ws.send(JSON.stringify({ type: "cancel", id: "pending" }));
    if (action === "stop") s.agent.stop();
    if (action === "remote-pause") ws.send(JSON.stringify({ type: "config", device: device({ paused: true }) }));
    if (action === "disconnect") ws.terminate();
    await cancelled;
    decide("approve");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 0);
    assert.deepEqual(closed, ["local-pending"]);
    assert.ok(audits.some((entry) => entry.outcome === "failed" && /取消/.test(entry.detail)));
  });
}

test("capability disabled while local approval is open is checked before execution", async (t) => {
  let decide;
  let asked;
  const prompted = new Promise((resolve) => (asked = resolve));
  let executions = 0;
  const s = setup(t, {
    local: () => ({ paused: false, forceLocalApproval: true }),
    approve: () => new Promise((resolve) => { decide = resolve; asked(); }),
    ops: { run: async () => { executions++; return {}; } },
  });
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "call", id: "policy", operation: "shell", args: { command: "ignored" } }));
  await prompted;
  s.agent.setConfig({ capabilities: { shell: "off" } });
  decide("approve");
  const result = await s.waitFor((m) => m.type === "result" && m.id === "policy");
  assert.equal(executions, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /关闭/);
});

for (const action of ["stop", "remote-pause", "revoke-close"]) {
  test(`${action} terminates an active local shell process`, { timeout: 12_000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stop-"));
    const ready = path.join(dir, "ready");
    const late = path.join(dir, "late");
    const command = process.platform === "win32"
      ? `[IO.File]::WriteAllText('${ready.replace(/'/g, "''")}', 'ready'); Start-Sleep -Seconds 8; [IO.File]::WriteAllText('${late.replace(/'/g, "''")}', 'late')`
      : `printf ready > '${ready}'; sleep 8; printf late > '${late}'`;
    const ops = createOps();
    const s = setup(t, { ops });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const completed = new Promise((resolve) => s.agent.events.once("audit", resolve));
    const ws = await s.connected;
    await s.waitFor((m) => m.type === "hello");
    ws.send(JSON.stringify({ type: "call", id: "live", operation: "shell", args: { command, timeoutSec: 10 } }));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(ready), true, "shell reached its running marker");
    const stoppedAt = Date.now();
    if (action === "stop") s.agent.stop();
    if (action === "remote-pause") ws.send(JSON.stringify({ type: "config", device: device({ paused: true }) }));
    if (action === "revoke-close") ws.close(4401, "revoked");
    const audit = await completed;
    assert.ok(Date.now() - stoppedAt < 4000, "shell was cancelled before its normal completion");
    assert.equal(audit.outcome, "failed");
    assert.equal(fs.existsSync(late), false);
  });
}

test("stop terminates already-started background jobs", { timeout: 12_000 }, async (t) => {
  const ops = createOps();
  const s = setup(t, { ops });
  const ws = await s.connected;
  await s.waitFor((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "call", id: "bg", operation: "exec_start", args: { command: process.platform === "win32" ? "Start-Sleep -Seconds 8" : "sleep 8", waitMs: 100 } }));
  const result = await s.waitFor((m) => m.type === "result" && m.id === "bg");
  assert.equal(result.ok, true);
  assert.equal(result.result.status, "running");
  s.agent.stop();
  let job;
  const deadline = Date.now() + 4000;
  do {
    job = await ops.run("exec_poll", { jobId: result.result.jobId });
    if (job.endedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(job.status, "killed");
  assert.ok(job.endedAt, "background process actually exited");
});
