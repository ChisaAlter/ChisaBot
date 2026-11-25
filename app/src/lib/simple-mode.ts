import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "./preference-storage";

/**
 * 精简模式（`html[data-simple-mode="1"]`）。
 *
 * - 持久化于浏览器 `localStorage`（键 `chisabot.simple-mode`，值 `"1"` / `"0"`），跨标签页经 `storage` 事件实时同步。
 * - 开启时界面收敛为「左侧机器人列表 + 中间对话工作区」双栏，并在 `document.documentElement.dataset.simpleMode` 写入 `"1"`；关闭时移除该属性。
 * - 配套独立样式位于 `app/src/styles/simple-mode.css`，所有规则以 `html[data-simple-mode="1"]` 为前缀。
 * - 可通过账号菜单、设置页或全局快捷键随时切换，首屏由 `app/index.html` 同步写入属性以防闪烁。
 */

export const SIMPLE_MODE_STORAGE_KEY = "chisabot.simple-mode";

let simpleModeState: boolean | null = null;
const listeners = new Set<() => void>();

function readSimpleMode(): boolean {
  if (simpleModeState === null) {
    simpleModeState = readStoredPreference(SIMPLE_MODE_STORAGE_KEY) === "1";
  }
  return simpleModeState;
}

export function isSimpleModeEnabled(): boolean {
  return readSimpleMode();
}

function subscribeSimpleMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSimpleMode(): boolean {
  return useSyncExternalStore(
    subscribeSimpleMode,
    isSimpleModeEnabled,
    () => false,
  );
}

function applySimpleModeToDocument(enabled: boolean = readSimpleMode()): void {
  if (typeof document === "undefined") return;
  if (enabled) {
    document.documentElement.dataset.simpleMode = "1";
  } else {
    delete document.documentElement.dataset.simpleMode;
  }
}

export function setSimpleMode(enabled: boolean): void {
  if (readSimpleMode() === enabled) {
    applySimpleModeToDocument(enabled);
    return;
  }
  simpleModeState = enabled;
  writeStoredPreference(SIMPLE_MODE_STORAGE_KEY, enabled ? "1" : "0");
  applySimpleModeToDocument(enabled);
  for (const listener of listeners) listener();
}

export function toggleSimpleMode(): boolean {
  const next = !readSimpleMode();
  setSimpleMode(next);
  return next;
}

function syncSimpleModeFromStorage(key: string | null): void {
  if (key !== null && key !== SIMPLE_MODE_STORAGE_KEY) return;
  const next = readStoredPreference(SIMPLE_MODE_STORAGE_KEY) === "1";
  if (simpleModeState === next) {
    applySimpleModeToDocument(next);
    return;
  }
  simpleModeState = next;
  applySimpleModeToDocument(next);
  for (const listener of listeners) listener();
}

export function installSimpleMode(): () => void {
  applySimpleModeToDocument();
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return;
    }
    syncSimpleModeFromStorage(event.key);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
  };
}

/** 仅供单元测试重置内存缓存与 DOM 标记。 */
export function resetSimpleModeForTest(): void {
  simpleModeState = null;
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset.simpleMode;
  }
}
