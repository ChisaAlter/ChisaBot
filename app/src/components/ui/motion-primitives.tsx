import type * as React from "react";
import { DURATION_MS, usePresenceMount } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * 纯 CSS `grid-template-rows: 0fr ↔ 1fr` + `opacity` 平滑折叠原语：
 * - 零 JS `offsetHeight` 同步布局测量，自动适应动态内容高度；
 * - 关闭态自动给内层挂 `inert` 与 `aria-hidden`，阻止键盘焦点落入不可见区域；
 * - 严禁在动画 `opacity` 层内包裹带 `backdrop-filter` 的玻璃面板（避免 Chromium Backdrop Root 阻断采样）。
 */
export function SmoothCollapse({
  open,
  className,
  innerClassName,
  unmountOnExit = false,
  exitMs = DURATION_MS.collapse,
  children,
}: {
  open: boolean;
  className?: string;
  innerClassName?: string;
  /** 关闭退场结束后卸载子树（适用于重型表单或含轮询的内容）。 */
  unmountOnExit?: boolean;
  exitMs?: number;
  children: React.ReactNode;
}) {
  const { mounted } = usePresenceMount(open, exitMs);
  const shouldRender = unmountOnExit ? mounted : true;

  return (
    <div
      className={cn("ch-collapse", className)}
      data-open={open ? "true" : "false"}
    >
      <div
        aria-hidden={!open || undefined}
        className={cn("ch-collapse-inner", innerClassName)}
        inert={!open}
      >
        {shouldRender ? children : null}
      </div>
    </div>
  );
}

/**
 * Backdrop-Root-Safe 轻量叶子内容淡入原语：
 * - 仅用于不含 `backdrop-filter` 后代的叶子内容（页头、纯文本、设置页非模糊卡片、面板内部正文、Tab 视图内容）；
 * - 严禁包裹 `.glass-shell` / `.page` / `.glass-side-full` 等玻璃祖先；
 * - 动画结束自然回归 `transform: none` 且无 `forwards` 残留合成层。
 */
export function ContentEnter({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("ch-content-enter", className)} {...props}>
      {children}
    </div>
  );
}
