"use strict";
/**
 * PC Electron 壳冷启动、Windows 常驻 STA Helper、UIA 有界遍历、
 * config.js 解密缓存与异步审计一致性、detectSandboxes 并行探活回归测试。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  RESPONSE_PREFIX,
  HelperTransportError,
  buildResidentHelperScript,
  createWinPsHelper,
} = require("../src/agent/win-ps-helper");
const { createOps, buildWinInputPayload, OpError } = require("../src/agent/ops");
const {
  ACCESSIBILITY_SCOPE,
  buildWinReadTreeScript,
  buildWinActionScript,
  createAccessibilityBridge,
} = require("../src/accessibility-bridge");
const { createConfig } = require("../src/config");
const {
  detectSandboxes,
  which,
  clearWhichCache,
} = require("../src/agent-runtime/detect");

function createFakeChild(onRequest, { pid = 999001 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (child.exitCode === null) {
      child.killed = true;
      child.exitCode = 1;
      queueMicrotask(() => child.emit("close", 1, "SIGKILL"));
    }
    return true;
  };
  let buf = "";
  child.stdin.on("data", (chunk) => {
    buf += String(chunk);
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.cmd === "quit") {
          child.stdout.write(
            `${RESPONSE_PREFIX}${JSON.stringify({ id: msg.id, ok: true, data: { bye: true } })}\n`,
          );
          child.exitCode = 0;
          queueMicrotask(() => child.emit("close", 0, null));
        } else {
          onRequest(msg, child);
        }
      }
      idx = buf.indexOf("\n");
    }
  });
  queueMicrotask(() => {
    child.stdout.write(
      `${RESPONSE_PREFIX}${JSON.stringify({ ready: true, pid, apartment: "STA" })}\n`,
    );
  });
  return child;
}

test("win-ps-helper: script uses strict JSON whitelist without Invoke-Expression and runs with -STA", () => {
  const script = buildResidentHelperScript();
  assert.doesNotMatch(script, /\bInvoke-Expression\b/i);
  assert.doesNotMatch(script, /\biex\b/i);
  assert.match(script, /TreeWalker\]::ControlViewWalker/);
  assert.match(script, /FindFirst\(/);
  assert.doesNotMatch(script, /FindAll\([^)]*Descendants/);
});

test("win-ps-helper: lazy spawn, reuse, whitelist reject, auto-restart retry on pipe break, idle recycle, dispose", async () => {
  const spawnCalls = [];
  let attempt = 0;
  const helper = createWinPsHelper({
    idleTimeoutMs: 90,
    defaultTimeoutMs: 2000,
    spawn: (file, args) => {
      spawnCalls.push({ file, args });
      const instanceNo = ++attempt;
      return createFakeChild(
        (msg, proc) => {
          if (msg.cmd === "ping" && msg.payload?.crashOnce && instanceNo === 1) {
            proc.exitCode = 1;
            proc.emit("close", 1, null);
            return;
          }
          proc.stdout.write(
            `${RESPONSE_PREFIX}${JSON.stringify({
              id: msg.id,
              ok: true,
              data: { instanceNo, cmd: msg.cmd, payload: msg.payload },
            })}\n`,
          );
        },
        { pid: 990000 + instanceNo },
      );
    },
  });

  // 懒启动：未调用前不启动进程
  assert.equal(spawnCalls.length, 0);
  assert.equal(helper.stats().running, false);

  // 未授权命令在 Node 侧直接拒绝，绝不启动进程
  await assert.rejects(
    helper.request("eval_script", { code: "calc.exe" }),
    /拒绝未授权/,
  );
  assert.equal(spawnCalls.length, 0);

  // 首次请求启动并携带 -STA
  const r1 = await helper.request("ping", { seq: 1 });
  assert.equal(r1.instanceNo, 1);
  assert.equal(spawnCalls.length, 1);
  assert.ok(spawnCalls[0].args.includes("-STA"));

  // 连续请求复用同一个常驻进程
  const r2 = await helper.request("cursor_pos", {});
  assert.equal(r2.instanceNo, 1);
  assert.equal(spawnCalls.length, 1);

  // 管道异常断开：自动重启并单次重试成功
  const r3 = await helper.request("ping", { crashOnce: true });
  assert.equal(r3.instanceNo, 2);
  assert.equal(spawnCalls.length, 2);

  // 空闲自动回收
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(helper.stats().running, false);

  // 空闲回收后再次请求自动懒重建，dispose 后彻底清理
  const r4 = await helper.request("ping", { afterIdle: true });
  assert.equal(r4.instanceNo, 3);
  helper.dispose();
  assert.equal(helper.stats().running, false);
});

test("ops.js win32 input validates payload and routes through resident helper", async () => {
  assert.throws(() => buildWinInputPayload({ action: "move" }), OpError);
  assert.throws(
    () => buildWinInputPayload({ action: "type", text: "a".repeat(5000) }),
    OpError,
  );
  assert.throws(() => buildWinInputPayload({ action: "unknown" }), OpError);
  assert.deepEqual(buildWinInputPayload({ action: "type", text: "a+b%" }), {
    action: "type",
    sendKeysText: "a{+}b{%}",
  });

  const sent = [];
  const fakeHelper = {
    async request(cmd, payload) {
      sent.push({ cmd, payload });
      return { done: true };
    },
  };
  const ops = createOps({ platform: "win32", winHelper: fakeHelper });
  const res = await ops.run("input", { action: "click", x: 100.4, y: 200.6 });
  assert.deepEqual(res, { done: true, action: "click" });
  assert.deepEqual(sent, [
    { cmd: "input", payload: { action: "click", x: 100, y: 201 } },
  ]);
});

test("accessibility-bridge: bounded TreeWalker BFS & FindFirst scripts + directionEpoch gate before helper", async () => {
  const readScript = buildWinReadTreeScript({
    bundleId: "notepad",
    maxNodes: 40,
    maxDepth: 8,
  });
  assert.match(readScript, /TreeWalker\]::ControlViewWalker/);
  assert.match(readScript, /\$maxDepth = 8/);
  assert.match(readScript, /Generic\.List\[object\]/);
  assert.doesNotMatch(readScript, /FindAll\([^)]*Descendants/);

  const actScript = buildWinActionScript({
    bundleId: "notepad",
    action: "click",
    automationId: "SaveBtn",
  });
  assert.match(actScript, /FindFirst\(/);
  assert.match(actScript, /PropertyCondition/);
  assert.doesNotMatch(actScript, /FindAll\([^)]*Descendants/);

  const calls = [];
  const bridge = createAccessibilityBridge({
    platform: "win32",
    winHelper: {
      async request(cmd, payload) {
        calls.push({ cmd, payload });
        if (cmd === "uia_read") {
          return {
            found: true,
            windowTitle: "记事本",
            nodes: [{ name: "保存", role: "ControlType.Button" }],
          };
        }
        return { ok: true, action: payload.action, matched: "保存" };
      },
    },
  });

  // 未授权：严格走 gate，绝不触发 helper
  const denied = await bridge.readTree({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    scopes: [],
  });
  assert.equal(denied.status, "denied");
  assert.equal(calls.length, 0);

  const ask = await bridge.readTree({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(ask.status, "ask");
  assert.equal(calls.length, 0);

  // 授权后通过常驻 helper 执行 uia_read 与 uia_action
  const epoch = bridge.authorizer.currentEpoch("c1");
  bridge.authorizer.authorizeApp({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    epoch,
    scopes: [ACCESSIBILITY_SCOPE],
  });

  const readOk = await bridge.readTree({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    epoch,
    maxNodes: 25,
    maxDepth: 6,
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(readOk.ok, true);
  assert.equal(readOk.tree.nodes.length, 1);
  assert.deepEqual(calls[0], {
    cmd: "uia_read",
    payload: { bundleId: "notepad", maxNodes: 25, maxDepth: 6 },
  });

  const actOk = await bridge.performAction({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    epoch,
    action: "click",
    name: "保存",
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(actOk.ok, true);
  assert.equal(calls[1].cmd, "uia_action");

  // 推进 directionEpoch 后旧授权立即失效，绝不调 helper
  bridge.authorizer.advanceEpoch("c1");
  const afterAdvance = await bridge.readTree({
    conversationId: "c1",
    deviceId: "d1",
    bundleId: "notepad",
    epoch,
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(afterAdvance.status, "denied");
  assert.equal(calls.length, 2);

  // 传输层错误自动兜底到 runner
  const fallbackCalls = [];
  const fallbackBridge = createAccessibilityBridge({
    platform: "win32",
    winHelper: {
      async request() {
        throw new HelperTransportError("pipe closed");
      },
    },
    runner: async (file, args) => {
      fallbackCalls.push({ file, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ found: true, nodes: [] }),
        stderr: "",
      };
    },
  });
  fallbackBridge.authorizer.authorizeApp({
    conversationId: "c2",
    deviceId: "d1",
    bundleId: "notepad",
    scopes: [ACCESSIBILITY_SCOPE],
  });
  const fbRes = await fallbackBridge.readTree({
    conversationId: "c2",
    deviceId: "d1",
    bundleId: "notepad",
    scopes: [ACCESSIBILITY_SCOPE],
  });
  assert.equal(fbRes.ok, true);
  assert.equal(fallbackCalls.length, 1);
});

test(
  "Windows live STA helper: 5 warm requests reuse 1 process, vastly beat cold start, and exit cleanly without zombie",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const helper = createWinPsHelper({ idleTimeoutMs: 10_000 });
    let pid = null;
    try {
      const tColdStart = performance.now();
      const first = await helper.request("ping");
      const coldMs = performance.now() - tColdStart;
      assert.equal(first.pong, true);
      assert.equal(first.apartment, "STA");
      pid = helper.stats().pid;
      assert.ok(Number.isInteger(pid) && pid > 0);

      const warmDurations = [];
      for (let i = 0; i < 5; i += 1) {
        const t0 = performance.now();
        const pos = await helper.request("cursor_pos");
        const dt = performance.now() - t0;
        assert.equal(typeof pos.x, "number");
        assert.equal(typeof pos.y, "number");
        warmDurations.push(dt);
      }
      const avgWarmMs =
        warmDurations.reduce((sum, v) => sum + v, 0) / warmDurations.length;
      assert.equal(helper.stats().spawnCount, 1);
      assert.ok(
        avgWarmMs < coldMs / 5,
        `expected warm avg (${avgWarmMs.toFixed(1)}ms) << cold (${coldMs.toFixed(1)}ms)`,
      );

      // 只读 UIA 查询（不存在的进程名快速短路返回 found:false，不干扰任何窗口）
      const uiaRes = await helper.request("uia_read", {
        bundleId: "chisabot-nonexistent-proc-check",
        maxNodes: 20,
        maxDepth: 6,
      });
      assert.equal(uiaRes.found, false);
      assert.deepEqual(uiaRes.nodes, []);
    } finally {
      helper.dispose({ sync: true });
    }
    await new Promise((r) => setTimeout(r, 150));
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {}
    assert.equal(stillAlive, false, `helper PID ${pid} must exit cleanly`);
  },
);

test("config.js: getToken caches DPAPI/Keychain decryption, invalidates on setToken/clearToken/set, and appendAudit/readAudit stay consistent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-config-perf-"));
  let decryptCalls = 0;
  let encryptCalls = 0;
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      encryptCalls += 1;
      return Buffer.from(`enc:${plain}`, "utf8");
    },
    decryptString: (buf) => {
      decryptCalls += 1;
      const text = buf.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad cipher");
      return text.slice(4);
    },
  };

  try {
    const cfg = createConfig({ dir, safeStorage: fakeSafeStorage });
    cfg.setToken("tok_initial");
    assert.equal(encryptCalls, 1);
    assert.equal(decryptCalls, 0);

    // 从磁盘重新加载新实例：首次 getToken 解密 1 次，后续 20 次全部命中缓存
    const cfg2 = createConfig({ dir, safeStorage: fakeSafeStorage });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(cfg2.getToken(), "tok_initial");
    }
    assert.equal(decryptCalls, 1, "连续 20 次 getToken 只应触发 1 次解密");

    // setToken 更新后立即命中新值
    cfg2.setToken("tok_rotated");
    assert.equal(cfg2.getToken(), "tok_rotated");
    assert.equal(decryptCalls, 1);

    // 通过 set 改写 tokenEnc 立即失效缓存并重新解密
    const rawEnc = fakeSafeStorage.encryptString("tok_patched").toString("base64");
    cfg2.set({ tokenEnc: rawEnc });
    assert.equal(cfg2.getToken(), "tok_patched");
    assert.equal(decryptCalls, 2);

    // clearToken 即时清空
    cfg2.clearToken();
    assert.equal(cfg2.getToken(), null);
    assert.equal(cfg2.tokenProtected(), false);

    // onChange 通知机制
    let changeCount = 0;
    const unsub = cfg2.onChange(() => {
      changeCount += 1;
    });
    cfg2.set({ serverUrl: "https://example.test" });
    assert.equal(changeCount, 1);
    unsub();
    cfg2.set({ serverUrl: "https://example.test" });
    assert.equal(changeCount, 1);

    // appendAudit 异步写入 + readAudit 立即严格读写一致（未 flush 前即可读且无重复）
    for (let i = 1; i <= 15; i += 1) {
      cfg2.appendAudit({ seq: i, op: "test" });
    }
    const immediate = cfg2.readAudit(20);
    assert.equal(immediate.length, 15);
    assert.equal(immediate[0].seq, 15);
    assert.equal(immediate[14].seq, 1);

    await cfg2.flushAudit();
    const afterFlush = cfg2.readAudit(20);
    assert.equal(afterFlush.length, 15);
    assert.equal(afterFlush[0].seq, 15);
    assert.equal(afterFlush[14].seq, 1);

    // 落盘后再追加 3 条并立即同步读取
    cfg2.appendAudit({ seq: 16, op: "test" });
    cfg2.appendAudit({ seq: 17, op: "test" });
    cfg2.appendAudit({ seq: 18, op: "test" });
    const mixed = cfg2.readAudit(20);
    assert.equal(mixed.length, 18);
    assert.equal(mixed[0].seq, 18);
    assert.equal(mixed[17].seq, 1);

    // flushAuditSync 供退出前同步落盘
    cfg2.flushAuditSync();
    const fresh = createConfig({ dir, safeStorage: fakeSafeStorage });
    const persisted = fresh.readAudit(20);
    assert.equal(persisted.length, 18);
    assert.equal(persisted[0].seq, 18);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detect.js: detectSandboxes probes in parallel via Promise.allSettled and which() caches per PATH", async () => {
  const delayMs = 120;
  let startedCount = 0;
  const t0 = performance.now();
  const res = await detectSandboxes({
    platform: "win32",
    which: (name) => `/fake/${name}`,
    exists: async () => true,
    capture: async (file) => {
      startedCount += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      if (file.includes("podman")) throw new Error("podman probe crash");
      return { code: file.includes("docker") ? 1 : 0, out: "ok" };
    },
  });
  const elapsed = performance.now() - t0;
  assert.equal(startedCount, 4, "git + docker + podman + wsl 4 路探活均执行");
  assert.ok(
    elapsed < delayMs * 2.5,
    `4 路各 ${delayMs}ms 探活应并行完成，实测 ${elapsed.toFixed(1)}ms`,
  );
  assert.deepEqual(res, {
    git: true,
    worktree: true,
    copy: true,
    none: true,
    docker: false,
    podman: false,
    wsl: true,
    "windows-sandbox": true,
  });

  // which() 按 PATH 缓存并随 PATH 变更自动隔离
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "cb-which-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "cb-which-b-"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const binA = path.join(dirA, `cb-fake-tool${ext}`);
  const binB = path.join(dirB, `cb-fake-tool${ext}`);
  fs.writeFileSync(binA, "a");
  fs.writeFileSync(binB, "b");
  try {
    clearWhichCache();
    assert.equal(which("cb-fake-tool", { PATH: dirA }), binA);
    assert.equal(which("cb-fake-tool", { PATH: dirA }), binA);
    // 换 PATH 必须立刻命中新目录
    assert.equal(which("cb-fake-tool", { PATH: dirB }), binB);
  } finally {
    clearWhichCache();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test("main.js: parallel zero-flash startup, deferred updater, async .lnk scan, O(1) egress hook, clean before-quit", () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  // 1. requestSingleInstanceLock 提前于重型业务模块 require
  assert.ok(
    mainSrc.indexOf("app.requestSingleInstanceLock()") <
      mainSrc.indexOf('require("./agent/core")'),
  );
  // 2. sessionStatus 并行执行 auth.probe 与 localWeb.probeVersion
  assert.match(mainSrc, /Promise\.allSettled\(\[\s*auth\.probe\(/);
  assert.ok(mainSrc.includes("prewarmedChatWindow"));
  // 3. onBeforeRequest 热路径直接读预编译 activeEgressPolicy，零 config.get() 拷贝
  const hookStart = mainSrc.indexOf("ses.webRequest.onBeforeRequest(");
  const hookSnippet = mainSrc.slice(hookStart, hookStart + 260);
  assert.ok(hookSnippet.includes("policy: activeEgressPolicy"));
  assert.ok(!hookSnippet.includes("config.get"));
  assert.ok(!hookSnippet.includes("new URL"));
  // 4. 启动第 3s 异步 .lnk 扫描去重
  assert.ok(mainSrc.includes("fsp.readdir(dir, { withFileTypes: true })"));
  assert.ok(mainSrc.includes("dedupeWinPaths"));
  // 5. before-quit 彻底清理常驻 helper 并同步刷盘审计日志
  const quitStart = mainSrc.indexOf('app.on("before-quit"');
  const quitSnippet = mainSrc.slice(quitStart, quitStart + 900);
  assert.ok(quitSnippet.includes("disposeResidentWinHelper()"));
  assert.ok(quitSnippet.includes("config?.flushAuditSync?.()"));
  // 6. startUpdater 延后至主窗口启动之后
  const readyStart = mainSrc.indexOf("app.whenReady().then(");
  const readySnippet = mainSrc.slice(readyStart);
  assert.ok(
    readySnippet.indexOf("void openApp(") <
      readySnippet.indexOf("ensureUpdaterStarted()"),
  );
});
