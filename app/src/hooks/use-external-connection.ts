import { useEffect, useMemo, useRef } from "react";

export type ExternalConnectionKey = string | number | true;

export type AbortScope = {
  /** 当前组件仍处于挂载激活期时返回 true。 */
  readonly alive: () => boolean;
  /** 绑定到挂载生命周期的根 AbortSignal。 */
  readonly signal: AbortSignal;
  /** 派生一个随卸载自动中断的子 AbortController；若传入上一个未结束控制器则先取消之。 */
  readonly fork: (previous?: AbortController | null) => AbortController;
};

/** 组件挂载期内的统一中断作用域：卸载时自动中止根信号与所有派生子控制器。 */
export function useAbortScope(): AbortScope {
  const rootRef = useRef<AbortController | null>(null);
  const childrenRef = useRef<Set<AbortController>>(new Set());

  if (rootRef.current === null) {
    rootRef.current = new AbortController();
  }

  useEffect(() => {
    if (rootRef.current === null || rootRef.current.signal.aborted) {
      rootRef.current = new AbortController();
    }
    const children = childrenRef.current;
    return () => {
      rootRef.current?.abort();
      for (const child of children) child.abort();
      children.clear();
    };
  }, []);

  return useMemo<AbortScope>(
    () => ({
      alive: () => !(rootRef.current?.signal.aborted ?? true),
      get signal() {
        if (rootRef.current === null) {
          rootRef.current = new AbortController();
        }
        return rootRef.current.signal;
      },
      fork: (previous) => {
        previous?.abort();
        if (previous) childrenRef.current.delete(previous);
        const child = new AbortController();
        if (rootRef.current?.signal.aborted) {
          child.abort();
          return child;
        }
        childrenRef.current.add(child);
        child.signal.addEventListener(
          "abort",
          () => {
            childrenRef.current.delete(child);
          },
          { once: true },
        );
        return child;
      },
    }),
    [],
  );
}

/**
 * 按资源标识 key 管理外部系统连接 / 订阅 / 可取消异步同步生命周期。
 * key 为 null / undefined / false 时断开；key 切换或卸载时自动 abort 并执行清理函数。
 */
export function useExternalConnection<K extends ExternalConnectionKey>(
  key: K | null | undefined | false,
  connect: (
    activeKey: K,
    signal: AbortSignal,
  ) =>
    | undefined
    | (() => void)
    | Promise<undefined | (() => void)>,
): void;
export function useExternalConnection<K extends ExternalConnectionKey>(
  key: K | null | undefined | false,
  connect: (activeKey: K, signal: AbortSignal) => void | Promise<void>,
): void;
export function useExternalConnection<K extends ExternalConnectionKey>(
  key: K | null | undefined | false,
  connect: (activeKey: K, signal: AbortSignal) => unknown,
): void {
  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    if (key === null || key === undefined || key === false) return;
    const controller = new AbortController();
    let cleanup: (() => void) | undefined;
    const result = connectRef.current(key, controller.signal);
    if (typeof result === "function") {
      cleanup = result as () => void;
    } else if (
      result !== null &&
      typeof result === "object" &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).then((resolved) => {
        if (typeof resolved !== "function") return;
        if (controller.signal.aborted) (resolved as () => void)();
        else cleanup = resolved as () => void;
      });
    }
    return () => {
      controller.abort();
      cleanup?.();
      cleanup = undefined;
    };
  }, [key]);
}
