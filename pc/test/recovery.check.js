"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const auth = require("../src/agent/auth");
const { createAgentFetch } = require("../src/agent/proxy");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function desktop(fetchImpl) {
  class Window extends EventEmitter {
    constructor() {
      super();
      this.urls = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
    }
    loadURL(url) { this.urls.push(url); return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed === true; }
    setMenu() {}
    show() {}
    focus() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const windows = { chat: null };
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const start = source.indexOf("let chatOffline = false;");
  const end = source.indexOf("\n// ---------- 托盘", start);
  assert.ok(start > 0 && end > start);
  const context = {
    windows, BrowserWindow: Window, config: { get: () => ({ serverUrl: "https://chat.example" }) },
    path, __dirname, PARTITION: "owned-test", UI: "/ui", UI_URL: "file:///ui/",
    WINDOW_ICON: "icon", windowBackground: () => "#fff", net: { fetch: fetchImpl },
    agent: { reconnectNow() {} }, shell: { openExternal() {} },
    loginUrl: () => false, openLogin() {}, sessionExpired() {},
    compactWindows: () => ({ watch() {}, toggle() {} }), placeUpdateWindow() {},
    setInterval: () => 1, clearInterval() {}, URL, AbortController, AbortSignal,
    setImmediate, quitting: false,
  };
  return vm.runInNewContext(`${source.slice(start, end)}\n({openChat,showOffline,retryChat,windows})`, context);
}

test("desktop recovery returns to the last full navigation including query and anchor", async () => {
  const app = desktop(async () => ({ status: 200 }));
  const win = app.openChat("/channel/first");
  win.webContents.emit("did-navigate", {}, "https://chat.example/channel/second?view=files#last");
  app.showOffline(win, "connection lost");
  assert.equal(await app.retryChat(), true);
  assert.equal(win.urls.at(-1), "https://chat.example/channel/second?view=files#last");
});

test("manual and scheduled recovery share a request and navigate only once", async () => {
  const response = deferred();
  let probes = 0;
  const app = desktop(() => { probes++; return response.promise; });
  const win = app.openChat();
  app.showOffline(win, "offline");
  const first = app.retryChat();
  assert.equal(app.retryChat(), first);
  response.resolve({ status: 200 });
  assert.equal(await first, true);
  assert.equal(probes, 1);
  assert.equal(win.urls.length, 2);
});

test("closing the old window cancels its probe and late success cannot navigate a new window", async () => {
  const response = deferred();
  let signal;
  const app = desktop((_url, init) => { signal = init.signal; return response.promise; });
  const old = app.openChat("/channel/old");
  app.showOffline(old, "offline");
  const pending = app.retryChat();
  old.destroy();
  assert.equal(signal.aborted, true);
  const current = app.openChat("/channel/new");
  response.resolve({ status: 200 });
  assert.equal(await pending, false);
  assert.equal(old.urls.length, 1);
  assert.deepEqual(current.urls, ["https://chat.example/channel/new"]);
});

test("a newer offline attempt supersedes the old probe without restoring its page", async () => {
  const old = deferred();
  const current = deferred();
  const signals = [];
  const app = desktop((_url, init) => { signals.push(init.signal); return signals.length === 1 ? old.promise : current.promise; });
  const win = app.openChat();
  app.showOffline(win, "first");
  const first = app.retryChat();
  app.showOffline(win, "second");
  const second = app.retryChat();
  assert.equal(signals[0].aborted, true);
  old.resolve({ status: 200 });
  assert.equal(await first, false);
  assert.equal(win.urls.length, 1);
  current.resolve({ status: 200 });
  assert.equal(await second, true);
  assert.equal(win.urls.length, 2);
});

test("a failed probe keeps recovery available and a load failure reaches the retry caller", async () => {
  let online = false;
  const app = desktop(async () => ({ status: online ? 200 : 503 }));
  const win = app.openChat();
  app.showOffline(win, "offline");
  await assert.rejects(app.retryChat(), /仍然连不上/);
  online = true;
  win.loadURL = () => Promise.reject(new Error("navigation failed"));
  await assert.rejects(app.retryChat(), /navigation failed/);
});

async function stalledServer(t, fallback) {
  const server = http.createServer((request, response) => {
    request.resume();
    if (fallback && request.url === "/auth/login") { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const kind of ["login", "fallback", "logoutSession", "enroll", "checkToken", "unenroll"]) {
  test(`actual ${kind} HTTP request ends when the server accepts but never responds`, async (t) => {
    const serverUrl = await stalledServer(t, kind === "fallback");
    const operation = kind === "fallback" ? auth.login : auth[kind];
    const start = Date.now();
    await assert.rejects(operation({ serverUrl, username: "test", password: "test", token: "test", info: {}, timeoutMs: 100 }),
      (error) => kind === "login" || kind === "fallback" ? error.kind === "unreachable" : error.name === "TimeoutError");
    assert.ok(Date.now() - start < 2000, "request should release the user operation rather than hang");
  });
}

test("the proxied Node request path also respects authentication deadlines", async (t) => {
  const serverUrl = await stalledServer(t, false);
  const agent = new http.Agent();
  t.after(() => agent.destroy());
  const fetchImpl = createAgentFetch(async () => agent);
  await assert.rejects(auth.login({ serverUrl, username: "test", password: "test", timeoutMs: 100, fetchImpl }),
    (error) => error.kind === "unreachable");
});
