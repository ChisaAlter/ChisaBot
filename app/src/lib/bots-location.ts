/**
 * 记住机器人这边最后停的对话位置：从设置 / 管理回来时直接回到那个对话（不经过 `/` 再跳一次，主区不会空一下）。
 */
export type BotsLocation = { pathname: string; search: Record<string, unknown> };

let lastBots: BotsLocation | null = null;

export function isBotsChatPath(pathname: string): boolean {
  return pathname.startsWith("/channel/") || pathname.startsWith("/group/");
}

/** 只记 `/channel/...` 与 `/group/...`；`/`、设置、管理都不记。 */
export function rememberBotsLocation(pathname: string, search: Record<string, unknown> | undefined) {
  if (!isBotsChatPath(pathname)) return;
  lastBots = { pathname, search: { ...(search ?? {}) } };
}

export function lastBotsLocation(): BotsLocation | null {
  return lastBots;
}

/** 测试用。 */
export function resetBotsLocationMemory() {
  lastBots = null;
}

/** 回到机器人要去的地址。 */
export function botsTarget(): { to: string; search?: Record<string, unknown> } {
  const last = lastBots;
  return last ? { to: last.pathname, search: last.search } : { to: "/" };
}
