import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CONTROL_UNREACHABLE_ZH,
  readControlStatus,
} from "@/lib/computers/control";
import { SCREEN_USER_CONTROL_ZH } from "@/lib/computers/screen";
import { screenshotPollBlocked } from "@/lib/computers/screenshot-poll";
import {
  controlRetryDelay,
  controlStores,
  createControlStore,
  wakeControl,
} from "@/lib/computers/use-control";

/**
 * CB-103：GET /control 的三态（无 / 直播 / 用户接管）加「连不上」。连不上（包括部署重启时 nginx 自己回的
 * 502 / 503 / 504）显示「暂时连不上电脑」、退避重试，不打 console.error；接管中不取图。
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body?: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      body === undefined ? "<html>502</html>" : JSON.stringify(body),
      {
        status,
        headers: {
          "content-type": body === undefined ? "text/html" : "application/json",
        },
      },
    );
  }) as typeof fetch;
  return calls;
}

const base = {
  since: "2026-10-27T00:00:00.000Z",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
};

describe("readControlStatus (CB-103)", () => {
  test("none / live / user_control come through with the control state", async () => {
    answer(200, { ...base, holder: "bot", state: "none" });
    expect((await readControlStatus("bot-1")).kind).toBe("none");
    answer(200, { ...base, holder: "bot", state: "live" });
    expect((await readControlStatus("bot-1")).kind).toBe("live");
    answer(200, { ...base, holder: "human", state: "user_control" });
    const taken = await readControlStatus("bot-1");
    expect(taken.kind).toBe("user_control");
  });

  test("an older server without state still reads the holder", async () => {
    answer(200, { ...base, holder: "human" });
    expect((await readControlStatus("bot-1")).kind).toBe("user_control");
  });

  test("state=unreachable keeps its reason", async () => {
    answer(200, { state: "unreachable", reason: "timeout" });
    expect(await readControlStatus("bot-1")).toEqual({
      kind: "unreachable",
      reason: "timeout",
    });
  });

  for (const status of [502, 503, 504]) {
    test(`nginx ${status} is unreachable, not an error`, async () => {
      answer(status);
      expect(await readControlStatus("bot-1")).toEqual({
        kind: "unreachable",
        reason: `gateway_${status}`,
      });
    });
  }

  test("a dropped connection is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect((await readControlStatus("bot-1")).kind).toBe("unreachable");
  });
});

describe("control store backs off and stays quiet (CB-103)", () => {
  test("retry delay doubles up to 5s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(controlRetryDelay)).toEqual([
      0, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });

  test("a 502 shows 「暂时连不上电脑」, backs off, and never calls console.error", async () => {
    const calls = answer(502);
    const errors = spyOn(console, "error");
    const store = createControlStore("bot-backoff");
    const unsubscribe = store.subscribe(() => undefined, true);
    await Bun.sleep(3600);
    const snapshot = store.getSnapshot();
    unsubscribe();
    expect(snapshot.state).toBe("unreachable");
    expect(snapshot.problem).toBe(CONTROL_UNREACHABLE_ZH);
    expect(snapshot.problem).toBe("暂时连不上电脑");
    // 不退避的话 3.6 秒里是 4 次（0、1、2、3 秒）；退避后是 0、≥1、≥3 秒，最多 3 次。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  }, 10_000);

  test("recovering clears the problem and reports the state", async () => {
    answer(502);
    const store = createControlStore("bot-recover");
    await store.refresh();
    expect(store.getSnapshot().state).toBe("unreachable");
    answer(200, { ...base, holder: "human", state: "user_control" });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      state: "user_control",
      problem: null,
    });
  });
});

describe("the card asks who holds the computer before it fetches a picture (CB-103)", () => {
  test("no picture until the control state is known", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: null,
        controlEnabled: true,
      }),
    ).toBe("pending");
  });
  test("user_control → no picture", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: "user_control",
        controlEnabled: true,
      }),
    ).toBe("user_control");
  });
  test("unreachable → no picture", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: "unreachable",
        controlEnabled: true,
      }),
    ).toBe("unreachable");
  });
  test("none and live → fetch", () => {
    for (const controlState of ["none", "live"] as const)
      expect(
        screenshotPollBlocked({
          expanded: false,
          driving: false,
          controlState,
          controlEnabled: true,
        }),
      ).toBeNull();
  });
  test("a settled card without control polling still fetches", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: null,
      }),
    ).toBeNull();
  });
  test("takeover copy", () => {
    expect(SCREEN_USER_CONTROL_ZH).toBe(
      "电脑由你控制中，暂停预览；活动记录照常更新",
    );
  });
});

/**
 * 假时钟：接管 Date.now / setInterval，按 1 秒一拍推进，每拍后把 fetch 的 promise 链冲干净。
 * 断言的是请求的时间点（间隔）和总次数，不靠真实 sleep。
 */
function fakeClock() {
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 1_000_000;
  const timers = new Map<
    number,
    { fn: () => void; every: number; next: number }
  >();
  let id = 0;
  Date.now = () => now;
  globalThis.setInterval = ((fn: () => void, every: number) => {
    timers.set(++id, { fn, every, next: now + every });
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: number) => {
    timers.delete(handle);
  }) as unknown as typeof clearInterval;
  // r4：退避重试按 retryAt 排 setTimeout（every 0 = 只跑一次）。
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    timers.set(++id, { fn, every: 0, next: now + ms });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: number) => {
    timers.delete(handle);
  }) as unknown as typeof clearTimeout;
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    now: () => now,
    flush,
    async advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...timers.values()].filter((t) => t.next <= end);
        if (!due.length) break;
        const first = Math.min(...due.map((t) => t.next));
        now = first;
        for (const [key, t] of [...timers])
          if (t.next === first && timers.has(key)) {
            if (t.every) t.next += t.every;
            else timers.delete(key);
            t.fn();
          }
        await flush();
      }
      now = end;
      await flush();
    },
    restore() {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function countingServer(clock: { now: () => number }) {
  const at: number[] = [];
  let status = 502;
  globalThis.fetch = (async () => {
    at.push(clock.now());
    return status === 200
      ? new Response(
          JSON.stringify({ ...base, holder: "bot", state: "none" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      : new Response("<html>502</html>", { status });
  }) as unknown as typeof fetch;
  return { at, set: (next: number) => (status = next) };
}

describe("one backed-off poll per bot, with a fake clock (CB-103 r2)", () => {
  test("while unreachable the requests are 1s, 2s, 4s apart, then every 5s — never 1/s", async () => {
    const clock = fakeClock();
    try {
      const server = countingServer(clock);
      const store = createControlStore("bot-fake-backoff");
      const off = store.subscribe(() => undefined, true);
      await clock.flush();
      await clock.advance(60_000);
      off();
      const gaps = server.at.slice(1).map((t, i) => t - (server.at[i] ?? 0));
      expect(gaps.slice(0, 4)).toEqual([1000, 2000, 4000, 5000]);
      for (const gap of gaps.slice(3)) expect(gap).toBe(5000);
      // 0、1、3、7，然后每 5 秒：60 秒里 0、1、3、7、12…57 共 14 次（1/s 会是 61 次）。
      expect(server.at.length).toBe(14);
    } finally {
      clock.restore();
    }
  });

  test("three subscribers (chat notice, rail, button) share one poll source", async () => {
    const clock = fakeClock();
    try {
      const server = countingServer(clock);
      server.set(200);
      const store = createControlStore("bot-fake-shared");
      const offs = [1, 2, 3].map(() => store.subscribe(() => undefined, true));
      await clock.flush();
      await clock.advance(10_000);
      for (const off of offs) off();
      // 健康时每秒一次：0..10 秒 = 11 次；三个订阅者不会变成 33 次。
      expect(server.at.length).toBe(11);
    } finally {
      clock.restore();
    }
  });

  test("after recovery the store is back to normal within 5s even with no wake-up", async () => {
    const clock = fakeClock();
    try {
      const server = countingServer(clock);
      const store = createControlStore("bot-fake-recover");
      const off = store.subscribe(() => undefined, true);
      await clock.flush();
      await clock.advance(120_000);
      expect(store.getSnapshot().state).toBe("unreachable");
      server.set(200);
      const back = clock.now();
      while (store.getSnapshot().state === "unreachable")
        await clock.advance(1000);
      off();
      expect(clock.now() - back).toBeLessThanOrEqual(5000);
      expect(store.getSnapshot().problem).toBeNull();
    } finally {
      clock.restore();
    }
  });

  for (const trigger of ["focus", "online", "same-bot request ok"] as const) {
    test(`${trigger} re-reads immediately instead of waiting out the backoff`, async () => {
      const clock = fakeClock();
      try {
        const server = countingServer(clock);
        const id = `bot-wake-${trigger}`;
        // 走 useComputerControl 用的同一个全局 store 表，wakeControl 才找得到它。
        const store = createControlStore(id);
        controlStores.set(id, store);
        const off = store.subscribe(() => undefined, true);
        await clock.flush();
        await clock.advance(30_000);
        const before = server.at.length;
        server.set(200);
        if (trigger === "same-bot request ok") {
          const { readControl } = await import("@/lib/computers/control");
          await readControl(id);
          await clock.flush();
        } else {
          // window 事件本身在 control-poll-single-source.test.tsx 里用 happy-dom 真派发。
          wakeControl();
        }
        await clock.flush();
        off();
        controlStores.delete(id);
        expect(server.at.length).toBeGreaterThan(before);
        expect(store.getSnapshot().state).toBe("none");
        expect(store.getSnapshot().problem).toBeNull();
      } finally {
        clock.restore();
      }
    });
  }

  test("403 / 404 read as none: no reconnect copy, input not paused", async () => {
    for (const status of [403, 404]) {
      answer(status, { error: "nope" });
      const store = createControlStore(`bot-${status}`);
      await store.refresh();
      const snapshot = store.getSnapshot();
      expect(snapshot.state).toBe("none");
      expect(snapshot.problem).toBeNull();
      expect(String(snapshot.problem ?? "")).not.toContain("正在重连");
      expect(String(snapshot.problem ?? "")).not.toContain("输入已暂停");
    }
  });
});
