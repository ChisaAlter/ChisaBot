"use strict";
/**
 * 在线更新（docs/online-update.md §PC）。
 *
 *  - 更新源：electron-updater 的 generic provider，指向一个公开的更新目录（build-config.js 的
 *    resolveFeed：本机覆盖 → 构建期 updateFeed → GitHub Releases 的 latest/download/），里面是
 *    latest.yml + 安装包 + .blockmap。latest.yml 里有安装包的 sha512，下载完 electron-updater 会校验，
 *    不一致就丢弃，不会安装。
 *  - 安装包没有代码签名：build.win.verifyUpdateCodeSignature = false（app-update.yml 里就没有
 *    publisherName，NsisUpdater 不做 Authenticode 校验）；这里再把校验函数设成「通过」，两边一致。
 *    完整性靠 HTTPS + latest.yml 的 sha512。
 *  - 什么时候检查：开着「自动更新」时，启动 30 秒后一次、之后每 30 分钟一次；下载在后台进行，下载好了
 *    调 onDownloaded（主进程弹本机窗口「新版本已下载，重启以安装」：立即重启 / 稍后）。选「稍后」时，
 *    下次退出 ChisaBot PC 时自动安装（autoInstallOnAppQuit）。
 *  - 关掉「自动更新」只停掉定时检查；网页「本机」标签里的「检查更新」照样可以手动检查和下载。
 *  - 只有 NSIS 安装版能更新（安装目录里有卸载程序）。开发运行、免安装 zip 一律 supported = false。
 *  - 两种安装方式（docs/online-update.md §2.1）。每次更新下载的都是完整安装包，区别只在怎么运行它：
 *    · 普通更新：electron-updater 的 quitAndInstall → 安装包带 --updated /S 运行，保留快捷方式；
 *    · 重新安装：latest.yml 的 chisabotShell（外壳指纹：图标、安装脚本、Electron 版本…，见
 *      scripts/shell-fingerprint.js）和本机的不同，或者 fullInstall: true。安装包不带 --updated，以 /S --force-run
 *      运行：卸载旧版（保留数据）、全新安装、重建快捷方式、刷新图标缓存，装好后自动打开。弹窗文案换成
 *      「此更新需要重新安装，以更新图标/组件」。选「稍后」时退出程序那一刻同样走重新安装（installOnQuit）。
 */
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const FIRST_CHECK_MS = 30 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;

function cleanMessage(error) {
  const text = error && error.message ? String(error.message) : String(error || "未知错误");
  const first = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(first)) return "连不上更新服务器，请检查网络。";
  if (/sha512 checksum mismatch/i.test(first)) return "下载的安装包校验失败，已丢弃，稍后会重新下载。";
  if (/404|Cannot find latest\.yml|HttpError: 404/i.test(first)) return "更新服务器上还没有发布版本信息。";
  return first.slice(0, 160);
}

/**
 * 这次更新要不要「重新安装」：发布者强制（fullInstall: true），或者新版的外壳指纹和本机不同。
 * 旧的更新源没有 chisabotShell：不知道，按普通更新走。
 */
function requiresFullInstall(info, localShell) {
  if (!info || typeof info !== "object") return false;
  if (info.fullInstall === true || info.fullInstall === "true") return true;
  const remote = typeof info.chisabotShell === "string" ? info.chisabotShell.trim() : "";
  if (!remote) return false;
  return remote !== String(localShell || "");
}

function defaultSpawn(cmd, args) {
  const child = childProcess.spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child;
}

function defaultQuit() {
  try {
    require("electron").app.quit();
  } catch {}
}

/** NSIS 安装版：安装目录里有卸载程序。免安装 zip 解压出来的没有。 */
function isInstalledBuild({ execPath, productName, exists = fs.existsSync }) {
  const dir = path.dirname(execPath);
  // electron-builder 的 NSIS 卸载程序用 executableName（ChisaBotPC），不带 productName 里的空格。
  // 先找带空格的名字（旧安装器 / 测试），再找去掉空格的名字（当前安装包）。
  const compact = String(productName).replace(/\s+/g, "");
  return [`Uninstall ${productName}.exe`, `Uninstall ${compact}.exe`].some((name) => exists(path.join(dir, name)));
}

function createUpdater({ autoUpdater, feedUrl, isPackaged, platform, execPath, productName, shellHash = "", getAutoUpdate, onState, onDownloaded, logger, spawn = defaultSpawn, quitApp = defaultQuit, timers = { setTimeout, setInterval, clearTimeout, clearInterval }, now = () => new Date() }) {
  const supported = Boolean(isPackaged && platform === "win32" && autoUpdater && isInstalledBuild({ execPath, productName }));
  const state = { supported, status: "idle" };
  let installing = false;
  let firstTimer = null;
  let interval = null;
  let checking = null;

  function set(patch) {
    Object.assign(state, patch);
    if (state.status !== "downloading") delete state.percent;
    if (state.status !== "error") delete state.error;
    if (!state.fullInstall) delete state.fullInstall;
    onState?.({ ...state });
  }

  if (supported) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    if (logger) autoUpdater.logger = logger;
    // 运行时指定更新源（覆盖打包时的 app-update.yml）；不给就沿用 app-update.yml。
    if (feedUrl) autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    // 安装包不签名：见文件头。只影响 Authenticode；sha512 校验照常。
    try {
      autoUpdater.verifyUpdateCodeSignature = async () => null;
    } catch {}
    autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
    autoUpdater.on("update-available", (info) =>
      set({ status: "downloading", version: info?.version, percent: 0, fullInstall: requiresFullInstall(info, shellHash) }),
    );
    autoUpdater.on("update-not-available", () => set({ status: "none", version: undefined, fullInstall: false, checkedAt: now().toISOString() }));
    autoUpdater.on("download-progress", (progress) => {
      if (state.status === "downloaded") return;
      set({ status: "downloading", percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      const fullInstall = info ? requiresFullInstall(info, shellHash) : Boolean(state.fullInstall);
      // 重新安装不能交给 electron-updater 的「退出时安装」（它一定带 --updated）；退出时由 installOnQuit 处理。
      if (fullInstall) autoUpdater.autoInstallOnAppQuit = false;
      set({ status: "downloaded", version: info?.version || state.version, fullInstall, checkedAt: now().toISOString() });
      onDownloaded?.(state.version);
    });
    autoUpdater.on("error", (error) => {
      if (state.status === "downloaded") return;
      set({ status: "error", error: cleanMessage(error), checkedAt: now().toISOString() });
    });
  }

  async function check() {
    if (!supported) return { ...state };
    if (state.status === "downloaded" || state.status === "downloading") return { ...state };
    if (checking) return checking;
    checking = (async () => {
      set({ status: "checking" });
      try {
        await autoUpdater.checkForUpdates();
        if (state.status === "checking") set({ status: "none", checkedAt: now().toISOString() });
      } catch (error) {
        set({ status: "error", error: cleanMessage(error), checkedAt: now().toISOString() });
      } finally {
        checking = null;
      }
      return { ...state };
    })();
    return checking;
  }

  function schedule() {
    stop();
    if (!supported || !getAutoUpdate()) return;
    firstTimer = timers.setTimeout(() => void check(), FIRST_CHECK_MS);
    interval = timers.setInterval(() => {
      if (getAutoUpdate()) void check();
    }, INTERVAL_MS);
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (interval) timers.clearInterval(interval);
    firstTimer = null;
    interval = null;
  }

  /**
   * 重新安装：自己运行下载好的安装包，不带 --updated（electron-updater 的 quitAndInstall 一定会带）。
   * /S 静默；runAfter 时加 --force-run，装好自动打开。安装目录沿用注册表里上次的（NSIS 自己读）。
   * 拿不到安装包路径时退回普通更新（安装脚本和首次启动的外壳刷新仍会更新快捷方式和图标缓存）。
   */
  function runFullInstaller({ runAfter }) {
    const installer = autoUpdater.installerPath;
    if (!installer) {
      logger?.warn?.("重新安装：找不到已下载的安装包，退回普通更新");
      autoUpdater.autoInstallOnAppQuit = true;
      if (runAfter) autoUpdater.quitAndInstall(true, true);
      return runAfter;
    }
    autoUpdater.autoInstallOnAppQuit = false;
    spawn(installer, runAfter ? ["/S", "--force-run"] : ["/S"]);
    installing = true;
    return true;
  }

  /** 退出并静默安装，装好后自动重新打开。只在已经下载好时有效。 */
  function install() {
    if (!supported || state.status !== "downloaded" || installing) return false;
    if (state.fullInstall) {
      if (runFullInstaller({ runAfter: true })) quitApp();
      return true;
    }
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  /** 用户退出程序时：已下载且需要重新安装 → 静默重新安装（不自动打开）。普通更新由 electron-updater 自己处理。 */
  function installOnQuit() {
    if (!supported || state.status !== "downloaded" || !state.fullInstall || installing) return false;
    return runFullInstaller({ runAfter: false });
  }

  return { get state() { return { ...state }; }, supported, feedUrl: feedUrl || "", check, schedule, stop, install, installOnQuit };
}

module.exports = { createUpdater, cleanMessage, isInstalledBuild, requiresFullInstall, FIRST_CHECK_MS, INTERVAL_MS };
