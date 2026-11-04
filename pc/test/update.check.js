"use strict";
/* 在线更新（src/updater.js）：只有安装版能更新、事件 → 状态、定时检查跟着「自动更新」开关、未签名安装包不做 Authenticode 校验。 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createUpdater, cleanMessage, isInstalledBuild, FIRST_CHECK_MS, INTERVAL_MS } = require("../src/updater");

function fakeAutoUpdater(behavior = {}) {
  const emitter = new EventEmitter();
  emitter.checks = 0;
  emitter.installs = [];
  emitter.checkForUpdates = async () => {
    emitter.checks++;
    emitter.emit("checking-for-update");
    if (behavior.fail) {
      const error = new Error(behavior.fail);
      emitter.emit("error", error);
      throw error;
    }
    if (behavior.version) {
      emitter.emit("update-available", { version: behavior.version });
      emitter.emit("download-progress", { percent: 42.4 });
      if (behavior.download !== false) emitter.emit("update-downloaded", { version: behavior.version });
    } else emitter.emit("update-not-available", {});
    return {};
  };
  emitter.quitAndInstall = (silent, runAfter) => emitter.installs.push([silent, runAfter]);
  return emitter;
}

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeout = (fn, ms) => (t.timeouts.push({ fn, ms }), t.timeouts.length);
  t.setInterval = (fn, ms) => (t.intervals.push({ fn, ms }), 100 + t.intervals.length);
  t.clearTimeout = () => {};
  t.clearInterval = () => {};
  return t;
}

const installedExec = path.join(require("node:os").tmpdir(), "chisabot-pc-update-check", "ChisaBot.exe");

function make(options = {}) {
  const autoUpdater = "autoUpdater" in options ? options.autoUpdater : fakeAutoUpdater(options.behavior);
  const states = [];
  const downloaded = [];
  let auto = options.auto ?? true;
  const timers = fakeTimers();
  const dir = path.dirname(installedExec);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Uninstall ChisaBot.exe"), "");
  const updater = createUpdater({
    autoUpdater,
    isPackaged: options.isPackaged ?? true,
    platform: options.platform ?? "win32",
    execPath: options.execPath ?? installedExec,
    productName: "ChisaBot",
    getAutoUpdate: () => auto,
    onState: (s) => states.push(s),
    onDownloaded: (v) => downloaded.push(v),
    timers,
    now: () => new Date("2026-10-12T01:00:00Z"),
  });
  return { updater, autoUpdater, states, downloaded, timers, setAuto: (v) => (auto = v) };
}

test("only an NSIS-installed packaged Windows build updates", () => {
  assert.strictEqual(make({ isPackaged: false }).updater.supported, false, "开发运行");
  assert.strictEqual(make({ platform: "linux" }).updater.supported, false, "非 Windows");
  assert.strictEqual(make({ execPath: path.join(__dirname, "no-such-dir", "ChisaBot.exe") }).updater.supported, false, "免安装 zip（没有卸载程序）");
  assert.strictEqual(make({ autoUpdater: null }).updater.supported, false, "没有 electron-updater");
  assert.strictEqual(make().updater.supported, true);
  assert.ok(isInstalledBuild({ execPath: "C:\\x\\ChisaBot.exe", productName: "ChisaBot", exists: (p) => p.endsWith("Uninstall ChisaBot.exe") }));
});

test("unsigned installer: Authenticode verification is a pass, sha512 stays electron-updater's", async () => {
  const { autoUpdater } = make();
  assert.strictEqual(typeof autoUpdater.verifyUpdateCodeSignature, "function");
  assert.strictEqual(await autoUpdater.verifyUpdateCodeSignature(["x"], "C:\\t.exe"), null);
  assert.strictEqual(autoUpdater.autoDownload, true);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true);
  assert.strictEqual(autoUpdater.allowDowngrade, false);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.build.win.verifyUpdateCodeSignature, false);
  assert.deepStrictEqual(pkg.build.publish[0].provider, "generic");
  assert.doesNotMatch(JSON.stringify(pkg.build.publish), /ayase|whaleisle/, "仓库里不写死任何人的域名；CI 用 -c.publish.url 覆盖");
  assert.ok(pkg.dependencies["electron-updater"]);
});

test("found → downloading → downloaded calls onDownloaded once and install quits silently", async () => {
  const { updater, autoUpdater, states, downloaded } = make({ behavior: { version: "0.1.1" } });
  assert.strictEqual(updater.install(), false, "没下载好不能装");
  const result = await updater.check();
  assert.strictEqual(result.status, "downloaded");
  assert.strictEqual(result.version, "0.1.1");
  assert.ok(states.some((s) => s.status === "downloading" && s.percent === 42.4));
  assert.deepStrictEqual(downloaded, ["0.1.1"]);
  assert.strictEqual(updater.install(), true);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  await updater.check();
  assert.strictEqual(autoUpdater.checks, 1, "已下载后不再检查");
});

test("no update and errors become readable states", async () => {
  const none = make();
  assert.strictEqual((await none.updater.check()).status, "none");
  const offline = make({ behavior: { fail: "net::ERR_NAME_NOT_RESOLVED" } });
  const state = await offline.updater.check();
  assert.strictEqual(state.status, "error");
  assert.strictEqual(state.error, "连不上更新服务器，请检查网络。");
  assert.strictEqual(cleanMessage(new Error("sha512 checksum mismatch, expected x")), "下载的安装包校验失败，已丢弃，稍后会重新下载。");
});

test("scheduled checks follow the 自动更新 switch", () => {
  const on = make();
  on.updater.schedule();
  assert.strictEqual(on.timers.timeouts[0].ms, FIRST_CHECK_MS);
  assert.strictEqual(on.timers.intervals[0].ms, INTERVAL_MS);
  on.setAuto(false);
  on.timers.intervals[0].fn();
  assert.strictEqual(on.autoUpdater.checks, 0, "关掉后定时器不再检查");
  const off = make({ auto: false });
  off.updater.schedule();
  assert.strictEqual(off.timers.timeouts.length + off.timers.intervals.length, 0);
});

test("update IPC goes through the source checks", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  for (const ch of ["pc:check-update", "pc:install-update"]) assert.ok(main.includes(`handleWeb("${ch}"`), ch);
  for (const ch of ["update:current", "update:answer"]) assert.ok(main.includes(`handleLocal("${ch}"`), ch);
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  assert.ok(preload.includes('"update:answer"'));
  const web = fs.readFileSync(path.join(__dirname, "..", "src", "web-preload.js"), "utf8");
  assert.ok(web.includes('ipcRenderer.invoke("pc:install-update")'));
});
