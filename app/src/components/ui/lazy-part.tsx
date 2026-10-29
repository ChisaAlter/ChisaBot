import { type ComponentType, type ReactNode, useEffect, useState } from "react";

/**
 * 首屏画完、浏览器空下来以后才挂上 children（最多等 `timeout` 毫秒）：给首屏用不到、只在后台听事件的东西
 * （Alt+Space 速记、定时任务提醒、补资料弹窗），它们的代码不和首屏抢下载和主线程（DESIGN.md §41.5）。
 */
export function AfterIdle({ children, timeout = 2000 }: { children: ReactNode; timeout?: number }) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => setIdle(true), { timeout });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(() => setIdle(true), Math.min(timeout, 500));
    return () => window.clearTimeout(timer);
  }, [timeout]);
  return idle ? children : null;
}

/*
 * 用到才下载的一块界面（DESIGN.md §41.5），和 `lazyDialog`（§41.3）同一个思路：
 * - 代码第一次渲染（或 preload()）时才下载，不进入口包；
 * - 已经下载过就同步渲染——不用 React.lazy + Suspense，免得已经预加载好的块还要挂起一次、被 Suspense 重试节流拖慢 ~300ms；
 * - 没到之前画 `fallback`（用设计系统里现成的骨架，比如 RouteSkeleton；也可以是拿到同样 props 的函数，比如先画纯文字）；
 * - 下载失败抛给路由的错误边界：发版后旧分包没了由 StartupFailure / lib/stale-chunk.ts 自动刷新一次。
 */
export type LazyPart<P extends object> = ComponentType<P> & { preload: () => Promise<unknown> };

export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode | ((props: P) => ReactNode) = null,
): LazyPart<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => {
    pending ??= load()
      .then((component) => {
        loaded = component;
        return component;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };

  function Lazy(props: P) {
    const [component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    const [error, setError] = useState<unknown>(null);
    useEffect(() => {
      if (component) return;
      let alive = true;
      get().then(
        (next) => alive && setComponent(() => next),
        (failure) => alive && setError(failure ?? new Error("lazy part failed to load")),
      );
      return () => {
        alive = false;
      };
    }, [component]);
    if (error) throw error;
    const Ready = component ?? loaded;
    if (Ready) return <Ready {...props} />;
    return typeof fallback === "function" ? fallback(props) : fallback;
  }
  return Object.assign(Lazy, { preload: () => get().catch(() => {}) });
}