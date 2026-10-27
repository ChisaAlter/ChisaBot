import { afterEach, expect, test } from "bun:test";
import {
  type ChannelLike,
  type ControlTabsEnv,
  controlTabsScope,
  createControlTabs,
  type LocksLike,
} from "@/lib/computers/control-tabs";
import {
  type ControlClock,
  createControlStore,
} from "@/lib/computers/use-control";

/**
 * CB-107：多个标签页只有一个在轮询 /control（假锁、假频道、假时钟）。
 * 覆盖：选主、结果广播给跟随标签、主标签关掉 ≤5s 接管、按账号隔离、退避不在多个标签重复、
 * 不支持 Web Locks 时的心跳选举、两个都不支持时退回每个标签自己轮询。
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
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
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

/** 同一个"浏览器"：频道按名字互通（异步投递，和真的一样），锁按名字排队。 */
function fakeBrowser() {
  const channels = new Map<string, Set<FakeChannel>>();
  class FakeChannel implements ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    dead = false;
    constructor(readonly name: string) {
      const set = channels.get(name) ?? new Set();
      set.add(this);
      channels.set(name, set);
    }
    postMessage(data: unknown) {
      if (this.dead) return;
      for (const other of channels.get(this.name) ?? [])
        if (other !== this && !other.dead)
          queueMicrotask(() =>
            other.onmessage?.({ data: structuredClone(data) }),
          );
    }
    close() {
      channels.get(this.name)?.delete(this);
    }
  }
  type Waiter = { grant: () => void; signal?: AbortSignal };
  const held = new Set<string>();
  const queues = new Map<string, Waiter[]>();
  const next = (name: string) => {
    const q = queues.get(name) ?? [];
    while (q.length) {
      const w = q.shift() as Waiter;
      if (w.signal?.aborted) continue;
      w.grant();
      return;
    }
  };
  const locks: LocksLike = {
    request: (name, options, callback) =>
      new Promise((resolve, reject) => {
        const grant = () => {
          held.add(name);
          void callback().then((v) => {
            held.delete(name);
            resolve(v);
            next(name);
          });
        };
        if (options.signal?.aborted) return reject(new Error("AbortError"));
        options.signal?.addEventListener("abort", () => {
          reject(new Error("AbortError"));
        });
        const q = queues.get(name) ?? [];
        q.push({ grant, signal: options.signal });
        queues.set(name, q);
        if (!held.has(name)) next(name);
      }),
  };
  const all: FakeChannel[] = [];
  return {
    env: (clock: ControlClock, withLocks = true): ControlTabsEnv => ({
      clock,
      locks: withLocks ? locks : null,
      channel: (name) => {
        const c = new FakeChannel(name);
        all.push(c);
        return c;
      },
    }),
    /** 模拟标签卡死：频道收发都断，锁也不放（心跳模式用）。 */
    freezeLast: (index: number) => {
      const c = all[index];
      if (c) c.dead = true;
    },
  };
}

function server(c: ReturnType<typeof fakeClock>, initial = 200) {
  const reads: number[] = [];
  const state = { status: initial };
  globalThis.fetch = (async () => {
    reads.push(c.now());
    if (state.status !== 200)
      return new Response("<html>bad gateway</html>", { status: state.status });
    return new Response(
      JSON.stringify({
        holder: "bot",
        state: "none",
        since: "2026-10-27T00:00:00.000Z",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { reads, state };
}

function tab(
  b: ReturnType<typeof fakeBrowser>,
  c: ReturnType<typeof fakeClock>,
  account: string,
  computerId = "bot-tabs",
  withLocks = true,
) {
  const env = b.env(c.clock, withLocks);
  const scope = controlTabsScope(account, computerId);
  let tabs: ReturnType<typeof createControlTabs> | undefined;
  const store = createControlStore(computerId, c.clock, (h) => {
    tabs = createControlTabs(scope, h, env);
    return tabs;
  });
  const off = store.subscribe(() => undefined, true);
  return {
    store,
    off,
    leader: () => tabs?.isLeader() ?? false,
    tabs: () => tabs,
  };
}

for (const withLocks of [true, false]) {
  const mode = withLocks ? "web locks" : "heartbeat";

  test(`${mode}: 3 tabs elect one poller and followers get its result`, async () => {
    const c = fakeClock();
    const b = fakeBrowser();
    const s = server(c);
    const tabs = [tab(b, c, "acct-a", "bot-tabs", withLocks)];
    await c.advance(500);
    tabs.push(
      tab(b, c, "acct-a", "bot-tabs", withLocks),
      tab(b, c, "acct-a", "bot-tabs", withLocks),
    );
    await c.advance(1000);
    const start = s.reads.length;
    await c.advance(10_000);
    // 只有一个标签每秒读一次：10 秒 ≈ 10 次，不是 30 次。
    expect(s.reads.length - start).toBeGreaterThanOrEqual(9);
    expect(s.reads.length - start).toBeLessThanOrEqual(11);
    expect(tabs.filter((t) => t.leader()).length).toBe(1);
    for (const t of tabs) expect(t.store.getSnapshot().state).toBe("none");
    for (const t of tabs) t.off();
  });

  test(`${mode}: leader tab closes → a follower polls within 5s`, async () => {
    const c = fakeClock();
    const b = fakeBrowser();
    const s = server(c);
    const first = tab(b, c, "acct-a", "bot-tabs", withLocks);
    await c.advance(500);
    const second = tab(b, c, "acct-a", "bot-tabs", withLocks);
    await c.advance(2000);
    expect(first.leader()).toBe(true);
    expect(second.leader()).toBe(false);
    first.off(); // 关标签
    const closedAt = c.now();
    const before = s.reads.length;
    let firstRead = 0;
    while (!firstRead && c.now() - closedAt < 6000) {
      await c.advance(100);
      if (s.reads.length > before) firstRead = s.reads[before] as number;
    }
    expect(second.leader()).toBe(true);
    expect(firstRead - closedAt).toBeLessThanOrEqual(5000);
    second.off();
  });

  test(`${mode}: 502 backs off in one tab only, all tabs show it and recover together`, async () => {
    const c = fakeClock();
    const b = fakeBrowser();
    const s = server(c, 502);
    const tabs = [tab(b, c, "acct-a", "bot-tabs", withLocks)];
    await c.advance(200);
    tabs.push(
      tab(b, c, "acct-a", "bot-tabs", withLocks),
      tab(b, c, "acct-a", "bot-tabs", withLocks),
    );
    const start = s.reads.length;
    await c.advance(8000);
    // 一个标签退避（1/2/4s）：8 秒最多 4 次；三个标签各退避会是 9+ 次。
    expect(s.reads.length - start).toBeLessThanOrEqual(4);
    for (const t of tabs)
      expect(t.store.getSnapshot().state).toBe("unreachable");
    s.state.status = 200;
    await c.advance(5500);
    for (const t of tabs) {
      expect(t.store.getSnapshot().state).toBe("none");
      expect(t.store.getSnapshot().problem).toBeNull();
    }
    for (const t of tabs) t.off();
  });

  test(`${mode}: a follower's focus wake goes to the leader instead of polling itself`, async () => {
    const c = fakeClock();
    const b = fakeBrowser();
    const s = server(c, 502);
    const first = tab(b, c, "acct-a", "bot-tabs", withLocks);
    await c.advance(200);
    const second = tab(b, c, "acct-a", "bot-tabs", withLocks);
    await c.advance(3500);
    s.state.status = 200;
    const before = s.reads.length;
    second.store.wake();
    await c.flush();
    await c.advance(100);
    expect(s.reads.length - before).toBe(1);
    expect(second.store.getSnapshot().state).toBe("none");
    first.off();
    second.off();
  });
}

test("accounts are isolated: different account → own leader, no shared results", async () => {
  const c = fakeClock();
  const b = fakeBrowser();
  server(c);
  const a = tab(b, c, "acct-a");
  const other = tab(b, c, "acct-b");
  await c.advance(1500);
  expect(a.leader()).toBe(true);
  expect(other.leader()).toBe(true);
  // 手工往 A 账号频道塞一条结果，B 账号的标签不能收到。
  const fakeA = b
    .env(c.clock)
    .channel?.(controlTabsScope("acct-a", "bot-tabs"));
  fakeA?.postMessage({
    from: "intruder",
    scope: controlTabsScope("acct-a", "bot-tabs"),
    msg: {
      k: "snap",
      snap: { control: null, state: "user_control", problem: null },
    },
  });
  await c.flush();
  expect(a.store.getSnapshot().state).toBe("user_control");
  expect(other.store.getSnapshot().state).toBe("none");
  a.off();
  other.off();
});

test("heartbeat: a frozen leader (no heartbeat) is taken over within 5s", async () => {
  const c = fakeClock();
  const b = fakeBrowser();
  const s = server(c);
  const first = tab(b, c, "acct-a", "bot-tabs", false); // channel #0
  await c.advance(500);
  const second = tab(b, c, "acct-a", "bot-tabs", false);
  await c.advance(2000);
  expect(first.leader()).toBe(true);
  b.freezeLast(0);
  // 卡死的标签也不再发请求（模拟），只看第二个什么时候开始读。
  first.store.dispose();
  const frozenAt = c.now();
  const before = s.reads.length;
  let firstRead = 0;
  while (!firstRead && c.now() - frozenAt < 6000) {
    await c.advance(100);
    if (s.reads.length > before) firstRead = s.reads[before] as number;
  }
  expect(firstRead).toBeGreaterThan(0);
  expect(firstRead - frozenAt).toBeLessThanOrEqual(5000);
  expect(second.leader()).toBe(true);
  second.off();
});

test("heartbeat: two simultaneous leaders settle on one", async () => {
  const c = fakeClock();
  const b = fakeBrowser();
  const s = server(c);
  const x = tab(b, c, "acct-a", "bot-tabs", false);
  const y = tab(b, c, "acct-a", "bot-tabs", false);
  await c.advance(3000);
  expect([x, y].filter((t) => t.leader()).length).toBe(1);
  const before = s.reads.length;
  await c.advance(5000);
  expect(s.reads.length - before).toBeLessThanOrEqual(6);
  x.off();
  y.off();
});

test("no BroadcastChannel / Web Locks: each tab polls itself like before", async () => {
  const c = fakeClock();
  const s = server(c);
  const env: ControlTabsEnv = { clock: c.clock, locks: null, channel: null };
  const mk = () =>
    createControlStore("bot-solo", c.clock, (h) =>
      createControlTabs(controlTabsScope("acct-a", "bot-solo"), h, env),
    );
  const one = mk();
  const two = mk();
  const offs = [
    one.subscribe(() => undefined, true),
    two.subscribe(() => undefined, true),
  ];
  await c.flush();
  const before = s.reads.length;
  await c.advance(5000);
  expect(s.reads.length - before).toBeGreaterThanOrEqual(9);
  expect(one.getSnapshot().state).toBe("none");
  expect(two.getSnapshot().state).toBe("none");
  for (const off of offs) off();
});

test("hidden tab gives up leadership; the visible one takes over", async () => {
  const c = fakeClock();
  const b = fakeBrowser();
  server(c);
  const first = tab(b, c, "acct-a");
  await c.advance(300);
  const second = tab(b, c, "acct-a");
  await c.advance(1000);
  expect(first.leader()).toBe(true);
  // 第一个标签的订阅者全部藏起来（只剩不在屏幕上的订阅）。
  const hiddenOff = first.store.subscribe(() => undefined, false);
  first.off();
  await c.advance(500);
  expect(first.leader()).toBe(false);
  expect(second.leader()).toBe(true);
  hiddenOff();
  second.off();
});
