"use strict";
/**
 * 主窗口的 preload（docs/pc-node.md §8.2）。主窗口载入的是服务器上的 ChisaBot 网页本身。
 *
 *  - 网页（且只在已登录的那台服务器的顶层页面）里注入 window.chisabotPC：本机桥，只开放网页做不到的本机事情；
 *    主进程对每次调用再核对来源（主窗口 + 顶层框架 + 服务器 origin），放松安全的改动弹本机确认窗。
 *  - 网页的外观（深色 / 时间天空）转告主进程，本机窗口跟着网页走。
 *  - 主窗口断网时显示的本机离线页（file://）拿到和其它本机页面一样的 window.chisa（少量通道）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const isLocalPage = location.protocol === "file:";

/** 无边框主窗口的窗口控制：网页顶栏 / 离线页右上角的 小窗 · 最小化 · 最大化 · 关闭。 */
function exposeWindowControls() {
  contextBridge.exposeInMainWorld("chisabotWindow", {
    platform: process.platform,
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange(callback) {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on("window:maximized", listener);
      return () => ipcRenderer.removeListener("window:maximized", listener);
    },
    // 小窗模式（DESIGN.md §36）：手机比例的竖长小窗 ↔ 原来的大小和位置。
    toggleCompact: () => ipcRenderer.send("window:toggle-compact"),
    isCompact: () => ipcRenderer.invoke("window:is-compact"),
    onCompactChange(callback) {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on("window:compact", listener);
      return () => ipcRenderer.removeListener("window:compact", listener);
    },
  });
}

if (isLocalPage) {
  exposeWindowControls();
  const CHANNELS = new Set(["state:get", "paused:set", "chat:retry"]);
  contextBridge.exposeInMainWorld("chisa", {
    invoke(channel, payload) {
      if (!CHANNELS.has(channel)) return Promise.reject(new Error(`未知操作 ${channel}`));
      return ipcRenderer.invoke(channel, payload);
    },
    onState(callback) {
      const listener = (_event, kind) => callback(kind);
      ipcRenderer.on("state:changed", listener);
      return () => ipcRenderer.removeListener("state:changed", listener);
    },
  });
} else {
  let origin = "";
  try {
    origin = ipcRenderer.sendSync("pc:origin");
  } catch {}
  if (origin && location.origin === origin && window.top === window) {
    exposeWindowControls();
    const bool = (v) => (typeof v === "boolean" ? v : undefined);
    contextBridge.exposeInMainWorld("chisabotPC", {
      state: () => ipcRenderer.invoke("pc:state"),
      setLocal: (patch) =>
        ipcRenderer.invoke("pc:set", {
          localPaused: bool(patch?.localPaused),
          forceLocalApproval: bool(patch?.forceLocalApproval),
          autoStart: bool(patch?.autoStart),
          startHidden: bool(patch?.startHidden),
          autoUpdate: bool(patch?.autoUpdate),
          hardwareAcceleration: bool(patch?.hardwareAcceleration),
          spellcheck: bool(patch?.spellcheck),
          timezone: typeof patch?.timezone === "string" ? patch.timezone : undefined,
          allowedEgressDomains: Array.isArray(patch?.allowedEgressDomains) ? patch.allowedEgressDomains : undefined,
        }),
      checkUpdate: () => ipcRenderer.invoke("pc:check-update"),
      installUpdate: () => ipcRenderer.invoke("pc:install-update"),
      pickFolders: () => ipcRenderer.invoke("pc:pick-folders"),
      // 已登录但这台电脑没登记 / 令牌失效时，用当前会话重新登记（和托盘「重新登记这台电脑」同一条路径）。
      enroll: () => ipcRenderer.invoke("pc:enroll"),
      reconnect: () => ipcRenderer.invoke("pc:reconnect"),
      logout: () => ipcRenderer.invoke("pc:logout"),
      focusWindow: () => ipcRenderer.invoke("pc:focus-window"),
      consumeDeepLink: () => ipcRenderer.invoke("pc:consume-deep-link"),
      onDeepLink(callback) {
        const listener = (_event, link) => callback(link);
        ipcRenderer.on("pc:deep-link", listener);
        return () => ipcRenderer.removeListener("pc:deep-link", listener);
      },
      onChange(callback) {
        const listener = () => callback();
        ipcRenderer.on("state:changed", listener);
        return () => ipcRenderer.removeListener("state:changed", listener);
      },
    });

    // 外观：网页在 <html> 上切 .dark；时间天空看 <html data-sky>——SkyBackground 按外观模型
    // （模式 × 主题族双槽 × 天空来源，DESIGN §140/§143）写 "live"（实时动态天象）/ "snapshot"（固定场景）/
    // "off"（壁纸 · 主题渐变 · 性能模式），启动脚本在 React 前先写 "time"；旧键 chisabot-sky="off"
    // 时启动脚本不写属性 → 原生窗不画时间天空（老用户兼容）。
    const report = () => {
      const skyAttr = document.documentElement.getAttribute("data-sky");
      const sky = skyAttr === "live" || skyAttr === "time";
      ipcRenderer.invoke("pc:appearance", { dark: document.documentElement.classList.contains("dark"), sky }).catch(() => {});
    };
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(report, 200);
    };
    window.addEventListener("DOMContentLoaded", () => {
      report();
      new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-sky"] });
    });
    window.addEventListener("storage", schedule);
  }
}
