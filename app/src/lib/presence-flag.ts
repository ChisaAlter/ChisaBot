import { type RefCallback, useLayoutEffect } from "react";

/**
 * 「页面上有没有某个元素」记成 <body> / <html> 上的一个 data-* 属性（§41 ③，2026-10-29 设置面板卡顿）。
 *
 * 以前用 `body:has(.update-banner) .install-hint` 这类规则。Chromium 把所有 `:has()` 的失效集合并成一个，
 * 其中一条右边是 `*`（`body:has([data-slot=sheet-overlay]) :is(.glass-topbar *)`）时，任何带 data-slot 的元素
 * 插入 / 删除都会让 body 下整棵树（含藏着的聊天）重算样式：4× 降速下每次 50–110ms，一次点击好几次。
 * 改成元素自己挂上 / 卸下时拨一下开关，样式规则只看属性：开关变的那一刻才重算，平时 DOM 怎么变都不碰。
 *
 * 用法：`<div ref={presenceRef("has-update-banner")} …>`。按名字计数，同名元素同时有几个都行；返回的回调
 * 对同一个名字永远是同一个函数，React 不会每次渲染都重挂。
 */
type Target = "body" | "html";

const counts = new Map<string, number>();
const refs = new Map<string, RefCallback<Element>>();

function targetOf(target: Target): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return target === "html" ? document.documentElement : document.body;
}

function add(name: string, target: Target) {
  const key = `${target}:${name}`;
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  if (next === 1) targetOf(target)?.setAttribute(`data-${name}`, "");
}

function remove(name: string, target: Target) {
  const key = `${target}:${name}`;
  const next = (counts.get(key) ?? 0) - 1;
  if (next > 0) {
    counts.set(key, next);
    return;
  }
  counts.delete(key);
  targetOf(target)?.removeAttribute(`data-${name}`);
}

/** 挂到元素的 `ref` 上：元素在 DOM 里时 `<body data-{name}>`（或 `<html>`）在，卸下就去掉。 */
export function presenceRef(
  name: string,
  target: Target = "body",
): RefCallback<Element> {
  const key = `${target}:${name}`;
  let ref = refs.get(key);
  if (!ref) {
    ref = (el: Element | null) => {
      if (!el) return;
      add(name, target);
      return () => remove(name, target);
    };
    refs.set(key, ref);
  }
  return ref;
}

/**
 * 组件挂着时开着（给没法直接挂 ref 的外壳用，比如 `GlassShell` 的 `SidebarShell`）。
 * `on` 为 false 时不开（按组件自己的状态拨，比如侧栏收起时才开 `has-collapsed-sidebar`）。
 */
export function usePresenceFlag(name: string, target: Target = "body", on = true): void {
  useLayoutEffect(() => {
    if (!on) return;
    add(name, target);
    return () => remove(name, target);
  }, [name, target, on]);
}
