"use strict";
/**
 * 本机小窗口截图（DESIGN.md §91）：在真的 Windows 上用真的 Electron 打开登录窗、审批弹窗、本机确认、更新提示，
 * 窗口参数取自 src/window-chrome.js（和 main.js 同一份），页面就是 src/ui/ 下的原文件 + src/preload.js。
 * 主进程的数据用假的（不连服务器、不碰配置），只为看窗框、圆角、边缘和布局。
 *
 * 每个窗口两张图：
 *   <name>-desktop.png  整个桌面合成后的截图（含系统圆角 / 阴影 / DWM 边框），窗口外留 24px，背后垫一块中灰底，
 *                       白边或双层边框在灰底上一眼可见；
 *   <name>-page.png     webContents.capturePage（页面本身）。
 *
 * 用法（pc/ 目录）：npx electron scripts/shots/main.js --out=shots [--scale=1.25] [--frame=clip]
 * CI：.github/workflows/pc-shots.yml（windows-latest，100% / 125% / 150% × dwm / clip × 亮 / 暗）。
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require("electron");
const chrome = require("../../src/window-chrome");
const { expandUpdateWindowBounds } = require("../../src/update-backdrop");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = path.resolve(arg("out", "shots"));
const SCALE = Number(arg("scale", "1"));
const FRAME = arg("frame", chrome.frameMode({ platform: process.platform }));
const ONLY = arg("only", "");
if (SCALE && SCALE !== 1) app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
app.commandLine.appendSwitch("disable-gpu-vsync");

const SRC = path.join(__dirname, "..", "..", "src");
const UI = path.join(SRC, "ui");
const PRELOAD = path.join(SRC, "preload.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dark = false;
const current = { approval: null, confirm: null, update: null };
const log = [];

function state() {
  return {
    version: "0.1.15",
    platform: process.platform,
    hostname: "SHOTS",
    serverUrl: "",
    defaultServerUrl: "",
    recentServers: [],
    remember: true,
    username: "",
    loggedIn: false,
    status: "offline",
    statusText: "未登录",
    appearance: { dark, sky: false },
    local: {},
  };
}

function register() {
  ipcMain.handle("state:get", () => state());
  ipcMain.handle("approval:current", () => current.approval);
  ipcMain.handle("confirm:current", () => current.confirm);
  ipcMain.handle("update:current", () => current.update);
  for (const ch of ["approval:decide", "confirm:answer", "update:answer", "login:probe", "login:submit", "login:forget", "login:open", "paused:set", "chat:retry"])
    ipcMain.handle(ch, () => null);
  ipcMain.handle("window:local", () => true);
  const fit = (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const h = chrome.fitHeight(height);
    if (!win || !h) return false;
    const b = win.getBounds();
    // 用创建时的宽度：小数缩放下 getBounds 会多出几 px，拿它回写会越写越宽。
    win.setBounds({ x: b.x, y: b.y, width: win.chisaWidth || b.width, height: h });
    win.emit("chisa-fit");
    return true;
  };
  ipcMain.handle("dialog:fit", (event, { height } = {}) => fit(event, height));
  ipcMain.handle("update:fit", (event, { height } = {}) => {
    const pad = expandUpdateWindowBounds({ x: 0, y: 0, width: 0, height: 0 }, FRAME).pad;
    return fit(event, typeof height === "number" ? height + pad * 2 : height);
  });
}

/** 中灰垫底窗口：白边 / 双层边框在它上面最明显。 */
function backdrop() {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...workArea,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: "#6b7280",
    show: false,
  });
  win.loadURL("data:text/html,<body style='margin:0;background:%236b7280'></body>");
  // 盖住 runner 的控制台窗口；截图窗口用更高的 screen-saver 层。
  win.setAlwaysOnTop(true, "floating");
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

async function desktopShot(bounds, file) {
  const display = screen.getDisplayMatching(bounds);
  const sf = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
  });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error("no screen source");
  const img = src.thumbnail;
  const M = 24;
  // --force-device-scale-factor 只放大窗口内容和尺寸，窗口左上角在屏幕上的物理坐标仍等于 DIP 坐标（实测）。
  const crop = {
    x: Math.max(0, Math.round(bounds.x - display.bounds.x - M)),
    y: Math.max(0, Math.round(bounds.y - display.bounds.y - M)),
    width: Math.round((bounds.width + M * 2) * sf),
    height: Math.round((bounds.height + M * 2) * sf),
  };
  const size = img.getSize();
  crop.width = Math.min(crop.width, size.width - crop.x);
  crop.height = Math.min(crop.height, size.height - crop.y);
  fs.writeFileSync(file, img.crop(crop).toPNG());
  return { sf, crop, thumb: size };
}

async function open(name, page, options, { fitted = false } = {}) {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...options,
    x: workArea.x + 60,
    y: workArea.y + 40,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  win.chisaWidth = options.width;
  win.setAlwaysOnTop(true, "screen-saver");
  const shown = new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      win.show();
      resolve();
    };
    if (fitted) win.once("chisa-fit", go);
    win.once("ready-to-show", () => setTimeout(go, fitted ? 1500 : 0));
  });
  await win.loadFile(path.join(UI, page), { query: chrome.frameQuery(FRAME) });
  await shown;
  win.focus();
  await sleep(900);
  const tag = `${name}-${dark ? "dark" : "light"}`;
  const bounds = win.getBounds();
  const page_ = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${tag}-page.png`), page_.toPNG());
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el ? el.getBoundingClientRect().toJSON() : null;
    return {
      frame: document.documentElement.dataset.frame,
      dpr: devicePixelRatio,
      inner: [innerWidth, innerHeight],
      main: r(q("main")),
      code: r(q(".dialog-code")),
      codeScroll: q(".dialog-code") ? [q(".dialog-code").scrollHeight, q(".dialog-code").clientHeight] : null,
      winbar: r(q(".win-bar")),
      card: r(q(".login-card")),
      tab: (() => { const order = []; const els = [...document.querySelectorAll("button, input, [tabindex]")].filter((e) => !e.disabled && e.offsetParent !== null && e.tabIndex >= 0); for (const e of els) order.push(e.id || e.dataset.win || e.className); return order; })(),
      bodyBg: getComputedStyle(document.documentElement).backgroundImage,
    };
  })()`);
  let desk = null;
  try {
    desk = await desktopShot(bounds, path.join(OUT, `${tag}-desktop.png`));
  } catch (e) {
    desk = { error: String(e) };
  }
  log.push({ tag, frame: FRAME, scale: SCALE, bounds, metrics, desk });
  win.destroy();
  await sleep(300);
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  register();
  const bg = backdrop();
  await sleep(800);
  const background = () => (dark ? "#12203a" : "#9dbddc");
  for (const d of [false, true]) {
    dark = d;
    if (!ONLY || ONLY.includes("login")) await open("login", "login.html", { ...chrome.loginWindowOptions(FRAME, { background: background(), workAreaHeight: screen.getPrimaryDisplay().workArea.height }) });
    current.approval = {
      id: "a1",
      botName: "星灵",
      operation: "list_files",
      summary: "列出: C:\\（C:\\ 不在允许的文件夹里；批准后会把整个 C:\\ 加入允许的文件夹）",
      remainingMs: 595000,
    };
    if (!ONLY || ONLY.includes("approval"))
      await open("approval", "approval.html", { ...chrome.dialogWindowOptions(FRAME, { background: background() }), width: 460, height: 320 }, { fitted: true });
    current.approval = {
      id: "a2",
      botName: "星灵",
      operation: "edit_file",
      summary: "修改: D:\\work\\notes\\todo.md",
      diff: ["--- a/todo.md", "+++ b/todo.md", "@@ -1,6 +1,8 @@", ...Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `+ 新增第 ${i} 行` : i % 3 === 1 ? `- 删掉第 ${i} 行` : `  第 ${i} 行`))].join("\n"),
      remainingMs: 110000,
    };
    if (!ONLY || ONLY.includes("approval"))
      await open("approval-diff", "approval.html", { ...chrome.dialogWindowOptions(FRAME, { background: background() }), width: 560, height: 520 }, { fitted: true });
    current.confirm = { id: "c1", title: "解除紧急停止？", description: "解除后，机器人可以再次按这台电脑的权限设置操作它（「询问」的操作仍会先问你）。", confirmLabel: "解除紧急停止" };
    if (!ONLY || ONLY.includes("confirm"))
      await open("confirm", "confirm.html", { ...chrome.dialogWindowOptions(FRAME, { background: background() }), width: 440, height: 260 }, { fitted: true });
    current.update = { version: "0.1.15", currentVersion: "0.1.14", fullInstall: false };
    if (!ONLY || ONLY.includes("update")) {
      const updateBox = expandUpdateWindowBounds({ x: 0, y: 0, width: 440, height: 260 }, FRAME);
      await open("update", "update.html", { ...chrome.dialogWindowOptions(FRAME, { background: background() }), width: updateBox.width, height: updateBox.height }, { fitted: true });
    }
  }
  bg.destroy();
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify({ frame: FRAME, scale: SCALE, os: `${os.type()} ${os.release()}`, electron: process.versions.electron, shots: log }, null, 2));
  console.log(`shots: ${log.length} → ${OUT}`);
}

app.whenReady().then(() =>
  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => app.quit()),
);
