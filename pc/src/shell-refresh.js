"use strict";
/**
 * 外壳刷新（docs/online-update.md §2.1）：更新换了图标 / 安装配置之后，第一次启动新版本时把 Windows 上
 * 指向本程序的快捷方式按新 exe 重写，并让资源管理器重建图标缓存。
 *
 * 为什么需要：在线更新用 --updated 模式静默运行安装包，快捷方式原样保留，图标缓存也不刷新——exe 里的图标
 * 明明换了，桌面 / 开始菜单 / 任务栏上还是旧的。安装脚本（build/installer.nsh）会处理桌面和开始菜单；
 * 这里再兜一次底，并且顺带处理任务栏固定的快捷方式（安装程序不碰它）。
 *
 * 何时运行：src/shell-fingerprint.json 的哈希和本机 config.json 记下的 shellHash 不同（包括第一次装上带
 * 这个功能的版本，那时 shellHash 为空）；或者（0.1.12 起每次启动都看一眼）有指向本程序的快捷方式图标不是
 * 现在这份 resources\icons\chisabot-<哈希>.ico。只改指向本程序 exe 的快捷方式（以及指向已经不存在的
 * 旧安装位置里旧 exe 的快捷方式——换了安装目录重装后，旧快捷方式会一直显示旧图标）。
 *
 * 图标为什么指向单独的 .ico 而不是 exe：资源管理器按「图标文件路径 + 序号」缓存图标，exe 路径不变就可能
 * 一直用缓存里的旧图（0.1.11 在 Windows 11 上重新安装后仍是旧图标）。按内容哈希命名的 .ico 是新路径，必然重新读取。
 */
const fs = require("node:fs");
const path = require("node:path");

function loadFingerprint(file = path.join(__dirname, "shell-fingerprint.json")) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof data.hash === "string" && data.hash ? data.hash : "";
  } catch {
    return "";
  }
}

/** resources\icons 里按内容哈希命名的图标（打包时 build/icons → resources/icons）；没有就返回 ""。 */
function findIcon({ resourcesPath, readdir = fs.readdirSync } = {}) {
  if (!resourcesPath) return "";
  try {
    const name = readdir(path.win32.join(resourcesPath, "icons"))
      .filter((n) => /^chisabot-[0-9a-f]{6,}\.ico$/i.test(n))
      .sort()[0];
    return name ? path.win32.join(resourcesPath, "icons", name) : "";
  } catch {
    return "";
  }
}

/**
 * 去这几个地方找 .lnk：桌面、开始菜单 Programs（含一层子文件夹）、任务栏固定。名字不一定是「ChisaBot.lnk」
 * （用户自己固定 / 复制出来的可能叫别的），所以列目录，再按目标判断是不是本程序。
 */
function scanShortcuts({ desktopDir, appData, readdir = fs.readdirSync, isDir = (p) => fs.statSync(p).isDirectory() }) {
  const dirs = [];
  if (desktopDir) dirs.push([desktopDir, 0]);
  if (appData) {
    dirs.push([path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"), 1]);
    dirs.push([path.win32.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"), 0]);
  }
  const out = [];
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.win32.join(dir, name);
      if (/\.lnk$/i.test(name)) out.push(full);
      else if (depth > 0) {
        try {
          if (isDir(full)) walk(full, depth - 1);
        } catch {}
      }
    }
  };
  for (const [dir, depth] of dirs) walk(dir, depth);
  return out;
}

/** 可能指向本程序的快捷方式：桌面、开始菜单（用户级）、任务栏固定。 */
function shortcutCandidates({ desktopDir, appData, shortcutName }) {
  const list = [];
  if (desktopDir) list.push(path.win32.join(desktopDir, `${shortcutName}.lnk`));
  if (appData) {
    list.push(path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", `${shortcutName}.lnk`));
    list.push(path.win32.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", `${shortcutName}.lnk`));
  }
  return list;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.win32.normalize(String(a)).toLowerCase() === path.win32.normalize(String(b)).toLowerCase();
}

/** 外壳哈希变了才需要刷新。本机没记过（旧版本升上来）= 需要。 */
function needsShellRefresh({ current, last }) {
  if (!current) return false;
  return current !== (last || "");
}

/** 改名前（≤0.1.128）的 exe 名：旧安装被卸掉后，指向它的快捷方式也算本程序的，照样重定向到新 exe。 */
const LEGACY_EXE_BASENAMES = new Set(["chisabotpc.exe"]);

/** 这个快捷方式是不是本程序的：目标就是现在的 exe；或者目标是指向已不存在的旧安装位置的旧 exe。 */
function pointsAtUs(target, execPath, exists) {
  if (!target) return false;
  if (samePath(target, execPath)) return true;
  const base = path.win32.basename(String(target)).toLowerCase();
  return (base === path.win32.basename(String(execPath)).toLowerCase() || LEGACY_EXE_BASENAMES.has(base)) && !exists(target);
}

/** 图标已经是想要的那份？（icon 为空 = 用 exe 自己的图标） */
function iconUpToDate(info, wanted, execPath) {
  const icon = info?.icon ? String(info.icon) : "";
  if (wanted) return samePath(icon, wanted);
  return !icon || samePath(icon, execPath);
}

/**
 * 有没有指向本程序、但图标还不是 wanted 的快捷方式（每次启动用它决定要不要刷新；只读，不改）。
 */
function staleShortcuts({ shell, exists = fs.existsSync, execPath, icon = "", candidates }) {
  const stale = [];
  for (const link of candidates) {
    try {
      if (!exists(link)) continue;
      const info = shell.readShortcutLink(link);
      if (!pointsAtUs(info?.target, execPath, exists)) continue;
      if (!samePath(info?.target, execPath) || !iconUpToDate(info, icon, execPath)) stale.push(link);
    } catch {}
  }
  return stale;
}

/**
 * 重写快捷方式 + 刷新图标缓存。所有依赖可注入，方便测试。返回 { updated: [路径], cacheRefreshed }。
 *  - shell：Electron shell（readShortcutLink / writeShortcutLink，只在 Windows 上有）
 *  - icon：resources\icons\chisabot-<哈希>.ico（findIcon）；空 = 用 exe 里的图标
 *  - run(cmd, args)：启动外部程序，不等待
 */
function refreshShell({ shell, exists = fs.existsSync, execPath, icon = "", appUserModelId, candidates, systemRoot, osRelease = "", run, log = () => {} }) {
  const updated = [];
  const seen = new Set();
  for (const link of candidates) {
    const key = String(link).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!exists(link)) continue;
      const info = shell.readShortcutLink(link);
      if (!pointsAtUs(info?.target, execPath, exists)) continue;
      const ok = shell.writeShortcutLink(link, "update", {
        target: execPath,
        icon: icon || execPath,
        iconIndex: 0,
        ...(appUserModelId ? { appUserModelId } : {}),
      });
      if (ok) updated.push(link);
    } catch (error) {
      log(`快捷方式 ${link} 更新失败：${error?.message || error}`);
    }
  }
  let cacheRefreshed = false;
  if (systemRoot && run) {
    const tool = path.win32.join(systemRoot, "System32", "ie4uinit.exe");
    if (exists(tool)) {
      // Windows 10+（内核 10.x）用 -show；更早的用 -ClearIconCache。
      const major = Number(String(osRelease).split(".")[0]) || 10;
      try {
        run(tool, [major >= 10 ? "-show" : "-ClearIconCache"]);
        cacheRefreshed = true;
      } catch (error) {
        log(`刷新图标缓存失败：${error?.message || error}`);
      }
    }
  }
  return { updated, cacheRefreshed };
}

module.exports = { loadFingerprint, shortcutCandidates, scanShortcuts, findIcon, staleShortcuts, needsShellRefresh, refreshShell, samePath, pointsAtUs };
