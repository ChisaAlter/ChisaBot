"use strict";
/**
 * ChisaBot 桌面客户端（Electron 主进程）。docs/pc-node.md §8。
 *
 *  - 登录（ui/login.html）：本机的「登录 ChisaBot」页 —— 服务器地址（记住、带历史）+ 账号 + 密码
 *    + 记住登录。先探测地址，再直接请求服务器登录网关（和网页登录表单同一个 POST /auth/login），会话 Cookie
 *    写进主窗口的会话，再登记设备拿到令牌（DPAPI 加密保存）。密码从不保存。启动时会话仍有效就直接进入；
 *    主窗口被服务器跳到 /login（会话过期）时换回本机登录页，不再显示服务器的网页登录页。
 *  - 主窗口：直接载入该服务器的 ChisaBot 网页（登录 Cookie 已注入）——聊天、偏好设置、管理后台和网页完全同一套
 *    界面；本机设置就是网页的 偏好设置 → 设备 → 这台电脑（「本机」标签），通过 web-preload.js 的本机桥读写
 *    只能在本机做的事（紧急停止、本机确认、开机自启、文件夹选择器、退出登录）。关闭时缩到托盘。
 *  - 本机窗口（设置向导、审批弹窗、本机确认、离线页）用网页同一套 Skyglass 令牌（ui/skyglass-tokens.css）
 *  - 托盘：在线 / 离线 / 紧急停止三种图标；菜单含紧急停止
 *  - 节点：agent/core.js 出站 WebSocket；审批弹窗；本机审计日志
 *  - 在线更新（updater.js）：后台下载，下载好后本机窗口「新版本已下载，重启以安装」
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  desktopCapturer,
  screen,
  nativeImage,
  safeStorage,
  session,
  Notification,
  nativeTheme,
  net,
  powerMonitor,
  globalShortcut,
  systemPreferences,
} = require("electron");
const { pathToFileURL, fileURLToPath } = require("node:url");
const shellRefresh = require("./shell-refresh");
const windowChrome = require("./window-chrome");
const desktopPrefs = require("./desktop-prefs");
const buildConfig = require("./build-config");
const pkg = require("../package.json");

const APP_USER_MODEL_ID = "cn.ayase.chisabot.pc";

/**
 * 改名迁移（0.1.129，ChisaBot PC → ChisaBot）：productName 换了，userData 默认目录跟着换
 * （%APPDATA%\ChisaBot PC → %APPDATA%\ChisaBot），里面的设备令牌、登录会话、本机配置不能丢——
 * 新目录还没建、旧目录还在就整体改名搬过去。必须在任何 app.getPath("userData") 读取之前跑。
 */
(() => {
  try {
    const legacy = path.join(app.getPath("appData"), "ChisaBot PC");
    const current = app.getPath("userData");
    if (current !== legacy && !fs.existsSync(current) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, current);
    }
  } catch {}
})();

// 在 app.whenReady() 之前读取持久化桌面偏好：应用硬件加速开关与显式时区覆盖。
const bootstrapDesktopPrefs = desktopPrefs.readBootstrapDesktopPrefs(app.getPath("userData"));
if (bootstrapDesktopPrefs.hardwareAcceleration === false) {
  app.disableHardwareAcceleration();
}
if (bootstrapDesktopPrefs.timezone) {
  process.env.TZ = bootstrapDesktopPrefs.timezone;
}

if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
// 尽早抢占单实例锁：二次实例在加载重型业务/桥接模块之前直接退出。
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) app.quit();

const { createConfig } = require("./config");
const { parseProxyList, describeProxy, createProxyAgent, createAgentFetch } = require("./agent/proxy");
const auth = require("./agent/auth");
const { ensureEnrolled } = require("./agent/enrollment");
const { animateWindowBounds, createCompactController } = require("./compact-window");
const { createLocalWebController } = require("./local-web");
const { createDiagnosticsRingBuffer } = require("./diagnostics-log");
const BUILD = buildConfig.load();

// 重型桥接与节点模块按需懒加载，缩短冷启动首屏路径。
let nodeAgentMod = null;
let opsMod = null;
let agentRuntimeMod = null;
let updaterMod = null;
let updatePlacementMod = null;
let winPsHelperMod = null;
let accessibilityBridgeInstance = null;
let browserBridgeInstance = null;

function getNodeAgentMod() {
  if (!nodeAgentMod) nodeAgentMod = require("./agent/core");
  return nodeAgentMod;
}

function getOpsMod() {
  if (!opsMod) opsMod = require("./agent/ops");
  return opsMod;
}

function getAgentRuntimeMod() {
  if (!agentRuntimeMod) agentRuntimeMod = require("./agent-runtime/attach");
  return agentRuntimeMod;
}

function getUpdaterMod() {
  if (!updaterMod) updaterMod = require("./updater");
  return updaterMod;
}

function getUpdatePlacementMod() {
  if (!updatePlacementMod) updatePlacementMod = require("./update-placement");
  return updatePlacementMod;
}

function disposeResidentWinHelper() {
  if (!winPsHelperMod) {
    try {
      const resolved = require.resolve("./agent/win-ps-helper");
      winPsHelperMod = require.cache[resolved]?.exports || null;
    } catch {
      winPsHelperMod = null;
    }
  }
  winPsHelperMod?.disposeSharedWinPsHelper?.({ sync: true });
}

const PARTITION = "persist:chisabot";
/** 本机小窗口的窗框（DESIGN.md §91）：Windows 上透明窗口 + 网页裁圆角（clip），macOS 系统圆角（dwm）。 */
const FRAME = windowChrome.frameMode({ platform: process.platform, override: process.env.CHISABOT_WINDOW_FRAME });
const ASSETS = path.join(__dirname, "..", "assets");
/**
 * 窗口 / 任务栏图标：Windows 上用多尺寸 .ico（resources/icons/chisabot-<哈希>.ico，开发运行时 build/icon.ico），
 * 标题栏 16px、任务栏 24/32px、Alt+Tab 48px 都有对应尺寸，不是从 512px 的 PNG 缩出来的；其它系统用 PNG。
 */
const WINDOW_ICON = (() => {
  if (process.platform === "win32") {
    const packaged = shellRefresh.findIcon({ resourcesPath: process.resourcesPath });
    if (packaged) return packaged;
    const dev = path.join(__dirname, "..", "build", "icon.ico");
    if (fs.existsSync(dev)) return dev;
  }
  return path.join(ASSETS, "icon.png");
})();
const UI = path.join(__dirname, "ui");
const HIDDEN = process.argv.includes("--hidden");
/** 外壳指纹与客户端代码指纹（scripts/shell-fingerprint.js 打包前写入）：单次读盘解析。 */
const { SHELL_HASH, CLIENT_HASH } = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "shell-fingerprint.json"), "utf8"));
    return {
      SHELL_HASH: typeof parsed.hash === "string" && parsed.hash ? parsed.hash : "",
      CLIENT_HASH: typeof parsed.clientHash === "string" && parsed.clientHash ? parsed.clientHash : "",
    };
  } catch {
    return { SHELL_HASH: "", CLIENT_HASH: "" };
  }
})();

const DEEP_LINK_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 解析 `chisabot://agent/<id>` 与 `chisabot://channel/<id>[?agent=<id>]` 深链。 */
function parseDeepLinkUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || hasControlChar(trimmed)) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "chisabot:") return null;
  if (url.username || url.password || url.hash) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  let id;
  try {
    id = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (!DEEP_LINK_ID_RE.test(id) || id === "." || id === "..") return null;

  if (host === "agent") {
    if (url.search) return null;
    return {
      kind: "agent",
      agentId: id,
      pathname: `/channel/new?agent=${encodeURIComponent(id)}`,
      raw: trimmed,
    };
  }
  if (host === "channel") {
    const agentParam = url.searchParams.get("agent")?.trim() || "";
    if (agentParam && !DEEP_LINK_ID_RE.test(agentParam)) return null;
    return {
      kind: "channel",
      channelId: id,
      ...(agentParam ? { agentId: agentParam } : {}),
      pathname: `/channel/${encodeURIComponent(id)}`,
      raw: trimmed,
    };
  }
  return null;
}

function extractDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg === "string" && /^chisabot:\/\//i.test(arg.trim())) {
      const parsed = parseDeepLinkUrl(arg);
      if (parsed) return parsed;
    }
  }
  return null;
}

try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("chisabot", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("chisabot");
  }
} catch {}

let pendingDeepLink = extractDeepLinkFromArgv(process.argv);
let chatDomReady = false;

let config;
let agent = null;
/** 节点最近一次状态说明（例如「设备令牌无效」「设备已被撤销」），托盘和网页设备页用。 */
let agentDetail = "";
/** 为什么这台电脑还没成为在线设备（登记失败 / 会话过期 / 连不上）；登记成功后清空。 */
let enrollIssue = "";
let enrollRetryTimer = null;
let enrolling = null;
let tray = null;
const windows = { login: null, chat: null };
const UI_URL = pathToFileURL(UI).href; // 只用于 will-navigate 放行本机离线页
let quitting = false;
const approvalQueue = [];
let approvalWindow = null;
let currentApproval = null;
let updater = null;
let updateWindow = null;
const diagnosticsLog = createDiagnosticsRingBuffer();

function getAccessibilityBridge() {
  if (!accessibilityBridgeInstance) {
    const { createAccessibilityBridge } = require("./accessibility-bridge");
    accessibilityBridgeInstance = createAccessibilityBridge();
  }
  return accessibilityBridgeInstance;
}

function getBrowserBridge() {
  if (!browserBridgeInstance) {
    const { createDesktopBrowserBridgeClient } = require("./browser-bridge");
    browserBridgeInstance = createDesktopBrowserBridgeClient({
      getGrantedScopes: () => (Array.isArray(agent?.device?.grantedScopes) ? agent.device.grantedScopes : []),
      confirmApproval: (req) =>
        confirmLocal({
          title: req.kind === "passkey_forward" ? "允许本机通行密钥验证？" : "允许导入单域名登录态？",
          description:
            req.kind === "passkey_forward"
              ? `云端浏览器请求在本机完成 ${req.origin}（rpId: ${req.rpId}）的通行密钥 ${req.ceremonyKind} 操作。`
              : `云端浏览器请求从「${req.profileLabel}」导入 ${req.origin} 的登录 Cookie（仅限该单一域名）。`,
          confirmLabel: "允许本次",
        }),
      log: (entry) => diagnosticsLog.record(entry),
    });
  }
  return browserBridgeInstance;
}

function clientInfo() {
  return {
    clientVersion: pkg.version,
    platform: process.platform,
    osVersion: `${os.type()} ${os.release()}${typeof os.version === "function" ? ` (${os.version()})` : ""}`,
    hostname: os.hostname(),
    arch: os.arch(),
  };
}

/**
 * 建议的默认「允许的文件夹」：桌面、文档、下载（0.1.7 起随 hello 发给服务器）。服务器只在这台电脑的
 * 文件夹列表为空、从没被人改过配置时采用；文件操作仍按能力（默认「询问」）逐次审批。
 */
function suggestedRoots() {
  const roots = [];
  for (const name of ["desktop", "documents", "downloads"]) {
    try {
      const dir = app.getPath(name);
      if (dir && fs.existsSync(dir)) roots.push(dir);
    } catch {}
  }
  return roots;
}

// ---------- 窗口 ----------

function localWindow(name, file, { query, ...options } = {}) {
  if (windows[name] && !windows[name].isDestroyed()) {
    windows[name].show();
    windows[name].focus();
    return windows[name];
  }
  const win = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: "ChisaBot",
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
    ...options,
  });
  win.setMenu(null);
  win.loadFile(path.join(UI, file), { query: { ...windowChrome.frameQuery(FRAME), ...(query || {}) } });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    windows[name] = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  windows[name] = win;
  return win;
}

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#12203a" : "#9dbddc";
}

/** 本机登录页。notice：expired（会话过期）| logout（已退出）| switch（切换服务器）。 */
function openLogin(notice = "") {
  const existing = windows.login && !windows.login.isDestroyed();
  // 无边框、圆角、固定大小（DESIGN.md §91）：右上角只有最小化 + 关闭，页面顶部是拖动带。
  const win = localWindow("login", "login.html", {
    ...windowChrome.loginWindowOptions(FRAME, { background: windowBackground(), workAreaHeight: screen.getPrimaryDisplay().workArea.height }),
    query: notice ? { notice } : undefined,
  });
  if (existing && notice) win.webContents.send("state:changed", `notice:${notice}`);
  return win;
}

function loginUrl(url) {
  try {
    return isServerUrl(url) && /^\/(?:login|sign)\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** 主窗口被服务器带到网页登录页（会话过期 / 被退出）：关掉主窗口，换本机登录页。 */
function sessionExpired() {
  if (windows.chat && !windows.chat.isDestroyed()) windows.chat.destroy();
  windows.chat = null;
  openLogin("expired");
}

// ---------- 主进程网络走系统代理（agent/proxy.js） ----------
// 聊天窗口（Chromium）自动用系统代理；节点 WebSocket 和登记请求在 Node 里，以前直连，直连不通时窗口能聊天、
// 设备却一直离线。这里问 Chromium 对这个地址用什么代理，再让 Node 走同一条路。DIRECT 时行为和以前一样。
const proxyAgents = new Map();
let proxyRoute = "";
async function proxyAgentFor(url) {
  let answer = "DIRECT";
  try {
    answer = await session.fromPartition(PARTITION).resolveProxy(String(url));
  } catch {}
  const secure = /^(https|wss):/i.test(String(url));
  const key = `${secure ? "s" : "p"}|${answer}`;
  if (!proxyAgents.has(key)) {
    if (proxyAgents.size >= 50) {
      const oldest = proxyAgents.keys().next().value;
      if (oldest !== undefined) proxyAgents.delete(oldest);
    }
    const list = parseProxyList(answer);
    proxyAgents.set(key, createProxyAgent(list, { secure, onRoute: (proxy) => (proxyRoute = describeProxy(proxy)) }));
  }
  const agent = proxyAgents.get(key);
  if (!agent) proxyRoute = "直连";
  return agent;
}
const netFetch = createAgentFetch((url) => proxyAgentFor(url.toString()));

async function cookieHeaderFor(origin) {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ url: `${origin}/` });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 启动 / 托盘打开时：会话探测与版本探测并行执行，过期去本机登录页，断网走离线页（零闪屏）。 */
async function sessionStatus() {
  const origin = serverOrigin();
  if (!origin) return "login";
  try {
    const cookieHeader = await cookieHeaderFor(origin);
    const [authOutcome] = await Promise.allSettled([
      auth.probe({ fetchImpl: netFetch, serverUrl: origin, cookieHeader, timeoutMs: 3000 }),
      localWeb.probeVersion({ origin, fetchImpl: netFetch, cookieHeader, timeoutMs: 2500 }),
    ]);
    if (authOutcome.status !== "fulfilled") return "offline";
    if (authOutcome.value.gateway && !authOutcome.value.authenticated) return "login";
    return "ok";
  } catch {
    return "offline";
  }
}

let entering = null;
let prewarmedChatWindow = null;

function disposePrewarmedChatWindow() {
  if (prewarmedChatWindow && !prewarmedChatWindow.isDestroyed()) {
    try {
      prewarmedChatWindow.destroy();
    } catch {}
  }
  prewarmedChatWindow = null;
}

function openApp(pathname) {
  if (windows.chat && !windows.chat.isDestroyed()) return openChat(pathname);
  if (!config.get().serverUrl) return openLogin();
  if (!entering) {
    // 并行预建隐藏 BrowserWindow（绝不 show），提前启动渲染进程壳；探测完再决定加载或销毁。
    if (!prewarmedChatWindow || prewarmedChatWindow.isDestroyed()) {
      try {
        prewarmedChatWindow = openChat(null, { prewarmOnly: true });
      } catch {
        prewarmedChatWindow = null;
      }
    }
    entering = sessionStatus()
      .then((status) => {
        const prewarmed = prewarmedChatWindow;
        prewarmedChatWindow = null;
        if (status === "login") {
          if (prewarmed && !prewarmed.isDestroyed()) prewarmed.destroy();
          return openLogin("expired");
        }
        return openChat(pathname, {
          offline: status === "offline",
          prewarmedWin: prewarmed && !prewarmed.isDestroyed() ? prewarmed : null,
        });
      })
      .finally(() => {
        entering = null;
        disposePrewarmedChatWindow();
      });
  }
  return entering;
}

/** 本机设置 = 网页 偏好设置 → 设备 → 这台电脑。tab：permissions | local | audit | settings。 */
function openDeviceSettings(tab) {
  const { deviceId } = config.get();
  const query = tab ? `?tab=${encodeURIComponent(tab)}` : "";
  return openApp(deviceId ? `/settings/devices/${encodeURIComponent(deviceId)}${query}` : "/settings/devices");
}

let chatOffline = false;
let chatRetryTimer = null;
let chatRetry = null;
let lastWebPath = "/";

function cancelChatRetry() {
  chatRetry?.controller.abort();
  chatRetry = null;
}

function rememberWebPath(url) {
  const parsed = new URL(url);
  lastWebPath = parsed.pathname + parsed.search + parsed.hash;
}

let cachedServerUrlRaw = "";
let cachedServerOriginValue = "";

function serverOrigin() {
  const raw = (config.peek ? config.peek().serverUrl : config.get().serverUrl) || "";
  if (raw === cachedServerUrlRaw) return cachedServerOriginValue;
  cachedServerUrlRaw = raw;
  try {
    cachedServerOriginValue = raw ? new URL(raw).origin : "";
  } catch {
    cachedServerOriginValue = "";
  }
  return cachedServerOriginValue;
}

function isServerUrl(url) {
  try {
    return new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
}

function focusMainWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (typeof win.moveTop === "function") win.moveTop();
  win.focus();
}

function flushPendingDeepLink() {
  if (!pendingDeepLink) return;
  const win = windows.chat;
  if (!win || win.isDestroyed() || chatOffline || !chatDomReady) return;
  if (!isServerUrl(win.webContents.getURL())) return;
  const target = pendingDeepLink;
  pendingDeepLink = null;
  win.webContents.send("pc:deep-link", {
    kind: target.kind,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    ...(target.channelId ? { channelId: target.channelId } : {}),
    pathname: target.pathname,
  });
  focusMainWindow(win);
}

function handleDeepLinkUrl(rawUrl) {
  const target = parseDeepLinkUrl(rawUrl);
  if (!target) return false;
  pendingDeepLink = target;
  if (!app.isReady() || !config) return true;
  if (!config.get().serverUrl) {
    openLogin();
    return true;
  }
  if (windows.chat && !windows.chat.isDestroyed() && !chatOffline && chatDomReady) {
    flushPendingDeepLink();
    return true;
  }
  void openApp(target.pathname);
  return true;
}

function openChat(pathname, options) {
  const { serverUrl } = config.get();
  if (!serverUrl) return openLogin();
  if (!options?.prewarmOnly && windows.chat && !windows.chat.isDestroyed()) {
    if (options?.prewarmedWin && !options.prewarmedWin.isDestroyed() && options.prewarmedWin !== windows.chat) {
      options.prewarmedWin.destroy();
    }
    const effectivePath = pathname || pendingDeepLink?.pathname || null;
    const target = effectivePath ? `${serverOrigin()}${effectivePath}` : null;
    if (target && !chatOffline) windows.chat.loadURL(target);
    else if (effectivePath) lastWebPath = effectivePath;
    focusMainWindow(windows.chat);
    return windows.chat;
  }
  const win =
    options?.prewarmedWin && !options.prewarmedWin.isDestroyed()
      ? options.prewarmedWin
      : new BrowserWindow({
          width: 1280,
          height: 840,
          minWidth: 380,
          minHeight: 560,
          show: false,
          title: "ChisaBot",
          icon: WINDOW_ICON,
          autoHideMenuBar: true,
          // 无边框：网页顶栏就是标题栏（拖动区 + 网页里的最小化 / 最大化 / 关闭，DESIGN-v3 §3）。
          // 不透明窗口 + thickFrame：Windows 11 由系统画圆角（约 8px）和窗口阴影，拖边调整大小、
          // Win+方向键贴靠、最大化都是系统行为；Windows 10 上是方角。网页不再自己画圆角。
          // macOS：hiddenInset 出原生红绿灯（左上，网页隐藏自己的 Windows 式按钮）；Windows / Linux 忽略此项。
          frame: false,
          titleBarStyle: "hiddenInset",
          thickFrame: true,
          backgroundColor: windowBackground(),
          webPreferences: {
            partition: PARTITION,
            preload: path.join(__dirname, "web-preload.js"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: config.get().spellcheck !== false,
          },
        });
  win.setMenu(null);
  if (options?.prewarmOnly) return win;
  const effectivePath = pathname || pendingDeepLink?.pathname || null;
  const target = effectivePath ? `${serverOrigin()}${effectivePath}` : null;
  chatDomReady = false;
  win.webContents.on("context-menu", (_event, params) => {
    const template = desktopPrefs.buildContextMenuTemplate(params, {
      openExternal: (url) => shell.openExternal(url),
      writeClipboard: (text) => clipboard.writeText(text),
      replaceMisspelling: (word) => win.webContents.replaceMisspelling(word),
    });
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: win });
    }
  });
  win.once("ready-to-show", () => win.show());
  chatOffline = Boolean(options?.offline);
  if (chatOffline) {
    if (pathname) lastWebPath = pathname;
    showOffline(win, "连不上服务器");
  } else {
    win.loadURL(target || serverUrl);
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 同一服务器的弹窗（例如连接账号的授权窗口）照常打开；本机桥只认主窗口，弹窗里拿不到。
    if (isServerUrl(url)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: WINDOW_ICON } };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 服务器的网页登录页不在客户端里出现：会话过期时服务器会 302 到 /login，这里换成本机登录页。
  win.webContents.on("will-redirect", (event, url) => {
    if (!loginUrl(url)) return;
    event.preventDefault();
    setImmediate(sessionExpired);
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (loginUrl(url)) {
      event.preventDefault();
      setImmediate(sessionExpired);
      return;
    }
    if (isServerUrl(url) || url.startsWith(UI_URL)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-finish-load", () => {
    if (isServerUrl(win.webContents.getURL())) {
      chatDomReady = true;
      flushPendingDeepLink();
    }
  });
  win.webContents.on("did-navigate", (_event, url) => {
    if (loginUrl(url)) return setImmediate(sessionExpired);
    if (isServerUrl(url)) {
      rememberWebPath(url);
      chatOffline = false;
      clearInterval(chatRetryTimer);
      cancelChatRetry();
      // 网页刚从服务器加载成功 = 网络和服务器都通：节点如果还在退避等待，马上重连（服务器重启 / 更新之后尤其如此）。
      agent?.reconnectNow();
    }
  });
  win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (loginUrl(url)) return setImmediate(sessionExpired);
    if (isServerUrl(url)) rememberWebPath(url);
  });
  // 载不出网页（断网、服务器维护）时换成本机的离线页：同样的天空和玻璃，紧急停止照样能按，恢复后自动回到原页面。
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isServerUrl(url)) return;
    try {
      rememberWebPath(url);
    } catch {}
    showOffline(win, description || String(code));
  });
  win.webContents.on("render-process-gone", () => showOffline(win, "页面进程意外退出"));
  const sendMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send("window:maximized", win.isMaximized() || win.isFullScreen());
  };
  for (const name of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(name, sendMaximized);
  // 小窗模式（DESIGN.md §36）：Ctrl+Shift+M 在主窗口里随时可用（网页、离线页都一样，旧网页没有按钮也能切）。
  compactWindows().watch(win);
  win.on("focus", () => {
    if (updater) void updater.nudge({ reason: "focus", minGapMs: getUpdaterMod().DEFAULT_WAKE_GAP_MS });
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || !input.shift || input.alt) return;
    if (String(input.key).toLowerCase() !== "m") return;
    event.preventDefault();
    compactWindows().toggle(win);
  });
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    chatDomReady = false;
    windows.chat = null;
    clearInterval(chatRetryTimer);
    cancelChatRetry();
  });
  windows.chat = win;
  return win;
}

function showOffline(win, reason) {
  if (win.isDestroyed()) return;
  cancelChatRetry();
  chatOffline = true;
  win.loadFile(path.join(UI, "offline.html"), { query: { error: String(reason).slice(0, 80) } });
  clearInterval(chatRetryTimer);
  chatRetryTimer = setInterval(() => {
    void retryChat().catch(() => {});
  }, 15000);
}

async function probeServer(origin, signal) {
  const response = await net.fetch(`${origin}/`, { method: "HEAD", cache: "no-store", signal });
  return response.status < 500;
}

function retryChat() {
  const win = windows.chat;
  if (!win || win.isDestroyed() || !chatOffline) return Promise.resolve(true);
  if (chatRetry) return chatRetry.promise;
  const request = { origin: serverOrigin(), controller: new AbortController(), promise: null };
  chatRetry = request;
  request.promise = (async () => {
    // Use the same bounded wait as login probing; timer and button share this request.
    const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(8000)]);
    const reachable = await probeServer(request.origin, signal).catch(() => false);
    // Closing, logging out or navigating replaces the owner of this recovery attempt.
    if (chatRetry !== request || win.isDestroyed() || windows.chat !== win || request.origin !== serverOrigin()) return false;
    if (!reachable) throw new Error("仍然连不上服务器。");
    await localWeb.probeVersion({
      origin: request.origin,
      fetchImpl: netFetch,
      cookieHeader: await cookieHeaderFor(request.origin).catch(() => ""),
      timeoutMs: 2500,
    });
    if (chatRetry !== request || win.isDestroyed() || windows.chat !== win || request.origin !== serverOrigin()) return false;
    chatOffline = false;
    clearInterval(chatRetryTimer);
    await win.loadURL(`${request.origin}${lastWebPath || "/"}`);
    return true;
  })().finally(() => {
    if (chatRetry === request) chatRetry = null;
  });
  return request.promise;
}

// ---------- 托盘 ----------

const trayIconCache = new Map();
let lastTrayIconKind = "";
let lastTrayKey = "";

function trayIcon(kind) {
  let cached = trayIconCache.get(kind);
  if (!cached) {
    const image = nativeImage.createFromPath(path.join(ASSETS, `tray-${kind}.png`));
    cached = process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;
    trayIconCache.set(kind, cached);
  }
  return cached;
}

function statusKind() {
  if (config.get().localPaused) return "paused";
  return agent && agent.state === "online" ? "online" : "offline";
}

function statusText() {
  const local = config.get();
  if (!local.serverUrl) return "未登录";
  if (!config.getToken()) return enrollIssue || "已登录，但这台电脑还没登记为设备";
  if (local.localPaused) return "紧急停止中";
  switch (agent?.state) {
    case "online":
      return agent?.fullAccess ? "在线 · 完全访问" : "在线";
    case "connecting":
      return "正在连接…";
    case "revoked": {
      const { INVALID_TOKEN_DETAIL, invalidTokenHint } = getNodeAgentMod();
      return agentDetail === INVALID_TOKEN_DETAIL ? invalidTokenHint(agent?.invalidTokenRetryMs) : "已被撤销，请重新登记这台电脑";
    }
    default: {
      // 把真实原因写出来（以前一律「离线（自动重连中）」，看不出是被拦、超时还是代理问题）。
      const why = agent?.lastError || agentDetail;
      return why ? `离线（自动重连中）：${String(why).slice(0, 120)}` : "离线（自动重连中）";
    }
  }
}

function refreshTray() {
  if (!tray) return;
  const kind = statusKind();
  const text = statusText();
  const local = config.get();
  const paused = Boolean(local.localPaused);
  const hasServer = Boolean(local.serverUrl);
  const enroll = needsEnroll();
  const fullAccess = Boolean(agent?.fullAccess);
  const updStatus = updater?.state.status || "idle";
  const updVersion = updater?.state.version || "";
  // 托盘菜单不跟随 download-progress 逐小数点重建：实时百分比由独立更新进度窗口展示。
  const nextTrayKey = `${kind}|${text}|${paused ? 1 : 0}|${hasServer ? 1 : 0}|${enroll ? 1 : 0}|${fullAccess ? 1 : 0}|${updStatus}|${updVersion}`;
  if (nextTrayKey !== lastTrayKey) {
    lastTrayKey = nextTrayKey;
    if (kind !== lastTrayIconKind) {
      lastTrayIconKind = kind;
      tray.setImage(trayIcon(kind));
    }
    tray.setToolTip(`ChisaBot · ${text}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `状态：${text}`, enabled: false },
        { type: "separator" },
        { label: "打开 ChisaBot", click: () => void openApp() },
        ...(enroll
          ? [{ label: "重新登记这台电脑", click: () => void repairDevice({ force: true, manual: true }) }]
          : []),
        ...(hasServer
          ? [
              // 打开主窗口并直接弹出网页「绑定手机」二维码（DESIGN.md §33）。
              { label: "绑定手机…", click: () => void openApp("/settings/devices?pair=1") },
              { label: "这台电脑的权限…", click: () => void openDeviceSettings() },
              { label: "本机设置…", click: () => void openDeviceSettings("local") },
            ]
          : []),
        ...(updStatus === "downloaded"
          ? [{ label: `重启以安装 ${updVersion || "新版本"}…`, click: () => openUpdateWindow({ focus: true }) }]
          : updStatus === "downloading"
            ? [{ label: `正在下载新版本 ${updVersion || ""}…`, click: () => openUpdateWindow({ focus: true }) }]
            : updStatus === "verifying"
              ? [{ label: `正在校验新版本 ${updVersion || ""}…`, click: () => openUpdateWindow({ focus: true }) }]
              : []),
        { type: "separator" },
        ...(fullAccess
          ? [
              { label: "完全访问已开启", enabled: false },
              { label: "关闭完全访问", click: () => agent?.setConfig({ fullAccess: "off" }) },
            ]
          : []),
        {
          label: paused ? "解除紧急停止…" : "紧急停止（拒绝一切远程操作）",
          click: () => void requestPaused(!paused),
        },
        { type: "separator" },
        { label: "切换服务器…", click: () => openLogin("switch") },
        ...(hasServer ? [{ label: "退出登录…", click: () => void confirmLogout() }] : []),
        { type: "separator" },
        {
          label: "退出 ChisaBot",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  }
  broadcast();
}

// ---------- 节点 ----------

function screenshotHook({ maxWidth }) {
  const display = screen.getPrimaryDisplay();
  const physical = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  return desktopCapturer.getSources({ types: ["screen"], thumbnailSize: physical }).then((sources) => {
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) throw new Error("没有可截取的屏幕。");
    let image = source.thumbnail;
    const size = image.getSize();
    if (size.width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
    const out = image.getSize();
    return {
      format: "png",
      width: out.width,
      height: out.height,
      screenWidth: physical.width,
      screenHeight: physical.height,
      scaleFactor: display.scaleFactor,
      note: "鼠标坐标使用 screenWidth × screenHeight（物理像素）",
      base64: image.toPNG().toString("base64"),
    };
  });
}

/** 已登录服务器，但这台电脑没有可用的设备令牌（没登记 / 令牌无效 / 被撤销）。 */
function needsEnroll() {
  if (!config.get().serverUrl) return false;
  return !config.getToken() || agent?.state === "revoked";
}

/**
 * 补登记这台电脑（agent/enrollment.js）。自动路径（启动时）只在本机完全没有令牌时登记；
 * 用户亲自点「重新登记」（托盘 / 网页设备页）时 force，作废无效或被撤销的旧令牌再登记。
 * 连不上服务器时每分钟自动重试；会话过期时提示重新登录，不弹登录窗打断用户。
 */
let enrollingOpts = null;
function repairDevice({ force = false, manual = false } = {}) {
  if (enrolling) {
    if ((force && !enrollingOpts?.force) || (manual && !enrollingOpts?.manual)) {
      return enrolling.then(() => repairDevice({ force, manual }));
    }
    return enrolling;
  }
  clearTimeout(enrollRetryTimer);
  enrollingOpts = { force, manual };
  enrolling = ensureEnrolled({
    config,
    force,
    sessionStatus,
    cookieHeader: () => cookieHeaderFor(serverOrigin()),
    enroll: (input) => auth.enroll({ ...input, fetchImpl: netFetch }),
    checkToken: (input) => auth.checkToken({ ...input, fetchImpl: netFetch }),
    info: { ...clientInfo(), name: config.get().deviceName || os.hostname() },
  })
    .then((result) => {
      enrollIssue = result.status === "enrolled" || result.status === "already" || result.status === "no-server" ? "" : result.message;
      if (result.status === "enrolled" || result.status === "already") {
        if (result.status === "enrolled") {
          agentDetail = "";
          config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "enroll", outcome: "succeeded", summary: `${manual ? "重新登记" : "自动补登记"}：${result.message}` });
        }
        startAgent();
      } else if (result.status === "failed") {
        config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "enroll", outcome: "failed", summary: result.message.slice(0, 300) });
      } else if (result.status === "offline") {
        enrollRetryTimer = setTimeout(() => void repairDevice({ force }), 60_000);
      }
      if (manual && result.status === "login") void openApp();
      if (manual && Notification.isSupported() && result.status !== "already")
        new Notification({ title: "ChisaBot", body: result.message }).show();
      refreshTray();
      return result;
    })
    .finally(() => {
      enrolling = null;
      enrollingOpts = null;
    });
  return enrolling;
}

function startAgent() {
  if (agent) agent.stop();
  const local = config.get();
  if (!local.serverUrl || !config.getToken()) return refreshTray();
  const { createOps } = getOpsMod();
  const { attachAgentRuntime } = getAgentRuntimeMod();
  const { createNodeAgent } = getNodeAgentMod();
  const ops = createOps({
    clientVersion: pkg.version,
    hooks: {
      screenshot: screenshotHook,
      screenInfo: async () =>
        screen.getAllDisplays().map((d) => ({
          id: d.id,
          primary: d.id === screen.getPrimaryDisplay().id,
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor),
          scaleFactor: d.scaleFactor,
        })),
      clipboardRead: async () => clipboard.readText(),
      clipboardWrite: async (text) => clipboard.writeText(text),
      openExternal: (url) => shell.openExternal(url),
      // 「打开」文件 / 文件夹（CB-030）：ops.js 已检查过类型和允许的文件夹；返回错误文字，成功为空。
      openPath: (file) => shell.openPath(file),
    },
  });
  // 本地 agent（Claude Code / Codex / 内置循环…，docs/local-agents.md）：和节点共用这条连接。
  const agentRuntime = attachAgentRuntime();
  const handleExtra = (message) => {
    if (message?.type === "desktop_browser_cookie_request") {
      if (config.get().localPaused || agent?.device?.paused) {
        agent?.sendRaw({ type: "desktop_browser_cookie_response", requestId: message.requestId, decision: { approved: false, reason: "设备已紧急停止，拒绝本机 Cookie 导入请求。" } });
        return true;
      }
      const exp = Date.parse(String(message.expiresAt || ""));
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        agent?.sendRaw({ type: "desktop_browser_cookie_response", requestId: message.requestId, decision: { approved: false, reason: "本机 Cookie 导入审批请求已过期。" } });
        return true;
      }
      void getBrowserBridge()
        .handleCookieApprovalRequest(message)
        .then((decision) => {
          agent?.sendRaw({ type: "desktop_browser_cookie_response", requestId: message.requestId, decision });
        })
        .catch((err) => {
          diagnosticsLog.record({ category: "browser_bridge", level: "error", event: "cookie_approval_failed", message: String(err?.message || err) });
          agent?.sendRaw({ type: "desktop_browser_cookie_response", requestId: message.requestId, decision: { approved: false, reason: "本机 Cookie 导入处理异常，已拒绝。" } });
        });
      return true;
    }
    if (message?.type === "desktop_browser_webauthn_request") {
      if (config.get().localPaused || agent?.device?.paused) {
        agent?.sendRaw({ type: "desktop_browser_webauthn_response", requestId: message.requestId, result: { ok: false, error: "设备已紧急停止，拒绝本机 Passkey 请求。" } });
        return true;
      }
      const exp = Date.parse(String(message.expiresAt || ""));
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        agent?.sendRaw({ type: "desktop_browser_webauthn_response", requestId: message.requestId, result: { ok: false, error: "本机 Passkey 转发请求已过期。" } });
        return true;
      }
      void getBrowserBridge()
        .handleWebAuthnRequest(message)
        .then((result) => {
          agent?.sendRaw({ type: "desktop_browser_webauthn_response", requestId: message.requestId, result });
        })
        .catch((err) => {
          diagnosticsLog.record({ category: "browser_bridge", level: "error", event: "webauthn_forward_failed", message: String(err?.message || err) });
          agent?.sendRaw({ type: "desktop_browser_webauthn_response", requestId: message.requestId, result: { ok: false, error: "本机 Passkey 转发处理异常，已拒绝。" } });
        });
      return true;
    }
    return agentRuntime.onExtra(message);
  };
  agent = createNodeAgent({
    onExtra: handleExtra,
    serverUrl: local.serverUrl,
    getToken: () => config.getToken(),
    ops,
    clientInfo: { ...clientInfo(), suggestedRoots: suggestedRoots() },
    getAgent: (url) => proxyAgentFor(url),
    approve: (request) => askApproval(request),
    local: () => ({ paused: config.get().localPaused, forceLocalApproval: config.get().forceLocalApproval }),
    // 完全访问（docs/pc-node.md §13）：网页上打开后，这台电脑还要本人在本机确认一次才生效（网页脚本点不到这个窗口）。
    acceptFullAccess: (device) => {
      const until = device.fullAccessUntil && !String(device.fullAccessUntil).startsWith("9999") ? `，到 ${new Date(device.fullAccessUntil).toLocaleString("zh-CN", { hour12: false })} 自动关闭` : "，直到你手动关闭";
      return confirmLocal({
        title: "允许机器人完全访问这台电脑？",
        description: `网页上为「${device.name}」打开了完全访问${until}。开启后机器人可以不经询问运行任何命令、读写整台电脑的文件、长时间运行程序，也可以申请管理员权限。所有操作仍会记录；托盘「紧急停止」随时可以立即关闭。`,
        confirmLabel: "允许完全访问",
      });
    },
  });
  agent.events.on("full_access", () => refreshTray());
  agentRuntime.bind(agent, { isPaused: () => !!config.get().localPaused });
  agent.events.on("state", (event) => {
    agentDetail = event?.detail ? String(event.detail) : event?.state === "online" ? "" : agentDetail;
    diagnosticsLog.record({ category: "connection", event: "agent_state", message: event?.state || "unknown", detail: event?.detail ? { detail: event.detail } : undefined });
    refreshTray();
    if (event && event.state === "online" && config.get().autoUpdate !== false) {
      ensureUpdaterStarted();
      void updater?.check();
    }
  });
  // 连接失败（断网、DNS、证书）由 core 自己重连；没有监听时 EventEmitter 的 "error" 会让主进程崩溃。
  agent.events.on("error", () => {});
  agent.events.on("config", (device) => {
    if (device && typeof device.paused === "boolean" && device.paused !== config.get().localPaused)
      config.set({ localPaused: device.paused });
    if (device?.name) config.set({ deviceName: device.name, deviceId: device.id });
    refreshTray();
  });
  agent.events.on("audit", (entry) => {
    config.appendAudit(entry);
    broadcast("audit");
  });
  agent.events.on("call", ({ operation, botName }) => {
    if (operation === "input" || operation === "shell") tray?.setToolTip(`ChisaBot · ${botName || "机器人"} 正在操作…`);
  });
  agent.events.on("approval_closed", ({ id }) => closeApproval(id));
  agent.events.on("check_update", ({ version, reason } = {}) => {
    config.appendAudit({
      at: new Date().toISOString(),
      actor: "服务器",
      operation: "update_push_received",
      outcome: "succeeded",
      summary: `收到服务器更新推送${version ? `（${version}）` : ""}${reason ? ` · ${reason}` : ""}`,
    });
    ensureUpdaterStarted();
    void updater?.nudge({ version, reason: reason || "server_push", minGapMs: getUpdaterMod().DEFAULT_PUSH_GAP_MS });
  });
  agent.events.on("revoked", () => {
    refreshTray();
    if (Notification.isSupported())
      new Notification({ title: "ChisaBot", body: "这台电脑已被撤销，请重新登录。" }).show();
  });
  agent.start();
  refreshTray();
}

function setPaused(paused) {
  config.set({ localPaused: paused });
  config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: paused ? "kill_switch_on" : "kill_switch_off", outcome: "succeeded", summary: paused ? "紧急停止" : "解除紧急停止" });
  if (paused) {
    for (const item of approvalQueue.splice(0)) item.resolve("deny");
    if (currentApproval) {
      currentApproval.resolve("deny");
      currentApproval = null;
      approvalWindow?.close();
    }
  }
  agent?.setConfig({ paused });
  refreshTray();
}

/** 开启紧急停止立即生效；解除要本机确认（网页 / 托盘发起都一样）。返回最终是否处于紧急停止。 */
async function requestPaused(paused) {
  if (paused) {
    setPaused(true);
    return true;
  }
  if (!config.get().localPaused) return false;
  const ok = await confirmLocal({
    title: "解除紧急停止？",
    description: "解除后，机器人可以再次按这台电脑的权限设置操作它（「询问」的操作仍会先问你）。",
    confirmLabel: "解除紧急停止",
  });
  if (ok) setPaused(false);
  return config.get().localPaused;
}

// ---------- 本机确认窗 ----------
// 放松安全的改动在这里由本人确认。它是本机文件页面、独立窗口，网页里的脚本既看不到也点不到。

const confirmQueue = [];
let confirmCurrent = null;
let confirmWindow = null;

function confirmLocal({ title, description, confirmLabel }) {
  return new Promise((resolve) => {
    confirmQueue.push({ request: { id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title, description, confirmLabel }, resolve });
    pumpConfirm();
  });
}

function pumpConfirm() {
  if (confirmCurrent || !confirmQueue.length) return;
  confirmCurrent = confirmQueue.shift();
  const parent = windows.chat && !windows.chat.isDestroyed() && windows.chat.isVisible() ? windows.chat : undefined;
  confirmWindow = new BrowserWindow({
    width: 440,
    height: confirmCurrent.request.description && confirmCurrent.request.description.length > 90 ? 330 : 260,
    ...windowChrome.dialogWindowOptions(FRAME, { background: windowBackground() }),
    parent,
    modal: !!parent,
    alwaysOnTop: !parent,
    show: false,
    title: "ChisaBot · 本机确认",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  confirmWindow.loadFile(path.join(UI, "confirm.html"), { query: windowChrome.frameQuery(FRAME) });
  dialogWidth.set(confirmWindow, 440);
  showAfterFit(confirmWindow, () => {
    confirmWindow?.show();
    confirmWindow?.focus();
  });
  confirmWindow.on("closed", () => {
    confirmWindow = null;
    if (confirmCurrent) {
      confirmCurrent.resolve(false);
      confirmCurrent = null;
    }
    setTimeout(pumpConfirm, 100);
  });
}

/**
 * 按内容定高的弹窗（DESIGN.md §91.3）：等页面量好高度（dialog:fit）再显示，不先露出旧高度再跳；
 * 页面没报（旧页面 / 出错）时 ready-to-show 后 400ms 照常显示。
 */
const pendingShow = new WeakMap();
/** 创建时的宽度：小数缩放（125% / 150%）下 getBounds 会比设定值多几 px，定高时用它回写，不越来越宽。 */
const dialogWidth = new WeakMap();
function showAfterFit(win, show) {
  let done = false;
  const go = () => {
    if (done || win.isDestroyed()) return;
    done = true;
    pendingShow.delete(win);
    show();
  };
  pendingShow.set(win, go);
  win.once("ready-to-show", () => setTimeout(go, 400));
}

// ---------- 审批弹窗 ----------

function askApproval(request) {
  return new Promise((resolve) => {
    if (config.get().localPaused) return resolve("deny");
    approvalQueue.push({ request, resolve });
    if (Notification.isSupported())
      new Notification({ title: "ChisaBot 请求操作这台电脑", body: `${request.botName || "机器人"}：${request.summary}` }).show();
    pumpApprovals();
  });
}

function pumpApprovals() {
  if (currentApproval || !approvalQueue.length) return;
  currentApproval = approvalQueue.shift();
  const { workArea } = screen.getPrimaryDisplay();
  const width = currentApproval.request.diff ? 560 : 460;
  const height = currentApproval.request.diff ? 520 : 320;
  approvalWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + workArea.height - height - 16,
    ...windowChrome.dialogWindowOptions(FRAME, { background: windowBackground() }),
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: "ChisaBot 请求操作这台电脑",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  approvalWindow.setAlwaysOnTop(true, "screen-saver");
  approvalWindow.loadFile(path.join(UI, "approval.html"), { query: windowChrome.frameQuery(FRAME) });
  dialogWidth.set(approvalWindow, width);
  showAfterFit(approvalWindow, () => {
    approvalWindow?.showInactive();
    approvalWindow?.flashFrame(true);
  });
  approvalWindow.on("closed", () => {
    approvalWindow = null;
    if (currentApproval) {
      currentApproval.resolve("deny");
      currentApproval = null;
    }
    setTimeout(pumpApprovals, 150);
  });
}

function closeApproval(id) {
  const queued = approvalQueue.findIndex((item) => item.request.id === id);
  if (queued >= 0) approvalQueue.splice(queued, 1)[0].resolve("dismissed");
  if (currentApproval && currentApproval.request.id === id) {
    currentApproval.resolve("dismissed");
    currentApproval = null;
    approvalWindow?.close();
  }
}

// ---------- 在线更新 ----------
// 发现新版本开始下载或点击「查看更新进度」时打开独立更新进度窗；下载并验签完成后在原位提示立即重启 / 稍后。

let dismissedDownloadVersion = "";

function updateLogger() {
  const write = (level) => (...args) =>
    config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_log", outcome: level, summary: args.map(String).join(" ").slice(0, 300) });
  // 只记 warn / error；info 太多。
  return { info: () => {}, debug: () => {}, warn: write("warn"), error: write("error") };
}

function updateWindowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#111318" : "#ffffff";
}

function manualUpdateDownloadUrl() {
  return buildConfig.resolveManualDownloadUrl(BUILD, config.get(), {
    feedUrl: updater?.feedUrl || "",
    publishUrl: pkg.build?.publish?.[0]?.url || "",
  });
}

function currentUpdatePayload() {
  if (!updater) return null;
  const st = updater.state;
  const percent =
    typeof st.percent === "number" && Number.isFinite(st.percent)
      ? Math.max(0, Math.min(100, st.percent))
      : st.status === "downloaded" || st.status === "verifying"
        ? 100
        : 0;
  return {
    status: st.status || "idle",
    version: st.version || "",
    currentVersion: pkg.version,
    percent,
    fullInstall: !!updater.state.fullInstall,
    error: st.error || "",
    downloadUrl: manualUpdateDownloadUrl(),
  };
}

function sendUpdateState() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("update:state", currentUpdatePayload());
  }
}

function startUpdater() {
  if (updater) return updater;
  let autoUpdater = null;
  if (app.isPackaged) {
    try {
      ({ autoUpdater } = require("electron-updater"));
    } catch {
      autoUpdater = null;
    }
  }
  const { createUpdater } = getUpdaterMod();
  const updateSignature = require("./update-signature");
  const feed = buildConfig.resolveFeedDetail(BUILD, config.get());
  let lastUpdaterTrayKey = "";
  updater = createUpdater({
    autoUpdater,
    feedUrl: feed.url,
    // 本机 config.json 的 updateFeed 是手动覆盖：它失效（源上版本比本机还低）时退回构建期的源再查。
    fallbackFeed: feed.source === "local" ? buildConfig.resolveFeed(BUILD, {}) : "",
    currentVersion: pkg.version,
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    productName: pkg.productName || "ChisaBot",
    shellHash: SHELL_HASH,
    clientHash: CLIENT_HASH,
    // 内置更新公钥（docs/pc-update-signing.md）：为空 = 这个构建不验签（自建版没配公钥），保持旧行为。
    updateKeys: updateSignature.loadKeys(),
    getAutoUpdate: () => config.get().autoUpdate !== false,
    logger: updateLogger(),
    onState: (nextState) => {
      sendUpdateState();
      // download-progress 高频推送时仅广播更新进度，状态键未变不重建托盘菜单或全窗口群发 state:changed。
      const nextKey = `${nextState?.status || ""}|${nextState?.version || ""}|${nextState?.fullInstall ? 1 : 0}|${nextState?.error || ""}`;
      if (nextKey !== lastUpdaterTrayKey) {
        lastUpdaterTrayKey = nextKey;
        refreshTray();
      }
    },
    onAvailable: (version) => {
      config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_available", outcome: "succeeded", summary: `发现新版本 ${version || ""}，正在后台下载` });
      if (Notification.isSupported()) new Notification({ title: "ChisaBot", body: `发现新版本 ${version || ""}，正在后台下载…` }).show();
      if ((!updateWindow || updateWindow.isDestroyed()) && dismissedDownloadVersion !== (version || "")) {
        openUpdateWindow({ focus: false });
      }
    },
    onDownloaded: (version) => {
      dismissedDownloadVersion = "";
      config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_downloaded", outcome: "succeeded", summary: `新版本 ${version || ""} 已下载` });
      promptUpdate(version);
    },
    onRejected: ({ version, code, reason }) => {
      config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_rejected", outcome: "failed", summary: `新版本 ${version || ""} 签名校验失败，已拒绝安装（${code}）：${reason}`.slice(0, 300) });
    },
  });
  updater.schedule();
  // 「稍后」≈ 永远不装：客户端常驻托盘几乎不退出，autoInstallOnAppQuit 轮不到。
  // 待安装状态按周期重弹提示窗，直到装上或被更新版本顶掉（CB-137）。
  setInterval(() => {
    if (updater?.state.status === "downloaded" && Date.now() - updatePromptAt >= UPDATE_REMIND_MS) promptUpdate(updater.state.version);
  }, UPDATE_REMIND_TICK_MS).unref();
  return updater;
}

function ensureUpdaterStarted() {
  return updater || startUpdater();
}

/** 待安装提醒：距离上次弹窗超过这么久就再弹一次。 */
const UPDATE_REMIND_MS = 4 * 60 * 60 * 1000;
const UPDATE_REMIND_TICK_MS = 30 * 60 * 1000;
let updatePromptAt = 0;

function promptUpdate(version) {
  updatePromptAt = Date.now();
  const alreadyOpen = updateWindow && !updateWindow.isDestroyed() && updateWindow.isVisible();
  if (!alreadyOpen && Notification.isSupported()) new Notification({ title: "ChisaBot", body: `新版本 ${version || ""} 已下载，重启以安装。` }).show();
  openUpdateWindow({ focus: true });
}

function openUpdateWindow({ focus = true, allowIdle = false } = {}) {
  const status = updater?.state.status;
  if (!allowIdle && !["checking", "available", "downloading", "verifying", "downloaded", "error"].includes(status)) return false;
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (focus && updateWindow.isMinimized()) updateWindow.restore();
    sendUpdateState();
    if (focus) {
      updateWindow.show();
      updateWindow.focus();
    } else {
      updateWindow.showInactive();
    }
    return true;
  }
  const chat = windows.chat && !windows.chat.isDestroyed() ? windows.chat : null;
  const chatVisible = Boolean(chat?.isVisible() && !chat.isMinimized());
  const workArea = (chat ? screen.getDisplayMatching(chat.getBounds()) : screen.getPrimaryDisplay()).workArea;
  const { computeUpdateWindowBounds } = getUpdatePlacementMod();
  const bounds = computeUpdateWindowBounds({ chat: chat ? chat.getBounds() : null, chatVisible, workArea });
  updateWindow = new BrowserWindow({
    ...windowChrome.updateWindowOptions({ background: updateWindowBackground() }),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    icon: WINDOW_ICON,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  updateWindow.setMenu(null);
  updateWindow.loadFile(path.join(UI, "update.html"), { query: windowChrome.frameQuery("dwm") });
  const sendMax = () => {
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send("window:local-maximized", updateWindow.isMaximized());
  };
  updateWindow.on("maximize", sendMax);
  updateWindow.on("unmaximize", sendMax);
  updateWindow.once("ready-to-show", () => {
    if (!updateWindow || updateWindow.isDestroyed()) return;
    if (focus) {
      updateWindow.show();
      updateWindow.focus();
    } else {
      updateWindow.showInactive();
    }
    sendUpdateState();
    sendMax();
  });
  updateWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  updateWindow.on("closed", () => {
    if (updater?.state.status === "downloading" || updater?.state.status === "verifying") {
      dismissedDownloadVersion = updater.state.version || "";
    }
    updateWindow = null;
  });
  return true;
}

function installUpdateNow() {
  if (updater?.state.status !== "downloaded") return false;
  const how = updater.state.fullInstall ? "重新安装" : "重启并安装";
  config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_install", outcome: "succeeded", summary: `${how} ${updater.state.version || ""}` });
  quitting = true;
  agent?.stop();
  setTimeout(() => updater.install(), 50);
  return true;
}

// ---------- 渲染进程接口 ----------

function publicState() {
  const local = config.get();
  return {
    version: pkg.version,
    platform: process.platform,
    hostname: os.hostname(),
    serverUrl: local.serverUrl,
    defaultServerUrl: BUILD.serverUrl,
    recentServers: Array.isArray(local.recentServers) ? local.recentServers.slice(0, 6) : [],
    remember: local.remember !== false,
    username: local.username,
    loggedIn: !!(local.serverUrl && config.getToken()),
    tokenProtected: config.tokenProtected(),
    status: statusKind(),
    statusText: statusText(),
    agentState: agent?.state ?? "offline",
    /** 节点这次连接走的路线（直连 / HTTP 代理 127.0.0.1:7890 …），排查「窗口能用、设备离线」用。 */
    networkRoute: proxyRoute,
    device: agent?.device ?? null,
    appearance: local.appearance,
    local: { autoStart: local.autoStart, forceLocalApproval: local.forceLocalApproval, localPaused: local.localPaused, startHidden: local.startHidden },
  };
}

/** 给网页本机桥的状态（只有网页「本机」标签需要的字段，没有令牌、没有账号）。 */
function webLocalState() {
  const local = config.get();
  return {
    version: pkg.version,
    platform: process.platform,
    hostname: os.hostname(),
    serverUrl: local.serverUrl,
    deviceId: local.deviceId,
    agentState: agent?.state ?? "offline",
    statusText: statusText(),
    networkRoute: proxyRoute,
    /** 本机有没有设备令牌；false = 已登录但没登记（网页设备页显示「登记这台电脑」）。 */
    enrolled: !!config.getToken(),
    /** 需要用户点「重新登记这台电脑」（没登记 / 令牌无效 / 被撤销）。 */
    needsEnroll: needsEnroll(),
    tokenProtected: config.tokenProtected(),
    localPaused: local.localPaused,
    forceLocalApproval: local.forceLocalApproval,
    autoStart: local.autoStart,
    startHidden: local.startHidden,
    autoUpdate: local.autoUpdate !== false,
    hardwareAcceleration: local.hardwareAcceleration !== false,
    spellcheck: local.spellcheck !== false,
    timezone: local.timezone || "",
    allowedEgressDomains: Array.isArray(local.allowedEgressDomains) ? local.allowedEgressDomains : [],
    update: updater ? updater.state : { supported: false, status: "idle" },
    webUi: localWeb.statusFor(serverOrigin()),
  };
}

function broadcast(kind = "state") {
  for (const win of [windows.login, windows.chat, approvalWindow, confirmWindow, updateWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("state:changed", kind);
  }
}

async function injectCookies(origin, cookies) {
  const ses = session.fromPartition(PARTITION);
  for (const cookie of cookies) {
    // 跟服务器给的寿命走：有 Max-Age / Expires 就是持久 Cookie（记住登录 = 30 天），没有就是会话 Cookie
    // （没勾记住登录：退出客户端后失效，下次启动回到本机登录页）。
    let expirationDate;
    if (cookie.maxAge > 0) expirationDate = Math.floor(Date.now() / 1000) + cookie.maxAge;
    else if (cookie.expires > Date.now()) expirationDate = Math.floor(cookie.expires / 1000);
    await ses.cookies.set({
      url: `${origin}/`,
      name: cookie.name,
      value: cookie.value,
      path: "/",
      secure: origin.startsWith("https:"),
      httpOnly: cookie.httpOnly !== false,
      sameSite: "lax",
      ...(expirationDate ? { expirationDate } : {}),
    });
  }
  await ses.cookies.flushStore();
}

/** 本机页面（file://…/src/ui/）发来的调用。 */
function isTopFrame(event) {
  return !!event.senderFrame && !event.senderFrame.parent;
}

function fromLocalUi(event) {
  if (!isTopFrame(event)) return false;
  try {
    // 比较解码后的路径，安装目录里有空格或中文（如 C:\Users\张三\…）时 URL 编码方式不影响判断。
    const file = path.resolve(fileURLToPath(event.senderFrame.url));
    const root = path.resolve(UI) + path.sep;
    return process.platform === "win32" ? file.toLowerCase().startsWith(root.toLowerCase()) : file.startsWith(root);
  } catch {
    return false;
  }
}

/** 主窗口里的本机离线页（file://）：同样要能最小化 / 关闭无边框窗口。 */
function fromChatLocalPage(event) {
  const chat = windows.chat;
  return Boolean(chat && !chat.isDestroyed() && event.sender === chat.webContents && String(event.senderFrame?.url || "").startsWith("file:"));
}

/** 网页本机桥：只认主窗口、顶层框架、而且是已登录的那台服务器。 */
function fromServerPage(event) {
  const chat = windows.chat;
  if (!chat || chat.isDestroyed() || event.sender !== chat.webContents) return false;
  if (!isTopFrame(event)) return false;
  return isServerUrl(event.senderFrame.url) && !!serverOrigin();
}

function handleLocal(channel, fn) {
  ipcMain.handle(channel, (event, payload) => {
    if (!fromLocalUi(event)) throw new Error("拒绝：调用来源不是 ChisaBot 本机页面。");
    return fn(payload, event);
  });
}

function handleWeb(channel, fn) {
  ipcMain.handle(channel, (event, payload) => {
    if (!fromServerPage(event)) throw new Error("拒绝：只有已登录服务器的页面可以使用本机桥。");
    return fn(payload, event);
  });
}

/** 小窗模式控制器（主进程里只有一个，app ready 之后才能用 screen）。 */
let compactController = null;
function compactWindows() {
  if (!compactController) {
    compactController = createCompactController({
      screen,
      onChange: (win, compact) => {
        if (!win.isDestroyed()) win.webContents.send("window:compact", compact);
      },
      // macOS 走系统原生动画（减少动画时直接落位）；Windows / Linux 单次原子 setBounds 落位消除 16ms 卡顿与二次闪跳。
      animate: (win, target, done, meta) => {
        let reducedMotion = false;
        try {
          reducedMotion = Boolean(systemPreferences.getAnimationSettings?.().prefersReducedMotion);
        } catch {
          /* 平台不支持读动画设置就当没减少动画 */
        }
        return animateWindowBounds(win, target, {
          phase: meta?.phase,
          reducedMotion,
          onDone: done,
        });
      },
    });
  }
  return compactController;
}

/** 无边框主窗口的窗口控制：已登录服务器的顶层页面，或主窗口里的本机离线页。 */
function handleChatWindow(channel, fn) {
  ipcMain.handle(channel, (event, payload) => {
    if (!fromServerPage(event) && !fromChatLocalPage(event)) throw new Error("拒绝：只有主窗口可以控制窗口。");
    return fn(payload, event);
  });
}

/** 作废这台电脑在 serverUrl 上的设备令牌并清掉本机记录（退出登录、换服务器时用）。 */
async function dropDevice(serverUrl) {
  clearInterval(chatRetryTimer);
  cancelChatRetry();
  clearTimeout(enrollRetryTimer);
  enrollIssue = "";
  agentDetail = "";
  const token = config.getToken();
  agent?.stop();
  agent = null;
  if (token && serverUrl) await auth.unenroll({ fetchImpl: netFetch, serverUrl, token }).catch(() => false);
  config.setToken(null);
  config.set({ deviceId: "", deviceName: "", localPaused: false });
}

/** 退出登录：网页会话作废 + 设备令牌作废 + 清 Cookie。保留服务器地址和账号，登录页直接预填。 */
async function logout() {
  clearInterval(chatRetryTimer);
  cancelChatRetry();
  const local = config.get();
  if (local.serverUrl) {
    const origin = serverOrigin();
    await auth.logoutSession({ fetchImpl: netFetch, serverUrl: origin, cookieHeader: await cookieHeaderFor(origin).catch(() => "") }).catch(() => false);
  }
  await dropDevice(local.serverUrl);
  config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "logout", outcome: "succeeded", summary: "已退出本机登录并清除设备记录" });
  await session.fromPartition(PARTITION).clearStorageData({ storages: ["cookies"] });
  if (windows.chat && !windows.chat.isDestroyed()) windows.chat.destroy();
  windows.chat = null;
  refreshTray();
  openLogin("logout");
}

async function confirmLogout() {
  const ok = await confirmLocal({
    title: "退出登录？",
    description: "会作废这台电脑的设备令牌并清除登录状态，机器人不能再操作它。之后可以重新登录或换一台服务器。",
    confirmLabel: "退出登录",
  });
  if (ok) setTimeout(() => void logout(), 50);
  return ok;
}

/**
 * 本机登录页的「登录」：先 probe（login:probe）再调这里。
 * 换了服务器或账号时先作废旧身份的设备令牌；同一身份且令牌仍有效时不重复登记。
 * 设备登记失败（例如服务器还不支持 PC 设备）不挡登录，只在结果里带上 warning。
 */
async function submitLogin(input) {
  const serverUrl = auth.normalizeServerUrl(input.serverUrl);
  const username = String(input.username || "").trim();
  const remember = input.remember === true;
  const sessionInfo = await auth.login({ fetchImpl: netFetch, serverUrl, username, password: String(input.password || ""), remember });
  const prev = config.get();
  const ses = session.fromPartition(PARTITION);
  if (prev.serverUrl && (prev.serverUrl !== serverUrl || prev.username !== username)) {
    await dropDevice(prev.serverUrl);
    if (windows.chat && !windows.chat.isDestroyed()) windows.chat.destroy();
    windows.chat = null;
    await ses.clearStorageData({ storages: ["cookies"] });
  }
  await injectCookies(serverUrl, sessionInfo.cookies);
  const recent = [serverUrl, ...(Array.isArray(prev.recentServers) ? prev.recentServers : []).filter((s) => s !== serverUrl)].slice(0, 6);
  config.set({ serverUrl, username, remember, recentServers: recent });
  const versionProbe = localWeb.probeVersion({
    origin: serverUrl,
    fetchImpl: netFetch,
    cookieHeader: sessionInfo.cookieHeader,
    timeoutMs: 2500,
  });

  let device = null;
  let warning = "";
  const token = config.getToken();
  if (token) {
    const check = await auth.checkToken({ fetchImpl: netFetch, serverUrl, token }).catch(() => ({ ok: false }));
    if (check.ok) device = check.device;
    else if (check.revoked || check.invalid) config.setToken(null);
  }
  if (!config.getToken()) {
    try {
      const result = await auth.enroll({
        fetchImpl: netFetch,
        serverUrl,
        cookieHeader: sessionInfo.cookieHeader,
        info: { ...clientInfo(), name: config.get().deviceName || os.hostname() },
      });
      config.set({ deviceId: result.device.id, deviceName: result.device.name, localPaused: false });
      config.setToken(result.token);
      device = result.device;
    } catch (error) {
      warning = `已登录，但这台电脑没能登记为设备：${error.message}`;
      config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "enroll", outcome: "failed", summary: warning.slice(0, 300) });
    }
  }
  config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "login", outcome: "succeeded", summary: `登录 ${serverUrl}（${remember ? "记住登录" : "本次会话"}）` });
  clearTimeout(enrollRetryTimer);
  enrollIssue = warning;
  agentDetail = "";
  await versionProbe;
  startAgent();
  return { device, warning };
}

async function setLocal(patch) {
  const current = config.get();
  if (typeof patch.localPaused === "boolean" && patch.localPaused !== current.localPaused) await requestPaused(patch.localPaused);
  if (typeof patch.forceLocalApproval === "boolean" && patch.forceLocalApproval !== current.forceLocalApproval) {
    const ok =
      patch.forceLocalApproval ||
      (await confirmLocal({
        title: "关闭高风险操作的本机确认？",
        description: "关闭后，权限里设为「允许」的命令行、写入文件、鼠标键盘会直接执行，不再在这台电脑上弹窗。建议保持开启。",
        confirmLabel: "仍然关闭",
      }));
    if (ok) {
      config.set({ forceLocalApproval: patch.forceLocalApproval });
      config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "config_changed", outcome: "succeeded", summary: `本机确认 → ${patch.forceLocalApproval ? "开启" : "关闭"}` });
    }
  }
  if (typeof patch.autoStart === "boolean") {
    config.set({ autoStart: patch.autoStart });
    if (app.isPackaged || process.platform === "win32") app.setLoginItemSettings({ openAtLogin: patch.autoStart, args: ["--hidden"] });
  }
  if (typeof patch.startHidden === "boolean") config.set({ startHidden: patch.startHidden });
  if (typeof patch.autoUpdate === "boolean" && patch.autoUpdate !== (current.autoUpdate !== false)) {
    config.set({ autoUpdate: patch.autoUpdate });
    config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "config_changed", outcome: "succeeded", summary: `自动更新 → ${patch.autoUpdate ? "开启" : "关闭"}` });
    updater?.schedule();
  }
  const desktopPatch = desktopPrefs.sanitizeDesktopPrefsPatch(patch);
  if (Object.keys(desktopPatch).length > 0) {
    config.set(desktopPatch);
    if (typeof desktopPatch.spellcheck === "boolean") {
      try {
        session.fromPartition(PARTITION).setSpellCheckerEnabled?.(desktopPatch.spellcheck);
      } catch {}
    }
    if (typeof desktopPatch.timezone === "string") {
      if (desktopPatch.timezone) process.env.TZ = desktopPatch.timezone;
      else delete process.env.TZ;
    }
    config.appendAudit({
      at: new Date().toISOString(),
      actor: "本机",
      operation: "config_changed",
      outcome: "succeeded",
      summary: `桌面壳偏好已更新：${Object.keys(desktopPatch).join("、")}`,
    });
  }
  refreshTray();
  return webLocalState();
}

function registerIpc() {
  // 本机页面（设置向导 / 审批 / 本机确认 / 离线页）
  handleLocal("state:get", () => publicState());
  // 本机登录页（ui/login.html）。错误带 kind，登录页据此把提示放到对应输入框旁；
  // ipc 只能传 message，所以把 kind 编进 message 前缀「[kind] 」，页面再拆开。
  const tagged = (fn) => async (payload) => {
    try {
      return await fn(payload || {});
    } catch (error) {
      throw new Error(`[${error.kind || "invalid"}] ${error.message}`);
    }
  };
  handleLocal("login:probe", tagged(async ({ serverUrl }) => {
    const result = await auth.probe({ fetchImpl: netFetch, serverUrl });
    return { origin: result.origin, gateway: result.gateway };
  }));
  handleLocal("login:submit", tagged((input) => submitLogin(input)));
  handleLocal("login:forget", (serverUrl) => {
    const recent = (config.get().recentServers || []).filter((s) => s !== serverUrl);
    config.set({ recentServers: recent });
    return recent;
  });
  handleLocal("login:open", () => {
    if (windows.login && !windows.login.isDestroyed()) windows.login.close();
    openChat();
  });
  handleLocal("paused:set", async (paused) => {
    await requestPaused(!!paused);
    return publicState();
  });
  handleLocal("chat:retry", () => retryChat());
  handleLocal("approval:current", () => currentApproval?.request ?? null);
  handleLocal("approval:decide", ({ id, decision }) => {
    if (currentApproval && currentApproval.request.id === id) {
      currentApproval.resolve(decision === "approve" ? "approve" : "deny");
      currentApproval = null;
      approvalWindow?.close();
    }
  });
  handleLocal("update:current", () => currentUpdatePayload());
  handleLocal("update:answer", ({ restart } = {}) => {
    if (restart === true) return installUpdateNow();
    updateWindow?.close();
    return false;
  });
  handleLocal("update:retry", async () => {
    dismissedDownloadVersion = "";
    const activeUpdater = ensureUpdaterStarted();
    return activeUpdater ? activeUpdater.check() : currentUpdatePayload();
  });
  handleLocal("update:download-latest", () => {
    const url = manualUpdateDownloadUrl();
    if (!/^https:\/\//i.test(url)) return false;
    void shell.openExternal(url);
    return true;
  });
  // 本机小窗口自己的窗口按钮（最小化 / 最大化 / 关闭，DESIGN.md §91、§152）：只作用于发起调用的那个本机窗口。
  handleLocal("window:local", (action, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win === windows.chat) return false;
    if (action === "minimize" && win.isMinimizable()) win.minimize();
    else if (action === "toggle-maximize" && win.isMaximizable()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close();
    else return false;
    return true;
  });
  // 审批 / 本机确认按内容定高（DESIGN.md §91.3）：审批窗贴住右下角往上长，确认窗保持中心。
  handleLocal("dialog:fit", ({ height } = {}, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || (win !== approvalWindow && win !== confirmWindow)) return false;
    const h = windowChrome.fitHeight(height);
    if (!h) return false;
    const b = win.getBounds();
    const width = dialogWidth.get(win) || b.width;
    if (Math.abs(b.height - h) >= 2 || b.width !== width) {
      if (win === approvalWindow) win.setBounds({ x: b.x, y: b.y + b.height - h, width, height: h });
      else win.setBounds({ x: b.x, y: Math.round(b.y + (b.height - h) / 2), width, height: h });
    }
    pendingShow.get(win)?.();
    return true;
  });
  handleLocal("confirm:current", () => confirmCurrent?.request ?? null);
  handleLocal("confirm:answer", ({ id, ok }) => {
    if (confirmCurrent && confirmCurrent.request.id === id) {
      confirmCurrent.resolve(ok === true);
      confirmCurrent = null;
      confirmWindow?.close();
    }
  });

  // 网页本机桥（web-preload.js → window.chisabotPC）
  ipcMain.on("pc:origin", (event) => {
    event.returnValue = event.sender === windows.chat?.webContents ? serverOrigin() : "";
  });
  handleWeb("pc:state", () => webLocalState());
  // 无边框主窗口的窗口控制（网页顶栏右上角）。关闭 = 和原来点 ✕ 一样隐藏到托盘。
  const chatWin = (event) => (fromServerPage(event) || fromChatLocalPage(event) ? windows.chat : null);
  ipcMain.on("window:minimize", (event) => chatWin(event)?.minimize());
  ipcMain.on("window:toggle-maximize", (event) => {
    const win = chatWin(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("window:close", (event) => chatWin(event)?.close());
  handleChatWindow("window:is-maximized", () => Boolean(windows.chat && !windows.chat.isDestroyed() && windows.chat.isMaximized()));
  // 小窗模式：网页右上角的「小窗模式 / 恢复窗口」按钮。
  ipcMain.on("window:toggle-compact", (event) => {
    const win = chatWin(event);
    if (win) compactWindows().toggle(win);
  });
  handleChatWindow("window:is-compact", () => compactWindows().isCompact(windows.chat));
  handleWeb("pc:set", (patch) => setLocal(patch && typeof patch === "object" ? patch : {}));
  handleWeb("pc:pick-folders", async () => {
    const result = await dialog.showOpenDialog(windows.chat, {
      title: "选择允许机器人访问的文件夹",
      properties: ["openDirectory", "multiSelections", "createDirectory", "dontAddToRecent"],
    });
    return result.canceled ? [] : result.filePaths;
  });
  handleWeb("pc:logout", () => confirmLogout());
  // 网页设备页的「登记这台电脑」：和托盘「重新登记这台电脑」同一条路径（本机亲自操作，所以 force）。
  handleWeb("pc:enroll", async () => {
    // 这台电脑是被人撤销的：网页脚本不能替用户把它重新接回去，先在本机确认（和解除紧急停止同一道闸）。
    if (agent?.state === "revoked" && agentDetail !== "设备令牌无效") {
      const ok = await confirmLocal({
        title: "重新登记这台电脑？",
        description: "这台电脑之前被撤销了关联。重新登记后它会作为新设备出现在设备列表里，能力默认「询问」（每次要你批准）。",
        confirmLabel: "重新登记",
      });
      if (!ok) return { status: "cancelled", message: "已取消。", state: webLocalState() };
    }
    const result = await repairDevice({ force: true, manual: true });
    return { status: result.status, message: result.message, state: webLocalState() };
  });
  // 设备页「重新连接」：没登记就补登记，否则跳过退避立刻重连。
  handleWeb("pc:reconnect", async () => {
    if (needsEnroll() && agent?.state !== "revoked") {
      const result = await repairDevice({ manual: false });
      return { status: result.status, message: result.message, state: webLocalState() };
    }
    if (!agent) startAgent();
    else agent.reconnectNow();
    return { status: "reconnecting", message: "正在重新连接…", state: webLocalState() };
  });
  handleWeb("pc:check-update", async () => {
    const activeUpdater = ensureUpdaterStarted();
    const next = activeUpdater ? await activeUpdater.check() : { supported: false, status: "idle" };
    if (["downloading", "verifying", "downloaded"].includes(next?.status)) {
      dismissedDownloadVersion = "";
      openUpdateWindow({ focus: true });
    }
    return next;
  });
  // 网页只能把独立更新进度/就绪窗口叫出来；立即重启要在那个窗口里由本人点。
  handleWeb("pc:install-update", () => {
    dismissedDownloadVersion = "";
    return openUpdateWindow({ focus: true });
  });
  handleWeb("pc:focus-window", () => {
    focusMainWindow(windows.chat);
    return true;
  });
  handleWeb("pc:consume-deep-link", () => {
    if (!pendingDeepLink) return null;
    const next = {
      kind: pendingDeepLink.kind,
      ...(pendingDeepLink.agentId ? { agentId: pendingDeepLink.agentId } : {}),
      ...(pendingDeepLink.channelId ? { channelId: pendingDeepLink.channelId } : {}),
      pathname: pendingDeepLink.pathname,
    };
    pendingDeepLink = null;
    return next;
  });
  handleWeb("pc:appearance", (value) => {
    const next = { dark: typeof value?.dark === "boolean" ? value.dark : null, sky: value?.sky !== false };
    const prev = config.get().appearance || {};
    if (prev.dark !== next.dark || prev.sky !== next.sky) {
      config.set({ appearance: next });
      nativeTheme.themeSource = next.dark === null ? "system" : next.dark ? "dark" : "light";
      broadcast("appearance");
      if (updateWindow && !updateWindow.isDestroyed()) updateWindow.setBackgroundColor(updateWindowBackground());
    }
    return true;
  });
  handleWeb("pc:diagnostics-export", () =>
    diagnosticsLog.buildExportPayload({
      clientVersion: pkg.version,
      agentState: agent?.state || "offline",
      accessibilityGrants: getAccessibilityBridge().authorizer.snapshot().grants.length,
    }),
  );
  handleWeb("pc:browser-profiles", () => getBrowserBridge().discoverProfiles());
}

// ---------- 生命周期 ----------

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
});
app.on("second-instance", (_event, argv) => {
  const link = extractDeepLinkFromArgv(argv);
  if (link) {
    handleDeepLinkUrl(link.raw);
    return;
  }
  void Promise.resolve(openApp()).then((win) => focusMainWindow(win));
});
// macOS：点 Dock 图标把主窗口叫回来（窗口关掉只是隐藏，应用常驻）。
app.on("activate", () => void openApp());
app.on("window-all-closed", () => {
  /* 常驻托盘 */
});
app.on("before-quit", (event) => {
  quitting = true;
  disposePrewarmedChatWindow();
  try {
    globalShortcut?.unregisterAll?.();
  } catch {}
  agent?.stop();
  disposeResidentWinHelper();
  // 下载好（并验签通过）的更新而用户选了「稍后」：退出这一刻静默安装。需要重新安装（换了图标 / 组件）的走重新安装；
  // 普通更新在启用验签时也由这里安装（electron-updater 自己的退出安装没挂，见 updater.js）。
  const outcome = updater?.installOnQuit();
  // macOS 验签后退出安装要撑住应用：Squirrel 还在从本地代理拉包，拉完 electron-updater 会自己再退一次。
  if (outcome === "hold") {
    event.preventDefault();
    return;
  }
  if (outcome)
    config?.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "update_install", outcome: "succeeded", summary: `${updater.state.fullInstall ? "退出时重新安装" : "退出时安装"} ${updater.state.version || ""}` });
  config?.flushAuditSync?.();
});

// ---------- 外壳刷新（src/shell-refresh.js） ----------
// 新版本第一次启动且外壳指纹变了：把指向本程序的桌面 / 开始菜单 / 任务栏快捷方式按新 exe 重写，刷新图标缓存。

async function scanShortcutsAsync({ desktopDir, appData }) {
  const roots = [];
  if (desktopDir) roots.push([desktopDir, 0]);
  if (appData) {
    roots.push([path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"), 1]);
    roots.push([path.win32.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"), 0]);
  }
  const dirEntries = new Map();
  const dirPaths = new Set();

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = [];
    const subdirs = [];
    for (const entry of entries) {
      names.push(entry.name);
      if (depth > 0 && entry.isDirectory()) {
        const full = path.win32.join(dir, entry.name);
        dirPaths.add(full);
        subdirs.push(full);
      }
    }
    dirEntries.set(dir, names);
    if (subdirs.length > 0) {
      await Promise.all(subdirs.map((sub) => walk(sub, depth - 1)));
    }
  }

  await Promise.all(roots.map(([dir, depth]) => walk(dir, depth)));
  return shellRefresh.scanShortcuts({
    desktopDir,
    appData,
    readdir: (dir) => dirEntries.get(dir) || [],
    isDir: (p) => dirPaths.has(p),
  });
}

function dedupeWinPaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const key = path.win32.normalize(String(item)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function refreshShellIfChanged() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const last = config.get().shellHash || "";
  const icon = shellRefresh.findIcon({ resourcesPath: process.resourcesPath });
  const desktopDir = app.getPath("desktop");
  const defaultCandidates = shellRefresh.shortcutCandidates({
    desktopDir,
    appData: process.env.APPDATA,
    shortcutName: pkg.build?.nsis?.shortcutName || pkg.productName || "ChisaBot",
  });
  const scannedCandidates = await scanShortcutsAsync({ desktopDir, appData: process.env.APPDATA });
  const candidates = dedupeWinPaths([...defaultCandidates, ...scannedCandidates]);
  const existingPairs = await Promise.all(
    candidates.map(async (link) => [
      link,
      await fsp.access(link).then(
        () => true,
        () => false,
      ),
    ]),
  );
  const existingLinks = [];
  const existingSet = new Set();
  for (const [link, ok] of existingPairs) {
    if (ok) {
      existingLinks.push(link);
      existingSet.add(path.win32.normalize(link).toLowerCase());
    }
  }
  const fastExists = (p) => {
    const key = path.win32.normalize(String(p)).toLowerCase();
    if (existingSet.has(key)) return true;
    return fs.existsSync(p);
  };
  // 指纹没变也看一眼：有快捷方式的图标还不是这份 .ico（或指向已不存在的旧安装位置）就修。
  const changed = shellRefresh.needsShellRefresh({ current: SHELL_HASH, last });
  if (!changed && !shellRefresh.staleShortcuts({ shell, exists: fastExists, execPath: process.execPath, icon, candidates: existingLinks }).length) return;
  let result = { updated: [], cacheRefreshed: false };
  try {
    result = shellRefresh.refreshShell({
      shell,
      exists: fastExists,
      execPath: process.execPath,
      icon,
      appUserModelId: APP_USER_MODEL_ID,
      candidates: existingLinks,
      systemRoot: process.env.SystemRoot || process.env.windir,
      osRelease: os.release(),
      run: (cmd, args) => {
        const child = require("node:child_process").spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
      },
      log: (line) => config.appendAudit({ at: new Date().toISOString(), actor: "本机", operation: "shell_refresh", outcome: "warn", summary: line.slice(0, 300) }),
    });
  } finally {
    config.set({ shellHash: SHELL_HASH });
  }
  config.appendAudit({
    at: new Date().toISOString(),
    actor: "本机",
    operation: "shell_refresh",
    outcome: "succeeded",
    summary: `外壳已更新（${SHELL_HASH}）：快捷方式 ${result.updated.length} 个${result.cacheRefreshed ? "，已刷新图标缓存" : ""}`,
  });
}

const localWeb = createLocalWebController({
  bundleDir: path.join(__dirname, "web-bundle"),
  localVersion: pkg.version,
  getServerOrigin: serverOrigin,
  onModeChange: ({ origin, mode, prevMode, serverVersion }) => {
    broadcast();
    if (serverVersion && getUpdaterMod().compareVersion(serverVersion, pkg.version) > 0) {
      ensureUpdaterStarted();
      void updater?.nudge({ version: serverVersion, reason: "server_version", minGapMs: 30_000 });
    }
    // 探测/嗅探可能晚于页面加载（窗口里还是内置旧前端）：local→remote 一旦翻转就重载聊天窗口，
    // 换到服务器前端。serverVersions 单调递增，local→remote 每会话最多翻一次，不会反复重载。
    if (mode === "remote" && prevMode === "local" && origin === serverOrigin() && windows.chat && !windows.chat.isDestroyed() && !chatOffline) {
      windows.chat.webContents.reload();
    }
  },
});

app.whenReady().then(() => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  const ses = session.fromPartition(PARTITION);
  localWeb.installSessionProtocol(ses);
  let activeEgressPolicy = desktopPrefs.compileEgressPolicy({
    serverOrigin: "",
    allowedDomains: [],
  });
  let cachedEgressOrigin = "";
  let cachedEgressDomainsKey = "\0__uninit__";
  const refreshEgressPolicy = () => {
    const origin = serverOrigin();
    const raw = config?.peek ? config.peek() : config?.get();
    const domains = Array.isArray(raw?.allowedEgressDomains) ? raw.allowedEgressDomains : [];
    const domainsKey = domains.join("\0");
    if (origin === cachedEgressOrigin && domainsKey === cachedEgressDomainsKey) return;
    cachedEgressOrigin = origin;
    cachedEgressDomainsKey = domainsKey;
    activeEgressPolicy = desktopPrefs.compileEgressPolicy({
      serverOrigin: origin,
      allowedDomains: domains,
    });
  };
  // 出口域名白名单：仅放行已配 server origin、loopback 与显式放行域名，防恶意渲染脚本外泄。
  // 热路径直接读取配置变更时预编译的策略引用，零 config.get() 拷贝与零 URL 重复构造。
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = desktopPrefs.isEgressUrlAllowed(details.url, {
      policy: activeEgressPolicy,
    });
    callback({ cancel: !allowed });
  });
  // macOS 应用菜单：没有它 ⌘C/⌘V/⌘Q 都不生效（窗口 setMenu 在 mac 上是空的，菜单是应用级的）。
  // 编辑 / 视图 / 窗口用系统 role；退出走 role:"quit"→ before-quit（隐藏语义的「关闭窗口」归 ⌘W）。
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: pkg.productName || "ChisaBot",
          submenu: [
            { role: "about", label: `关于 ${pkg.productName || "ChisaBot"}` },
            { type: "separator" },
            { role: "hide", label: "隐藏 ChisaBot" },
            { role: "hideOthers", label: "隐藏其他" },
            { role: "unhide", label: "全部显示" },
            { type: "separator" },
            { role: "quit", label: "退出 ChisaBot" },
          ],
        },
        // 文件 > 关闭窗口（⌘W）：macOS 惯例；关的是窗口不是进程——和窗口里的 ✕ 一样只是隐藏，应用常驻。
        { label: "文件", submenu: [{ role: "close", label: "关闭窗口" }] },
        { role: "editMenu", label: "编辑" },
        { label: "视图", submenu: [{ role: "togglefullscreen", label: "切换全屏" }] },
        { role: "windowMenu", label: "窗口" },
      ]),
    );
    // 开发运行时是 Electron 默认图标，dock 上换成品牌图标；打包版用 build/icon.icns。
    if (!app.isPackaged) {
      try {
        app.dock?.setIcon(nativeImage.createFromPath(path.join(ASSETS, "icon.png")));
      } catch {}
    }
  }
  // 休眠唤醒 / 解锁后网络往往刚恢复，旧连接可能已经半死：立刻重连，不等退避和看门狗；顺手节流补查一次更新。
  powerMonitor.on("resume", () => {
    agent?.reconnectNow();
    if (updater) void updater.nudge({ reason: "resume", minGapMs: getUpdaterMod().DEFAULT_WAKE_GAP_MS });
  });
  powerMonitor.on("unlock-screen", () => {
    agent?.reconnectNow();
    if (updater) void updater.nudge({ reason: "unlock", minGapMs: getUpdaterMod().DEFAULT_WAKE_GAP_MS });
  });
  config = createConfig({ dir: app.getPath("userData"), safeStorage });
  refreshEgressPolicy();
  config.onChange(() => refreshEgressPolicy());
  try {
    ses.setSpellCheckerEnabled?.(config.get().spellcheck !== false);
  } catch {}
  const appearance = config.get().appearance || {};
  nativeTheme.themeSource = typeof appearance.dark === "boolean" ? (appearance.dark ? "dark" : "light") : "system";
  registerIpc();
  // 全局快捷键 Alt+Space 呼出 ChisaBot 随手问浮窗（Spotlight 模式）
  try {
    globalShortcut?.register?.("Alt+Space", () => {
      void Promise.resolve(openApp()).then((win) => {
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.executeJavaScript(
            'window.dispatchEvent(new CustomEvent("chisabot-spotlight"))',
          ).catch(() => {});
        }
      });
    });
  } catch {}
  setTimeout(() => {
    void refreshShellIfChanged().catch(() => {});
  }, 3000).unref();
  tray = new Tray(trayIcon("offline"));
  tray.on("click", () => void openApp());
  tray.on("double-click", () => void openApp());
  refreshTray();
  if (config.get().serverUrl) {
    if (config.getToken()) startAgent();
    // 已登录但没有设备令牌（重装、令牌解不开、旧版配置）：用还有效的会话补登记，不再永远「看不到这台电脑」。
    else void repairDevice();
    if (pendingDeepLink) void openApp(pendingDeepLink.pathname);
    else if (!HIDDEN && !config.get().startHidden) void openApp();
  } else {
    openLogin();
  }
  // 将更新器初始化延后至主窗口开始加载之后，避免阻塞冷启动首帧（尤其是 macOS codesign 检查）。
  setTimeout(() => {
    try {
      ensureUpdaterStarted();
    } catch {}
  }, 1500).unref();
});
