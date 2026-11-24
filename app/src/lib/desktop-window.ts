import { useCallback, useSyncExternalStore } from "react";
import { beginResizing } from "@/lib/resize-state";

export type DesktopWindowStatePayload = {
  maximized?: boolean;
  compact?: boolean;
  transitioning?: boolean;
};

/**
 * ChisaBot 无边框窗口的窗口控制（DESIGN.md §18）。
 *
 * PC 客户端的主窗口没有系统标题栏：网页自己的顶栏就是标题栏（拖动区 + 最小化 / 最大化 / 关闭）。
 * 桥由 Electron 的 web-preload 只在已登录服务器的顶层页面里注入；普通浏览器里 `window.chisabotWindow`
 * 不存在，顶栏、圆角、内边距都和以前一样。
 */
export type DesktopWindowBridge = {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  /**
   * 小窗模式（DESIGN.md §36）：手机比例的竖长小窗 ↔ 原来的大小和位置。PC 0.1.3 起才有；
   * 旧客户端没有这三个方法，网页就不显示小窗按钮（快捷键 Ctrl+Shift+M 由主进程处理，也要新客户端）。
   */
  toggleCompact?(): void;
  isCompact?(): Promise<boolean>;
  onCompactChange?(callback: (compact: boolean) => void): () => void;
  /** 合并推送 maximized + compact 状态，避免小窗切换期间分两次 IPC 与双重重渲。 */
  onStateChange?(
    callback: (state: DesktopWindowStatePayload) => void,
  ): () => void;
};

export type DesktopWindowSnapshot = {
  bridge: DesktopWindowBridge;
  maximized: boolean;
  compact: boolean;
};

declare global {
  interface Window {
    chisabotWindow?: DesktopWindowBridge;
  }
}

export function desktopWindow(): DesktopWindowBridge | null {
  return typeof window !== "undefined" && window.chisabotWindow
    ? window.chisabotWindow
    : null;
}

/** 这台 PC 客户端支持小窗模式吗（旧客户端没有）。 */
export function canCompact(bridge: DesktopWindowBridge | null): boolean {
  return Boolean(
    bridge &&
      typeof bridge.toggleCompact === "function" &&
      typeof bridge.isCompact === "function",
  );
}

/*
 * 模块级单例外部存储：DesktopStrip（__root.tsx）与 GlassTopBar 共用同一份 IPC 订阅、
 * 同一个 resize 监听、同一个 250ms 边缘裁切轮询与一次 <html> 属性同步，彻底消除双份定时器和双写 DOM。
 * 最后一个消费方卸载时自动拆除全部监听与定时器并清理 --edge-clip-r。
 */
/** 小窗切换期间暂缓 --edge-clip-r 写入的结算窗口（ms），避免 unmaximize/setBounds 中间态在 <html> 上反复触发布局样式重算。 */
const COMPACT_CLIP_SETTLE_MS = 220;

const subscribers = new Set<() => void>();
let activeBridge: DesktopWindowBridge | null = null;
let activeSnapshot: DesktopWindowSnapshot | null = null;
let fallbackBridge: DesktopWindowBridge | null = null;
let fallbackSnapshot: DesktopWindowSnapshot | null = null;
let teardownActive: (() => void) | null = null;
let onCompactTransitionStart: (() => void) | null = null;
let sessionSeq = 0;

/**
 * 标记即将发生小窗竖屏↔横屏切换：
 * 1) 同步预挂 `html[data-resizing]`，令单次原子 `setBounds` 首帧跨断点即享过渡/动画抑制；
 * 2) 暂缓过渡期内的 `--edge-clip-r` 根属性写入，待落位稳定后一次结算，避免 160–290ms 全树 RecalcStyle 抖动。
 */
export function beginCompactTransition() {
  beginResizing(COMPACT_CLIP_SETTLE_MS);
  onCompactTransitionStart?.();
}

/** 点击顶栏小窗按钮时统一入口：先同步预挂过渡护栏，再通知主进程原子切窗。 */
export function triggerCompactToggle(bridge: DesktopWindowBridge | null) {
  if (!bridge || !canCompact(bridge)) return;
  beginCompactTransition();
  bridge.toggleCompact?.();
}

/** 点击最大化/还原或双击顶栏时统一入口：先同步预挂过渡护栏，再通知主进程切窗。 */
export function triggerMaximizeToggle(bridge: DesktopWindowBridge | null) {
  if (!bridge) return;
  beginCompactTransition();
  bridge.toggleMaximize();
}

function notifySubscribers() {
  for (const listener of [...subscribers]) listener();
}

function writeDocumentFlags(
  root: HTMLElement,
  maximized: boolean,
  compact: boolean,
) {
  const maxStr = maximized ? "true" : "false";
  const compactStr = compact ? "true" : "false";
  if (root.dataset.maximized !== maxStr) root.dataset.maximized = maxStr;
  if (root.dataset.compact !== compactStr) root.dataset.compact = compactStr;
}

function stopActiveBridge() {
  sessionSeq += 1;
  const teardown = teardownActive;
  teardownActive = null;
  onCompactTransitionStart = null;
  activeBridge = null;
  activeSnapshot = null;
  teardown?.();
}

function startActiveBridge(bridge: DesktopWindowBridge) {
  if (activeBridge === bridge && teardownActive) return;
  stopActiveBridge();
  const seq = sessionSeq;
  activeBridge = bridge;
  let maximizedNow = false;
  let compactNow = false;
  let lastClip = "";
  let compactSettling = false;
  let compactSettleTimer = 0;
  let resizeClipRaf = 0;
  activeSnapshot = { bridge, maximized: false, compact: false };

  const root = document.documentElement;
  root.dataset.desktop = bridge.platform || "win32";
  writeDocumentFlags(root, maximizedNow, compactNow);

  /*
   * 把窗口右缘越出屏幕工作区多少写进 --edge-clip-r，右缘的「面板」把手按它让位（styles.css）。
   * 恢复态窗口可以被拖得右缘出屏，这时把手跟着出屏被裁；最大化时客户区就是工作区，
   * 越屏量恒为 0（outerWidth 是否含 thickFrame 进边各实现不一，按 0 收），把手维持贴可见边缘。
   * 拖窗口不触发 resize、桥没有 bounds 回调，250ms 轮询比对越屏量（读 screenX/outerWidth
   * 不引发布局，不变时不写样式）——0.1.161 的让位逻辑否则只在窗口改大小时生效，
   * 把手跟着出屏被裁半条（用户 2026-11-18 截图实测）。浏览器没有这座桥，变量不设、恒回落 0。
   */
  const syncEdgeClip = (force = false) => {
    if (compactSettling && !force) return;
    const availLeft =
      (window.screen as Screen & { availLeft?: number }).availLeft ?? 0;
    const availWidth = window.screen.availWidth;
    const availRight = availLeft + availWidth;
    const rawOverhang = Math.max(
      0,
      Math.round(window.screenX + window.outerWidth - availRight),
    );
    const frameExcess = window.outerWidth - window.innerWidth;
    const emulatedNarrowViewport =
      frameExcess > 48 && availWidth <= window.innerWidth + 48;
    const unclippedFullSpan =
      window.screenX <= availLeft && window.innerWidth <= availWidth;
    const maxOverhang = Math.max(0, window.innerWidth - 48);
    const overhang =
      availWidth <= 0 || emulatedNarrowViewport || unclippedFullSpan
        ? 0
        : Math.min(rawOverhang, maxOverhang);
    const next = `${maximizedNow ? 0 : overhang}px`;
    if (next !== lastClip) {
      lastClip = next;
      root.style.setProperty("--edge-clip-r", next);
    }
  };

  const pauseClipForCompact = () => {
    compactSettling = true;
    window.clearTimeout(compactSettleTimer);
    compactSettleTimer = window.setTimeout(() => {
      compactSettleTimer = 0;
      compactSettling = false;
      syncEdgeClip(true);
    }, COMPACT_CLIP_SETTLE_MS);
  };
  onCompactTransitionStart = pauseClipForCompact;

  const onWindowResize = () => {
    if (compactSettling) {
      // 窗口实际 resize 已到达，刷新结算窗口以便落位后单次更新 --edge-clip-r。
      pauseClipForCompact();
      return;
    }
    if (resizeClipRaf) return;
    resizeClipRaf = window.requestAnimationFrame(() => {
      resizeClipRaf = 0;
      syncEdgeClip();
    });
  };

  const updateState = (
    nextMax: boolean,
    nextCompact: boolean,
    options?: { skipClip?: boolean },
  ) => {
    const changed = nextMax !== maximizedNow || nextCompact !== compactNow;
    maximizedNow = nextMax;
    compactNow = nextCompact;
    writeDocumentFlags(root, maximizedNow, compactNow);
    if (!options?.skipClip) syncEdgeClip();
    if (changed) {
      activeSnapshot = { bridge, maximized: maximizedNow, compact: compactNow };
      notifySubscribers();
    }
  };

  syncEdgeClip(true);
  window.addEventListener("resize", onWindowResize, { passive: true });
  const clipTimer = window.setInterval(() => syncEdgeClip(), 250);

  void bridge
    .isMaximized()
    .then((value) => {
      if (seq !== sessionSeq) return;
      updateState(Boolean(value), compactNow);
    })
    .catch(() => {});

  let offMax = () => {};
  let offCompact = () => {};
  let offState = () => {};

  if (canCompact(bridge)) {
    void bridge
      .isCompact?.()
      .then((value) => {
        if (seq !== sessionSeq) return;
        updateState(maximizedNow, Boolean(value));
      })
      .catch(() => {});
  }

  if (typeof bridge.onStateChange === "function") {
    offState = bridge.onStateChange((state) => {
      if (seq !== sessionSeq) return;
      const nextMax =
        typeof state.maximized === "boolean" ? state.maximized : maximizedNow;
      const nextCompact =
        typeof state.compact === "boolean" ? state.compact : compactNow;
      const isCompactToggle =
        state.transitioning === true || nextCompact !== compactNow;
      if (isCompactToggle) {
        beginCompactTransition();
      }
      updateState(nextMax, nextCompact, { skipClip: isCompactToggle });
    });
  } else {
    offMax = bridge.onMaximizedChange((value) => {
      if (seq !== sessionSeq) return;
      updateState(Boolean(value), compactNow);
    });
    if (canCompact(bridge)) {
      offCompact =
        bridge.onCompactChange?.((value) => {
          if (seq !== sessionSeq) return;
          const nextCompact = Boolean(value);
          if (nextCompact !== compactNow) beginCompactTransition();
          updateState(maximizedNow, nextCompact, {
            skipClip: nextCompact !== compactNow,
          });
        }) ?? offCompact;
    }
  }

  teardownActive = () => {
    offState();
    offMax();
    offCompact();
    window.removeEventListener("resize", onWindowResize);
    window.clearInterval(clipTimer);
    window.clearTimeout(compactSettleTimer);
    if (resizeClipRaf) window.cancelAnimationFrame(resizeClipRaf);
    root.style.removeProperty("--edge-clip-r");
  };
}

function getSnapshotFor(
  bridge: DesktopWindowBridge | null,
): DesktopWindowSnapshot | null {
  if (!bridge) return null;
  if (activeBridge === bridge && activeSnapshot) return activeSnapshot;
  if (fallbackBridge !== bridge || !fallbackSnapshot) {
    fallbackBridge = bridge;
    fallbackSnapshot = { bridge, maximized: false, compact: false };
  }
  return fallbackSnapshot;
}

/**
 * 在 PC 客户端里返回 { bridge, maximized, compact }，并把 `data-desktop` / `data-maximized` / `data-compact`
 * 写到 <html> 上，让样式表按窗口状态调整（小窗时标题按钮变窄等）；在浏览器里返回 null，什么都不改。
 * 多个组件同时调用时共享唯一一份 IPC 订阅、resize 监听与 250ms 边缘裁切轮询。
 */
export function useDesktopWindow(): DesktopWindowSnapshot | null {
  const bridge = desktopWindow();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!bridge) return () => {};
      subscribers.add(listener);
      startActiveBridge(bridge);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          stopActiveBridge();
        }
      };
    },
    [bridge],
  );
  const getSnapshot = useCallback(() => getSnapshotFor(bridge), [bridge]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
