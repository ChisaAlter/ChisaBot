import { useState } from "react";
import { useDocumentSync, useExternalConnection } from "@/hooks";
import { objectConnectionKey } from "@/lib/connection-key";

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
};

declare global {
  interface Window {
    chisabotWindow?: DesktopWindowBridge;
  }
}

export function desktopWindow(): DesktopWindowBridge | null {
  return typeof window !== "undefined" && window.chisabotWindow ? window.chisabotWindow : null;
}

/** 这台 PC 客户端支持小窗模式吗（旧客户端没有）。 */
export function canCompact(bridge: DesktopWindowBridge | null): boolean {
  return Boolean(bridge && typeof bridge.toggleCompact === "function" && typeof bridge.isCompact === "function");
}

/**
 * 在 PC 客户端里返回 { maximized, compact }，并把 `data-desktop` / `data-maximized` / `data-compact` 写到 <html> 上，
 * 让样式表按窗口状态调整（小窗时标题按钮变窄等）；在浏览器里返回 null，什么都不改。
 */
export function useDesktopWindow(): { bridge: DesktopWindowBridge; maximized: boolean; compact: boolean } | null {
  const bridge = desktopWindow();
  const [maximized, setMaximized] = useState(false);
  const [compact, setCompact] = useState(false);
  const bridgeKey = objectConnectionKey(bridge);
  useExternalConnection(bridgeKey, (_key, signal) => {
    if (!bridge) return;
    const root = document.documentElement;
    root.dataset.desktop = bridge.platform || "win32";
    /*
     * 把窗口右缘越出屏幕工作区多少写进 --edge-clip-r，右缘的「面板」把手按它让位（styles.css）。
     * 恢复态窗口可以被拖得右缘出屏，这时把手跟着出屏被裁；最大化时客户区就是工作区，
     * 越屏量恒为 0（outerWidth 是否含 thickFrame 进边各实现不一，按 0 收），把手维持贴可见边缘。
     * 拖窗口不触发 resize、桥没有 bounds 回调，250ms 轮询比对越屏量（读 screenX/outerWidth
     * 不引发布局，不变时不写样式）——0.1.161 的让位逻辑否则只在窗口改大小时生效，
     * 把手跟着出屏被裁半条（用户 2026-11-18 截图实测）。浏览器没有这座桥，变量不设、恒回落 0。
     */
    let maximizedNow = false;
    let lastClip = "";
    const syncEdgeClip = () => {
      // availLeft / availTop 是 Windows / Electron 事实标准但没进 TS 的 DOM Screen 类型。
      const availLeft =
        (window.screen as Screen & { availLeft?: number }).availLeft ?? 0;
      const availRight = availLeft + window.screen.availWidth;
      const overhang = Math.max(
        0,
        Math.round(window.screenX + window.outerWidth - availRight),
      );
      const next = `${maximizedNow ? 0 : overhang}px`;
      if (next !== lastClip) {
        lastClip = next;
        root.style.setProperty("--edge-clip-r", next);
      }
    };
    syncEdgeClip();
    window.addEventListener("resize", syncEdgeClip);
    const clipTimer = window.setInterval(syncEdgeClip, 250);
    void bridge
      .isMaximized()
      .then((value) => {
        if (signal.aborted) return;
        maximizedNow = value;
        setMaximized(value);
        syncEdgeClip();
      })
      .catch(() => {});
    const off = bridge.onMaximizedChange((value) => {
      maximizedNow = value;
      setMaximized(value);
      syncEdgeClip();
    });
    let offCompact = () => {};
    if (canCompact(bridge)) {
      void bridge
        .isCompact?.()
        .then((value) => {
          if (!signal.aborted) setCompact(Boolean(value));
        })
        .catch(() => {});
      offCompact = bridge.onCompactChange?.((value) => setCompact(value)) ?? offCompact;
    }
    return () => {
      off();
      offCompact();
      window.removeEventListener("resize", syncEdgeClip);
      window.clearInterval(clipTimer);
      root.style.removeProperty("--edge-clip-r");
    };
  });
  useDocumentSync(
    bridgeKey ? { bridgeKey, maximized, compact } : null,
    (doc, state) => {
      if (!state) return;
      doc.documentElement.dataset.maximized = state.maximized ? "true" : "false";
      doc.documentElement.dataset.compact = state.compact ? "true" : "false";
    },
  );
  return bridge ? { bridge, maximized, compact } : null;
}
