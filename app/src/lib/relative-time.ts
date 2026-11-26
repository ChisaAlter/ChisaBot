import { useCallback, useSyncExternalStore } from "react";

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat("zh-CN", {
  numeric: "auto",
});

/** Locale-aware relative timestamp, e.g. "2 minutes ago". Pass `now` so UI can tick. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = now - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}

/*
 * 单模块共享相对时间时钟：默认 60s 周期在整页所有频道行 / 搜索结果行之间共享唯一一个 setInterval，
 * 并在标签页隐藏（document.hidden）时暂停、恢复可见时立即 tick，不再每行各自开定时器。
 */
const DEFAULT_RELATIVE_INTERVAL_MS = 60_000;

type SharedRelativeClock = {
  intervalMs: number;
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
};

const clocks = new Map<number, SharedRelativeClock>();
let visibilityBound = false;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

function tickClock(clock: SharedRelativeClock) {
  clock.now = Date.now();
  for (const listener of [...clock.listeners]) listener();
}

function stopClock(clock: SharedRelativeClock) {
  if (clock.timer !== undefined) {
    clearInterval(clock.timer);
    clock.timer = undefined;
  }
}

function startClock(clock: SharedRelativeClock) {
  if (
    clock.timer !== undefined ||
    clock.listeners.size === 0 ||
    isDocumentHidden()
  ) {
    return;
  }
  clock.now = Date.now();
  clock.timer = setInterval(() => {
    if (isDocumentHidden()) {
      stopClock(clock);
      return;
    }
    tickClock(clock);
  }, clock.intervalMs);
}

function onVisibilityChange() {
  if (isDocumentHidden()) {
    for (const clock of clocks.values()) stopClock(clock);
    return;
  }
  for (const clock of clocks.values()) {
    if (clock.listeners.size === 0) continue;
    tickClock(clock);
    startClock(clock);
  }
}

function ensureVisibilityListener() {
  if (visibilityBound || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", onVisibilityChange);
  visibilityBound = true;
}

function teardownVisibilityListener() {
  if (!visibilityBound || typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  visibilityBound = false;
}

function getOrCreateClock(intervalMs: number): SharedRelativeClock {
  const normalized =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.round(intervalMs)
      : DEFAULT_RELATIVE_INTERVAL_MS;
  let clock = clocks.get(normalized);
  if (!clock) {
    clock = {
      intervalMs: normalized,
      now: Date.now(),
      listeners: new Set(),
      timer: undefined,
    };
    clocks.set(normalized, clock);
  }
  return clock;
}

function subscribeRelativeClock(
  intervalMs: number,
  listener: () => void,
): () => void {
  const clock = getOrCreateClock(intervalMs);
  clock.listeners.add(listener);
  ensureVisibilityListener();
  if (!isDocumentHidden()) {
    startClock(clock);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0) {
      stopClock(clock);
      clocks.delete(clock.intervalMs);
      if (clocks.size === 0) teardownVisibilityListener();
    }
  };
}

function readRelativeClockNow(intervalMs: number): number {
  const normalized =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.round(intervalMs)
      : DEFAULT_RELATIVE_INTERVAL_MS;
  return clocks.get(normalized)?.now ?? Date.now();
}

/** 测试用：读取共享相对时间时钟状态。 */
export function relativeClockStatus(
  intervalMs = DEFAULT_RELATIVE_INTERVAL_MS,
): { subscribers: number; running: boolean } {
  const clock = clocks.get(intervalMs);
  return {
    subscribers: clock?.listeners.size ?? 0,
    running: clock?.timer !== undefined,
  };
}

/** 测试用：清空全部共享相对时间时钟。 */
export function resetRelativeClocksForTests(): void {
  for (const clock of clocks.values()) stopClock(clock);
  clocks.clear();
  teardownVisibilityListener();
}

/** FIX-09：共享 60s 时钟刷新相对时间（侧栏「1 小时前」不会卡死，且多行共用单定时器并在后台暂停）。 */
export function useRelativeNow(
  intervalMs = DEFAULT_RELATIVE_INTERVAL_MS,
): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRelativeClock(intervalMs, listener),
    [intervalMs],
  );
  const getSnapshot = useCallback(
    () => readRelativeClockNow(intervalMs),
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
