import { useRef, useState, useSyncExternalStore } from "react";

/**
 * 卡片上「已用 12 秒」这类每秒走的时间共用一个时钟：整页只有一个 1 秒的 interval，
 * 第一个订阅者来时开、最后一个走时停（以前每张卡片各开一个）。
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function clockNow(): number {
  return now;
}

/** 测试用：当前有几个订阅者、时钟是否在走。 */
export function clockStatus(): { subscribers: number; running: boolean } {
  return { subscribers: listeners.size, running: timer !== undefined };
}

const idle = () => () => {};

/** active 时每秒更新一次的当前时间；不 active 时停在最后看到的那一刻（不订阅、不重画）。 */
export function useNow(active: boolean): number {
  const [mountedAt] = useState(() => Date.now());
  const last = useRef(mountedAt);
  const ticking = useSyncExternalStore(
    active ? subscribeClock : idle,
    clockNow,
    clockNow,
  );
  if (!active) return last.current;
  const value = Math.max(ticking, last.current);
  last.current = value;
  return value;
}
