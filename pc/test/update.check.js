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
    feedUrl: options.feedUrl,
    fallbackFeed: options.fallbackFeed,
    currentVersion: options.currentVersion,
    isPackaged: options.isPackaged ?? true,
    platform: options.platform ?? "win32",
    execPath: options.execPath ?? installedExec,
    productName: "ChisaBot",
    shellHash: options.shellHash,
    clientHash: options.clientHash,
    updateKeys: options.updateKeys,
    verifyDownload: options.verifyDownload,
    spawn: options.spawn,
    spawnSync: options.spawnSync ?? (() => ({ status: 0, stdout: "", stderr: "Identifier=com.chisabot.app\nSignature size=4785\nAuthority=Developer ID Application: ChisaBot (TESTTEAM)\nTeamIdentifier=TESTTEAM\n" })),
    quitApp: options.quitApp,
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

test("stale feed (version lower than installed) is flagged and falls back to the next tier", async () => {
  const emitter = new EventEmitter();
  const feeds = [];
  let calls = 0;
  emitter.setFeedURL = (c) => feeds.push(c.url);
  emitter.checkForUpdates = async () => {
    emitter.emit("checking-for-update");
    calls++;
    if (calls === 1) {
      emitter.emit("update-not-available", {});
      return { updateInfo: { version: "0.1.125" } };
    }
    emitter.emit("update-available", { version: "0.1.131" });
    emitter.emit("update-downloaded", { version: "0.1.131" });
    return { updateInfo: { version: "0.1.131" } };
  };
  const { updater, states, downloaded } = make({
    autoUpdater: emitter,
    feedUrl: "https://stale.example/feed/",
    fallbackFeed: "https://github.com/me/chisabot/releases/latest/download/",
    currentVersion: "0.1.129",
  });
  const state = await updater.check();
  assert.strictEqual(calls, 2, "退回后再查一次");
  assert.strictEqual(feeds[0], "https://stale.example/feed/");
  assert.strictEqual(feeds[1], "https://github.com/me/chisabot/releases/latest/download/");
  assert.strictEqual(state.status, "downloaded");
  assert.strictEqual(state.version, "0.1.131");
  assert.deepStrictEqual(state.feedStale, { url: "https://stale.example/feed/", version: "0.1.125" });
  assert.strictEqual(state.feedUrl, "https://github.com/me/chisabot/releases/latest/download/");
  assert.deepStrictEqual(downloaded, ["0.1.131"]);
  assert.ok(states.some((s) => s.feedStale));
});

test("stale feed without a fallback stays flagged instead of claiming 已是最新", async () => {
  const emitter = new EventEmitter();
  emitter.setFeedURL = () => {};
  emitter.checkForUpdates = async () => {
    emitter.emit("checking-for-update");
    emitter.emit("update-not-available", {});
    return { updateInfo: { version: "0.1.125" } };
  };
  const { updater } = make({ autoUpdater: emitter, feedUrl: "https://stale.example/feed/", currentVersion: "0.1.129" });
  const state = await updater.check();
  assert.strictEqual(state.status, "none");
  assert.deepStrictEqual(state.feedStale, { url: "https://stale.example/feed/", version: "0.1.125" });
  await updater.check();
  assert.strictEqual(updater.state.feedStale.url, "https://stale.example/feed/");
});

test("compareVersion orders numeric segments", () => {
  const { compareVersion } = require("../src/updater");
  assert.ok(compareVersion("0.1.131", "0.1.9") > 0);
  assert.ok(compareVersion("0.1.125", "0.1.129") < 0);
  assert.strictEqual(compareVersion("v0.1.130", "0.1.130"), 0);
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

test("macOS: any packaged .app updates; fullInstall still uses quitAndInstall (Squirrel replaces the whole bundle)", async () => {
  const { updater, autoUpdater } = make({
    platform: "darwin",
    execPath: "/Applications/ChisaBot.app/Contents/MacOS/ChisaBot",
    behavior: { version: "0.1.9" },
  });
  assert.strictEqual(updater.supported, true, "打包版 .app 就能更新，不需要 Windows 的「安装版」判定");
  const result = await updater.check();
  assert.strictEqual(result.status, "downloaded");
  assert.strictEqual(updater.install(), true);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]], "quitAndInstall(true, true)");

  // adhoc 签名过不了 Squirrel 的 requirement 校验（cdhash 随构建变化），不启用更新链
  const adhoc = () => ({ status: 0, stdout: "", stderr: "Identifier=Electron\nSignature=adhoc\nTeamIdentifier=not set\n" });
  assert.strictEqual(
    make({ platform: "darwin", execPath: "/Applications/ChisaBot.app/Contents/MacOS/ChisaBot", spawnSync: adhoc }).updater.supported,
    false,
    "adhoc 签名的 .app 不启用在线更新",
  );

  // 外壳指纹变了在 mac 上照常整包替换，不走 runFullInstaller / spawn
  const spawns = [];
  const full = make({
    platform: "darwin",
    execPath: "/Applications/ChisaBot.app/Contents/MacOS/ChisaBot",
    shellHash: "old-shell",
    spawn: (cmd, args) => spawns.push([cmd, args]),
    autoUpdater: (() => {
      const e = fakeAutoUpdater();
      e.checkForUpdates = async () => {
        e.emit("checking-for-update");
        e.emit("update-available", { version: "0.1.9", chisabotShell: "new-shell" });
        e.emit("update-downloaded", { version: "0.1.9", chisabotShell: "new-shell" });
        return {};
      };
      return e;
    })(),
  });
  assert.strictEqual((await full.updater.check()).fullInstall, true);
  assert.strictEqual(full.updater.install(), true);
  assert.deepStrictEqual(spawns, [], "mac 不跑安装包");
  assert.deepStrictEqual(full.autoUpdater.installs, [[true, true]]);
});

test("macOS installOnQuit: unsigned quit installs itself (return false); signed holds the quit via quitAndInstall", async () => {
  const darwinOpts = { platform: "darwin", execPath: "/Applications/ChisaBot.app/Contents/MacOS/ChisaBot", behavior: { version: "0.1.9" } };
  const unsigned = make(darwinOpts);
  await unsigned.updater.check();
  assert.strictEqual(unsigned.updater.installOnQuit(), false, "Squirrel 已经拿到更新，普通退出就装");

  const signed = make({ ...darwinOpts, updateKeys: { enforce: true, keys: new Map(), problem: "" }, verifyDownload: async () => {} });
  await signed.updater.check();
  await signed.updater.settled();
  assert.strictEqual(signed.updater.state.status, "downloaded");
  assert.strictEqual(signed.updater.installOnQuit(), "hold", "调用方要 preventDefault 撑住退出");
  assert.strictEqual(signed.autoUpdater.autoRunAppAfterInstall, false, "装好不重启");
  assert.deepStrictEqual(signed.autoUpdater.installs, [[true, true]], "quitAndInstall 触发 Squirrel 拉本地包");
  assert.strictEqual(signed.updater.installOnQuit(), false, "已在安装中的重复退出直接放行");
});
