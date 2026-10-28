import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "./preference-storage";

/**
 * 性能模式：一个开关，开了以后
 * - 所有玻璃（.glass、左右栏、输入框）换成不透明的实色底，不再 backdrop-filter；
 * - 动态天空不启动（已经在跑的会停下，见 sky-background.tsx）。
 *
 * 状态在这里，`<html data-perf="on">` 由 applyPerfModeToDocument 写；样式在 styles.css 的 Hark 层。
 * 系统「减少透明度」也走同一套实色样式（纯 CSS 媒体查询，不需要这里）。
 * 设置入口暂不放在外观设置页（那个文件不在这次的改动范围里），见 docs/rfc/hark-redesign.md。
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
}
