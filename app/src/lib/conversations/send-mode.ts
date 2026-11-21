import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "../preference-storage";

export type BusySendMode = "steer" | "queue";

export const BUSY_SEND_MODE_STORAGE_KEY = "chisabot.busy-send-mode";
export const DEFAULT_BUSY_SEND_MODE: BusySendMode = "steer";

let currentMode: BusySendMode | null = null;
const listeners = new Set<() => void>();

function parseBusySendMode(raw: string | null): BusySendMode {
  return raw === "queue" ? "queue" : DEFAULT_BUSY_SEND_MODE;
}

function readMode(): BusySendMode {
  if (currentMode === null) {
    currentMode = parseBusySendMode(
      readStoredPreference(BUSY_SEND_MODE_STORAGE_KEY),
    );
  }
  return currentMode;
}

export function getBusySendMode(): BusySendMode {
  return readMode();
}

export function reverseBusySendMode(mode: BusySendMode): BusySendMode {
  return mode === "steer" ? "queue" : "steer";
}

export function subscribeBusySendMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBusySendMode(): BusySendMode {
  return useSyncExternalStore(
    subscribeBusySendMode,
    getBusySendMode,
    () => DEFAULT_BUSY_SEND_MODE,
  );
}

export function setBusySendMode(mode: BusySendMode): void {
  if (readMode() === mode) return;
  currentMode = mode;
  writeStoredPreference(BUSY_SEND_MODE_STORAGE_KEY, mode);
  for (const listener of listeners) listener();
}

export function syncBusySendModeFromStorage(key: string | null): void {
  if (key !== null && key !== BUSY_SEND_MODE_STORAGE_KEY) return;
  const next = parseBusySendMode(
    readStoredPreference(BUSY_SEND_MODE_STORAGE_KEY),
  );
  if (currentMode === next) return;
  currentMode = next;
  for (const listener of listeners) listener();
}

export function installBusySendMode(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    syncBusySendModeFromStorage(event.key);
  });
}
