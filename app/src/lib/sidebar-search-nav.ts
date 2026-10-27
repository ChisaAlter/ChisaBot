/**
 * 左栏「搜索会话」的键盘导航（CB-106）：焦点留在输入框里，↑ / ↓ 在结果间移动一个可见高亮，
 * Enter 打开高亮的那条，Esc 关闭（输入框自己处理）。
 *
 * 结果行由好几种组件画（标题命中的会话行、正文命中行），所以不在每个组件里各记一份状态，
 * 而是按 DOM 顺序取结果容器（role=listbox）里的 role=option：画出来是什么顺序，方向键就按什么顺序走。
 * 每个 option 一直带 `aria-selected`（高亮的那条是 true，其余 false），输入框（combobox）用
 * `aria-controls` 指向 listbox、`aria-activedescendant` 指向高亮的 option，读屏能念出来。
 */
import { scrollIntoViewWithin } from "@/lib/scroll-within";

export const SEARCH_RESULTS_ID = "sidebar-search-results";
export const SEARCH_ACTIVE_ATTR = "data-search-active";

/** 下一个高亮位置：首尾相接；没有高亮时 ↓ 到第一条、↑ 到最后一条；没有结果时 -1。 */
export function nextSearchIndex(
  current: number,
  delta: 1 | -1,
  length: number,
): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export function searchResultItems(
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
): HTMLElement[] {
  const container = root?.querySelector?.(`#${SEARCH_RESULTS_ID}`);
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** option 里真正能打开的那个链接（option 本身是链接时就是它自己）。 */
function linkOf(option: HTMLElement): HTMLElement | null {
  return option.matches("a[href]")
    ? option
    : option.querySelector<HTMLElement>("a[href]");
}

let idSeq = 0;

/** 把高亮移到 index（-1 = 清除）；返回高亮元素的 id，给输入框的 aria-activedescendant。 */
export function setSearchActive(
  items: HTMLElement[],
  index: number,
): string | undefined {
  let activeId: string | undefined;
  items.forEach((item, i) => {
    if (i === index) {
      if (!item.id) item.id = `sidebar-search-result-${++idSeq}`;
      item.setAttribute(SEARCH_ACTIVE_ATTR, "");
      item.setAttribute("aria-selected", "true");
      activeId = item.id;
      // 只滚结果列表，不用原生 scrollIntoView（§98.5，免得拖动 keep-alive 聊天）。
      scrollIntoViewWithin(item, { block: "nearest", behavior: "auto" });
    } else {
      item.removeAttribute(SEARCH_ACTIVE_ATTR);
      item.setAttribute("aria-selected", "false");
    }
  });
  return activeId;
}

export function activeSearchIndex(items: HTMLElement[]): number {
  return items.findIndex((item) => item.hasAttribute(SEARCH_ACTIVE_ATTR));
}

/** ↑ / ↓：移动高亮。返回新高亮的 id（没有结果时 undefined）。 */
export function moveSearchActive(
  delta: 1 | -1,
  root?: ParentNode | null,
): string | undefined {
  const items = searchResultItems(root);
  return setSearchActive(
    items,
    nextSearchIndex(activeSearchIndex(items), delta, items.length),
  );
}

/** Enter：打开高亮的那条；没有高亮但只有一条结果时打开它。打开了返回 true。 */
export function openSearchActive(root?: ParentNode | null): boolean {
  const items = searchResultItems(root);
  const at = activeSearchIndex(items);
  const target =
    at >= 0 ? items[at] : items.length === 1 ? items[0] : undefined;
  const link = target ? linkOf(target) : null;
  if (!link) return false;
  link.click();
  return true;
}

export function clearSearchActive(root?: ParentNode | null) {
  setSearchActive(searchResultItems(root), -1);
}

/** 「最近活动 8分钟前」：结果行的时间字段（CB-106 r2，说清楚是会话最近活动，不是那条消息的时间）。 */
export function searchHitWhen(
  relative: string | undefined,
): string | undefined {
  return relative ? `最近活动 ${relative}` : undefined;
}

/** 摘要里的 markdown 图片（含被截断、没收尾的）。 */
const MD_IMAGE = /!\[[^\]\n]*\](?:\([^)\s]*\)?)?|!\[[^\]\n]*$/g;
export const SNIPPET_IMAGE_ZH = "[图片]";

/**
 * 摘要里的 `![alt](url)` 显示成「[图片]」，高亮区间跟着平移（落在图片语法里的那一头收到「[图片]」的边上）。
 */
export function cleanSearchSnippet(
  snippet: string,
  highlight?: { start: number; end: number },
): { snippet: string; highlight?: { start: number; end: number } } {
  const cuts: { from: number; to: number }[] = [];
  for (const m of snippet.matchAll(MD_IMAGE))
    cuts.push({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length });
  if (!cuts.length) return { snippet, highlight };
  let out = "";
  let at = 0;
  for (const cut of cuts) {
    out += snippet.slice(at, cut.from) + SNIPPET_IMAGE_ZH;
    at = cut.to;
  }
  out += snippet.slice(at);
  const map = (pos: number, end: boolean) => {
    let shift = 0;
    for (const cut of cuts) {
      if (pos <= cut.from) break;
      if (pos < cut.to)
        return cut.from + shift + (end ? SNIPPET_IMAGE_ZH.length : 0);
      shift += SNIPPET_IMAGE_ZH.length - (cut.to - cut.from);
    }
    return pos + shift;
  };
  return {
    snippet: out,
    highlight: highlight
      ? { start: map(highlight.start, false), end: map(highlight.end, true) }
      : undefined,
  };
}
