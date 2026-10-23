"use strict";
// 电脑文件夹导入失败后残留、移除后无法重新导入（DESIGN.md §87）：PC 端同步管理。
//  - 新建失败 → 撤销：终止 Mutagen 会话、去掉本机记录、服务器 abandon，报中文原因；
//  - 文件夹的旧记录指向已删掉的工作区（残留）：检查结果 boundStale，新建时放下旧记录再导入；工作区还在：拦住；
//  - 启动对账 / 服务器 sync_forget / 上报 404：服务器确认工作区没了才放下本机记录（连不上服务器什么都不动）；
//  - forget 只在服务器确认删掉时放。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSyncManager } = require("../src/sync/manager");
const { sessionName } = require("../src/sync/mutagen");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-forget-"));
}

function fakeMutagen() {
  const sessions = new Map();
  const calls = [];
  let failCreate = null;
  let failFlush = null;
  return {
    calls,
    sessions,
    failNextCreate(msg) {
      failCreate = msg;
    },
    failNextFlush(msg) {
      failFlush = msg;
    },
    startDaemon: async () => true,
    stopDaemon: async () => true,
    list: async () => [...sessions.values()],
    get: async (ws) => sessions.get(sessionName(ws)) || null,
    create: async ({ workspaceId }) => {
      calls.push(["create", workspaceId]);
      if (failCreate) {
        const m = failCreate;
        failCreate = null;
        // 先建了会话再连不上（和真的 Mutagen 一样会留一个会话）
        sessions.set(sessionName(workspaceId), { name: sessionName(workspaceId), status: "disconnected" });
        throw new Error(`建立同步失败：${m}`);
      }
      sessions.set(sessionName(workspaceId), { name: sessionName(workspaceId), status: "watching", conflicts: [], alpha: { totalFileSize: 1 }, beta: { totalFileSize: 1 } });
      return true;
    },
    pause: async (ws) => calls.push(["pause", ws]),
    resume: async (ws) => calls.push(["resume", ws]),
    flush: async (ws) => {
      calls.push(["flush", ws]);
      if (failFlush) {
        const m = failFlush;
        failFlush = null;
        throw new Error(m);
      }
    },
    terminate: async (ws) => {
      calls.push(["terminate", ws]);
      sessions.delete(sessionName(ws));
    },
    reset: async () => true,
    running: () => true,
  };
}

/** 假服务器：/api/devices/agent/sync/*。workspaces = 服务器上还在的工作区。 */
function fakeServer() {
  const workspaces = new Set();
  const calls = [];
  let n = 0;
  let down = false;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    const p = new URL(url).pathname.replace("/api/devices/agent/sync", "");
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push([p, body]);
    if (down) throw new Error("connect ECONNREFUSED");
    if (p === "/workspaces") {
      const id = `ws_t${++n}`;
      workspaces.add(id);
      return reply(200, { workspace: { id, name: body.name, source: "local", syncState: "paused" } });
    }
    if (p === "/reconcile") return reply(200, { gone: body.workspaceIds.filter((id) => !workspaces.has(id)) });
    if (p === "/abandon") {
      const had = workspaces.delete(body.workspaceId);
      return reply(200, { abandoned: had, gone: true });
    }
    if (!workspaces.has(body.workspaceId)) return reply(404, { error: "没有这个工作区。" });
    if (p === "/bind") return reply(200, { bindingId: "sb_1", epoch: 1, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrW7vYqk4H7qC6lq0q1nW8mXo8bJqk0q0Vd1u0bU9xY", workPath: `/w/${body.workspaceId}/work`, isGit: false });
    if (p === "/state") return reply(200, { state: body.state });
    if (p === "/release") return reply(200, { state: "paused" });
    return reply(200, {});
  };
  return {
    workspaces,
    calls,
    fetchImpl,
    setDown(v) {
      down = v;
    },
  };
}

function setup() {
  const dir = tmp();
  const folder = path.join(dir, "Seelen-UI");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "README.md"), "# x\n");
  const mut = fakeMutagen();
  const srv = fakeServer();
  const audits = [];
  const m = createSyncManager({
    dataDir: path.join(dir, "data"),
    serverUrl: () => "https://chisabot.test",
    getToken: () => "dev_token",
    fetchImpl: srv.fetchImpl,
    mutagenPath: process.execPath,
    sshPath: process.execPath,
    mutagenImpl: mut,
    gitPath: "/nonexistent/git",
    nodeExe: process.execPath,
    tunnelScript: "/x/tunnel.js",
    platform: "linux",
    audit: (e) => audits.push(e),
  });
  return { dir, folder, mut, srv, m, audits };
}

test("create fails (sidecar unreachable) → rolled back everywhere, Chinese reason, retry works", async () => {
  const { folder, mut, srv, m, audits } = setup();
  assert.equal(await m.start(), true);
  mut.failNextCreate("ssh: connect to host sync.chisabot.invalid: Connection closed by UNKNOWN port 65535 (ECONNREFUSED)");
  await assert.rejects(m.createFromFolder({ dir: folder, name: "Seelen-UI" }), (e) => {
    assert.match(e.message, /新建没有成功，已经撤销（云端没有留下工作区，电脑上的文件没动）：连不上云端的同步组件/);
    assert.equal(e.rolledBack, true);
    return true;
  });
  assert.deepEqual(Object.keys(m._internal.state().bindings), [], "no local binding left");
  assert.equal(mut.sessions.size, 0, "mutagen session terminated");
  assert.ok(srv.calls.some(([p, b]) => p === "/abandon" && b.workspaceId === "ws_t1"));
  assert.equal(srv.workspaces.size, 0, "server workspace abandoned");
  assert.ok(audits.some((a) => a.operation === "sync_create" && a.outcome === "failed"));
  assert.equal((await m.inspect(folder)).bound, null, "folder free again");
  assert.ok(fs.existsSync(path.join(folder, "README.md")), "pc files untouched");
  // 重试
  const r = await m.createFromFolder({ dir: folder, name: "Seelen-UI" });
  assert.equal(r.state, "pc_active");
  assert.equal(r.workspace.id, "ws_t2");
  await m.stop();
});

test("folder bound to a deleted workspace = stale: inspect says so, create forgets it and imports; live binding still blocks", async () => {
  const { folder, mut, srv, m } = setup();
  assert.equal(await m.start(), true);
  const a = await m.createFromFolder({ dir: folder, name: "A" });
  // 仍在：拦住
  const live = await m.inspect(folder);
  assert.equal(live.bound, a.workspace.id);
  assert.equal(live.boundStale, false);
  await assert.rejects(m.createFromFolder({ dir: folder, name: "B" }), /已经在同步工作区「A」了/);
  // 服务器连不上：不下结论（当作还在同步）
  srv.setDown(true);
  assert.equal((await m.inspect(folder)).boundStale, false);
  srv.setDown(false);
  // 网页上删了（旧版本：电脑没收到通知）→ 残留
  await m.release(a.workspace.id);
  srv.workspaces.delete(a.workspace.id);
  const stale = await m.inspect(folder);
  assert.equal(stale.bound, a.workspace.id);
  assert.equal(stale.boundStale, true);
  assert.deepEqual(stale.staleIds, [a.workspace.id]);
  const b = await m.createFromFolder({ dir: folder, name: "B" });
  assert.equal(b.state, "pc_active");
  assert.deepEqual(Object.keys(m._internal.state().bindings), [b.workspace.id], "old record dropped, new one kept");
  assert.ok(mut.calls.some(([op, ws]) => op === "terminate" && ws === a.workspace.id), "old mutagen session terminated");
  await m.stop();
});

test("forget: only when the server confirms the workspace is gone; sync_forget + startup reconcile drop gone records", async () => {
  const { dir, folder, srv, m } = setup();
  assert.equal(await m.start(), true);
  const a = await m.createFromFolder({ dir: folder, name: "A" });
  await assert.rejects(m.forget(a.workspace.id), /还在云端/);
  srv.setDown(true);
  await assert.rejects(m.forget(a.workspace.id), /连不上服务器/);
  srv.setDown(false);
  // 服务器删工作区后发 sync_forget：对账确认后放下
  srv.workspaces.delete(a.workspace.id);
  assert.equal(m.onServerMessage({ type: "sync_forget", workspaceId: a.workspace.id }), true);
  for (let i = 0; i < 50 && m._internal.binding(a.workspace.id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(m._internal.binding(a.workspace.id), null);
  assert.equal(m.onServerMessage({ type: "sync_forget", workspaceId: "../x" }), false);
  await m.stop();

  // 启动对账：sync.json 里记着一个已删掉的工作区（0.1.13 留下的状态）
  const dataDir = path.join(dir, "data");
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, "sync.json"), "utf8"));
  st.bindings.ws_gone = { workspaceId: "ws_gone", name: "Seelen-UI", path: folder, enabled: false, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrW7vYqk4H7qC6lq0q1nW8mXo8bJqk0q0Vd1u0bU9xY", workPath: "/w" };
  fs.writeFileSync(path.join(dataDir, "sync.json"), JSON.stringify(st));
  const mut2 = fakeMutagen();
  const m2 = createSyncManager({
    dataDir,
    serverUrl: () => "https://chisabot.test",
    getToken: () => "dev_token",
    fetchImpl: srv.fetchImpl,
    mutagenPath: process.execPath,
    sshPath: process.execPath,
    mutagenImpl: mut2,
    gitPath: "/nonexistent/git",
    nodeExe: process.execPath,
    tunnelScript: "/x/tunnel.js",
    platform: "linux",
  });
  assert.equal(await m2.start(), true);
  assert.equal(m2._internal.binding("ws_gone"), null, "startup reconcile dropped it");
  assert.ok(mut2.calls.some(([op, ws]) => op === "terminate" && ws === "ws_gone"));
  assert.ok(!fs.readFileSync(path.join(dataDir, "ssh", "config"), "utf8").includes("cb-ws_gone"), "ssh config rewritten");
  assert.equal((await m2.inspect(folder)).bound, null);
  await m2.stop();
});

test("explain(): ssh / mutagen noise → one Chinese line; server's own Chinese message kept", () => {
  const { m } = setup();
  const { explain } = m._internal;
  assert.match(explain(new Error("建立同步失败：kex_exchange_identification: Connection closed by remote host")), /^连不上云端的同步组件（/);
  assert.equal(explain(new Error("云端的同步组件没有就绪（连不上同步边车：ECONNREFUSED），这次什么都没有建。")), "云端的同步组件没有就绪（连不上同步边车：ECONNREFUSED），这次什么都没有建。");
  assert.equal(explain(new Error("云端工作区不在线。")), "云端工作区不在线。");
});

test("createFromFolder: initial flush failure keeps workspace in syncing state (no rollback) and sync_flush flushes on demand", async () => {
  const { folder, mut, srv, m } = setup();
  assert.equal(await m.start(), true);
  mut.failNextFlush("flush timed out");
  const r = await m.createFromFolder({ dir: folder, name: "Seelen-UI" });
  assert.equal(r.state, "syncing");
  assert.equal(r.deferred, true);
  const wsId = r.workspace.id;
  assert.equal(srv.workspaces.size, 1, "workspace kept on server");
  assert.equal(srv.calls.some(([p]) => p === "/abandon"), false, "did not abandon workspace");
  assert.ok(m._internal.binding(wsId), "local binding kept");

  // Server sends sync_flush before starting a turn
  srv.calls.length = 0;
  m.onServerMessage({ type: "sync_flush", workspaceId: wsId, flushId: "fl_123" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(mut.calls.some(([op, ws]) => op === "flush" && ws === wsId));
  assert.ok(srv.calls.some(([p, b]) => p === "/flush" && b.workspaceId === wsId && b.flushId === "fl_123" && b.ok === true));
  assert.equal(m._internal.binding(wsId).lastState, "pc_active", "onFlush transitions deferred syncing to pc_active");

  // Release and re-enable with deferred flush
  await m.release(wsId);
  mut.failNextFlush("enable flush timed out");
  const en = await m.enable({ workspaceId: wsId });
  assert.equal(en.state, "syncing");
  assert.equal(en.deferred, true);
  await m.stop();
});

