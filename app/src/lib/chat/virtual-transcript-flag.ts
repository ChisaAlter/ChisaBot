import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";

/**
 * 长对话虚拟化（jank P3-3）的开关 `virtualTranscript`，默认关。
 *
 * 打开方式（任选其一，刷新后生效）：
 * - 地址栏加 `?virtualTranscript=1`（`=0` 关掉），会记进 localStorage，之后不用再带；
 * - 控制台 `localStorage.setItem("chisabot.virtual-transcript", "on")`；
 * - 构建时 `VITE_VIRTUAL_TRANSCRIPT=1`（只改默认值，给 perf harness 对比用；localStorage 里写了 off 仍然关）。
 *
 * 关着的时候 transcript 走原来的 tail-first 路径，一行都不变。
 */
export const VIRTUAL_TRANSCRIPT_STORAGE_KEY = "chisabot.virtual-transcript";
export const VIRTUAL_TRANSCRIPT_URL_PARAM = "virtualTranscript";

let current: boolean | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "on" || v === "true") return true;
  if (v === "0" || v === "off" || v === "false") return false;
  return null;
}

/** 纯函数：URL 参数 > localStorage > 构建默认。 */
export function resolveVirtualTranscript(input: {
  url?: string | null;
  stored?: string | null;
  buildDefault?: string | null;
}): boolean {
  return (
    parse(input.url) ??
    parse(input.stored) ??
    parse(input.buildDefault) ??
    false
  );
}

function read(): boolean {
  if (current !== null) return current;
  let url: string | null = null;
  if (typeof location !== "undefined") {
    try {
      url = new URLSearchParams(location.search).get(
        VIRTUAL_TRANSCRIPT_URL_PARAM,
      );
    } catch {
      url = null;
    }
  }
  const fromUrl = parse(url);
  if (fromUrl !== null)
    writeStoredPreference(
      VIRTUAL_TRANSCRIPT_STORAGE_KEY,
      fromUrl ? "on" : "off",
    );
  current = resolveVirtualTranscript({
    url,
    stored: readStoredPreference(VIRTUAL_TRANSCRIPT_STORAGE_KEY),
    buildDefault: import.meta.env?.VITE_VIRTUAL_TRANSCRIPT ?? null,
  });
  return current;
}

export function getVirtualTranscript(): boolean {
  return read();
}

export function setVirtualTranscript(on: boolean) {
  if (read() === on) return;
  current = on;
  writeStoredPreference(VIRTUAL_TRANSCRIPT_STORAGE_KEY, on ? "on" : "off");
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVirtualTranscript(): boolean {
  return useSyncExternalStore(subscribe, getVirtualTranscript, () => false);
}

/** 测试用：清掉缓存的值。 */
export function resetVirtualTranscriptForTest(value: boolean | null = null) {
  current = value;
}
