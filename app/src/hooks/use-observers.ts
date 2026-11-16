import { type RefObject, useEffect, useRef } from "react";

function resolveElement<T extends Node>(
  target: RefObject<T | null> | T | null,
): T | null {
  if (target && typeof target === "object" && "current" in target) {
    return target.current;
  }
  return target;
}

/** 监听元素尺寸变化（ResizeObserver），卸载或禁用时自动 disconnect，可通过 rebindKey 重绑。 */
export function useResizeObserver<T extends Element>(
  target: RefObject<T | null> | T | null,
  onResize: (entry: ResizeObserverEntry) => void,
  enabled = true,
  rebindKey?: string | number | boolean | null,
): void {
  const callbackRef = useRef(onResize);
  callbackRef.current = onResize;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );

  useEffect(() => {
    epochRef.current = rebindKey;
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const element = resolveElement(target);
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) callbackRef.current(entry);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, enabled, rebindKey]);
}

/** 监听元素可见交叉区域变化（IntersectionObserver），自动规范化阈值与清理。 */
export function useIntersectionObserver<T extends Element>(
  target: RefObject<T | null> | T | null,
  onIntersect: (entry: IntersectionObserverEntry) => void,
  options?: IntersectionObserverInit & {
    enabled?: boolean;
    rebindKey?: string | number | boolean | null;
  },
): void {
  const callbackRef = useRef(onIntersect);
  callbackRef.current = onIntersect;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );
  const enabled = options?.enabled ?? true;
  const rebindKey = options?.rebindKey;
  const root = options?.root ?? null;
  const rootMargin = options?.rootMargin;
  const thresholdKey = Array.isArray(options?.threshold)
    ? options.threshold.join(",")
    : String(options?.threshold ?? "");

  useEffect(() => {
    epochRef.current = rebindKey;
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const element = resolveElement(target);
    if (!element) return;
    const parsedThreshold = thresholdKey.includes(",")
      ? thresholdKey.split(",").map(Number)
      : thresholdKey === ""
        ? undefined
        : Number(thresholdKey);
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) callbackRef.current(entry);
      },
      {
        root,
        ...(rootMargin !== undefined ? { rootMargin } : {}),
        ...(parsedThreshold !== undefined ? { threshold: parsedThreshold } : {}),
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, enabled, root, rootMargin, thresholdKey, rebindKey]);
}

/** 监听 DOM 树变更（MutationObserver），卸载或禁用时自动 disconnect。 */
export function useMutationObserver<T extends Node>(
  target: RefObject<T | null> | T | null,
  onMutate: (records: MutationRecord[]) => void,
  options: MutationObserverInit & {
    enabled?: boolean;
    rebindKey?: string | number | boolean | null;
  },
): void {
  const callbackRef = useRef(onMutate);
  callbackRef.current = onMutate;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );
  const enabled = options.enabled ?? true;
  const rebindKey = options.rebindKey;
  const attributes = options.attributes;
  const childList = options.childList;
  const subtree = options.subtree;
  const characterData = options.characterData;
  const attributeOldValue = options.attributeOldValue;
  const characterDataOldValue = options.characterDataOldValue;
  const filterKey = options.attributeFilter?.join("\0") ?? null;

  useEffect(() => {
    epochRef.current = rebindKey;
    if (!enabled || typeof MutationObserver === "undefined") return;
    const node = resolveElement(target);
    if (!node) return;
    const observer = new MutationObserver((records) => {
      callbackRef.current(records);
    });
    const init: MutationObserverInit = {};
    if (attributes !== undefined) init.attributes = attributes;
    if (childList !== undefined) init.childList = childList;
    if (subtree !== undefined) init.subtree = subtree;
    if (characterData !== undefined) init.characterData = characterData;
    if (attributeOldValue !== undefined)
      init.attributeOldValue = attributeOldValue;
    if (characterDataOldValue !== undefined)
      init.characterDataOldValue = characterDataOldValue;
    if (filterKey !== null) init.attributeFilter = filterKey.split("\0");
    observer.observe(node, init);
    return () => observer.disconnect();
  }, [
    target,
    enabled,
    attributes,
    childList,
    subtree,
    characterData,
    attributeOldValue,
    characterDataOldValue,
    filterKey,
    rebindKey,
  ]);
}
