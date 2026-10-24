import type { QueryClient } from "@tanstack/react-query";
import { cloudWorkspaceQueryOptions, ccSessionQueryOptions, ccWorkspacesQueryOptions, LAST_CC_SESSION_KEY } from "@/lib/cloud-cc";

/**
 * 左栏「机器人｜Claude Code」切换是同一个外壳里的原地切换（DESIGN.md §84）：
 * - 地址决定模式：`/cc` 开头是 Claude Code，其余都是机器人；
 * - 切回机器人直接回到上次停的那个对话（不经过 `/` 再跳一次，主区不会空一下）；
 * - 切过去之前（空闲时 / 鼠标移上去 / 按下）先把对面的页面分包和数据取好，点下去就是现成的。
 */
export type LeftMode = "bots" | "cc";

export function modeOfPath(pathname: string): LeftMode {
  return pathname === "/cc" || pathname.startsWith("/cc/") ? "cc" : "bots";
}

export type BotsLocation = { pathname: string; search: Record<string, unknown> };

let lastBots: BotsLocation | null = null;

export function isBotsChatPath(pathname: string): boolean {
  return pathname.startsWith("/channel/") || pathname.startsWith("/group/");
}

/** 记住机器人这边最后停的对话位置（只记 `/channel/...` 与 `/group/...`；`/`、设置、管理、Claude Code 都不记）。 */
export function rememberBotsLocation(pathname: string, search: Record<string, unknown> | undefined) {
  if (!isBotsChatPath(pathname)) return;
  lastBots = { pathname, search: { ...(search ?? {}) } };
}

export function lastBotsLocation(): BotsLocation | null {
  return lastBots;
}

/** 测试用。 */
export function resetLeftModeMemory() {
  lastBots = null;
}

export function lastCcSession(): string | null {
  try {
    return localStorage.getItem(LAST_CC_SESSION_KEY);
  } catch {
    return null;
  }
}

/** 切到某个模式要去的地址（导航和预取用同一个）。 */
export function modeTarget(mode: LeftMode): { to: string; params?: Record<string, string>; search?: Record<string, unknown> } {
  if (mode === "bots") {
    const last = lastBots;
    return last ? { to: last.pathname, search: last.search } : { to: "/" };
  }
  const session = lastCcSession();
  return session ? { to: "/cc/$sessionId", params: { sessionId: session } } : { to: "/cc" };
}

type CcSidebarComponent = typeof import("@/components/cloud-cc/cc-sidebar").CcSidebar;
let ccSidebar: CcSidebarComponent | null = null;
let ccSidebarLoad: Promise<CcSidebarComponent> | null = null;

/** Claude Code 左栏单独一个分包：机器人用户的首屏不多下载它；切过去之前（空闲 / 指针移上来）先取好。 */
export function loadCcSidebar(): Promise<CcSidebarComponent> {
  ccSidebarLoad ??= import("@/components/cloud-cc/cc-sidebar")
    .then((m) => {
      ccSidebar = m.CcSidebar;
      return m.CcSidebar;
    })
    .catch((error: unknown) => {
      ccSidebarLoad = null;
      throw error;
    });
  return ccSidebarLoad;
}

/** 已经取好的 Claude Code 左栏（没取好是 null）。 */
export function loadedCcSidebar(): CcSidebarComponent | null {
  return ccSidebar;
}

type Preloader = { preloadRoute: (opts: never) => Promise<unknown> };

const warmed = new Set<string>();

/**
 * 预取对面：页面分包（router.preloadRoute）+ 进去第一眼要的数据（react-query 缓存）。重复调用便宜：
 * 分包只取一次，数据交给 react-query 的 staleTime。
 */
export function preloadMode(router: Preloader, queryClient: QueryClient, mode: LeftMode) {
  const target = modeTarget(mode);
  const key = JSON.stringify(target);
  if (!warmed.has(key)) {
    warmed.add(key);
    void router.preloadRoute(target as never).catch(() => warmed.delete(key));
  }
  if (mode !== "cc") return;
  void loadCcSidebar().catch(() => {});
  void queryClient
    .fetchQuery(cloudWorkspaceQueryOptions())
    .then((status) => {
      if (status?.node) void queryClient.prefetchQuery(ccWorkspacesQueryOptions(true));
    })
    .catch(() => {});
  const session = lastCcSession();
  if (session) void queryClient.prefetchQuery({ ...ccSessionQueryOptions(session), staleTime: 10_000 });
}
