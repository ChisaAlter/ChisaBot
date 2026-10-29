import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import {
  goToLogin,
  installLoginRedirect,
  isGatewayLoginRequired,
  isGoingToLogin,
  loginHref,
  resetLoginRedirectForTests,
} from "../src/lib/auth/login-redirect";
import { currentUserQueryOptions } from "../src/lib/auth/queries";

/**
 * 会话过期（网关的 401）直接整页去 /login?next=当前地址，而不是在应用里转到 /sign（网关不提供 /sign 页面，
 * 线上 0.1.110 会停在加载）。
 */

const gateway401 = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: "请先登录。",
      openbotAuthRequired: true,
    }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );

function fakeWin(href: string, respond: () => Response) {
  const url = new URL(href);
  const replaced: string[] = [];
  const win = {
    location: {
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (to: string) => {
        replaced.push(to);
      },
    },
    fetch: (async () => respond()) as unknown as typeof fetch,
  };
  return { win: win as unknown as Window, replaced };
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  resetLoginRedirectForTests();
  (globalThis as { window?: unknown }).window = originalWindow;
  globalThis.fetch = originalFetch;
});

describe("网关登录跳转", () => {
  test("登录页地址带上路径、查询和锚点", () => {
    expect(
      loginHref({
        pathname: "/channel/abc",
        search: "?watch=true",
        hash: "#m1",
      }),
    ).toBe("/login?next=%2Fchannel%2Fabc%3Fwatch%3Dtrue%23m1");
  });

  test("只认网关的「请先登录」401：别的 401 / 非 JSON 不算", async () => {
    expect(await isGatewayLoginRequired(gateway401())).toBe(true);
    expect(
      await isGatewayLoginRequired(
        new Response(JSON.stringify({ ok: false }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
    expect(
      await isGatewayLoginRequired(new Response("nope", { status: 401 })),
    ).toBe(false);
    expect(
      await isGatewayLoginRequired(
        new Response(JSON.stringify({ openbotAuthRequired: true }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
  });

  test("fetch 拿到网关 401：整页去 /login?next=，只跳一次，响应原样还给调用方", async () => {
    const { win, replaced } = fakeWin(
      "https://bot.example/settings/models?tab=a",
      gateway401,
    );
    installLoginRedirect(win);
    const response = await win.fetch("/api/channels");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ openbotAuthRequired: true });
    expect(isGoingToLogin()).toBe(true);
    await win.fetch("/api/me");
    expect(replaced).toEqual(["/login?next=%2Fsettings%2Fmodels%3Ftab%3Da"]);
  });

  test("跨域请求的 401 不动", async () => {
    const { win, replaced } = fakeWin("https://bot.example/", gateway401);
    installLoginRedirect(win);
    await win.fetch("https://elsewhere.example/api");
    expect(replaced).toEqual([]);
    expect(isGoingToLogin()).toBe(false);
  });

  test("已经在 /login 上不再跳", () => {
    const { win, replaced } = fakeWin(
      "https://bot.example/login?next=%2F",
      gateway401,
    );
    goToLogin(win);
    expect(replaced).toEqual([]);
  });

  test("当前用户接口 401（网关）：返回 null 并去 /login?next=当前地址", async () => {
    const { win, replaced } = fakeWin(
      "https://bot.example/channel/abc",
      gateway401,
    );
    (globalThis as { window?: unknown }).window = win;
    globalThis.fetch = (async () => gateway401()) as unknown as typeof fetch;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = await client.fetchQuery(currentUserQueryOptions());
    client.clear();
    expect(user).toBeNull();
    expect(replaced).toEqual(["/login?next=%2Fchannel%2Fabc"]);
  });

  test("没有网关的 401（普通部署）：只是未登录，不跳 /login", async () => {
    const { win, replaced } = fakeWin(
      "https://bot.example/channel/abc",
      gateway401,
    );
    (globalThis as { window?: unknown }).window = win;
    globalThis.fetch = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    expect(await client.fetchQuery(currentUserQueryOptions())).toBeNull();
    client.clear();
    expect(replaced).toEqual([]);
  });

  test("接线：入口装上拦截；_authed 在去登录页时不转 /sign", () => {
    const src = (p: string) =>
      readFileSync(join(import.meta.dir, "../src", p), "utf8");
    expect(src("main.tsx")).toMatch(/installLoginRedirect\(\);/);
    const authed = src("routes/_authed.tsx");
    const going = authed.indexOf("if (isGoingToLogin())");
    expect(going).toBeGreaterThan(-1);
    expect(going).toBeLessThan(
      authed.indexOf('throw redirect({ to: "/sign" })'),
    );
  });
});
