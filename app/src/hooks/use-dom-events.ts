import { type RefObject, useEffect, useRef } from "react";

function normalizeListenerOptions(options?: boolean | AddEventListenerOptions): {
  capture: boolean;
  passive: boolean | undefined;
  once: boolean | undefined;
} {
  if (typeof options === "boolean") {
    return { capture: options, passive: undefined, once: undefined };
  }
  return {
    capture: options?.capture ?? false,
    passive: options?.passive,
    once: options?.once,
  };
}

function buildAddOptions(
  capture: boolean,
  passive: boolean | undefined,
  once: boolean | undefined,
): boolean | AddEventListenerOptions | undefined {
  if (passive === undefined && once === undefined) {
    return capture ? true : undefined;
  }
  const out: AddEventListenerOptions = { capture };
  if (passive !== undefined) out.passive = passive;
  if (once !== undefined) out.once = once;
  return out;
}

/** 绑定全局 window 事件；传入 null/undefined handler 时自动解绑。 */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: ((event: WindowEventMap[K]) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void;
export function useWindowEvent(
  type: string,
  handler: ((event: Event) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void;
export function useWindowEvent(
  type: string,
  handler: ((event: never) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = handler !== null && handler !== undefined;
  const { capture, passive, once } = normalizeListenerOptions(options);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const listener = (event: Event) => {
      (handlerRef.current as ((ev: Event) => void) | null | undefined)?.(event);
    };
    const listenerOptions = buildAddOptions(capture, passive, once);
    window.addEventListener(type, listener, listenerOptions);
    return () => {
      window.removeEventListener(type, listener, capture);
    };
  }, [type, enabled, capture, passive, once]);
}

/** 绑定 document 事件；传入 null/undefined handler 时自动解绑。 */
export function useDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  handler: ((event: DocumentEventMap[K]) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void;
export function useDocumentEvent(
  type: string,
  handler: ((event: Event) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void;
export function useDocumentEvent(
  type: string,
  handler: ((event: never) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = handler !== null && handler !== undefined;
  const { capture, passive, once } = normalizeListenerOptions(options);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const listener = (event: Event) => {
      (handlerRef.current as ((ev: Event) => void) | null | undefined)?.(event);
    };
    const listenerOptions = buildAddOptions(capture, passive, once);
    document.addEventListener(type, listener, listenerOptions);
    return () => {
      document.removeEventListener(type, listener, capture);
    };
  }, [type, enabled, capture, passive, once]);
}

/** 绑定指定 DOM 元素或 RefObject 的事件；handler 为 null/undefined 时解绑，可通过 rebindKey 在同 ref 重建 DOM 时重绑。 */
export function useElementEvent<
  T extends EventTarget,
  K extends keyof HTMLElementEventMap,
>(
  target: RefObject<T | null> | T | null,
  type: K,
  handler: ((event: HTMLElementEventMap[K]) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
  rebindKey?: string | number | boolean | null,
): void;
export function useElementEvent<T extends EventTarget = EventTarget>(
  target: RefObject<T | null> | T | null,
  type: string,
  handler: ((event: Event) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
  rebindKey?: string | number | boolean | null,
): void;
export function useElementEvent<T extends EventTarget = EventTarget>(
  target: RefObject<T | null> | T | null,
  type: string,
  handler: ((event: never) => void) | null | undefined,
  options?: boolean | AddEventListenerOptions,
  rebindKey?: string | number | boolean | null,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );
  const enabled = handler !== null && handler !== undefined;
  const { capture, passive, once } = normalizeListenerOptions(options);

  useEffect(() => {
    epochRef.current = rebindKey;
    if (!enabled) return;
    const element =
      target && typeof target === "object" && "current" in target
        ? target.current
        : target;
    if (!element) return;
    const listener = (event: Event) => {
      (handlerRef.current as ((ev: Event) => void) | null | undefined)?.(event);
    };
    const listenerOptions = buildAddOptions(capture, passive, once);
    element.addEventListener(type, listener, listenerOptions);
    return () => {
      element.removeEventListener(type, listener, capture);
    };
  }, [target, type, enabled, capture, passive, once, rebindKey]);
}
