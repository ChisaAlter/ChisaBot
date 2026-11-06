import type { JsonRenderComponentName } from "./catalog";

/**
 * 对话里 render_ui 界面缺的那层外壳（DESIGN.md §29「一层外壳」，2026-11-06）。
 *
 * 外壳本该是最外层的 Card，模型却常常直接用 Stack 起头：上面一排卡片，下面一行淡色小字
 * （「数值越大越好」）。卡片有底，那行字直接落在天空 / 壁纸上，看着像漏在气泡外面。
 *
 * 从根往下只穿过排版容器（Stack / Grid / Carousel / Tabs），遇到 Card 就停（里面已经有底）。
 * 一路上碰到任何自己没有底的东西（Text、Heading、KeyValue、图表、时间线……）直接画在背景上，
 * 整张界面就要自己当外壳（返回 true），里面的 Card 按嵌套卡片平铺成小节。
 * 只有自带底的东西（Metric、List、按钮、商品卡……）时不加，和以前一样。
 *
 * 纯函数，不改传入的规范；流式时规范还没写完：还没到的孩子先跳过，下一行到了再判断。
 */

type Element = { type?: unknown; props?: unknown; children?: unknown };
type SpecLike = { root?: unknown; elements?: unknown } | null | undefined;

/** 自己有底色的组件（卡面、胶囊、玻璃块、渐变横幅、图片本身）：可以直接放在背景上。 */
const SURFACED: ReadonlySet<string> = new Set<JsonRenderComponentName>([
  "Metric",
  "List",
  "Alert",
  "Hero",
  "Products",
  "Link",
  "Badge",
  "Button",
  "Delta",
]);

/** 有这个属性时多出一行直接画在背景上的小字：Separator「更早」、Image 的图注、Icon 的标签；没有就只是线 / 图。 */
const LABELLED = {
  Separator: "label",
  Image: "caption",
  Icon: "label",
} satisfies Partial<Record<JsonRenderComponentName, string>>;

/** 只负责排版、自己不画字的容器：看它的孩子。 */
const LAYOUT: ReadonlySet<string> = new Set<JsonRenderComponentName>([
  "Stack",
  "Grid",
  "Carousel",
  "Tabs",
]);

function props(element: Element): Record<string, unknown> {
  return element.props && typeof element.props === "object"
    ? (element.props as Record<string, unknown>)
    : {};
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 这个元素自己有没有直接画在背景上的东西（不看孩子）。 */
function drawsBare(type: string, element: Element): boolean {
  if (SURFACED.has(type)) return false;
  const label = (LABELLED as Record<string, string | undefined>)[type];
  if (label) return hasText(props(element)[label]);
  // 分段开关（默认）有自己的底；下划线标签（variant: tabs）的标签字直接画在背景上。
  if (type === "Tabs") return props(element).variant === "tabs";
  return !LAYOUT.has(type);
}

export function needsShell(spec: SpecLike): boolean {
  const root = spec?.root;
  const elements = spec?.elements;
  if (
    typeof root !== "string" ||
    !root ||
    !elements ||
    typeof elements !== "object"
  )
    return false;
  const all = elements as Record<string, Element | undefined>;
  const seen = new Set<string>();
  const bare = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const element = all[key];
    // 还没写到（流式）或者写坏了被跳过的元素：先不算。
    if (!element || typeof element.type !== "string") return false;
    if (element.type === "Card") return false;
    if (drawsBare(element.type, element)) return true;
    if (!LAYOUT.has(element.type)) return false;
    const children = Array.isArray(element.children) ? element.children : [];
    return children.some((child) => typeof child === "string" && bare(child));
  };
  return bare(root);
}
