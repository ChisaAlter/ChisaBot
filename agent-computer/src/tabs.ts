/**
 * 浏览器多标签（DESIGN.md §95，docs/browser-tabs.md）。
 *
 * 一个机器人的浏览器 = 一个 Chromium 持久上下文；一个标签 = 上下文里的一个 Page。以前只有「最新打开的那页」
 * 是当前页（网站弹窗时跟过去）；现在多了一个明确的「当前标签」：新开的标签 / 网站弹出的窗口仍然自动成为当前，
 * 但人或机器人可以切到别的标签，关掉当前标签时落到它右边（没有就左边）的那个。
 *
 * 这个文件只放不碰浏览器的规则（编号、上限、关闭后落到哪、保存到磁盘的格式），这样测试不用启动 Chromium；
 * Page 只当类型导入。真正开 / 关 / 切页面在 profiles.ts。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { numberFromEnv } from "./env";

/** 一个机器人最多同时开几个标签。每个标签都是常驻内存的渲染进程，所以要有上限。 */
export const MAX_TABS = Math.max(1, Math.min(20, numberFromEnv("COMPUTER_MAX_TABS", 8)));

/** 超过上限时给人 / 机器人看的话。 */
export const TAB_LIMIT_MESSAGE = `最多同时打开 ${MAX_TABS} 个标签页，先关掉一个再开新的。`;

export class TabError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TabError";
  }
}

/** 足够判断的页面形状，测试里用假对象。 */
export type TabPage = { isClosed(): boolean; url(): string };

/** 每个 Page 一个稳定编号（t1、t2…），整个进程里不重复，关掉的标签编号不复用。 */
const ids = new WeakMap<object, string>();
let next = 0;
export function tabIdOf(page: object): string {
  let id = ids.get(page);
  if (!id) {
    next += 1;
    id = `t${next}`;
    ids.set(page, id);
  }
  return id;
}

/** 打开着的标签，按打开顺序。 */
export function openTabs<T extends TabPage>(pages: readonly T[]): T[] {
  return pages.filter((page) => !page.isClosed());
}

export function findTab<T extends TabPage>(pages: readonly T[], id: string): T | undefined {
  return openTabs(pages).find((page) => tabIdOf(page) === id);
}

/** 关掉 `closing` 之后应该落到哪个标签：右边的，没有就左边的；它不是当前标签就保持当前不变。 */
export function neighbourAfterClose<T extends TabPage>(
  pages: readonly T[],
  closing: T,
  active: T | undefined,
): T | undefined {
  const open = openTabs(pages);
  if (active && active !== closing && !active.isClosed()) return active;
  const index = open.indexOf(closing);
  if (index < 0) return active;
  return open[index + 1] ?? open[index - 1];
}

/** 一个标签给外面看的样子。 */
export type TabInfo = {
  id: string;
  url: string;
  title: string;
  active: boolean;
  /** data: 图标（≤64KB），拿不到就没有，界面上画首字母。 */
  favicon?: string;
  /** 正在加载。 */
  loading?: boolean;
};

export type TabsView = {
  tabs: TabInfo[];
  activeId: string | null;
  max: number;
  /** 浏览器没在运行时，列出的是上次保存的标签（还没打开）。 */
  running: boolean;
};

/** 标签标题：空白页叫「新标签页」，没有标题时用主机名。 */
export function tabTitle(url: string, title: string): string {
  const trimmed = title.trim();
  if (url === "about:blank" || url === "") return trimmed && trimmed !== "about:blank" ? trimmed : "新标签页";
  if (trimmed) return trimmed.slice(0, 200);
  try {
    return new URL(url).host || url.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

/* ---------- 重启后恢复：标签存在配置目录里 ---------- */

export const TABS_FILE = "chisabot-tabs.json";

export type SavedTabs = { tabs: { url: string; title: string }[]; active: number };

/** 只恢复真网页（http/https）；空白页、chrome:// 错误页不存。 */
export function restorableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= 4096;
}

export function savedTabsFrom(
  tabs: readonly { url: string; title: string; active: boolean }[],
): SavedTabs {
  const kept = tabs
    .filter((tab) => restorableUrl(tab.url))
    .slice(0, MAX_TABS)
    .map((tab) => ({ url: tab.url, title: tab.title.slice(0, 200) }));
  const activeTab = tabs.find((tab) => tab.active);
  const active = activeTab ? kept.findIndex((tab) => tab.url === activeTab.url) : -1;
  return { tabs: kept, active: Math.max(0, active) };
}

export function parseSavedTabs(raw: unknown): SavedTabs | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(value.tabs)) return null;
  const tabs = value.tabs
    .filter(
      (tab): tab is { url: string; title?: unknown } =>
        !!tab && typeof tab === "object" && typeof (tab as { url?: unknown }).url === "string",
    )
    .filter((tab) => restorableUrl(tab.url))
    .slice(0, MAX_TABS)
    .map((tab) => ({ url: tab.url, title: typeof tab.title === "string" ? tab.title.slice(0, 200) : "" }));
  const active =
    typeof value.active === "number" && Number.isInteger(value.active) && value.active >= 0 && value.active < tabs.length
      ? value.active
      : 0;
  return { tabs, active };
}

export async function readSavedTabs(profileDir: string): Promise<SavedTabs | null> {
  try {
    return parseSavedTabs(JSON.parse(await readFile(join(profileDir, TABS_FILE), "utf8")));
  } catch {
    return null;
  }
}

/** 先写临时文件再改名，写到一半断电也不会留下半个 JSON。 */
export async function writeSavedTabs(profileDir: string, saved: SavedTabs): Promise<void> {
  const target = join(profileDir, TABS_FILE);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(saved));
  await rename(temporary, target);
}

/** 是否在启动时恢复上次的标签。COMPUTER_RESTORE_TABS=0 关掉。 */
export const RESTORE_TABS = (process.env.COMPUTER_RESTORE_TABS ?? "1").trim() !== "0";

/** 等 `work` 最多 `ms` 毫秒，超时或出错就给 `fallback`。 */
export async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
