/**
 * 只滚一个容器，把里面的元素滚进来（DESIGN.md §98.5）。
 *
 * 不用原生 `scrollIntoView`：它会顺着整条祖先链挑能滚的容器来滚。设置左栏打开时把当前那一行滚进来
 * （`scrollIntoView({ block: "nearest" })`），Chrome 实测会把藏在下面、留着的聊天（§98，`visibility: hidden`）
 * 的滚动容器挪几十像素（1280 宽第一次去设置 +68px），回聊天时滚动位置就对不上了。这里只改 `container.scrollTop`，
 * 别的容器一个像素都不动。
 */
export type ScrollBlock = "nearest" | "center";

/** `el` 外面最近一个能竖着滚的容器（没有就 null）。 */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** 算出 `container` 要滚到的 scrollTop（不需要滚时返回 null）。 */
export function targetScrollTop(
  container: Pick<HTMLElement, "scrollTop" | "getBoundingClientRect">,
  el: Pick<HTMLElement, "getBoundingClientRect">,
  block: ScrollBlock = "nearest",
): number | null {
  const delta = scrollDelta(container.getBoundingClientRect(), el.getBoundingClientRect(), block);
  return delta === null ? null : Math.max(0, container.scrollTop + delta);
}

type Box = Pick<DOMRectReadOnly, "top" | "bottom" | "height">;

/** `row` 要滚进 `box` 时容器要多滚多少（正数往下；不需要滚时返回 null）。 */
export function scrollDelta(box: Box, row: Box, block: ScrollBlock = "nearest"): number | null {
  if (block === "center") {
    const delta = row.top + row.height / 2 - (box.top + box.height / 2);
    return Math.abs(delta) < 1 ? null : delta;
  }
  if (row.top < box.top) return row.top - box.top;
  if (row.bottom > box.bottom) {
    // 比容器还高时对齐顶部（和原生 nearest 一样）。
    return row.height > box.height ? row.top - box.top : row.bottom - box.bottom;
  }
  return null;
}

/** 把 `el` 滚进 `container`（不给就找最近的可滚祖先）；只动这一个容器。 */
export function scrollIntoViewWithin(
  el: HTMLElement,
  { container, block = "nearest", behavior = "auto" }: { container?: HTMLElement | null; block?: ScrollBlock; behavior?: ScrollBehavior } = {},
): void {
  const box = container ?? scrollParentOf(el);
  if (!box) return;
  const top = targetScrollTop(box, el, block);
  if (top === null) return;
  if (behavior === "smooth" && typeof box.scrollTo === "function") box.scrollTo({ top, behavior });
  else box.scrollTop = top;
}

/**
 * 同 `scrollIntoViewWithin`，但不在这一刻读布局（2026-10-29 设置面板卡顿，§41 ④）。
 *
 * 打开设置 / 切分类时左栏的 effect 和点击在同一个任务里跑；那时读 `getBoundingClientRect` 会逼浏览器当场把
 * 刚挂上的设置页（以及整棵树）排一遍版，再在这一帧里正常排一遍。这里交给 IntersectionObserver：浏览器排完版
 * 自己把两个矩形算好给回调，回调里只写（`scrollBy`，不读 scrollTop），一次强制布局都没有。
 * 返回取消函数（effect 清理时调）。没有 IntersectionObserver 的环境（测试）退回同步版本。
 */
export function scrollIntoViewWithinAsync(
  el: HTMLElement,
  { container, block = "nearest" }: { container: HTMLElement; block?: ScrollBlock },
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    scrollIntoViewWithin(el, { container, block });
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      observer.disconnect();
      const entry = entries[entries.length - 1];
      if (!entry?.rootBounds) return;
      const delta = scrollDelta(entry.rootBounds, entry.boundingClientRect, block);
      if (delta !== null) container.scrollBy({ top: delta });
    },
    { root: container },
  );
  observer.observe(el);
  return () => observer.disconnect();
}
