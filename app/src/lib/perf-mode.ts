import { useSyncExternalStore } from "react";
import {
  getAppearanceConfig,
  installAppearanceStorageSync,
  setAppearanceConfig,
  subscribeAppearance,
  syncAppearanceFromStorage,
} from "./appearance";

/**
 * 性能模式薄代理（V2 收编）：
 *  - 不再维护独立的 `chisabot.perf-mode` 状态源，直接映射到 V2 的
 *    `material === "solid" && staticBackground`；
 *  - 开启：`material: "solid"` + `staticBackground: true`；
 *  - 关闭：`material: "glass"` + `staticBackground: false`；
 *  - 仍保留 `data-perf="on"` 根属性同步与页面隐藏时暂停无限 CSS 动画的优化。
 */
export const PERF_MODE_STORAGE_KEY = "chisabot.perf-mode";

export function getPerfMode(): boolean {
  const cfg = getAppearanceConfig();
  return cfg.material === "solid" && cfg.staticBackground;
}

export function subscribePerfMode(listener: () => void): () => void {
  let last = getPerfMode();
  return subscribeAppearance(() => {
    const next = getPerfMode();
    if (next !== last) {
      last = next;
      listener();
    }
  });
}

export function usePerfMode(): boolean {
  return useSyncExternalStore(subscribePerfMode, getPerfMode, () => false);
}

export function applyPerfModeToDocument(on: boolean = getPerfMode()): void {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.setAttribute("data-perf", "on");
  else document.documentElement.removeAttribute("data-perf");
}

export function setPerfMode(on: boolean): void {
  if (getPerfMode() === on) return;
  if (on) {
    setAppearanceConfig({ material: "solid", staticBackground: true });
  } else {
    setAppearanceConfig({ material: "glass", staticBackground: false });
  }
}

export function syncPerfModeFromStorage(key: string | null): void {
  void syncAppearanceFromStorage(key);
}

/**
 * 页面看不见时（最小化、切到别的标签页）把所有无限循环的 CSS 动画暂停，回来再继续。
 */
export function installHiddenAnimationPause(): void {
  if (
    typeof document === "undefined" ||
    typeof document.getAnimations !== "function"
  ) {
    return;
  }
  let paused: Animation[] = [];
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      paused = document
        .getAnimations()
        .filter(
          (a) =>
            a.playState === "running" &&
            a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
        );
      for (const a of paused) a.pause();
    } else {
      for (const a of paused) {
        if (a.playState === "paused") a.play();
      }
      paused = [];
    }
  });
}

export function installPerfMode(): void {
  applyPerfModeToDocument();
  installHiddenAnimationPause();
  installAppearanceStorageSync();
}
