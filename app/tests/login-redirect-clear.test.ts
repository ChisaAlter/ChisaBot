import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";

/*
 * /api/me 回 200 = 登录确认有效：清掉 /login 跳转时间戳，30 秒循环窗口重新算。
 * 否则「刚登录完、30 秒内会话真的过期」会被当成死循环，停在「登录状态异常」而不是直接去 /login。
 */
let mod: typeof import("../src/lib/auth/login-redirect");
let queries: typeof import("../src/lib/auth/queries");
let originalFetch: typeof fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/channel/abc" });
  originalFetch = globalThis.fetch;
  mod = await import("../src/lib/auth/login-redirect");
  queries = await import("../src/lib/auth/queries");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
  mod.resetLoginRedirectForTests();
});
afterAll(() => GlobalRegistrator.unregister());

function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const user = { id: "u1", email: "a@b.c", role: "user", onboarding: null };

test("clearLoginRedirectMark 删掉时间戳", () => {
  window.sessionStorage.setItem(mod.LOGIN_REDIRECT_KEY, "123");
  mod.clearLoginRedirectMark();
  expect(window.sessionStorage.getItem(mod.LOGIN_REDIRECT_KEY)).toBeNull();
});

test("/api/me 200：清掉时间戳，之后 30 秒内的网关 401 直接去 /login 而不是判成死循环", async () => {
  window.sessionStorage.setItem(
    mod.LOGIN_REDIRECT_KEY,
    String(Date.now() - 2_000),
  );
  respondWith(200, { user });
  const got = await new QueryClient().fetchQuery(
    queries.currentUserQueryOptions(),
  );
  expect(got?.id).toBe("u1");
  expect(window.sessionStorage.getItem(mod.LOGIN_REDIRECT_KEY)).toBeNull();

  const replaced: string[] = [];
  mod.goToLogin({
    location: {
      pathname: "/channel/abc",
      search: "",
      hash: "",
      replace: (to: string) => replaced.push(to),
    },
    sessionStorage: window.sessionStorage,
  } as unknown as Window);
  expect(replaced).toEqual(["/login?next=%2Fchannel%2Fabc"]);
  expect(mod.isLoginLoopDetected()).toBe(false);
});

test("/api/me 失败（500）：时间戳保留", async () => {
  window.sessionStorage.setItem(mod.LOGIN_REDIRECT_KEY, "123");
  respondWith(500, { error: "x" });
  await new QueryClient()
    .fetchQuery(queries.currentUserQueryOptions())
    .catch(() => null);
  expect(window.sessionStorage.getItem(mod.LOGIN_REDIRECT_KEY)).toBe("123");
});
