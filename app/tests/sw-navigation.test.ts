import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

/** DF-13：导航失败要区分「真断网」和「服务器慢 / 部署重启 / 502」。直接在沙箱里跑 app/public/sw.js。 */
const source = readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8");

type Timer = { at: number; fn: () => void; id: number };
function fakeClock() {
  let now = 0;
  let seq = 0;
  let timers: Timer[] = [];
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
    pending: () => timers.map((t) => t.at - now),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

function loadSw(opts: { onLine?: boolean; fetch?: () => Promise<Response> }) {
  const clock = fakeClock();
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    location: { origin: "https://bot.example" },
    navigator: { onLine: opts.onLine ?? true },
    registration: {},
  };
  const sandbox = {
    self,
    caches: { keys: async () => [], open: async () => ({}) },
    fetch: opts.fetch ?? (() => new Promise<Response>(() => {})),
    Response,
    Headers,
    URL,
    Set,
    Promise,
    JSON,
    Math,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const ctx = runInNewContext(
    `${source}\n;({ retryMain, RETRY_DELAYS_MS, RETRY_STATUSES: [...RETRY_STATUSES] })`,
    sandbox,
  );
  async function navigate(path = "/chat/abc") {
    let responded: Promise<Response> | undefined;
    listeners.fetch?.({
      request: {
        method: "GET",
        url: `https://bot.example${path}`,
        mode: "navigate",
        headers: new Headers(),
      },
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    if (!responded) throw new Error("not intercepted");
    return responded;
  }
  return { ctx, clock, navigate, self };
}

async function kindOf(res: Response) {
  return {
    kind: res.headers.get("x-chisabot-sw")?.split(":")[1] ?? null,
    html: await res.clone().text(),
    status: res.status,
  };
}

describe("sw.js 导航失败", () => {
  test("断网（onLine=false）且 fetch 抛 TypeError：离线卡片，不带重试脚本", async () => {
    const sw = loadSw({
      onLine: false,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const r = await kindOf(await sw.navigate());
    expect(r.kind).toBe("offline");
    expect(r.html).toContain("网络不可用");
    expect(r.html).not.toContain("<script>");
    expect(r.status).toBe(503);
  });

  test("在线但 fetch 抛错（连接被重置）：当成服务器慢", async () => {
    const sw = loadSw({
      fetch: () => Promise.reject(new TypeError("network")),
    });
    const r = await kindOf(await sw.navigate());
    expect(r.kind).toBe("slow");
    expect(r.html).toContain("服务器响应慢，正在重试…");
  });

  test("20s 没回：服务器慢卡片（在线）", async () => {
    const sw = loadSw({});
    const p = sw.navigate();
    expect(sw.clock.pending()).toEqual([20_000]);
    await sw.clock.advance(19_999);
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await sw.clock.advance(1);
    const r = await kindOf(await p);
    expect(r.kind).toBe("slow");
    expect(r.html).toContain("<script>");
  });

  test("20s 没回但此时已断网：离线卡片", async () => {
    const sw = loadSw({});
    const p = sw.navigate();
    sw.self.navigator.onLine = false;
    await sw.clock.advance(20_000);
    expect((await kindOf(await p)).kind).toBe("offline");
  });

  for (const status of [502, 503, 504, 522]) {
    test(`网关 ${status}：服务器慢卡片`, async () => {
      const sw = loadSw({
        fetch: async () => new Response("bad gateway", { status }),
      });
      expect((await kindOf(await sw.navigate())).kind).toBe("slow");
      expect(sw.clock.pending()).toEqual([]);
    });
  }

  for (const status of [200, 302, 404, 500]) {
    test(`${status} 原样转交`, async () => {
      const sw = loadSw({ fetch: async () => new Response("x", { status }) });
      const res = await sw.navigate();
      expect(res.status).toBe(status);
      expect(res.headers.get("x-chisabot-sw")).toBeNull();
    });
  }

  test("退避表有上限：1/2/4/8/15/30s", () => {
    const sw = loadSw({});
    const got: number[] = [...sw.ctx.RETRY_DELAYS_MS];
    expect(got).toEqual([1000, 2000, 4000, 8000, 15000, 30000]);
    expect(Math.max(...got)).toBeLessThanOrEqual(30_000);
  });
});

function fakeWin(
  responses: Array<number | "throw">,
  href = "https://bot.example/chat/abc?x=1#m",
) {
  const clock = fakeClock();
  const events: Record<string, () => void> = {};
  const els: Record<string, { textContent: string }> = {
    title: { textContent: "" },
    hint: { textContent: "" },
  };
  const probes: string[] = [];
  let reloads = 0;
  const win = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigator: { onLine: true },
    location: {
      href,
      reload: () => {
        reloads++;
      },
    },
    document: { getElementById: (id: string) => els[id] ?? null },
    addEventListener: (t: string, fn: () => void) => {
      events[t] = fn;
    },
    fetch: async (url: string) => {
      probes.push(url);
      const next = responses.shift() ?? 200;
      if (next === "throw") throw new TypeError("network");
      return { status: next };
    },
  };
  return { win, clock, events, els, probes, reloads: () => reloads };
}

describe("重试卡片脚本", () => {
  const { ctx } = loadSw({});
  const env = (win: unknown) => ({
    win,
    delays: ctx.RETRY_DELAYS_MS,
    retryStatuses: ctx.RETRY_STATUSES,
  });

  test("502 两次、超时一次后 200：按退避探测同一地址，恢复后自己刷新回原页面", async () => {
    const w = fakeWin([502, 503, "throw", 200]);
    ctx.retryMain(env(w.win));
    expect(w.clock.pending()).toEqual([1000]);
    await w.clock.advance(1000);
    expect(w.clock.pending()).toEqual([2000]);
    await w.clock.advance(2000);
    expect(w.clock.pending()).toEqual([4000]);
    await w.clock.advance(4000);
    expect(w.clock.pending()).toEqual([8000]);
    expect(w.reloads()).toBe(0);
    await w.clock.advance(8000);
    expect(w.reloads()).toBe(1);
    expect(w.clock.pending()).toEqual([]);
    expect(w.probes).toEqual(
      Array(4).fill("https://bot.example/chat/abc?x=1#m"),
    );
  });

  test("一直 503：间隔封顶 30s，不会无限变长", async () => {
    const w = fakeWin(Array(20).fill(503));
    ctx.retryMain(env(w.win));
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const [d] = w.clock.pending();
      waits.push(d as number);
      await w.clock.advance(d as number);
    }
    expect(waits).toEqual([
      1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000,
    ]);
    expect(w.reloads()).toBe(0);
    expect(w.els.hint?.textContent).toContain("30 秒后再试一次");
  });

  test("重试时断网：改成离线提示并停下；online 事件立刻重试并恢复", async () => {
    const w = fakeWin([200]);
    ctx.retryMain(env(w.win));
    w.win.navigator.onLine = false;
    await w.clock.advance(1000);
    expect(w.els.title?.textContent).toBe("网络不可用");
    expect(w.clock.pending()).toEqual([]);
    expect(w.probes).toEqual([]);
    w.win.navigator.onLine = true;
    w.events.online?.();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(w.reloads()).toBe(1);
  });
});
