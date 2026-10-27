import { afterEach, expect, test } from "bun:test";
import {
  type ControlClock,
  createControlStore,
} from "@/lib/computers/use-control";

/**
 * CB-103 r4：连不上时 /control 的请求间隔必须是 1、2、4、5、5 秒（假时钟），
 * 不能因为每秒一拍的对齐而每次晚一拍（QA 实测 2→3→5→6→6）。
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<
    number,
    { at: number; fn: () => void; every?: number }
  >();
  const clock: ControlClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn, every: ms });
      return seq;
    },
    clearInterval: (h) => void timers.delete(h as number),
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** 以 100ms 步进推进时间，每步都让 fetch 的 promise 跑完。 */
  const advance = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += 100;
      for (const [id, t] of [...timers]) {
        if (t.at > now || !timers.has(id)) continue;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      await flush();
    }
  };
  return { clock, advance, flush, now: () => now };
}

test("unreachable backoff: request intervals are exactly 1/2/4/5/5s", async () => {
  const c = fakeClock();
  const reads: number[] = [];
  globalThis.fetch = (async () => {
    reads.push(c.now());
    return new Response("<html>bad gateway</html>", { status: 502 });
  }) as unknown as typeof fetch;
  const store = createControlStore("bot-timing", c.clock);
  const off = store.subscribe(() => undefined, true);
  await c.flush();
  await c.advance(23_000);
  const gaps = reads.slice(1).map((t, i) => t - (reads[i] as number));
  expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  expect(store.getSnapshot().state).toBe("unreachable");
  off();
});

test("recovery returns to 1s polling and 404 counts as none", async () => {
  const c = fakeClock();
  const reads: number[] = [];
  let status = 502;
  globalThis.fetch = (async () => {
    reads.push(c.now());
    return new Response("x", { status });
  }) as unknown as typeof fetch;
  const store = createControlStore("bot-recover", c.clock);
  const off = store.subscribe(() => undefined, true);
  await c.flush();
  await c.advance(3_500); // 0、1、3s
  status = 404;
  await c.advance(1_000); // 7s 那次还没到
  store.wake(); // 回焦：马上读
  await c.flush();
  expect(store.getSnapshot().state).toBe("none");
  const n = reads.length;
  await c.advance(3_000);
  expect(reads.length - n).toBe(3);
  off();
});
