import { useSyncExternalStore } from "react";
import { useExternalConnection } from "@/hooks";
import { tryClient } from "@/lib/client";
import { useKeptVisible } from "@/lib/kept-visible";

/**
 * 机器人浏览器的标签（DESIGN.md §95）。
 *
 * 一份按机器人分的小仓库：直播画面的 socket 推来的 `tabs` 帧和没有直播时的轮询（GET /tabs，2 秒一次，
 * 页面不可见时停）写进同一个地方，标签栏只读这里。人接管时的 + / × / 切换走 POST /human/tab，
 * 回来的就是新的标签列表，直接写回仓库，画面不用等下一次轮询。
 */
export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  active: boolean;
  favicon?: string;
  loading?: boolean;
};
export type TabsView = {
  tabs: BrowserTab[];
  activeId: string | null;
  max: number;
  running: boolean;
};

const views = new Map<string, TabsView>();
const listeners = new Map<string, Set<() => void>>();

export function parseTabsView(value: unknown): TabsView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TabsView>;
  if (!Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs
    .filter(
      (tab): tab is BrowserTab =>
        !!tab && typeof tab === "object" && typeof tab.id === "string" && typeof tab.url === "string",
    )
    .slice(0, 20)
    .map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: typeof tab.title === "string" ? tab.title : "",
      active: tab.active === true,
      ...(typeof tab.favicon === "string" && tab.favicon.startsWith("data:image/") && tab.favicon.length < 100_000
        ? { favicon: tab.favicon }
        : {}),
    }));
  return {
    tabs,
    activeId: typeof raw.activeId === "string" ? raw.activeId : null,
    max: typeof raw.max === "number" && raw.max > 0 ? raw.max : 8,
    running: raw.running !== false,
  };
}

export function setTabsView(computerId: string, value: unknown): void {
  const view = parseTabsView(value);
  if (!view) return;
  const before = views.get(computerId);
  if (before && JSON.stringify(before) === JSON.stringify(view)) return;
  views.set(computerId, view);
  for (const listener of listeners.get(computerId) ?? []) listener();
}

function subscribe(computerId: string, listener: () => void) {
  const set = listeners.get(computerId) ?? new Set();
  set.add(listener);
  listeners.set(computerId, set);
  return () => {
    set.delete(listener);
  };
}

export async function readTabs(computerId: string, signal?: AbortSignal): Promise<TabsView | null> {
  const response = await tryClient(`/api/computers/${encodeURIComponent(computerId)}/tabs`, {
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  if (!response?.ok) return null;
  const view = parseTabsView(await response.json().catch(() => null));
  if (view) setTabsView(computerId, view);
  return view;
}

export type TabActionResult = { ok: true; view: TabsView } | { ok: false; error: string };

/** 人接管时的标签操作。 */
export async function humanTab(
  computerId: string,
  action: "new" | "activate" | "close",
  id?: string,
): Promise<TabActionResult> {
  const response = await tryClient(`/api/computers/${encodeURIComponent(computerId)}/human/tab`, {
    method: "POST",
    body: { action, ...(id ? { id } : {}) },
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as { error?: unknown } | null;
  if (!response?.ok) {
    return { ok: false, error: typeof body?.error === "string" ? body.error : "标签页操作没有成功。" };
  }
  const view = parseTabsView(body);
  if (!view) return { ok: false, error: "标签页操作没有成功。" };
  setTabsView(computerId, view);
  return { ok: true, view };
}

/** 机器人工具用：开 / 切 / 关标签（新开时可以带网址）。 */
export async function botTab(
  computerId: string,
  input: { action: "new" | "activate" | "close"; id?: string; url?: string; toolCallId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const response = await tryClient(`/api/computers/${encodeURIComponent(computerId)}/tabs`, {
    method: "POST",
    body: input,
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as Record<string, unknown> | null;
  if (response?.ok && body) setTabsView(computerId, body);
  return { ok: Boolean(response?.ok), status: response?.status ?? 0, body };
}

const POLL_MS = 2_000;

/**
 * 标签列表。`poll` 为真时（画面在屏幕上、没有直播 socket 在推）每 2 秒问一次。
 */
export function useBrowserTabs(computerId: string, pollWanted: boolean): TabsView | null {
  // 藏着的聊天 / 右栏不轮询（DESIGN.md §98.3）。
  const kept = useKeptVisible();
  const poll = pollWanted && kept;
  const view = useSyncExternalStore(
    (listener) => subscribe(computerId, listener),
    () => views.get(computerId) ?? null,
    () => null,
  );
  useExternalConnection(poll ? `tabs:${computerId}` : false, (_key, signal) => {
    const tick = async () => {
      if (signal.aborted) return;
      if (
        typeof document === "undefined" ||
        document.visibilityState === "visible"
      )
        await readTabs(computerId, signal);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      clearInterval(timer);
    };
  });
  return view;
}
