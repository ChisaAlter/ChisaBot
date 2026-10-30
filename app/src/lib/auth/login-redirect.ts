/**
 * 公网网关（deploy/public）的登录：会话过期时网关对 /api/* 回 JSON 401 `{ openbotAuthRequired: true }`，
 * 登录页是网关自己的 /login（不是应用里的 /sign）。
 *
 * 以前靠网关注入的 workspace.js 拦 fetch 跳登录页；但应用画了自己的账号控件（index.html 的
 * #chisabot-account-control），workspace.js 一看到就整段退出，拦截器从来没装上。于是过期会话里 /api/me 401
 * → 应用在页面里转到 /sign（SPA 路由，网关的 `/sign → /login` 302 根本碰不到）→ 停在加载 / 出错页。
 *
 * 现在应用自己认这个 401：整页跳到 /login?next=当前地址（网关 login.js 的 safeNext 只收站内路径），
 * 登录后回到原页面。不带 `openbotAuthRequired` 的 401（没有网关的部署、业务接口自己的 401）不动。
 * 30 秒内又被弹回来（会话有效但后端仍回这种 401）就停下，见下面的循环保护。
 */

import { mdCache } from "@/lib/chat/md-cache";

type LoginWindow = Pick<Window, "location" | "fetch"> & {
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
};
type LoginWindowStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;
type RedirectWindow = Pick<LoginWindow, "location"> & {
  sessionStorage?: LoginWindowStorage;
};

/**
 * 防死循环：后端在会话其实有效时也可能回网关的 401（身份头重放、签名校验失败：secret 不一致或时钟偏差）。
 * 这时 /login 查 /auth/session 看到已登录，立刻 replace(next) 回来，又 401，又去 /login……一直转。
 * 所以每次跳之前在 sessionStorage 记一个时间戳；LOGIN_LOOP_WINDOW_MS 内回来又碰到这种 401，就不再跳，
 * 改成显示「登录状态异常」（AuthLoopNotice），让用户先退出再重新登录。
 */
export const LOGIN_REDIRECT_KEY = "chisabot:login-redirect-at";
export const LOGIN_LOOP_WINDOW_MS = 30_000;

let redirecting = false;
let loopDetected = false;
const loopListeners = new Set<() => void>();

function storageOf(win: RedirectWindow): RedirectWindow["sessionStorage"] {
  try {
    return win.sessionStorage;
  } catch {
    return undefined;
  }
}

function lastRedirectAt(win: RedirectWindow): number | null {
  try {
    const value = Number(storageOf(win)?.getItem(LOGIN_REDIRECT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function markRedirect(win: RedirectWindow, now: number): void {
  try {
    storageOf(win)?.setItem(LOGIN_REDIRECT_KEY, String(now));
  } catch {}
}

/**
 * 确认登录正常（/api/me 回 200）后清掉跳转时间戳：30 秒的循环窗口重新算。
 * 否则「刚登录完、30 秒内会话又真的过期」会被误当成死循环，停在「登录状态异常」而不是直接去 /login。
 */
export function clearLoginRedirectMark(
  win: Pick<RedirectWindow, "sessionStorage"> = window,
): void {
  try {
    storageOf(win as RedirectWindow)?.removeItem?.(LOGIN_REDIRECT_KEY);
  } catch {}
}

function setLoopDetected(value: boolean): void {
  if (loopDetected === value) return;
  loopDetected = value;
  for (const listener of loopListeners) listener();
}

/** 登录页地址，带上当前位置作为 next；在应用自己的 /sign 上不带（登录完回 /sign 没有意义）。 */
export function loginHref(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  if (location.pathname === "/sign" || location.pathname.startsWith("/sign/"))
    return "/login";
  return `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

/** 已经在去登录页的路上（整页跳转还没发生）。 */
export function isGoingToLogin(): boolean {
  return redirecting;
}

/** 刚从 /login 回来又被网关 401：不再跳，页面显示「登录状态异常」。 */
export function isLoginLoopDetected(): boolean {
  return loopDetected;
}

export function subscribeLoginLoop(listener: () => void): () => void {
  loopListeners.add(listener);
  return () => {
    loopListeners.delete(listener);
  };
}

/** 整页去网关登录页；只跳一次。LOGIN_LOOP_WINDOW_MS 内已经跳过一次就不跳，改为标记「登录状态异常」。 */
export function goToLogin(
  win: RedirectWindow = window,
  now: number = Date.now(),
): void {
  if (redirecting || loopDetected) return;
  if (win.location.pathname === "/login") return;
  const last = lastRedirectAt(win);
  if (last !== null && now >= last && now - last < LOGIN_LOOP_WINDOW_MS) {
    setLoopDetected(true);
    return;
  }
  markRedirect(win, now);
  redirecting = true;
  win.location.replace(loginHref(win.location));
}

/**
 * 「退出重新登录」：先 POST /api/auth/sign-out 清掉会话，再去 /login（不带 next）。
 * 退出失败也照样去 /login；时间戳重新记一次，万一还是被弹回来，循环保护仍然生效，不会再转起来。
 */
export async function signOutAndReLogin(
  win: RedirectWindow & Pick<Window, "fetch"> = window,
  now: number = Date.now(),
): Promise<void> {
  try {
    await win.fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {}
  // 解析缓存里是消息原文；退出失败也照清（反正要去重新登录）。
  mdCache.clear();
  markRedirect(win, now);
  redirecting = true;
  win.location.replace("/login");
}

/** 这是网关说「请先登录」的 401 吗？只读克隆出来的响应体，原响应不动。 */
export async function isGatewayLoginRequired(
  response: Response,
): Promise<boolean> {
  if (response.status !== 401) return false;
  if (
    !(response.headers.get("content-type") || "").includes("application/json")
  )
    return false;
  try {
    const body = (await response.clone().json()) as {
      openbotAuthRequired?: unknown;
    } | null;
    return body?.openbotAuthRequired === true;
  } catch {
    return false;
  }
}

/**
 * 包一层 fetch：同源请求拿到网关的「请先登录」401 就去登录页，响应原样还给调用方。
 * 在返回响应之前判断，所以 /api/me 的调用方拿到 401 时 `isGoingToLogin()` 已经是真。
 */
export function installLoginRedirect(win: LoginWindow = window): void {
  const original = win.fetch.bind(win);
  win.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    if (response.status === 401 && sameOrigin(args[0], win.location.href)) {
      if (await isGatewayLoginRequired(response)) goToLogin(win);
    }
    return response;
  }) as typeof fetch;
}

function sameOrigin(input: RequestInfo | URL, base: string): boolean {
  try {
    const href = input instanceof Request ? input.url : String(input);
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** 只给测试用。 */
export function resetLoginRedirectForTests(): void {
  redirecting = false;
  loopDetected = false;
  loopListeners.clear();
}
