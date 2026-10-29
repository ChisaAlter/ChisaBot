"use strict";
// 在线更新 + 验签（src/updater.js 的 updateKeys，docs/pc-update-signing.md）：
// 验签通过才进入 downloaded；不通过删掉安装包、报错、不安装、不弹窗；启用验签时退出安装由 installOnQuit 负责。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createUpdater } = require("../src/updater");
const sig = require("../src/update-signature");

const execPath = path.join(os.tmpdir(), "chisabot-pc-update-verify", "ChisaBotPC.exe");
fs.mkdirSync(path.dirname(execPath), { recursive: true });
fs.writeFileSync(path.join(path.dirname(execPath), "Uninstall ChisaBot PC.exe"), "");

/** 和 electron-updater 6.8.9 一样：先派发 update-downloaded（带 downloadedFile），再看 autoInstallOnAppQuit 决定挂不挂退出安装。 */
function fakeAutoUpdater(info) {
  const e = new EventEmitter();
  e.installs = [];
  e.quitAndInstalls = [];
  e.installerPath = info.downloadedFile;
  e.checkForUpdates = async () => {
    e.emit("checking-for-update");
    e.emit("update-available", info);
    e.emit("update-downloaded", info);
    e.quitHandlerAdded = e.autoInstallOnAppQuit;
    return {};
  };
  e.quitAndInstall = (silent, runAfter) => e.quitAndInstalls.push([silent, runAfter]);
  e.install = (silent, runAfter) => (e.installs.push([silent, runAfter]), true);
  return e;
}

function make(info, { updateKeys = { enforce: true, keys: new Map(), problem: "" }, verifyDownload, shellHash = "aaaa" } = {}) {
  const autoUpdater = fakeAutoUpdater(info);
  const out = { states: [], downloaded: [], rejected: [], removed: [], spawned: [], quits: 0 };
  out.autoUpdater = autoUpdater;
  out.updater = createUpdater({
    autoUpdater,
    isPackaged: true,
    platform: "win32",
    execPath,
    productName: "ChisaBot PC",
    shellHash,
    updateKeys,
    verifyDownload,
    removeFile: (f) => out.removed.push(f),
    getAutoUpdate: () => true,
    onState: (s) => out.states.push(s.status),
    onDownloaded: (v) => out.downloaded.push(v),
    onRejected: (r) => out.rejected.push(r),
    spawn: (cmd, args) => out.spawned.push([cmd, args]),
    quitApp: () => out.quits++,
    timers: { setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {} },
  });
  return out;
}

const pass = async () => ({ keyId: "00000000" });
const reject = async () => {
  throw new sig.UpdateSignatureError("ERR_SIGNATURE_MISMATCH", "更新清单的签名不符");
};
const INFO = { version: "0.1.200", chisabotShell: "aaaa", downloadedFile: "C:\\pending\\ChisaBot-PC-0.1.200-x64-setup.exe" };

test("signing on: electron-updater never registers its own quit-time install", async () => {
  const t = make(INFO, { verifyDownload: pass });
  assert.strictEqual(t.updater.signing, true);
  assert.strictEqual(t.updater.state.signing, true);
  assert.strictEqual(t.autoUpdater.autoInstallOnAppQuit, false);
  await t.updater.check();
  assert.strictEqual(t.autoUpdater.quitHandlerAdded, false, "update-downloaded 时还没验完，不能让它挂退出安装");
});

test("signature ok → verifying → downloaded; 稍后 then quit installs via autoUpdater.install(true, false)", async () => {
  const t = make(INFO, { verifyDownload: pass });
  const state = await t.updater.check();
  assert.strictEqual(state.status, "verifying");
  assert.strictEqual(t.updater.install(), false, "验完之前不能装");
  assert.strictEqual(t.updater.installOnQuit(), false);
  await t.updater.settled();
  assert.strictEqual(t.updater.state.status, "downloaded");
  assert.deepStrictEqual(t.downloaded, ["0.1.200"]);
  assert.ok(t.states.indexOf("verifying") < t.states.indexOf("downloaded"));
  assert.strictEqual(t.updater.installOnQuit(), true);
  assert.deepStrictEqual(t.autoUpdater.installs, [[true, false]]);
  assert.strictEqual(t.updater.installOnQuit(), false, "只装一次");
  assert.deepStrictEqual(t.removed, []);
});

test("signature ok + 立即重启 → quitAndInstall(true, true), quitting afterwards does not install twice", async () => {
  const t = make(INFO, { verifyDownload: pass });
  await t.updater.check();
  await t.updater.settled();
  assert.strictEqual(t.updater.install(), true);
  assert.deepStrictEqual(t.autoUpdater.quitAndInstalls, [[true, true]]);
  assert.strictEqual(t.updater.installOnQuit(), false);
  assert.deepStrictEqual(t.autoUpdater.installs, []);
});

test("signature ok + full reinstall → our installer path, both now and on quit", async () => {
  const now = make({ ...INFO, chisabotShell: "bbbb" }, { verifyDownload: pass });
  await now.updater.check();
  await now.updater.settled();
  assert.strictEqual(now.updater.state.fullInstall, true);
  assert.strictEqual(now.updater.install(), true);
  assert.deepStrictEqual(now.spawned, [[INFO.downloadedFile, ["/S", "--force-run"]]]);
  assert.strictEqual(now.quits, 1);
  const later = make({ ...INFO, chisabotShell: "bbbb" }, { verifyDownload: pass });
  await later.updater.check();
  await later.updater.settled();
  assert.strictEqual(later.updater.installOnQuit(), true);
  assert.deepStrictEqual(later.spawned, [[INFO.downloadedFile, ["/S"]]]);
  assert.deepStrictEqual(later.autoUpdater.installs, []);
});

test("full reinstall without an installer path under signing falls back to autoUpdater.install on quit", async () => {
  const t = make({ version: "0.1.200", fullInstall: true, downloadedFile: undefined }, { verifyDownload: pass });
  await t.updater.check();
  await t.updater.settled();
  assert.strictEqual(t.updater.installOnQuit(), true);
  assert.deepStrictEqual(t.autoUpdater.installs, [[true, false]]);
  assert.strictEqual(t.autoUpdater.autoInstallOnAppQuit, false);
});

test("signature bad → file removed, error state, audit hook, no window, no install (now or on quit)", async () => {
  const t = make(INFO, { verifyDownload: reject });
  await t.updater.check();
  await t.updater.settled();
  const state = t.updater.state;
  assert.strictEqual(state.status, "error");
  assert.match(state.error, /^更新包签名校验失败，已拒绝安装：更新清单的签名不符/);
  assert.deepStrictEqual(t.removed, [INFO.downloadedFile]);
  assert.deepStrictEqual(t.downloaded, [], "不弹「新版本已下载」");
  assert.deepStrictEqual(t.rejected, [{ version: "0.1.200", code: "ERR_SIGNATURE_MISMATCH", reason: "更新清单的签名不符" }]);
  assert.strictEqual(t.updater.install(), false);
  assert.strictEqual(t.updater.installOnQuit(), false);
  assert.deepStrictEqual(t.autoUpdater.installs, []);
  assert.deepStrictEqual(t.autoUpdater.quitAndInstalls, []);
  assert.deepStrictEqual(t.spawned, []);
  assert.strictEqual(t.autoUpdater.autoInstallOnAppQuit, false);
  // 下次检查会重新下载、重新验（electron-updater 发现缓存的文件没了）。
  const again = await t.updater.check();
  assert.strictEqual(again.status, "verifying");
});

test("a rejected full reinstall does not run the installer either", async () => {
  const t = make({ ...INFO, chisabotShell: "bbbb" }, { verifyDownload: reject });
  await t.updater.check();
  await t.updater.settled();
  assert.strictEqual(t.updater.state.status, "error");
  assert.ok(!t.updater.state.fullInstall);
  assert.strictEqual(t.updater.install(), false);
  assert.strictEqual(t.updater.installOnQuit(), false);
  assert.deepStrictEqual(t.spawned, []);
});

test("no keys in this build (self-built without CHISABOT_UPDATE_PUBKEYS) → old behavior, state.signing = false", async () => {
  const t = make(INFO, { updateKeys: { enforce: false, keys: new Map(), problem: "" }, verifyDownload: reject });
  assert.strictEqual(t.updater.state.signing, false);
  assert.strictEqual(t.autoUpdater.autoInstallOnAppQuit, true);
  const state = await t.updater.check();
  assert.strictEqual(state.status, "downloaded", "不验签");
  assert.strictEqual(t.autoUpdater.quitHandlerAdded, true, "退出安装照旧交给 electron-updater");
  assert.strictEqual(t.updater.installOnQuit(), false);
});

test("real verification end to end: signed release passes, re-signed by a stranger or swapped file is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-update-verify-"));
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pub = sig.rawPublicKey(publicKey).toString("base64");
    const updateKeys = { enforce: true, keys: sig.parseKeys({ keys: [{ publicKey: pub }] }), problem: "" };
    const file = path.join(dir, "ChisaBot-PC-0.1.200-x64-setup.exe");
    const bytes = crypto.randomBytes(2048);
    fs.writeFileSync(file, bytes);
    const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
    const base = { version: "0.1.200", path: path.basename(file), sha512, files: [{ url: path.basename(file), sha512, size: bytes.length }], chisabotShell: "aaaa" };
    const good = { ...base, chisabotSig: sig.signManifest(base, privateKey), downloadedFile: file };

    const ok = make(good, { updateKeys });
    await ok.updater.check();
    await ok.updater.settled();
    assert.strictEqual(ok.updater.state.status, "downloaded");

    const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
    const forged = make({ ...base, chisabotSig: sig.signManifest(base, stranger), downloadedFile: file }, { updateKeys });
    await forged.updater.check();
    await forged.updater.settled();
    assert.strictEqual(forged.rejected[0]?.code, "ERR_UNKNOWN_KEY");

    const unsigned = make({ ...base, downloadedFile: file }, { updateKeys });
    await unsigned.updater.check();
    await unsigned.updater.settled();
    assert.strictEqual(unsigned.rejected[0]?.code, "ERR_NO_SIGNATURE", "没签名的更新源（被换掉的 latest.yml）也拒绝");

    fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, 100), Buffer.from([bytes[100] ^ 1]), bytes.subarray(101)]));
    const swapped = make(good, { updateKeys });
    await swapped.updater.check();
    await swapped.updater.settled();
    assert.strictEqual(swapped.rejected[0]?.code, "ERR_HASH_MISMATCH");

    const broken = make(good, { updateKeys: { enforce: true, keys: new Map(), problem: "公钥表坏了" } });
    await broken.updater.check();
    await broken.updater.settled();
    assert.strictEqual(broken.rejected[0]?.code, "ERR_NO_KEYS", "公钥表坏了：宁可装不上");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main wires the key table, the rejection audit and quit-time install", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(main.includes("updateKeys: updateSignature.loadKeys()"));
  assert.ok(main.includes('operation: "update_rejected"'));
  assert.ok(main.includes("updater?.installOnQuit()"));
});
