import { IconMenu2, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { BrandMark } from "@/components/layout/brand-mark";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canCompact, type DesktopWindowBridge, useDesktopWindow } from "@/lib/desktop-window";
import { PROTO_PREVIEW } from "@/lib/proto-preview";
import { requestSidebarSearchFocus } from "@/lib/sidebar-search";
import { cn } from "@/lib/utils";


export function initialsOf(name: string | null | undefined, email: string | undefined) {
  const trimmed = name?.trim();
  if (trimmed) {
    // A CJK name reads best as its first character; a Latin one as its initials.
    if (/^[\u3400-\u9fff]/.test(trimmed)) return trimmed.slice(0, 1);
    return trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("");
  }
  return email?.slice(0, 2).toUpperCase() ?? "?";
}

export function GlassAvatar({ size = 44, ring = true }: { size?: number; ring?: boolean }) {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <span
      className={cn("glass-avatar", ring && "glass-avatar-ring")}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {user?.image ? (
        <img alt="" className="glass-avatar-img" draggable={false} src={user.image} />
      ) : (
        initialsOf(user?.name, user?.email)
      )}
    </span>
  );
}

export type ShellScope = "app" | "settings" | "admin";

/**
 * 顶栏：电脑上只有左上角的品牌文字（ChisaBot）和 PC 无边框窗口的 — □ ✕。
 *
 * 身份只有左栏最底下的账号卡一个位置；搜索会话在左栏卡片顶部；左栏开关在左栏卡片右上角（收起时在 80px 列顶），
 * 和右栏「面板」开关在右栏上对称（#374 回退，DESIGN.md §9.1）。
 * 手机上不变：左 ☰ 打开抽屉 ｜ 右 搜索按钮（打开抽屉并聚焦抽屉顶部的搜索框）。
 */
export function GlassTopBar({ scope = "app" }: { scope?: ShellScope }) {
  const sidebar = useOptionalSidebar();
  const mobile = Boolean(sidebar?.isMobile);
  const desktop = useDesktopWindow();
  const drawerLabel = scope === "app" ? "机器人列表" : scope === "settings" ? "设置分区" : "管理导航";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 容器只代理指针 / 右键 / 双击事件，键盘入口在内部的链接和按钮上
    <header
      className="glass-topbar"
      data-scope={scope}
      // 左栏收起 / PC 标题按钮个数直接写在顶栏上，CSS 不用挂在整个外壳上的 :has()（流式输出时会触发整页样式重算）。
      data-sidebar={sidebar && !mobile ? sidebar.state : undefined}
      data-winctrls={desktop ? (canCompact(desktop.bridge) ? 4 : 3) : undefined}
      // PC 无边框窗口：空白处双击 = 最大化 / 还原（拖动由 -webkit-app-region 交给系统）。
      onDoubleClick={
        desktop
          ? (event) => {
              if ((event.target as HTMLElement).closest("a,button,input,label,[role=menu]")) return;
              desktop.bridge.toggleMaximize();
            }
          : undefined
      }
    >
      <div className="glass-topbar-start">
        {mobile ? (
          <button
            aria-label={`打开${drawerLabel}`}
            className="hk-circle glass is-flat"
            onClick={() => sidebar?.setOpenMobile(true)}
            type="button"
          >
            <IconMenu2 className="hk-circle-ico" />
          </button>
        ) : (
          <span className="glass-brand">
            <BrandMark avatar={false} />
          </span>
        )}
        {PROTO_PREVIEW && !mobile ? (
          <span className="proto-badge" title={"这是独立的原型沙箱，使用线上数据的副本；改动不会影响线上。"}>
            {"原型预览"}
          </span>
        ) : null}
      </div>
      <span aria-hidden className="glass-topbar-mid" />
      <div className="glass-topbar-end">{mobile ? <MobileSearchButton scope={scope} /> : null}</div>
      {desktop ? <WindowControls bridge={desktop.bridge} compact={desktop.compact} maximized={desktop.maximized} /> : null}
    </header>
  );
}

/** 手机顶栏右边的搜索按钮：打开左栏抽屉，聚焦抽屉顶部的搜索框（设置 / 管理里先回聊天）。 */
function MobileSearchButton({ scope }: { scope: ShellScope }) {
  const sidebar = useOptionalSidebar();
  const navigate = useNavigate();
  return (
    <button
      aria-label={"搜索会话"}
      className="hk-circle glass is-flat"
      onClick={() => {
        if (scope !== "app") {
          requestSidebarSearchFocus();
          void navigate({ to: "/" });
          return;
        }
        sidebar?.setOpenMobile(true);
        requestSidebarSearchFocus();
      }}
      type="button"
    >
      <IconSearch className="hk-circle-ico" />
    </button>
  );
}

const COMPACT_KEYS = /Mac/.test(navigator.userAgent) ? "⌘⇧M" : "Ctrl+Shift+M";

/**
 * PC 无边框窗口右上角：Windows 11 传统标题按钮（46×40，贴在窗口右上角，无胶囊底）；关闭悬停 #c42b1c 红底白字。
 * 最左边是「小窗模式 / 恢复窗口」（DESIGN.md §36，PC 客户端支持时才有）；小窗里四个按钮收窄到 36px。
 */
export function WindowControls({
  bridge,
  maximized,
  compact = false,
}: {
  bridge: DesktopWindowBridge;
  maximized: boolean;
  compact?: boolean;
}) {
  const compactLabel = compact ? "恢复窗口" : "小窗模式";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
    <div aria-label={"窗口"} className="win-ctrls" data-count={canCompact(bridge) ? 4 : 3} role="group">
      {canCompact(bridge) ? (
        <button
          aria-label={compactLabel}
          aria-pressed={compact}
          className="win-ctrl is-compact-toggle"
          onClick={() => bridge.toggleCompact?.()}
          title={`${compactLabel}（${COMPACT_KEYS}）`}
          type="button"
        >
          {compact ? (
            // 恢复窗口：一台横放的显示器。
            <svg aria-hidden fill="none" height="10" viewBox="0 0 10 10" width="10">
              <rect height="6" rx="1.2" stroke="currentColor" strokeWidth="1.1" width="8.4" x="0.8" y="0.9" />
              <path d="M3.2 9.1h3.6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" />
            </svg>
          ) : (
            // 小窗模式：一部竖放的手机。
            <svg aria-hidden fill="none" height="10" viewBox="0 0 10 10" width="10">
              <rect height="8.6" rx="1.4" stroke="currentColor" strokeWidth="1.1" width="5.6" x="2.2" y="0.7" />
              <path d="M4.3 7.4h1.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" />
            </svg>
          )}
        </button>
      ) : null}
      <button aria-label={"最小化"} className="win-ctrl" onClick={() => bridge.minimize()} title={"最小化"} type="button">
        <svg aria-hidden height="10" viewBox="0 0 10 10" width="10">
          <path d="M1 5.5h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        aria-label={maximized ? "还原" : "最大化"}
        className="win-ctrl"
        onClick={() => bridge.toggleMaximize()}
        title={maximized ? "还原" : "最大化"}
        type="button"
      >
        {maximized ? (
          <svg aria-hidden fill="none" height="10" viewBox="0 0 10 10" width="10">
            <rect height="6" rx="1.2" stroke="currentColor" strokeWidth="1.1" width="6" x="1" y="3" />
            <path d="M3.2 1.2h4.4c.7 0 1.2.5 1.2 1.2v4.4" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg aria-hidden fill="none" height="10" viewBox="0 0 10 10" width="10">
            <rect height="8" rx="1.6" stroke="currentColor" strokeWidth="1.1" width="8" x="1" y="1" />
          </svg>
        )}
      </button>
      <button aria-label={"关闭"} className="win-ctrl is-close" onClick={() => bridge.close()} title={"关闭"} type="button">
        <svg aria-hidden height="10" viewBox="0 0 10 10" width="10">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}

/** The roster element the toggle points its `aria-controls` at. */
export const ROSTER_ID = "chisabot-bot-list";
export const PANEL_RAIL_ID = "chisabot-panel-rail";

export function ToggleTip({
  label,
  keys,
  children,
  side = "bottom",
}: {
  label: string;
  keys?: string;
  children: ReactElement;
  side?: "bottom" | "left" | "right" | "top";
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} sideOffset={8}>
        {label}
        {keys ? <span className="text-background/60">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
