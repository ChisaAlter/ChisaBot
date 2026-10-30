import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
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
  if (!sidebar || sidebar.isMobile) return null;
  const open = sidebar.open;
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
        onClick={sidebar.toggleSidebar}
        type="button"
      >
        <Icon className="glass-ghost-btn-ico" key={open ? "open" : "closed"} />
      </button>
    </ToggleTip>
  );
}
