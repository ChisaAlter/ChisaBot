import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClaudeAuth, CloudWorkspaceView } from "../../shared/cloud-cc";
import { authStale, maybeRecheckClaudeAuth, useClaudeAuthRecheck, resetClaudeAuthRecheck, shouldRecheck, showChecking, STALE_MS, THROTTLE_MS } from "@/lib/claude-auth-recheck";
import { ccKeys } from "@/lib/cloud-cc";

/**
 * 打开 Claude Code / 云端工作区设置、窗口聚焦时复查云端 Claude 登录状态（DESIGN.md §73.1 / §73.5）：
 * 节点在线且缓存「未登录」或超过 60 秒 → 调 /claude/check；节流；检查中不先闪「登录 Claude」。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => resetClaudeAuthRecheck());

const NOW = Date.parse("2026-10-17T07:30:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const auth = (loggedIn: boolean, checkedAt: string | null): ClaudeAuth => ({ loggedIn, email: loggedIn ? "a@example.com" : null, plan: loggedIn ? "pro" : null, method: null, checkedAt });
const view = (online: boolean, claude: ClaudeAuth): CloudWorkspaceView =>
  ({
    node: { deviceId: "dev_x", name: "云端工作区", online, claudeVersion: null, lastSeenAt: null },
    claude,
    running: 0,
    maxConcurrent: 2,
    browserLogin: true,
    proxy: null,
  }) as unknown as CloudWorkspaceView;

describe("rules", () => {
  test("stale = no checkedAt or older than 60 s", () => {
    expect(authStale(auth(true, null), NOW)).toBe(true);
    expect(authStale(auth(true, ago(STALE_MS + 1)), NOW)).toBe(true);
    expect(authStale(auth(true, ago(5_000)), NOW)).toBe(false);
  });

  test("recheck when online and cached not-logged-in or stale; never when offline or fresh+logged-in", () => {
    expect(shouldRecheck(view(true, auth(false, ago(5_000))), NOW, null)).toBe(true);
    expect(shouldRecheck(view(true, auth(true, ago(STALE_MS + 1))), NOW, null)).toBe(true);
    expect(shouldRecheck(view(true, auth(true, ago(5_000))), NOW, null)).toBe(false);
    expect(shouldRecheck(view(false, auth(false, null)), NOW, null)).toBe(false);
    expect(shouldRecheck({ ...view(true, auth(false, null)), node: null }, NOW, null)).toBe(false);
    expect(shouldRecheck(undefined, NOW, null)).toBe(false);
  });

  test("throttled: not again within 30 s, and not while one is in flight", () => {
    const v = view(true, auth(false, null));
    expect(shouldRecheck(v, NOW, NOW - 1_000)).toBe(false);
    expect(shouldRecheck(v, NOW, NOW - THROTTLE_MS)).toBe(true);
    expect(shouldRecheck(v, NOW, null, true)).toBe(false);
  });

  test("checking state only hides a stale not-logged-in value (a fresh 未登录 shows the login gate)", () => {
    expect(showChecking(view(true, auth(false, ago(10 * 60_000))), NOW, null, false)).toBe(true);
    expect(showChecking(view(true, auth(false, null)), NOW, null, true)).toBe(true);
    expect(showChecking(view(true, auth(false, ago(5_000))), NOW, null, true)).toBe(false);
    expect(showChecking(view(true, auth(true, ago(10 * 60_000))), NOW, null, true)).toBe(false);
    expect(showChecking(view(false, auth(false, null)), NOW, null, false)).toBe(false);
    // 刚查过失败（节流中）→ 不再假装在查，显示登录入口
    expect(showChecking(view(true, auth(false, null)), NOW, NOW - 1_000, false)).toBe(false);
  });
});

describe("maybeRecheckClaudeAuth", () => {
  test("stale 未登录 → one check; result written into the status cache; throttled after", async () => {
    const qc = new QueryClient();
    qc.setQueryData(ccKeys.status, view(true, auth(false, ago(10 * 60_000))));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const check = async () => {
      calls++;
      await gate;
      return { claude: auth(true, new Date(NOW).toISOString()) };
    };
    expect(maybeRecheckClaudeAuth(qc, NOW, check)).toBe(true);
    // 同时打开的其它组件 / 聚焦：不重复
    expect(maybeRecheckClaudeAuth(qc, NOW + 10, check)).toBe(false);
    release();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    const after = qc.getQueryData<CloudWorkspaceView>(ccKeys.status)!;
    expect(after.claude.loggedIn).toBe(true);
    expect(after.node?.online).toBe(true);
    // 节流：30 秒内即使缓存又被改成未登录也不再查
    qc.setQueryData(ccKeys.status, view(true, auth(false, null)));
    expect(maybeRecheckClaudeAuth(qc, NOW + 5_000, check)).toBe(false);
    expect(maybeRecheckClaudeAuth(qc, NOW + THROTTLE_MS + 1, check)).toBe(true);
  });

  test("fresh logged-in or offline node → no check", () => {
    const qc = new QueryClient();
    const check = async () => ({ claude: auth(true, null) });
    qc.setQueryData(ccKeys.status, view(true, auth(true, ago(5_000))));
    expect(maybeRecheckClaudeAuth(qc, NOW, check)).toBe(false);
    qc.setQueryData(ccKeys.status, view(false, auth(false, null)));
    expect(maybeRecheckClaudeAuth(qc, NOW, check)).toBe(false);
  });

  test("a failing check keeps the cached value and does not throw", async () => {
    const qc = new QueryClient();
    const before = view(true, auth(false, null));
    qc.setQueryData(ccKeys.status, before);
    expect(
      maybeRecheckClaudeAuth(qc, NOW, async () => {
        throw new Error("云端工作区不在线。");
      }),
    ).toBe(true);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(qc.getQueryData<CloudWorkspaceView>(ccKeys.status)!.claude.loggedIn).toBe(false);
  });

  // 「退出无效」的另一半：检查是在退出之前发出的，回来时缓存已经是「已退出」，这份旧结果不能把它改回已登录。
  test("a check that started before a logout does not overwrite the logged-out cache", async () => {
    const qc = new QueryClient();
    qc.setQueryData(ccKeys.status, view(true, auth(false, ago(10 * 60_000))));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const check = async () => {
      await gate;
      return { claude: auth(true, new Date(NOW).toISOString()) };
    };
    expect(maybeRecheckClaudeAuth(qc, NOW, check)).toBe(true);
    // 退出成功：页面刷新拿到了「没登录」，checkedAt 也换了新的
    qc.setQueryData(ccKeys.status, view(true, auth(false, new Date(NOW + 1_000).toISOString())));
    release();
    await Bun.sleep(0);
    await Bun.sleep(0);
    const after = qc.getQueryData<CloudWorkspaceView>(ccKeys.status)!;
    expect(after.claude.loggedIn).toBe(false);
  });
});

describe("useClaudeAuthRecheck (page wiring)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  test("opening the page with a stale 未登录: quiet checking state first (no login gate), one check, then logged in; focus within 30 s does not re-check", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ccKeys.status, view(true, auth(false, new Date(Date.now() - 10 * 60_000).toISOString())));
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.includes("/claude/check")) {
        await gate;
        return new Response(JSON.stringify({ claude: auth(true, new Date().toISOString()) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(qc.getQueryData(ccKeys.status)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const hook = renderHook(() => useClaudeAuthRecheck(), { wrapper });
    // 第一帧就是检查态，不会先闪「登录 Claude」
    expect(hook.result.current.checking).toBe(true);
    await act(async () => {
      await Bun.sleep(5);
    });
    expect(calls.filter((u) => u.includes("/claude/check")).length).toBe(1);
    expect(hook.result.current.checking).toBe(true);
    await act(async () => {
      release();
      await Bun.sleep(5);
    });
    expect(hook.result.current.checking).toBe(false);
    expect(qc.getQueryData<CloudWorkspaceView>(ccKeys.status)!.claude.loggedIn).toBe(true);
    // 回到窗口：已登录且刚查过 → 不再查
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Bun.sleep(5);
    });
    expect(calls.filter((u) => u.includes("/claude/check")).length).toBe(1);
  });

  test("window focus re-checks a stale cached value (after the throttle window)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ccKeys.status, view(true, auth(true, new Date().toISOString())));
    let checks = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/claude/check")) {
        checks++;
        return new Response(JSON.stringify({ claude: auth(true, new Date().toISOString()) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(qc.getQueryData(ccKeys.status)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const hook = renderHook(() => useClaudeAuthRecheck(), { wrapper });
    await act(async () => {
      await Bun.sleep(5);
    });
    expect(checks).toBe(0); // 刚查过、已登录
    expect(hook.result.current.checking).toBe(false);
    // 缓存变旧（比如窗口在后台放了几分钟）
    qc.setQueryData(ccKeys.status, view(true, auth(true, new Date(Date.now() - 5 * 60_000).toISOString())));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Bun.sleep(5);
    });
    expect(checks).toBeGreaterThanOrEqual(1);
    // 已登录的旧值不会被换成检查态（用缓存值）
    expect(hook.result.current.checking).toBe(false);
  });
});
