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

function loadSw(opts: {
  onLine?: boolean;
  fetch?: () => Promise<Response>;
  registration?: Record<string, unknown>;
}) {
  const clock = fakeClock();
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    location: { origin: "https://bot.example" },
    navigator: { onLine: opts.onLine ?? true },
    registration: opts.registration ?? {},
    skipWaiting: () => {},
    clients: { claim: async () => {} },
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
  /** 派发一个导航 fetch 事件；返回 respondWith 拿到的 Promise（没调用就是 undefined）。 */
  function dispatchNavigate(
    path: string,
    preloadResponse: Promise<Response | undefined> = Promise.resolve(undefined),
  ) {
    let responded: Promise<Response> | undefined;
    listeners.fetch?.({
      request: {
        method: "GET",
        url: `https://bot.example${path}`,
        mode: "navigate",
        headers: new Headers(),
      },
      preloadResponse,
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    return responded;
  }
  async function activate() {
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate?.({
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
  }
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
  return { ctx, clock, navigate, dispatchNavigate, activate, self };
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

describe("sw.js 登录回调只发一次（state_mismatch）", () => {
  for (const path of [
    "/api/auth/callback/github?code=c&state=s",
    "/api/auth/sign-in/social",
    "/api/auth/error?error=x",
    "/api/anything",
    "/auth/callback",
    "/sign-in",
  ]) {
    test(`${path}：导航不拦（不 respondWith），浏览器自己发一次`, () => {
      let fetches = 0;
      const sw = loadSw({
        fetch: async () => {
          fetches++;
          return new Response("x");
        },
      });
      expect(sw.dispatchNavigate(path)).toBeUndefined();
      expect(fetches).toBe(0);
    });
  }

  test("激活时关掉 navigation preload（旧版本开过，不关的话不拦的导航会被发两次）", async () => {
    const calls: string[] = [];
    const sw = loadSw({
      registration: {
        navigationPreload: {
          enable: async () => {
            calls.push("enable");
          },
          disable: async () => {
            calls.push("disable");
          },
        },
      },
    });
    await sw.activate();
    expect(calls).toEqual(["disable"]);
  });

  test("普通页面导航照旧拦截，只 fetch 一次", async () => {
    let fetches = 0;
    const sw = loadSw({
      fetch: async () => {
        fetches++;
        return new Response("page", { status: 200 });
      },
    });
    const p = sw.dispatchNavigate("/chat/abc");
    expect(p).toBeDefined();
    expect((await p!).status).toBe(200);
    expect(fetches).toBe(1);
  });

  test("还有 preload 响应时用它，不再发第二次", async () => {
    let fetches = 0;
    const sw = loadSw({
      fetch: async () => {
        fetches++;
        return new Response("net");
      },
    });
    const res = await sw.dispatchNavigate(
      "/chat/abc",
      Promise.resolve(new Response("preloaded", { status: 200 })),
    )!;
    expect(await res.text()).toBe("preloaded");
    expect(fetches).toBe(0);
  });
});

function fakeWin(
  responses: Array<number | "throw" | Response>,
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
  const replaced: string[] = [];
  const win = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigator: { onLine: true },
    location: {
      href,
      reload: () => {
        reloads++;
      },
      replace: (to: string) => {
        replaced.push(to);
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
      if (typeof next !== "number") return next;
      return { status: next };
    },
  };
  return { win, clock, events, els, probes, replaced, reloads: () => reloads };
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

describe("sw.js 会话过期（401）", () => {
  test("导航拿到 401：302 到 /login?next=原地址，不是把 401 页面交给浏览器", async () => {
    const sw = loadSw({
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, openbotAuthRequired: true }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const res = await sw.navigate("/channel/abc?watch=true");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://bot.example/login?next=%2Fchannel%2Fabc%3Fwatch%3Dtrue",
    );
  });

  test("网关的 302 → /login 原样交给浏览器（不当成失败）", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/login?next=%2Fchannel%2Fabc" },
    });
    const sw = loadSw({ fetch: async () => redirect });
    const res = await sw.navigate("/channel/abc");
    expect(res).toBe(redirect);
  });

  test("/login 导航不拦：登录页由网关直接给，不套 20 秒超时和 503 卡片", () => {
    const sw = loadSw({});
    for (const path of ["/login", "/login?next=%2Fsettings", "/login/"])
      expect(sw.dispatchNavigate(path)).toBeUndefined();
    // /log、/logins 这种不是登录页的前缀照常拦。
    expect(sw.dispatchNavigate("/logins")).toBeDefined();
  });

  test("重试卡片探测到 401：直接去 /login?next=原地址，不刷新回去再等 20 秒", async () => {
    const { ctx } = loadSw({});
    const w = fakeWin([gateway401()]);
    ctx.retryMain({
      win: w.win,
      delays: ctx.RETRY_DELAYS_MS,
      retryStatuses: ctx.RETRY_STATUSES,
    });
    await w.clock.advance(1000);
    expect(w.reloads()).toBe(0);
    expect(w.replaced).toEqual(["/login?next=%2Fchat%2Fabc%3Fx%3D1%23m"]);
    expect(w.clock.pending()).toEqual([]);
  });

  test("导航拿到不带 openbotAuthRequired 的 401（没有网关的部署）：原样交给浏览器，不跳 /login", async () => {
    for (const make of [
      () => new Response("nope", { status: 401 }),
      () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]) {
      const original = make();
      const sw = loadSw({ fetch: async () => original });
      const res = await sw.navigate("/channel/abc");
      expect(res).toBe(original);
      expect(res.status).toBe(401);
    }
  });

  test("重试卡片探测到不带 openbotAuthRequired 的 401：照旧刷新，不跳 /login", async () => {
    const { ctx } = loadSw({});
    const w = fakeWin([
      new Response(JSON.stringify({ error: "x" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ]);
    ctx.retryMain({
      win: w.win,
      delays: ctx.RETRY_DELAYS_MS,
      retryStatuses: ctx.RETRY_STATUSES,
    });
    await w.clock.advance(1000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(w.replaced).toEqual([]);
    expect(w.reloads()).toBe(1);
  });
});

function gateway401() {
  return new Response(
    JSON.stringify({ ok: false, openbotAuthRequired: true }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
}
