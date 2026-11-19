import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "./preference-storage";

/**
 * 一键隐私遮罩模式（`data-privacy-mask="1"` + `[data-private]`）。
 *
 * - 持久化于浏览器 `localStorage`（键 `chisabot.privacy-mask`），跨标签页经 `storage` 事件实时同步。
 * - 开启时在 `document.documentElement.dataset.privacyMask` 写入 `"1"`，关闭时移除该属性。
 * - 配套 CSS 规则在 `app/src/styles.css` 末尾，仅匹配 `[data-privacy-mask="1"] [data-private]`（严禁 `:has`）。
 * - 可通过全局快捷键 `Ctrl+Shift+P`（macOS：`⌘+Shift+P`）或「设置 → 通用 → 隐私遮罩模式」随时切换。
 */

export const PRIVACY_MASK_STORAGE_KEY = "chisabot.privacy-mask";

let privacyMaskState: boolean | null = null;
const listeners = new Set<() => void>();

function readPrivacyMask(): boolean {
  if (privacyMaskState === null) {
    const raw = readStoredPreference(PRIVACY_MASK_STORAGE_KEY);
    privacyMaskState = raw === "1" || raw === "on" || raw === "true";
  }
  return privacyMaskState;
}

export function getPrivacyMask(): boolean {
  return readPrivacyMask();
}

export function subscribePrivacyMask(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrivacyMask(): boolean {
  return useSyncExternalStore(
    subscribePrivacyMask,
    getPrivacyMask,
    () => false,
  );
}

export function applyPrivacyMaskToDocument(
  enabled: boolean = readPrivacyMask(),
): void {
  if (typeof document === "undefined") return;
  if (enabled) {
    document.documentElement.dataset.privacyMask = "1";
  } else {
    delete document.documentElement.dataset.privacyMask;
  }
}

export function setPrivacyMask(enabled: boolean): void {
  if (readPrivacyMask() === enabled) {
    applyPrivacyMaskToDocument(enabled);
    return;
  }
  privacyMaskState = enabled;
  writeStoredPreference(PRIVACY_MASK_STORAGE_KEY, enabled ? "1" : "0");
  applyPrivacyMaskToDocument(enabled);
  for (const listener of listeners) listener();
}

export function togglePrivacyMask(): boolean {
  const next = !readPrivacyMask();
  setPrivacyMask(next);
  return next;
}

/** 跨标签页同步：仅在外部标签页变更 storage 时触发，避免循环写回。 */
export function syncPrivacyMaskFromStorage(key: string | null): void {
  if (key !== null && key !== PRIVACY_MASK_STORAGE_KEY) return;
  const raw = readStoredPreference(PRIVACY_MASK_STORAGE_KEY);
  const next = raw === "1" || raw === "on" || raw === "true";
  if (privacyMaskState === next) {
    applyPrivacyMaskToDocument(next);
    return;
  }
  privacyMaskState = next;
  applyPrivacyMaskToDocument(next);
  for (const listener of listeners) listener();
}

export function installPrivacyMask(): void {
  applyPrivacyMaskToDocument();
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
      syncPrivacyMaskFromStorage(event.key);
    });
  }
}

/** 仅供单元测试重置内存缓存。 */
export function resetPrivacyMaskForTest(): void {
  privacyMaskState = null;
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset.privacyMask;
  }
}
