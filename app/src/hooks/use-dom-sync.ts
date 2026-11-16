import { type RefObject, useEffect, useRef } from "react";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function shallowEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

/** 在激活期间自动将焦点移入目标 HTMLElement（支持 preventScroll 与全选）。 */
export function useAutoFocus<T extends HTMLElement>(
  target: RefObject<T | null>,
  active: boolean,
  options?: FocusOptions & { select?: boolean },
): void {
  const preventScroll = options?.preventScroll;
  const select = options?.select ?? false;

  useEffect(() => {
    if (!active) return;
    const element = target.current;
    if (!element) return;
    element.focus(
      preventScroll === undefined ? undefined : { preventScroll },
    );
    if (
      select &&
      "select" in element &&
      typeof (element as unknown as { select?: () => void }).select ===
        "function"
    ) {
      (element as unknown as { select: () => void }).select();
    }
  }, [target, active, preventScroll, select]);
}

/** 将受控状态 value 单向命令式同步到指定 DOM 元素，按浅比较变更重跑并执行 cleanup。 */
export function useElementSync<TElement extends Element, TValue>(
  target: RefObject<TElement | null> | TElement | null,
  value: TValue,
  sync: (element: TElement, value: TValue) => undefined | (() => void),
): void;
export function useElementSync<TElement extends Element, TValue>(
  target: RefObject<TElement | null> | TElement | null,
  value: TValue,
  sync: (element: TElement, value: TValue) => void,
): void;
export function useElementSync<TElement extends Element, TValue>(
  target: RefObject<TElement | null> | TElement | null,
  value: TValue,
  sync: (element: TElement, value: TValue) => unknown,
): void {
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const stableValueRef = useRef(value);
  if (!shallowEqualValue(stableValueRef.current, value)) {
    stableValueRef.current = value;
  }
  const stableValue = stableValueRef.current;

  useEffect(() => {
    const element =
      target && typeof target === "object" && "current" in target
        ? target.current
        : target;
    if (!element) return;
    const cleanup = syncRef.current(element, stableValue);
    return typeof cleanup === "function" ? (cleanup as () => void) : undefined;
  }, [target, stableValue]);
}

/** 将应用状态同步到 Document（如标题、root dataset、meta 标签），按浅比较变更重跑。 */
export function useDocumentSync<TValue>(
  value: TValue,
  sync: (doc: Document, value: TValue) => undefined | (() => void),
): void;
export function useDocumentSync<TValue>(
  value: TValue,
  sync: (doc: Document, value: TValue) => void,
): void;
export function useDocumentSync<TValue>(
  value: TValue,
  sync: (doc: Document, value: TValue) => unknown,
): void {
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const stableValueRef = useRef(value);
  if (!shallowEqualValue(stableValueRef.current, value)) {
    stableValueRef.current = value;
  }
  const stableValue = stableValueRef.current;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const cleanup = syncRef.current(document, stableValue);
    return typeof cleanup === "function" ? (cleanup as () => void) : undefined;
  }, [stableValue]);
}
