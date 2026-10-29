import { useSyncExternalStore } from "react";

/**
 * HOW FAR EACH IN-FLIGHT UPLOAD HAS GOT, KEPT OUTSIDE REACT STATE ON PURPOSE.
 *
 * XHR reports progress many times a second. Putting that into the composer's state would
 * re-render the whole composer (toolbar, model pill, editor) on every tick, which is exactly the
 * cost the composer can least afford. Only the two small readers — a tile's percentage and the
 * "上传中 63%" hint next to Send — subscribe, and they are told only when a whole percent changes.
 *
 * Keyed by the attachment's local id (`upload-identity.ts`); `uploadKey` (file name + size) is only
 * the fallback for a card that was never matched to an upload.
 */
export type UploadProgressStore = {
  set(key: string, percent: number): void;
  clear(key: string): void;
  get(key: string): number | undefined;
  subscribe(listener: () => void): () => void;
};

export function uploadKey(name: string | undefined, size: number | undefined) {
  return `${name ?? ""}\u0000${size ?? ""}`;
}

export function createUploadProgressStore(): UploadProgressStore {
  const percents = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    set(key, percent) {
      const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
      if (percents.get(key) === rounded) return;
      percents.set(key, rounded);
      notify();
    },
    clear(key) {
      if (percents.delete(key)) notify();
    },
    get: (key) => percents.get(key),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One upload's percentage, or `undefined` before the first progress event. */
export function useUploadPercent(
  store: UploadProgressStore | undefined,
  key: string,
): number | undefined {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.get(key),
    () => undefined,
  );
}

/**
 * Overall percentage across every upload still in flight, weighted by size — what the hint next to
 * Send reads. `undefined` before any upload has reported.
 */
export function useOverallUploadPercent(
  store: UploadProgressStore | undefined,
  uploading: readonly { key: string; size: number }[],
): number | undefined {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => overallPercent(store, uploading),
    () => undefined,
  );
}

export function overallPercent(
  store: UploadProgressStore | undefined,
  uploading: readonly { key: string; size: number }[],
): number | undefined {
  if (!store || uploading.length === 0) return undefined;
  let total = 0;
  let done = 0;
  let reported = false;
  for (const { key, size } of uploading) {
    const weight = Math.max(1, size);
    const percent = store.get(key);
    if (percent !== undefined) reported = true;
    total += weight;
    done += (weight * (percent ?? 0)) / 100;
  }
  return reported ? Math.floor((done / total) * 100) : undefined;
}

const noopSubscribe = () => () => {};
