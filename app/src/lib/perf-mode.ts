import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "./preference-storage";

/**
 * 性能模式：一个开关，开了以后
 * - 所有毛玻璃（左右栏、输入框、顶栏、弹层）不再 backdrop-filter，大面板换成接近不透明的底色；
 * - 动态天空不启动（已经在跑的会停下，见 sky-background.tsx）；
 * - 形象头像的表情动画（呼吸、张望、眨眼、蹦跳）停下，停在静止的表情上。
 *
 * 状态在这里，`<html data-perf="on">` 由 applyPerfModeToDocument 写；样式在 styles.css 末尾「渲染预算」一节。
 * 系统「减少透明度」也走同一套实色样式（纯 CSS 媒体查询，不需要这里）。
 * 设置入口：设置 › 通用 › 外观 › 「性能模式」（components/settings/perf-mode-preference.tsx）。
 * 多个标签页之间通过 storage 事件同步（{@link syncPerfModeFromStorage}）。
 */
export const PERF_MODE_STORAGE_KEY = "chisabot.perf-mode";

let perfMode: boolean | null = null;
const listeners = new Set<() => void>();

function readPerfMode(): boolean {
  if (perfMode === null)
    perfMode = readStoredPreference(PERF_MODE_STORAGE_KEY) === "on";
  return perfMode;
}

export function getPerfMode(): boolean {
  return readPerfMode();
}

export function subscribePerfMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePerfMode(): boolean {
  return useSyncExternalStore(subscribePerfMode, getPerfMode, () => false);
}

export function applyPerfModeToDocument(on: boolean = readPerfMode()) {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.setAttribute("data-perf", "on");
  else document.documentElement.removeAttribute("data-perf");
}

export function setPerfMode(on: boolean) {
  if (readPerfMode() === on) return;
  perfMode = on;
  writeStoredPreference(PERF_MODE_STORAGE_KEY, on ? "on" : "off");
  applyPerfModeToDocument(on);
  for (const listener of listeners) listener();
}

/**
 * 别的标签页改了性能模式：这边跟着改，不写回存储（storage 事件只在别的标签页写入时触发）。
 * key 为 null 表示对方清空了存储，按存储重读（没有记录 = 关）。
 */
export function syncPerfModeFromStorage(key: string | null) {
  if (key !== null && key !== PERF_MODE_STORAGE_KEY) return;
  const on = readStoredPreference(PERF_MODE_STORAGE_KEY) === "on";
  if (perfMode === on) return;
  perfMode = on;
  applyPerfModeToDocument(on);
  for (const listener of listeners) listener();
}

/**
 * 页面看不见时（最小化、切到别的标签页）把所有无限循环的 CSS 动画暂停，回来再继续。
 * 用 Web Animations API 而不是一条 `animation-play-state` 规则：后者要赢过每条写了 animation 简写的
 * 规则，只能靠更高优先级或 !important。
 */
export function installHiddenAnimationPause() {
  if (
    typeof document === "undefined" ||
    typeof document.getAnimations !== "function"
  )
    return;
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

export function installPerfMode() {
  applyPerfModeToDocument();
  installHiddenAnimationPause();
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      syncPerfModeFromStorage(event.key);
    });
  }
}
