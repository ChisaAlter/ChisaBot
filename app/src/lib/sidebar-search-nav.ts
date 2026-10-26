/**
 * 左栏「搜索会话」的键盘导航（CB-106）：焦点留在输入框里，↑ / ↓ 在结果间移动一个可见高亮，
 * Enter 打开高亮的那条，Esc 关闭（输入框自己处理）。
 *
 * 结果行由好几种组件画（标题命中的会话行、正文命中行），所以不在每个组件里各记一份状态，
 * 而是按 DOM 顺序取结果容器里的链接：画出来是什么顺序，方向键就按什么顺序走。
 * 高亮写成 `data-search-active` + `aria-selected`，输入框用 `aria-activedescendant` 指向它，读屏能念出来。
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
  return Array.from(container.querySelectorAll<HTMLElement>("a[href]"));
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
      item.removeAttribute("aria-selected");
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
  if (!target) return false;
  target.click();
  return true;
}

export function clearSearchActive(root?: ParentNode | null) {
  setSearchActive(searchResultItems(root), -1);
}
