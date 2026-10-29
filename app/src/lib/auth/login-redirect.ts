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
 */

type LoginWindow = Pick<Window, "location" | "fetch">;

let redirecting = false;

/** 登录页地址，带上当前位置作为 next。 */
export function loginHref(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

/** 已经在去登录页的路上（整页跳转还没发生）。 */
export function isGoingToLogin(): boolean {
  return redirecting;
}

/** 整页去网关登录页；只跳一次。 */
export function goToLogin(win: Pick<Window, "location"> = window): void {
  if (redirecting) return;
  if (win.location.pathname === "/login") return;
  redirecting = true;
  win.location.replace(loginHref(win.location));
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
}
