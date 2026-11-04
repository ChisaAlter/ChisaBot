"use strict";
/* 外壳指纹 → 重新安装（docs/online-update.md §2.1）：指纹怎么算、latest.yml 怎么标、客户端怎么选安装方式、
 * 首次启动怎么刷新快捷方式和图标缓存。 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const fp = require("../scripts/shell-fingerprint");
const { createUpdater, isInstalledBuild, requiresFullInstall } = require("../src/updater");
const shellRefresh = require("../src/shell-refresh");

const PC = path.join(__dirname, "..");

/** 把 pc/ 的外壳输入复制到临时目录，改一样东西看指纹变不变。 */
function sandboxCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-shell-"));
  for (const rel of ["package.json", "build/icon.ico", "build/installer.nsh", "assets/icon.png", "assets/tray-online.png", "assets/tray-offline.png", "assets/tray-paused.png"]) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(PC, rel), path.join(dir, rel));
  }
  return dir;
}

function editPkg(dir, fn) {
  const file = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(pkg);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
}

test("committed src/shell-fingerprint.json matches the current shell inputs", () => {
  const committed = JSON.parse(fs.readFileSync(path.join(PC, "src", "shell-fingerprint.json"), "utf8"));
  assert.strictEqual(committed.hash, fp.compute().hash, "改了图标 / 安装配置后要运行 npm run fingerprint");
  assert.match(committed.hash, /^[0-9a-f]{16}$/);
  assert.strictEqual(shellRefresh.loadFingerprint(), committed.hash);
});

test("fingerprint changes with icons, installer script, Electron and shell config — not with version, publish or JS deps", () => {
  const dir = sandboxCopy();
  const base = fp.compute(dir).hash;
  assert.strictEqual(fp.compute(dir).hash, base, "确定性");

  editPkg(dir, (p) => (p.version = "9.9.9"));
  editPkg(dir, (p) => (p.build.publish = [{ provider: "generic", url: "https://example.org/feed/" }]));
  editPkg(dir, (p) => (p.dependencies.ws = "9.0.0"));
  editPkg(dir, (p) => (p.description = "另一句描述"));
  assert.strictEqual(fp.compute(dir).hash, base, "版本号 / 更新源 / 纯 JS 依赖 / 描述 不需要重新安装");

  const changes = [
    ["exe 图标", () => fs.appendFileSync(path.join(dir, "build/icon.ico"), Buffer.from([0]))],
    ["窗口图标", () => fs.appendFileSync(path.join(dir, "assets/icon.png"), Buffer.from([0]))],
    ["托盘图标", () => fs.appendFileSync(path.join(dir, "assets/tray-online.png"), Buffer.from([0]))],
    ["新托盘图标", () => fs.writeFileSync(path.join(dir, "assets/tray-busy.png"), "x")],
    ["安装脚本", () => fs.appendFileSync(path.join(dir, "build/installer.nsh"), "\n; x")],
    ["Electron 版本", () => editPkg(dir, (p) => (p.devDependencies.electron = "99.0.0"))],
    ["electron-builder 版本", () => editPkg(dir, (p) => (p.devDependencies["electron-builder"] = "99.0.0"))],
    ["快捷方式名", () => editPkg(dir, (p) => (p.build.nsis.shortcutName = "别的名字"))],
    ["appId", () => editPkg(dir, (p) => (p.build.appId = "x.y.z"))],
    ["入口", () => editPkg(dir, (p) => (p.main = "src/other.js"))],
  ];
  let prev = base;
  for (const [name, change] of changes) {
    change();
    const next = fp.compute(dir).hash;
    assert.notStrictEqual(next, prev, `${name} 变了，指纹应该变`);
    prev = next;
  }
});

test("stampYaml adds chisabotShell (and fullInstall) without touching sha512, and is idempotent", () => {
  const yml = "version: 0.1.3\nfiles:\n  - url: a.exe\n    sha512: abc==\n    size: 1\npath: a.exe\nsha512: abc==\nreleaseDate: '2026-10-13T00:00:00.000Z'\n";
  const once = fp.stampYaml(yml, { hash: "0123456789abcdef" });
  assert.ok(once.startsWith(yml.trimEnd()));
  assert.match(once, /\nchisabotShell: 0123456789abcdef\n$/);
  assert.doesNotMatch(once, /fullInstall/);
  const twice = fp.stampYaml(once, { hash: "fedcba9876543210", full: true });
  assert.strictEqual((twice.match(/chisabotShell:/g) || []).length, 1);
  assert.match(twice, /chisabotShell: fedcba9876543210\nfullInstall: true\n$/);
  assert.strictEqual((twice.match(/^sha512: abc==$/m) || []).length, 1);
});

test("requiresFullInstall: only a different shell hash or an explicit fullInstall", () => {
  assert.strictEqual(requiresFullInstall({ version: "0.1.3" }, "aaaa"), false, "旧更新源没有指纹：普通更新");
  assert.strictEqual(requiresFullInstall({ version: "0.1.3", chisabotShell: "aaaa" }, "aaaa"), false);
  assert.strictEqual(requiresFullInstall({ version: "0.1.3", chisabotShell: "bbbb" }, "aaaa"), true);
  assert.strictEqual(requiresFullInstall({ version: "0.1.3", chisabotShell: "bbbb" }, ""), true, "本机没有指纹 = 外壳未知，重新安装");
  assert.strictEqual(requiresFullInstall({ version: "0.1.3", chisabotShell: "aaaa", fullInstall: true }, "aaaa"), true, "发布者强制");
  assert.strictEqual(requiresFullInstall(null, "aaaa"), false);
});

// ---------- 客户端安装方式 ----------

function fakeAutoUpdater(info, { installerPath = "C:\\Users\\u\\AppData\\Local\\chisabot-pc-updater\\pending\\ChisaBot-0.1.3-x64-setup.exe" } = {}) {
  const e = new EventEmitter();
  e.installs = [];
  e.installerPath = installerPath;
  e.checkForUpdates = async () => {
    e.emit("checking-for-update");
    e.emit("update-available", info);
    // 和 electron-updater 一样：先派发 update-downloaded，再根据 autoInstallOnAppQuit 决定挂不挂退出安装。
    e.emit("update-downloaded", info);
    e.quitHandlerAdded = e.autoInstallOnAppQuit;
    return {};
  };
  e.quitAndInstall = (silent, runAfter) => e.installs.push([silent, runAfter]);
  return e;
}

const execPath = path.join(os.tmpdir(), "chisabot-pc-shell-check", "ChisaBot.exe");
fs.mkdirSync(path.dirname(execPath), { recursive: true });
fs.writeFileSync(path.join(path.dirname(execPath), "Uninstall ChisaBot.exe"), "");

test("installed build accepts electron-builder's legacy no-space uninstaller name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-pc-uninstaller-"));
  const exe = path.join(dir, "ChisaBot.exe");
  fs.writeFileSync(exe, "");
  fs.writeFileSync(path.join(dir, "Uninstall ChisaBotPC.exe"), "");
  try {
    assert.strictEqual(isInstalledBuild({ execPath: exe, productName: "ChisaBot" }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function make(info, { shellHash = "aaaa", installerPath } = {}) {
  const autoUpdater = fakeAutoUpdater(info, installerPath === undefined ? {} : { installerPath });
  const spawned = [];
  let quits = 0;
  const updater = createUpdater({
    autoUpdater,
    isPackaged: true,
    platform: "win32",
    execPath,
    productName: "ChisaBot",
    shellHash,
    getAutoUpdate: () => true,
    spawn: (cmd, args) => spawned.push([cmd, args]),
    quitApp: () => quits++,
    timers: { setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {} },
  });
  return { updater, autoUpdater, spawned, quits: () => quits };
}

test("same shell hash → ordinary silent update via electron-updater (--updated)", async () => {
  const { updater, autoUpdater, spawned } = make({ version: "0.1.3", chisabotShell: "aaaa" });
  const state = await updater.check();
  assert.strictEqual(state.status, "downloaded");
  assert.ok(!state.fullInstall);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true, "退出时照常由 electron-updater 安装");
  assert.strictEqual(updater.installOnQuit(), false);
  assert.strictEqual(updater.install(), true);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  assert.deepStrictEqual(spawned, []);
});

test("different shell hash → reinstall: installer runs without --updated, app quits, quit-time install is ours", async () => {
  const { updater, autoUpdater, spawned, quits } = make({ version: "0.1.3", chisabotShell: "bbbb" });
  const state = await updater.check();
  assert.strictEqual(state.fullInstall, true);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, false, "electron-updater 的退出安装一定带 --updated，关掉");
  assert.strictEqual(autoUpdater.quitHandlerAdded, false);
  assert.strictEqual(updater.install(), true);
  assert.deepStrictEqual(autoUpdater.installs, [], "不走 quitAndInstall");
  assert.deepStrictEqual(spawned, [[autoUpdater.installerPath, ["/S", "--force-run"]]]);
  assert.ok(!spawned[0][1].includes("--updated"));
  assert.strictEqual(quits(), 1);
  assert.strictEqual(updater.install(), false, "不重复启动安装程序");
  assert.strictEqual(updater.installOnQuit(), false, "已经在装了，退出时不再装一次");
});

test("reinstall chosen 稍后 → quitting the app runs the silent reinstall without reopening", async () => {
  const { updater, spawned } = make({ version: "0.1.3", chisabotShell: "bbbb" });
  await updater.check();
  assert.strictEqual(updater.installOnQuit(), true);
  assert.deepStrictEqual(spawned.map(([, a]) => a), [["/S"]]);
  assert.strictEqual(updater.installOnQuit(), false);
});

test("reinstall without a downloaded installer path falls back to the ordinary update", async () => {
  const { updater, autoUpdater, spawned } = make({ version: "0.1.3", fullInstall: true }, { installerPath: null });
  const state = await updater.check();
  assert.strictEqual(state.fullInstall, true);
  assert.strictEqual(updater.install(), true);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  assert.deepStrictEqual(spawned, []);
});

// ---------- 首次启动外壳刷新 ----------

test("needsShellRefresh: new hash or never refreshed (upgraded from a version without it)", () => {
  assert.strictEqual(shellRefresh.needsShellRefresh({ current: "aaaa", last: "" }), true);
  assert.strictEqual(shellRefresh.needsShellRefresh({ current: "aaaa", last: undefined }), true);
  assert.strictEqual(shellRefresh.needsShellRefresh({ current: "aaaa", last: "bbbb" }), true);
  assert.strictEqual(shellRefresh.needsShellRefresh({ current: "aaaa", last: "aaaa" }), false);
  assert.strictEqual(shellRefresh.needsShellRefresh({ current: "", last: "" }), false, "开发运行没有指纹");
});

test("refreshShell rewrites only shortcuts that point at this exe and refreshes the icon cache", () => {
  const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\ChisaBot\\ChisaBot.exe";
  const candidates = shellRefresh.shortcutCandidates({
    desktopDir: "C:\\Users\\u\\Desktop",
    appData: "C:\\Users\\u\\AppData\\Roaming",
    shortcutName: "ChisaBot",
  });
  assert.deepStrictEqual(candidates, [
    "C:\\Users\\u\\Desktop\\ChisaBot.lnk",
    "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\ChisaBot.lnk",
    "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\ChisaBot.lnk",
  ]);
  const links = {
    [candidates[0]]: { target: exe.toLowerCase() },
    // 开始菜单那个不存在（用户删了）
    [candidates[2]]: { target: "C:\\Other\\app.exe" },
  };
  const writes = [];
  const runs = [];
  const tool = "C:\\Windows\\System32\\ie4uinit.exe";
  const result = shellRefresh.refreshShell({
    shell: {
      readShortcutLink: (p) => links[p],
      writeShortcutLink: (p, op, opts) => (writes.push([p, op, opts]), true),
    },
    exists: (p) => p in links || p === tool,
    execPath: exe,
    appUserModelId: "cn.ayase.chisabot.pc",
    candidates,
    systemRoot: "C:\\Windows",
    osRelease: "10.0.22631",
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.deepStrictEqual(result.updated, [candidates[0]]);
  assert.deepStrictEqual(writes, [[candidates[0], "update", { target: exe, icon: exe, iconIndex: 0, appUserModelId: "cn.ayase.chisabot.pc" }]]);
  assert.deepStrictEqual(runs, [[tool, ["-show"]]]);
  assert.strictEqual(result.cacheRefreshed, true);

  const win7 = [];
  shellRefresh.refreshShell({ shell: {}, exists: (p) => p === tool, execPath: exe, candidates: [], systemRoot: "C:\\Windows", osRelease: "6.1.7601", run: (c, a) => win7.push(a) });
  assert.deepStrictEqual(win7, [["-ClearIconCache"]]);
});

test("a broken shortcut does not stop the others", () => {
  const exe = "C:\\A\\ChisaBot.exe";
  const logs = [];
  const result = shellRefresh.refreshShell({
    shell: {
      readShortcutLink: (p) => {
        if (p === "bad.lnk") throw new Error("Failed to read shortcut link");
        return { target: exe };
      },
      writeShortcutLink: () => true,
    },
    exists: () => true,
    execPath: exe,
    candidates: ["bad.lnk", "good.lnk"],
    log: (l) => logs.push(l),
  });
  assert.deepStrictEqual(result.updated, ["good.lnk"]);
  assert.strictEqual(logs.length, 1);
});

test("installer.nsh is wired in and refreshes shortcuts + icon cache on every install", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PC, "package.json"), "utf8"));
  assert.strictEqual(pkg.build.nsis.include, "build/installer.nsh");
  const nsh = fs.readFileSync(path.join(PC, "build", "installer.nsh"), "utf8");
  assert.match(nsh, /!macro customInstall\b/);
  assert.match(nsh, /\$newDesktopLink/);
  assert.match(nsh, /\$newStartMenuLink/);
  assert.match(nsh, /SHChangeNotify\(i 0x08000000, i 0x1000/);
  assert.match(nsh, /ie4uinit\.exe" -show/);
  const files = pkg.build.files.join(" ");
  assert.ok(files.includes("src/**/*"), "src/shell-fingerprint.json 要打进 asar");
});

test("main wires the fingerprint into the updater, quit-time reinstall and first-launch refresh", () => {
  const main = fs.readFileSync(path.join(PC, "src", "main.js"), "utf8");
  assert.ok(main.includes("shellHash: SHELL_HASH"));
  assert.ok(main.includes("updater?.installOnQuit()"));
  assert.ok(main.includes("refreshShellIfChanged()"));
  assert.ok(main.includes("fullInstall: !!updater.state.fullInstall"));
  const ui = fs.readFileSync(path.join(PC, "src", "ui", "update.js"), "utf8");
  assert.ok(ui.includes("此更新需要重新安装，以更新图标/组件"));
  assert.ok(ui.includes('"重新安装"'));
});

// ---- 0.1.12：快捷方式图标指向按内容哈希命名的 .ico（资源管理器图标缓存按路径记，exe 路径不变会一直显示旧图标） ----

function icoEntries(buf) {
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = 6 + 16 * i;
    const size = buf[at] || 256;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const png = buf.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    out.push({ size, png, bytes, headerOk: png || buf.readUInt32LE(offset) === 40 });
  }
  return out;
}

test("build/icon.ico: brand icon 16–256, small sizes as 32-bit BMP, big as PNG; build/icons has the same bytes under its content hash", () => {
  const ico = fs.readFileSync(path.join(PC, "build", "icon.ico"));
  const entries = icoEntries(ico);
  assert.deepStrictEqual(entries.map((e) => e.size), [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  for (const e of entries) {
    assert.ok(e.headerOk, `${e.size}px 帧头不对`);
    assert.strictEqual(e.png, e.size > 48, `${e.size}px 应该是 ${e.size > 48 ? "PNG" : "BMP"}`);
  }
  const names = fs.readdirSync(path.join(PC, "build", "icons")).filter((n) => n.endsWith(".ico"));
  assert.strictEqual(names.length, 1, "build/icons 里只放当前这一份");
  const hash = require("node:crypto").createHash("sha256").update(ico).digest("hex").slice(0, 12);
  assert.strictEqual(names[0], `chisabot-${hash}.ico`, "换了 build/icon.ico 要重跑 node pc/scripts/win-icon.mjs");
  assert.ok(fs.readFileSync(path.join(PC, "build", "icons", names[0])).equals(ico));
  const pkg = JSON.parse(fs.readFileSync(path.join(PC, "package.json"), "utf8"));
  assert.deepStrictEqual(pkg.build.extraResources, [{ from: "build/icons", to: "icons", filter: ["*.ico"] }]);
  assert.strictEqual(pkg.build.win.icon, "build/icon.ico");
});

test("fingerprint covers build/icons and differs from 0.1.11 (a37303ffb08b9d60) → old clients reinstall", () => {
  const inputs = fp.collectInputs ? fp.collectInputs() : fp.compute().inputs;
  assert.ok(Object.keys(inputs).some((k) => k.startsWith("build/icons/")));
  assert.notStrictEqual(fp.compute().hash, "a37303ffb08b9d60");
  assert.strictEqual(requiresFullInstall({ version: "0.1.12", chisabotShell: fp.compute().hash }, "a37303ffb08b9d60"), true);
});

test("installer.nsh points shortcuts at resources\\icons\\chisabot-*.ico and notifies the shell per file", () => {
  const nsh = fs.readFileSync(path.join(PC, "build", "installer.nsh"), "utf8");
  assert.match(nsh, /FindFirst \$R8 \$R9 "\$INSTDIR\\resources\\icons\\chisabot-\*\.ico"/);
  assert.match(nsh, /CreateShortCut "\$\{LINK\}" "\$appExe" "" "\$chisabotIcon" 0/);
  assert.match(nsh, /SHChangeNotify\(i 0x2000, i 0x0005, w "\$\{LINK\}"/);
  assert.match(nsh, /!ifndef BUILD_UNINSTALLER\s+Var chisabotIcon\s+!endif/, "卸载程序里不能有没用到的变量（warningsAsErrors）");
  assert.ok(nsh.indexOf("!insertmacro chisabotFindIcon") < nsh.indexOf('!insertmacro chisabotRefreshLink "$newDesktopLink"'));
});

test("findIcon / scanShortcuts / staleShortcuts / refreshShell with the hashed icon", () => {
  const res = "C:\\Users\\u\\AppData\\Local\\Programs\\ChisaBot\\resources";
  const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\ChisaBot\\ChisaBot.exe";
  const ico = `${res}\\icons\\chisabot-61767ffc510d.ico`;
  assert.strictEqual(shellRefresh.findIcon({ resourcesPath: res, readdir: () => ["x.png", "chisabot-61767ffc510d.ico"] }), ico);
  assert.strictEqual(shellRefresh.findIcon({ resourcesPath: res, readdir: () => { throw new Error("ENOENT"); } }), "");
  assert.strictEqual(shellRefresh.findIcon({}), "");

  const desk = "C:\\Users\\u\\Desktop";
  const appData = "C:\\Users\\u\\AppData\\Roaming";
  const start = `${appData}\\Microsoft\\Windows\\Start Menu\\Programs`;
  const bar = `${appData}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar`;
  const tree = {
    [desk]: ["ChisaBot.lnk", "ChisaBot - 副本.lnk", "笔记.txt", "别的.lnk"],
    [start]: ["ChisaBot.lnk", "工具"],
    [`${start}\\工具`]: ["ChisaBot.lnk"],
    [bar]: ["ChisaBot (2).lnk"],
  };
  const found = shellRefresh.scanShortcuts({ desktopDir: desk, appData, readdir: (d) => { if (!(d in tree)) throw new Error("ENOENT"); return tree[d]; }, isDir: (p) => p in tree });
  assert.deepStrictEqual(found, [
    `${desk}\\ChisaBot.lnk`, `${desk}\\ChisaBot - 副本.lnk`, `${desk}\\别的.lnk`,
    `${start}\\ChisaBot.lnk`, `${start}\\工具\\ChisaBot.lnk`, `${bar}\\ChisaBot (2).lnk`,
  ]);

  const oldExe = "D:\\旧\\ChisaBot PC\\ChisaBotPC.exe"; // 以前装在别处、现在已经删了
  const links = {
    [`${desk}\\ChisaBot.lnk`]: { target: exe, icon: exe, iconIndex: 0 },
    [`${desk}\\ChisaBot - 副本.lnk`]: { target: oldExe },
    [`${desk}\\别的.lnk`]: { target: "C:\\Windows\\notepad.exe" },
    [`${start}\\ChisaBot.lnk`]: { target: exe, icon: ico },
    [`${bar}\\ChisaBot (2).lnk`]: { target: exe.toUpperCase(), icon: "" },
  };
  const exists = (p) => p in links || p === exe || p === ico;
  const shell = { readShortcutLink: (p) => links[p], writeShortcutLink: (p, op, opts) => (writes.push([p, opts.target, opts.icon]), true) };
  const writes = [];
  const stale = shellRefresh.staleShortcuts({ shell, exists, execPath: exe, icon: ico, candidates: found });
  assert.deepStrictEqual(stale, [`${desk}\\ChisaBot.lnk`, `${desk}\\ChisaBot - 副本.lnk`, `${bar}\\ChisaBot (2).lnk`]);
  // 全都已经是新图标：不需要刷新。
  assert.deepStrictEqual(shellRefresh.staleShortcuts({ shell: { readShortcutLink: () => ({ target: exe, icon: ico }) }, exists: () => true, execPath: exe, icon: ico, candidates: found }), []);

  const result = shellRefresh.refreshShell({ shell, exists, execPath: exe, icon: ico, candidates: [...found, `${desk}\\ChisaBot.lnk`] });
  assert.deepStrictEqual(result.updated, [`${desk}\\ChisaBot.lnk`, `${desk}\\ChisaBot - 副本.lnk`, `${start}\\ChisaBot.lnk`, `${bar}\\ChisaBot (2).lnk`]);
  assert.ok(writes.every(([, target, icon]) => target === exe && icon === ico));
  assert.strictEqual(writes.length, 4, "同一个快捷方式只写一次，别人的不碰");
});

test("main: window icon = hashed .ico on Windows; launch checks stale shortcuts even when the fingerprint is unchanged", () => {
  const main = fs.readFileSync(path.join(PC, "src", "main.js"), "utf8");
  assert.ok(!main.includes('icon: path.join(ASSETS, "icon.png")'), "窗口都用 WINDOW_ICON");
  assert.ok(main.includes("shellRefresh.findIcon({ resourcesPath: process.resourcesPath })"));
  assert.ok(main.includes("shellRefresh.staleShortcuts("));
  assert.ok(main.includes("shellRefresh.scanShortcuts("));
});
