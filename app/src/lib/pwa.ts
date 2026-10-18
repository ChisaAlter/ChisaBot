import { useSyncExternalStore } from "react";
import { isAndroidApp, isIOS, isPhone, isStandalone } from "@/lib/device";

/**
 * 网页应用（PWA，DESIGN.md §40，docs/pwa.md）：注册 service worker、接住浏览器的「可安装」事件、
 * 安装后在电脑上把独立窗口开到宽屏大小。
 *
 * ChisaBot PC（Electron）和安卓客户端本身就是应用：不注册 service worker，也不提示安装。
 */

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function isNativeClient(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as { chisabotWindow?: unknown }).chisabotWindow) || isAndroidApp() || /\bElectron\//.test(navigator.userAgent);
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export type InstallState = { canPrompt: boolean; installed: boolean };
let snapshot: InstallState = { canPrompt: false, installed: false };
function refreshSnapshot() {
  snapshot = { canPrompt: Boolean(deferred), installed };
  emit();
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** 弹出浏览器自己的安装对话框。返回用户是否装了。 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  refreshSnapshot();
  try {
    // Chromium 无头 / 部分桌面环境会挂住不弹窗也不 resolve；限时后当取消，避免横幅卡死。
    const outcome = await Promise.race([
      (async () => {
        await event.prompt();
        const choice = await event.userChoice;
        return choice.outcome === "accepted";
      })(),
      new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(false), 12_000);
      }),
    ]);
    return outcome;
  } catch {
    return false;
  }
}

/** iOS Safari（不是 iOS 上的 Chrome / Firefox / 应用内浏览器）：只能「分享 → 添加到主屏幕」。 */
export function isIOSSafari(): boolean {
  if (typeof navigator === "undefined" || !isIOS()) return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|MicroMessenger|QQ\/|Weibo|DingTalk/i.test(ua);
}

const SW_OFF_KEY = "chisabot-sw";

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext || import.meta.env.DEV) return;
  let off = false;
  try {
    off = window.localStorage.getItem(SW_OFF_KEY) === "off";
  } catch {}
  if (off || isNativeClient()) {
    // 退路：关掉时把已经装上的注销（PC / 安卓客户端里也不留）。
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    return;
  }
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
}

const SIZED_KEY = "chisabot-pwa-window-sized";

/**
 * 电脑上第一次以安装后的应用打开：浏览器给的独立窗口常常只有 ~800px 宽（落到窄布局），
 * 这里开到宽屏（最多 1440×920，留出边距并居中）。只做一次；之后用户自己调的大小浏览器会记住。
 */
function sizeDesktopWindow() {
  if (!isStandalone() || isPhone() || isNativeClient()) return;
  if (window.matchMedia("(pointer: coarse)").matches) return;
  try {
    if (window.localStorage.getItem(SIZED_KEY)) return;
    window.localStorage.setItem(SIZED_KEY, "1");
  } catch {
    return;
  }
  const availW = window.screen.availWidth || 0;
  const availH = window.screen.availHeight || 0;
  if (!availW || !availH || window.outerWidth >= Math.min(1200, availW - 40)) return;
  const width = Math.min(1440, availW - 48);
  const height = Math.min(920, availH - 48);
  try {
    window.resizeTo(width, height);
    const left = ((window.screen as { availLeft?: number }).availLeft ?? 0) + Math.round((availW - width) / 2);
    const top = ((window.screen as { availTop?: number }).availTop ?? 0) + Math.round((availH - height) / 2);
    window.moveTo(left, top);
  } catch {}
}

let started = false;

/** 入口调用一次。 */
export function installPwa() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (isNativeClient()) {
    void registerServiceWorker(); // unregisters only
    return;
  }
  // index.html 的内联脚本可能比这里早接到事件（存在 window.__chisabotInstallPrompt）。
  const early = (window as { __chisabotInstallPrompt?: InstallPromptEvent }).__chisabotInstallPrompt;
  if (early) {
    deferred = early;
    refreshSnapshot();
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // 我们自己挑时机提示（install-hint.tsx），不让浏览器在加载第一秒弹条
    deferred = event as InstallPromptEvent;
    refreshSnapshot();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    refreshSnapshot();
  });
  sizeDesktopWindow();
  // 不和首屏抢网络：页面加载完、空闲时再注册。
  const register = () => {
    const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(() => void registerServiceWorker(), { timeout: 5000 });
    else window.setTimeout(() => void registerServiceWorker(), 2000);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
