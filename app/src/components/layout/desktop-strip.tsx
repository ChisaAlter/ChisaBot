import { WindowControls } from "@/components/layout/glass-topbar";
import { useDesktopWindow } from "@/lib/desktop-window";

/**
 * PC 无边框窗口里，没有应用外壳的页面（登录、机器人登录请求、新手引导）也要能拖动和关窗：
 * 顶部一条 44px 透明拖动带 + 右上角窗口控制。有顶栏的页面由顶栏负责，这条带用 CSS 隐藏。
 * 浏览器里不渲染。
 */
export function DesktopStrip() {
  const desktop = useDesktopWindow();
  if (!desktop) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 容器只代理指针 / 右键 / 双击事件，键盘入口在内部的链接和按钮上
    <div
      className="desk-strip"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        desktop.bridge.toggleMaximize();
      }}
    >
      <WindowControls bridge={desktop.bridge} compact={desktop.compact} maximized={desktop.maximized} />
    </div>
  );
}
