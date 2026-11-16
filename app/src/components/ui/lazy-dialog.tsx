import { type ComponentType, useState } from "react";
import { useExternalConnection } from "@/hooks";

/*
 * 用到才加载、打开过才挂载的弹窗（DESIGN.md §41.3）。
 *
 * 左栏每个机器人行、账号菜单都各自带着「删除机器人」「电脑操作」「绑定手机」「个人资料」这些弹窗。以前它们一直挂在树上
 * （关着也在渲染、也在跑查询），代码也跟着首屏一起下载（「电脑操作」还把整个设备页拖进了左栏的包）。现在：
 * - 代码在第一次打开（或菜单打开时 preload()）才下载；
 * - 第一次打开前不挂载；打开过以后一直挂着，关闭动画、表单状态和以前一样；
 * - 第一次挂载时先以 open=false 渲染一帧再打开，进场动画照常（不会「啪」地直接出现）。
 */
type DialogProps = { open: boolean };

export type LazyDialog<P extends DialogProps> = ComponentType<P> & { preload: () => void };

export function lazyDialog<P extends DialogProps>(load: () => Promise<ComponentType<P>>): LazyDialog<P> {
  // 不用 React.lazy + Suspense：哪怕代码早已预加载，lazy 第一次渲染也要挂起一次，Suspense 的重试节流让第一次打开晚 ~300ms。
  // 这里自己记住加载好的组件：已经到了就同步渲染，没到就等它到了再挂载。
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => {
    pending ??= load()
      .then((component) => {
        loaded = component;
        return component;
      })
      .catch((error) => {
        pending = null; // 下载失败（断网 / 发版后旧分包）：下次打开再试；过期分包由 lib/stale-chunk.ts 处理
        throw error;
      });
    return pending;
  };

  function Opening({ component: Loaded, ...props }: P & { component: ComponentType<P> }) {
    // 第一次挂载先以 open=false 渲染一帧再打开，进场动画照常。
    const [ready, setReady] = useState(false);
    useExternalConnection(!ready, () => {
      const frame = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(frame);
    });
    return <Loaded {...(props as unknown as P)} open={props.open && ready} />;
  }

  function Lazy(props: P) {
    const [mounted, setMounted] = useState(props.open);
    const [component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    if (props.open && !mounted) setMounted(true);
    useExternalConnection(mounted && !component, (_key, signal) => {
      get().then(
        (next) => {
          if (!signal.aborted) setComponent(() => next);
        },
        (error) => console.warn("[ChisaBot] 弹窗代码加载失败，下次打开再试", error),
      );
    });
    const ready = component ?? (mounted ? loaded : null);
    if (!mounted || !ready) return null;
    return <Opening {...props} component={ready} />;
  }
  return Object.assign(Lazy, { preload: () => void get().catch(() => {}) });
}
