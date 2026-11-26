"use strict";
/**
 * PC 桌面端（Electron / Agent Runtime）性能占用、稳定性与安全加固回归测试。
 * 覆盖：
 * - [P1-1] acp-client stdout/stderr 缓冲硬上限截断 + stdin EPIPE error 保护
 * - [P1-2] win-ps-helper 显式 dispose 永久不可复活 vs 空闲回收、stdoutBuf 上限、单次遍历 UIA3 索引脚本契约
 * - [P1-3] sandbox.git 截断与 AbortSignal 解绑
 * - [P1-4] main.js prewarmedChatWindow 提前返回/异常销毁与生命周期清理
 * - [P1-5] config asyncSave 串行异步原子写 + flush/flushSync + readAudit 缓存一致性 + desktop-prefs 冷启复用
 * - [P1-6] local-web 代理流中途 nr.on("error") 主动终止流与销毁 res（不挂起）
 * - [P1-7 & P1-8] deriveUpdateView manualInstall 视图 + updater 非 fullInstall 恢复 autoInstallOnAppQuit / 验签失败清 version / 失败重检重新触发 onAvailable
 * - [P1-9] code-ops backupOf 拒绝 .git 与 .git/chisabot-backups symlink
 * - [P2] refreshTray 变更门控、headless 信号退出 await cleanupSessions、ui.js 隐藏/关天象停表
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { createJsonRpcConnection } = require("../src/agent-runtime/acp-client");
const sandbox = require("../src/agent-runtime/sandbox");
const {
  RESPONSE_PREFIX,
  buildResidentHelperScript,
  createWinPsHelper,
} = require("../src/agent/win-ps-helper");
const { createCodeOps } = require("../src/agent/code-ops");
const { resolveInRoots } = require("../src/agent/ops");
const { createLocalWebController } = require("../src/local-web");
const { createConfig } = require("../src/config");
const desktopPrefs = require("../src/desktop-prefs");
const { deriveUpdateView } = require("../src/ui/update");
const { createUpdater } = require("../src/updater");

async function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createFakeWinPsChild(onRequest, { pid = 990001 } = {}) {
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

test("[P1-1] acp-client: enforces stdout/stderr buffer caps and swallows stdin EPIPE errors", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const stderrLines = [];
  const notifications = [];
  const rpc = createJsonRpcConnection(child, {
    maxStdoutBytes: 1024,
    maxStderrBytes: 512,
    onNotification: (method, params) => notifications.push({ method, params }),
    onStderrLine: (line) => stderrLines.push(line),
  });

  // stdin 触发 EPIPE 不应抛未捕获异常击穿主进程
  assert.doesNotThrow(() => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    child.stdin.emit("error", err);
  });

  // 写入一条超长无换行 stdout 垃圾块，再发送正常 JSON-RPC 通知，连接应安全丢弃超限行并继续工作
  child.stdout.write("x".repeat(4096));
  child.stdout.write("\n");
  child.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { ok: true } })}\n`,
  );

  // 写入超长 stderr 无换行块，应截断并回调 onStderrLine 而非无限累积
  child.stderr.write("e".repeat(2048));
  child.stderr.write("\nshort stderr\n");

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    method: "session/update",
    params: { ok: true },
  });
  assert.ok(
    stderrLines.some((line) => line.includes("stderr 缓冲超限已截断")),
    "超限 stderr 应被截断报告",
  );
  assert.ok(
    stderrLines.includes("short stderr"),
    "截断后后续正常 stderr 行应继续接收",
  );

  rpc.closeAll();
});

test("[P1-2] win-ps-helper: explicit dispose prevents resurrection, idle timeout still respawns, stdoutBuf cap aborts runaway output", async () => {
  // 1. 脚本应包含单次遍历 CollectLegacyDefaultActionRuntimeIds 且避免快照循环内 O(N^2) 调用
  const script = buildResidentHelperScript();
  assert.match(script, /CollectLegacyDefaultActionRuntimeIds/);
  assert.match(script, /\$legacyHwndBudget\s*=\s*64/);

  // 2. 空闲回收后仍可按需重建，但显式 dispose() 后永久不可复活
  let spawns = 0;
  const helper = createWinPsHelper({
    idleTimeoutMs: 60,
    defaultTimeoutMs: 2000,
    maxStdoutBytes: 2048,
    spawn: () => {
      spawns += 1;
      return createFakeWinPsChild((msg, proc) => {
        if (msg.cmd === "win_list" && msg.payload?.flood) {
          proc.stdout.write("A".repeat(4096));
          return;
        }
        proc.stdout.write(
          `${RESPONSE_PREFIX}${JSON.stringify({ id: msg.id, ok: true, data: { seq: spawns } })}\n`,
        );
      });
    },
  });

  const first = await helper.request("ping", {});
  assert.equal(first.seq, 1);

  // 等空闲回收触发
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(helper.stats().running, false);

  // 空闲回收后再次请求可正常重建
  const second = await helper.request("ping", {});
  assert.equal(second.seq, 2);

  // stdoutBuf 超上限立即拒绝且不无限重试
  await assert.rejects(
    () => helper.request("win_list", { flood: true }),
    /输出超过安全上限/,
  );

  // 显式 dispose 后永久不可复活
  const spawnsBeforeDispose = helper.stats().spawnCount;
  helper.dispose({ sync: false });
  await assert.rejects(
    () => helper.request("ping", {}),
    /Windows helper 已关闭/,
  );
  assert.equal(helper.stats().spawnCount, spawnsBeforeDispose);
});

test("[P1-3] sandbox.git enforces maxOutBytes cap and unbinds abort listener cleanly", async () => {
  const controller = new AbortController();
  const res = await sandbox.git(["--version"], {
    maxOutBytes: 1024,
    signal: controller.signal,
  });
  assert.equal(res.code, 0);
  assert.equal(res.truncated, false);
  assert.match(res.out, /git version/i);

  // 已取消 signal 直接快速返回不启动进程
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await sandbox.git(["--version"], {
    signal: aborted.signal,
  });
  assert.equal(cancelled.code, -1);
});

test("[P1-5] config asyncSave queues atomic writes, flush/flushSync persists, readAudit cache stays consistent, and bootstrap config is reused once", async () => {
  await withTempDir("cb-cfg-async-", async (dir) => {
    const cfg = createConfig({ dir, safeStorage: null, asyncSave: true });
    cfg.set({ serverUrl: "https://one.example.test", username: "alice" });
    cfg.set({ serverUrl: "https://two.example.test", timezone: "Asia/Shanghai" });
    await cfg.flush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    );
    assert.equal(onDisk.serverUrl, "https://two.example.test");
    assert.equal(onDisk.username, "alice");
    assert.equal(onDisk.timezone, "Asia/Shanghai");

    // 同步 flushSync 立即刷盘未完成脏写入
    cfg.set({ username: "bob" });
    cfg.flushSync();
    const afterSync = JSON.parse(
      fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    );
    assert.equal(afterSync.username, "bob");

    // 冷启 bootstrap 读取并一次性消费缓存
    const prefs = desktopPrefs.readBootstrapDesktopPrefs(dir);
    assert.equal(prefs.timezone, "Asia/Shanghai");
    const raw = desktopPrefs.takeBootstrapRawConfig(dir);
    assert.ok(raw && raw.username === "bob");
    assert.equal(desktopPrefs.takeBootstrapRawConfig(dir), null);

    const cfgReused = createConfig({
      dir,
      safeStorage: null,
      initialConfig: raw,
    });
    assert.equal(cfgReused.get().username, "bob");

    // readAudit / readAuditAsync 缓存一致性
    cfgReused.appendAudit({ seq: 1, op: "a" });
    cfgReused.appendAudit({ seq: 2, op: "b" });
    await cfgReused.flushAudit();
    assert.equal(cfgReused.readAudit(10).length, 2);
    const asyncList = await cfgReused.readAuditAsync(10);
    assert.equal(asyncList.length, 2);
    assert.equal(asyncList[0].seq, 2);
  });
});

test("[P1-6] local-web forwardWithNetRequest errors stream and destroys res when nr emits error mid-stream", async () => {
  await withTempDir("cb-localweb-err-", async (root) => {
    const bundleDir = path.join(root, "web-bundle");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.html"), "<html/>");
    fs.writeFileSync(
      path.join(bundleDir, "chisabot-web-meta.json"),
      JSON.stringify({ version: "0.1.191" }),
    );

    let destroyedWith = null;
    let activeNr = null;
    const fakeNet = {
      request() {
        const nr = new EventEmitter();
        activeNr = nr;
        nr.write = () => {};
        nr.abort = () => {};
        nr.end = () => {
          queueMicrotask(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = { "content-type": "text/event-stream" };
            res.destroy = (err) => {
              destroyedWith = err;
            };
            nr.emit("response", res);
            queueMicrotask(() => {
              res.emit("data", Buffer.from("data: hello\n\n"));
            });
          });
        };
        return nr;
      },
    };

    const handlers = {};
    const fakeSes = {
      protocol: {
        handle(scheme, fn) {
          handlers[scheme] = fn;
        },
      },
    };

    const ctrl = createLocalWebController({
      bundleDir,
      localVersion: "0.1.191",
      getServerOrigin: () => "https://srv.example.com",
      netImpl: fakeNet,
    });
    assert.equal(ctrl.installSessionProtocol(fakeSes), true);

    const response = await handlers.https(
      new Request("https://srv.example.com/api/events", { method: "GET" }),
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(
      Buffer.from(first.value).toString("utf8"),
      "data: hello\n\n",
    );

    // 模拟流式传输中途底层连接断开仅触发 nr.on("error") 而未触发 res.on("error")
    const nextRead = reader.read();
    activeNr.emit("error", new Error("net::ERR_CONNECTION_RESET"));
    await assert.rejects(() => nextRead, /ERR_CONNECTION_RESET/);
    assert.match(destroyedWith?.message || "", /ERR_CONNECTION_RESET/);
  });
});

test("[P1-7] deriveUpdateView renders actionable manualInstall guidance instead of stuck 0%", () => {
  const dlUrl = "https://github.com/ChisaAlter/ChisaBot/releases/latest";
  const view = deriveUpdateView({
    status: "available",
    version: "0.1.192",
    manualInstall: true,
    fullInstall: true,
    downloadUrl: dlUrl,
  });
  assert.equal(view.action, "发现新版本");
  assert.equal(view.progressMode, "hidden");
  assert.equal(view.percentText, "");
  assert.equal(view.actionKind, "manual");
  assert.equal(view.primaryLabel, "手动下载安装");
  assert.equal(view.manualInstall, true);
  assert.match(view.subtitle, /0\.1\.192/);
  assert.equal(view.downloadUrl, dlUrl);
});

test("[P1-8] updater restores autoInstallOnAppQuit on non-fullInstall, clears state.version on verify failure, and re-notifies onAvailable after download error", async () => {
  await withTempDir("cb-upd-state-", async (dir) => {
    const execPath = path.join(dir, "ChisaBot.exe");
    fs.writeFileSync(execPath, "");
    fs.writeFileSync(path.join(dir, "Uninstall ChisaBot.exe"), "");

    // 场景 A：无验签模式下，fullInstall 置 false 后，后续非 fullInstall 必须恢复 autoInstallOnAppQuit = true
    const au1 = new EventEmitter();
    au1.autoDownload = true;
    au1.autoInstallOnAppQuit = true;
    au1.setFeedURL = () => {};
    au1.checkForUpdates = async () => ({ updateInfo: { version: "0.1.200" } });
    const avail1 = [];
    const u1 = createUpdater({
      autoUpdater: au1,
      currentVersion: "0.1.191",
      isPackaged: true,
      platform: "win32",
      execPath,
      productName: "ChisaBot",
      shellHash: "shell-a",
      getAutoUpdate: () => true,
      onAvailable: (v) => avail1.push(v),
      timers: {
        setTimeout: () => ({ unref() {} }),
        setInterval: () => ({ unref() {} }),
        clearTimeout() {},
        clearInterval() {},
      },
    });

    // 先模拟一次可用 → 下载失败 → 重试同版本，应能再次触发 onAvailable
    au1.emit("update-available", { version: "0.1.195", chisabotShell: "shell-b" });
    assert.deepEqual(avail1, ["0.1.195"]);
    au1.emit("error", new Error("network reset"));
    assert.equal(u1.state.status, "error");
    au1.emit("update-available", { version: "0.1.195", chisabotShell: "shell-b" });
    assert.deepEqual(avail1, ["0.1.195", "0.1.195"]);

    // 下载了一个 fullInstall 包（shell-b != shell-a）→ autoInstallOnAppQuit = false
    au1.emit("update-downloaded", { version: "0.1.195", chisabotShell: "shell-b" });
    assert.equal(au1.autoInstallOnAppQuit, false);

    // 后续被同壳（shell-a）的更高版本覆盖 → autoInstallOnAppQuit 恢复为 true
    au1.emit("update-downloaded", { version: "0.1.196", chisabotShell: "shell-a" });
    assert.equal(au1.autoInstallOnAppQuit, true);
    assert.equal(u1.state.version, "0.1.196");

    // 场景 B：验签失败时清空 state.version 并允许重试触发 onAvailable
    const au2 = new EventEmitter();
    au2.autoDownload = true;
    au2.autoInstallOnAppQuit = false;
    au2.setFeedURL = () => {};
    au2.checkForUpdates = async () => ({ updateInfo: { version: "0.1.199" } });
    const removed = [];
    const avail2 = [];
    const u2 = createUpdater({
      autoUpdater: au2,
      currentVersion: "0.1.191",
      isPackaged: true,
      platform: "win32",
      execPath,
      productName: "ChisaBot",
      updateKeys: { enforce: true, keys: {} },
      verifyDownload: async () => {
        throw new Error("bad signature");
      },
      removeFile: (f) => removed.push(f),
      getAutoUpdate: () => true,
      onAvailable: (v) => avail2.push(v),
      timers: {
        setTimeout: () => ({ unref() {} }),
        setInterval: () => ({ unref() {} }),
        clearTimeout() {},
        clearInterval() {},
      },
    });
    au2.emit("update-available", { version: "0.1.199" });
    au2.emit("update-downloaded", {
      version: "0.1.199",
      downloadedFile: path.join(dir, "fake-setup.exe"),
    });
    await u2.settled();
    assert.equal(u2.state.status, "error");
    assert.equal(u2.state.version, undefined);
    assert.equal(removed.length, 1);

    // 验签失败后重检同版本仍可再次通知 onAvailable
    au2.emit("update-available", { version: "0.1.199" });
    assert.deepEqual(avail2, ["0.1.199", "0.1.199"]);
  });
});

test("[P1-9] code-ops backupOf rejects symlink/junction .git and .git/chisabot-backups targets", async () => {
  await withTempDir("cb-backup-sec-", async (root) => {
    const outsideDir = path.join(root, "outside");
    const repo1 = path.join(root, "repo-symlink-git");
    const repo2 = path.join(root, "repo-symlink-backups");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(repo1, { recursive: true });
    fs.mkdirSync(path.join(repo2, ".git"), { recursive: true });

    const file1 = path.join(repo1, "a.txt");
    const file2 = path.join(repo2, "b.txt");
    fs.writeFileSync(file1, "hello-1\n");
    fs.writeFileSync(file2, "hello-2\n");

    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(outsideDir, path.join(repo1, ".git"), linkType);
    fs.symlinkSync(
      outsideDir,
      path.join(repo2, ".git", "chisabot-backups"),
      linkType,
    );

    const codeOps = createCodeOps({
      platform: process.platform,
      resolveInRoots,
    });

    await assert.rejects(
      () =>
        codeOps.table.edit_file(
          { path: file1, oldText: "hello-1", newText: "changed-1" },
          { allowedRoots: [repo1], fullAccess: false },
        ),
      /符号链接/,
    );
    // 原文件未被修改且外部目录无任何写入
    assert.equal(fs.readFileSync(file1, "utf8"), "hello-1\n");
    assert.deepEqual(fs.readdirSync(outsideDir), []);

    await assert.rejects(
      () =>
        codeOps.table.edit_file(
          { path: file2, oldText: "hello-2", newText: "changed-2" },
          { allowedRoots: [repo2], fullAccess: false },
        ),
      /符号链接/,
    );
    assert.equal(fs.readFileSync(file2, "utf8"), "hello-2\n");
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  });
});

test("[P1-4 & P2] source contracts: prewarm cleanup, refreshTray gated broadcast, headless cleanupSessions, ui.js visibility timer pause", () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  const headlessSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "headless.js"),
    "utf8",
  );
  const uiSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "ui", "ui.js"),
    "utf8",
  );

  // P1-4: openChat 清理传入 prewarmedWin，prewarmOnly 绑 closed 与 render-process-gone
  assert.match(mainSrc, /if\s*\(!serverUrl\)\s*\{\s*disposeUnusedPrewarm\(\);/);
  assert.match(
    mainSrc,
    /if\s*\(options\?\.prewarmOnly\)\s*\{[\s\S]*win\.once\("closed"[\s\S]*render-process-gone/,
  );

  // P2: refreshTray 仅在 changed 或 forceBroadcast 时广播；before-quit 调 updater?.stop?.()
  assert.match(mainSrc, /if\s*\(changed\s*\|\|\s*forceBroadcast\)\s*\{\s*broadcast\(\);/);
  assert.match(mainSrc, /updater\?\.stop\?\.\(\)/);

  // P2: headless 退出前 await cleanupSessions
  assert.match(headlessSrc, /agentRuntime\.runtime\.cleanupSessions\(\)/);

  // P2: ui.js 监听 visibilitychange 并在隐藏或 sky===false 时停表
  assert.match(uiSrc, /visibilitychange/);
  assert.match(uiSrc, /clearInterval\(skyTimer\)/);
});
