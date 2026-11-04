import { useEffect, useState } from "react";

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
  useEffect(() => {
    if (!bridge) return;
    const root = document.documentElement;
    root.dataset.desktop = bridge.platform || "win32";
    let alive = true;
    void bridge
      .isMaximized()
      .then((value) => alive && setMaximized(value))
      .catch(() => {});
    const off = bridge.onMaximizedChange((value) => setMaximized(value));
    let offCompact = () => {};
    if (canCompact(bridge)) {
      void bridge
        .isCompact?.()
        .then((value) => alive && setCompact(Boolean(value)))
        .catch(() => {});
      offCompact = bridge.onCompactChange?.((value) => setCompact(value)) ?? offCompact;
    }
    return () => {
      alive = false;
      off();
      offCompact();
    };
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    document.documentElement.dataset.maximized = maximized ? "true" : "false";
  }, [bridge, maximized]);
  useEffect(() => {
    if (!bridge) return;
    document.documentElement.dataset.compact = compact ? "true" : "false";
  }, [bridge, compact]);
  return bridge ? { bridge, maximized, compact } : null;
}
