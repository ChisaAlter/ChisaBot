/**
 * 设置搜索落点（审查模块 12 第 2 条）。
 *
 * 顺序：
 * 1. `[data-setting-item~="页.项"]`：registry 的稳定 id，写在对应区块上（一个区块可带多个 id，空格分开）。
 * 2. `[data-setting-item~="<find 文字>"]`：外观页的三块用 find 文字当锚点（appearance-preferences.tsx）。
 * 3. 兜底：区块标题 / 设置行标题等的文字，全等优先、其次前缀。
 *
 * 找到的是锚点本身就直接高亮它；找到的是标题文字就高亮它所在的那一行 / 那一块。
 */

const TEXT_CANDIDATES =
  "main h2, main h3, main [data-slot=item-title], main .sg-srow-t, main label, main legend, [data-slot=page-section] h2";

function byAnchor(root: ParentNode, value: string): HTMLElement | null {
  const quoted = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return root.querySelector<HTMLElement>(`[data-setting-item~="${quoted}"]`);
}

export function locateSettingItem(
  root: ParentNode,
  itemId: string,
  find: string | null,
): HTMLElement | null {
  const anchored =
    byAnchor(root, itemId) ?? (find ? byAnchor(root, find) : null);
  if (anchored) return anchored;
  if (!find) return null;
  const candidates = root.querySelectorAll<HTMLElement>(TEXT_CANDIDATES);
  for (const el of candidates) if (el.textContent?.trim() === find) return el;
  for (const el of candidates)
    if (el.textContent?.trim().startsWith(find)) return el;
  return null;
}

/** 要滚进来、闪一下的那一块。 */
export function settingTarget(found: HTMLElement): HTMLElement {
  if (found.hasAttribute("data-setting-item")) return found;
  return (
    found.closest<HTMLElement>(
      "[data-slot=item], .sg-srow, .sg-card, [data-slot=page-section], section",
    ) ?? found
  );
}
