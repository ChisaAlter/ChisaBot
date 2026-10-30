import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
import { useLayoutEffect, useRef } from "react";
import {
  ROSTER_ID,
  type ShellScope,
  ToggleTip,
} from "@/components/layout/glass-topbar";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const MOD_LABEL = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  ? "⌘B"
  : "Ctrl+B";

/**
 * 键盘用户按开关后，展开 / 收起两种状态下的开关是不同的按钮（左栏卡片右上角 ↔ 80px 列顶），
 * 旧按钮随状态切换被卸掉，焦点会掉到 body。点开关时先记一笔「要把焦点交给新开关」，
 * 切换后新出现（或状态变了）的那个开关在 layout effect 里把焦点接过去。
 */
let focusRequested = false;

/**
 * 左栏开关（Ctrl+B 是 primitive 自己的快捷键）：放在左栏卡片的右上角；收起成 80px 那列时放在列顶。
 * 和右栏「面板」开关一样长在自己那一栏上，不再单独放在顶栏（#374 回退）。手机上是抽屉，不画。
 */
export function RosterToggle({
  scope,
  className,
}: {
  scope: ShellScope;
  className?: string;
}) {
  const sidebar = useOptionalSidebar();
  const ref = useRef<HTMLButtonElement>(null);
  const open = sidebar?.open;
  // open 变了（切换刚发生）就重跑一次，看要不要接焦点。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!focusRequested || !el?.isConnected) return;
    if (el.closest('[hidden],[inert],[aria-hidden="true"]')) return;
    focusRequested = false;
    el.focus();
  }, [open]);
  if (!sidebar || sidebar.isMobile) return null;
  const what =
    scope === "app"
      ? "机器人列表"
      : scope === "settings"
        ? "设置分区"
        : "管理导航";
  const label = open ? `收起${what}` : `展开${what}`;
  const Icon = open
    ? IconLayoutSidebarLeftCollapse
    : IconLayoutSidebarLeftExpand;
  return (
    <ToggleTip keys={MOD_LABEL} label={label} side={open ? "bottom" : "right"}>
      <button
        aria-controls={ROSTER_ID}
        aria-expanded={open}
        aria-label={label}
        className={cn("glass-ghost-btn glass-roster-toggle", className)}
        onClick={() => {
          focusRequested = true;
          sidebar.toggleSidebar();
          // 没有开关接手（例如切换没有发生）就作废，免得之后 Ctrl+B 切换时抢焦点。
          setTimeout(() => {
            focusRequested = false;
          }, 0);
        }}
        ref={ref}
        type="button"
      >
        <Icon className="glass-ghost-btn-ico" key={open ? "open" : "closed"} />
      </button>
    </ToggleTip>
  );
}
