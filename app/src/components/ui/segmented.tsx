import { type RefObject, useRef } from "react";

/**
 * ARIA radiogroup 的键盘约定，只写一次（2026-10-20 审查）。
 *
 * 这个产品里的「分段选择」（`.sg-segmented`）有十几处是手写的 `<div role="radiogroup">` +
 * `<button role="radio">`：能点、也能 Tab 到，但 Tab 会挨个停在每一项上（没有 roving tabindex），
 * 方向键什么都没做。一处一处补太容易漏——这次审查就漏掉了十几处，只修了左栏那一个。
 *
 * 所以规则放在这里，一处实现、处处一致：
 *  - Tab 只停在选中项（roving tabindex），其余项 `tabIndex={-1}`；
 *  - 左右 / 上下方向键换选项，Home / End 到首尾，首尾相接；
 *  - 换完焦点跟到新选中项；读屏念的是调用处按钮上的 `aria-checked`。
 *
 * 用法：`const keys = useSegmentedKeys({ value, values, onChange })`；
 * 组上 `ref={keys.groupRef}` + `{...keys.groupProps}`，每一项 `tabIndex={keys.itemTabIndex(item)}`。
 */
export function useSegmentedKeys<T extends string>(options: {
  value: T;
  /** 选项的 DOM 顺序，和容器里 `[role="radio"]` 的顺序一致。 */
  values: readonly T[];
  onChange: (next: T) => void;
  disabled?: boolean;
}): {
  groupRef: RefObject<HTMLDivElement | null>;
  groupProps: { onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void };
  itemTabIndex: (item: T) => 0 | -1;
} {
  const { value, values, onChange, disabled = false } = options;
  const groupRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || values.length === 0) return;
    const at = Math.max(0, values.indexOf(value));
    let next = at;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (at + 1) % values.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (at - 1 + values.length) % values.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = values.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = values[next];
    if (target === undefined) return;
    if (target !== value) onChange(target);
    // 焦点跟到新选中项：读屏要听到选中变了，键盘也得停在那儿接着按。
    const radios = groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
  };
  // 选中的那个值不在列表里（数据还没到 / 旧值）时，让第一项可 Tab，别整组都进不去。
  const active = values.includes(value) ? value : values[0];
  return {
    groupRef,
    groupProps: { onKeyDown },
    itemTabIndex: (item) => (item === active ? 0 : -1),
  };
}
