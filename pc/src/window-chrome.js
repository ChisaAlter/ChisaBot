"use strict";
/**
 * 本机小窗口的「窗框」（DESIGN.md §91）：登录窗、本机确认、审批弹窗、更新提示都无边框、圆角，和主窗口同一套做法。
 *
 *  - Windows（10 和 11）、Linux：透明窗口，网页自己把整页裁成 WINDOW_RADIUS 圆角（chrome.css 里 html[data-frame="clip"]），
 *    外沿一圈很淡的墨色细线（不是白边）。frameMode = "clip"。
 *    为什么 Windows 11 也不用系统圆角（DWM + thickFrame，主窗口的做法）：在 Windows 真机 Electron 44 上截图（pc-shots.yml），
 *    125% / 150% 缩放下这些小窗口左右两侧会露出 1–2px 的浅色窗框边（≈ #d7d8d9 / #f1f1f1），深色时就是一圈白边——
 *    正是「多了圈边框」；没有 GPU 的 Windows 11（虚拟机、远程桌面）系统也不画圆角。透明裁切在 100/125/150% 都只有一道边。
 *    代价：透明窗口没有系统阴影。
 *  - macOS：不透明无边框窗口，系统画圆角和阴影。frameMode = "dwm"。
 *  - 设置 CHISABOT_WINDOW_FRAME=dwm|clip 可以强制某一种（排查用）。
 *  - 这些窗口都不能改大小、不能最大化 / 全屏（右上角只有最小化 + 关闭，弹窗只有自己的按钮）。
 *
 * 纯函数，pc/test/window-chrome.check.js 直接测；main.js 和截图脚本（scripts/shots/）都只从这里拿窗口参数。
 */

/** 和 Windows 11 系统圆角一致（DWM 固定约 8px）；Windows 10 的透明裁切用同一个值。 */
const WINDOW_RADIUS = 8;
/** 登录窗尺寸（DIP）：固定大小，不能拖边调整。 */
const LOGIN_SIZE = { width: 460, height: 760 };

/** Windows 版本号 "10.0.22631" → 22631；拿不到时 0。 */
function windowsBuild(release) {
  const parts = String(release || "").split(".");
  const build = Number(parts[2]);
  return Number.isFinite(build) ? build : 0;
}

/**
 * 这台系统上本机小窗口用哪种窗框。
 * @param {{platform: string, release?: string}} sys process.platform + os.release()
 * @returns {"dwm" | "clip"}
 */
function frameMode({ platform, override } = {}) {
  if (override === "dwm" || override === "clip") return override;
  if (platform === "darwin") return "dwm";
  return "clip";
}

/** 登录窗高度：放得下就 760，矮屏幕（如 1366×768 @125% 工作区只有 ~614）贴着工作区留 24px。 */
function loginHeight(workAreaHeight) {
  const h = Number(workAreaHeight);
  if (!Number.isFinite(h) || h <= 0) return LOGIN_SIZE.height;
  return Math.max(480, Math.min(LOGIN_SIZE.height, Math.floor(h - 24)));
}

/**
 * 无边框小窗口的公共参数。background：dwm 模式下窗口底色（天空色，避免载入前闪白）。
 * clip 模式窗口本身完全透明，圆角外露出桌面。
 */
function chromeOptions(mode, { background = "#9dbddc" } = {}) {
  const base = {
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
  };
  if (mode === "clip") return { ...base, thickFrame: false, transparent: true, hasShadow: false, backgroundColor: "#00000000" };
  // thickFrame 让 Windows 11 给无边框窗口画系统圆角和阴影；resizable:false 时 Electron 不会因此允许拖边。
  // titleBarStyle 只在 macOS 生效：hiddenInset = 原生红绿灯（左上），网页里的 .win-ctrl 由 chrome.css 按 data-os 隐藏。
  return { ...base, titleBarStyle: "hiddenInset", thickFrame: true, transparent: false, hasShadow: true, backgroundColor: background };
}

/** 登录窗：固定 460×760，可以最小化，不能最大化 / 改大小。 */
function loginWindowOptions(mode, opts = {}) {
  return {
    ...chromeOptions(mode, opts),
    width: LOGIN_SIZE.width,
    height: opts.workAreaHeight ? loginHeight(opts.workAreaHeight) : LOGIN_SIZE.height,
    minimizable: true,
    title: "登录 ChisaBot",
  };
}

/** 本机确认 / 审批 / 更新提示：同一套窗框，自己没有最小化。 */
function dialogWindowOptions(mode, opts) {
  return { ...chromeOptions(mode, opts), minimizable: false };
}

/** 交给页面的查询参数：页面据此决定要不要自己裁圆角（chrome.js 读 ?frame=）。 */
function frameQuery(mode) {
  return { frame: mode };
}

/**
 * 弹窗按内容定高：页面量出内容高度后报上来（dialog:fit），夹在 [min, max] 里、取整。
 * @returns {number}
 */
function fitHeight(height, { min = 160, max = 640 } = {}) {
  if (typeof height !== "number" || !Number.isFinite(height)) return 0;
  return Math.round(Math.min(max, Math.max(min, Math.ceil(height))));
}

module.exports = {
  WINDOW_RADIUS,
  LOGIN_SIZE,
  windowsBuild,
  frameMode,
  loginHeight,
  chromeOptions,
  loginWindowOptions,
  dialogWindowOptions,
  frameQuery,
  fitHeight,
};
