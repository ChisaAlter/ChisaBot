import type { Spec } from "@json-render/core";

/**
 * 空的列表 / 重复区块不画（2026-10-13 Hark 第四轮）。
 *
 * 实测香港天气面板「未来 5 天」只剩一个小标题，下面什么都没有：模型写了一个 `repeat` 指向 state 里
 * 不存在的数组（或给 List 的 items 绑了一个空路径）。json-render 照结构画，结果就是一个孤零零的标题。
 *
 * 这里在渲染前把这类「注定是空的」区块剪掉：
 *  - 带 `repeat` 的元素，statePath 解析出来不是非空数组；
 *  - List 的 items、Table 的 rows 是空数组（或 $state 指向空 / 不存在的值）；
 *  - 容器（Stack / Grid / Card）本来有孩子，但孩子全被剪掉了；
 *  - 紧挨在被剪掉区块前面的 Heading，如果它后面（到下一个 Heading 之前）已经什么都不剩，也一起剪掉。
 *
 * 只认 `$state`：`$item` / `$index` / 其他动态值在重复作用域里才知道，一律当作「不空」，宁可多画也不误删。
 * 服务器的 panel_update 用 {@link emptySections} 把同一类问题退回给机器人；浏览器用 {@link pruneEmptySections}
 * 兜底（老面板、render_ui）。两边同一套判断。
 */

type Element = {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
  repeat?: { statePath?: unknown } | null;
};

const CONTAINERS = new Set(["Stack", "Grid", "Card", "Carousel", "Accordion", "Tabs"]);

/** 数据在某个数组属性里的组件：数组为空就是空区块（2026-10-13 富组件）。 */
const ARRAY_PROP: Record<string, string> = {
  List: "items",
  Table: "rows",
  Timeline: "items",
  KeyValue: "items",
  Sparkline: "data",
  HeatStrip: "values",
};

/** Chart 有两种写法：data（单条）或 series（多条，每条有 data）。 */
function chartEmpty(props: Record<string, unknown> | undefined, state: unknown): boolean {
  const series = props?.series;
  if (Array.isArray(series) && series.length > 0) {
    return series.every((one) => emptyArray((one as { data?: unknown } | null)?.data, state) === true);
  }
  return emptyArray(props?.data, state) === true;
}

function lookup(state: unknown, path: string): unknown {
  return path
    .split("/")
    .filter(Boolean)
    .reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
      state ?? {},
    );
}

/** `undefined` = 不知道（动态值），`true` / `false` = 确定空 / 不空。 */
function emptyArray(value: unknown, state: unknown): boolean | undefined {
  if (Array.isArray(value)) return value.length === 0;
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "object") {
    const ref = (value as { $state?: unknown }).$state;
    if (typeof ref === "string") {
      const resolved = lookup(state, ref);
      return !Array.isArray(resolved) || resolved.length === 0;
    }
    return undefined;
  }
  return true;
}

export type EmptySectionReport = {
  /** 被剪掉的元素 key（含跟着一起剪掉的标题）。 */
  removed: Set<string>;
  /** 给人看的名字：区块前面的标题文字，没有就用组件名 + key。 */
  labels: string[];
  /** 根元素本身就是空的（整张都没东西）。 */
  rootEmpty: boolean;
};

export function findEmptySections(spec: Spec | null | undefined): EmptySectionReport {
  const removed = new Set<string>();
  const labels: string[] = [];
  const elements = (spec?.elements ?? {}) as Record<string, Element>;
  const state = (spec as { state?: unknown } | null | undefined)?.state ?? {};
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isEmpty = (key: string): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const element = elements[key];
    if (!element || visiting.has(key)) return false;
    visiting.add(key);
    let empty = false;
    const statePath = element.repeat?.statePath;
    if (typeof statePath === "string") {
      const items = lookup(state, statePath);
      empty = !Array.isArray(items) || items.length === 0;
    } else if (element.repeat && statePath !== undefined) {
      empty = false; // $item 等动态路径：不知道
    }
    const arrayProp = element.type ? ARRAY_PROP[element.type] : undefined;
    if (!empty && arrayProp) empty = emptyArray(element.props?.[arrayProp], state) === true;
    if (!empty && element.type === "Chart") empty = chartEmpty(element.props, state);
    if (!empty && !element.repeat && element.type && CONTAINERS.has(element.type)) {
      const children = (element.children ?? []).filter((child): child is string => typeof child === "string" && child in elements);
      empty = children.length > 0 && children.every((child) => isEmpty(child));
    }
    visiting.delete(key);
    memo.set(key, empty);
    return empty;
  };

  const headingText = (key: string | undefined) => {
    const element = key ? elements[key] : undefined;
    return element?.type === "Heading" && typeof element.props?.text === "string" ? element.props.text : undefined;
  };

  for (const [key, element] of Object.entries(elements)) {
    const children = (element?.children ?? []).filter((child): child is string => typeof child === "string");
    children.forEach((child, index) => {
      if (!isEmpty(child)) return;
      // 一个空的容器里套着空列表：只报最外层，免得同一个区块报三遍。
      if (!isEmpty(key) || key === spec?.root) {
        const previous = children[index - 1];
        const heading = headingText(previous);
        const child_ = elements[child];
        labels.push(
          heading ??
            (typeof child_?.props?.title === "string" ? child_.props.title : undefined) ??
            `${child_?.type ?? "元素"} ${child}`,
        );
      }
      removed.add(child);
      // 标题后面（到下一个标题前）一个不空的都没有 → 标题也剪掉。
      for (let back = index - 1; back >= 0; back--) {
        const candidate = children[back];
        if (!candidate) continue;
        if (elements[candidate]?.type === "Heading") {
          const tail = children.slice(back + 1);
          const nextHeading = tail.findIndex((k) => elements[k]?.type === "Heading");
          const section = nextHeading === -1 ? tail : tail.slice(0, nextHeading);
          if (section.length > 0 && section.every((k) => isEmpty(k) || removed.has(k))) removed.add(candidate);
          break;
        }
        if (!isEmpty(candidate)) break;
      }
    });
  }
  const rootEmpty = Boolean(spec?.root && isEmpty(spec.root));
  if (rootEmpty) labels.push("整张面板");
  return { removed, labels: [...new Set(labels)], rootEmpty };
}

/** 浏览器渲染前调用：返回剪掉空区块后的规范（根本身是空的就原样返回，交给外层显示「暂无内容」）。 */
export function pruneEmptySections<T extends Spec | null>(spec: T): T {
  if (!spec?.elements) return spec;
  const { removed, rootEmpty } = findEmptySections(spec);
  if (!removed.size || rootEmpty) return spec;
  const elements: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(spec.elements as Record<string, Element>)) {
    if (removed.has(key)) continue;
    elements[key] = Array.isArray(raw.children)
      ? { ...raw, children: raw.children.filter((child) => !(typeof child === "string" && removed.has(child))) }
      : raw;
  }
  return { ...spec, elements } as T;
}

/** 服务器：面板里有哪些区块注定是空的（给 panel_update 退回用）。 */
export function emptySections(spec: Spec | null | undefined): string[] {
  return findEmptySections(spec).labels;
}
