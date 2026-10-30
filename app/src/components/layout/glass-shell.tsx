import { useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { KeptVisibleContext } from "@/lib/kept-visible";
import { GlassTopBar, type ShellScope } from "@/components/layout/glass-topbar";
import { PhoneGestures } from "@/components/layout/phone-gestures";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { TopBarOwnsSidebarToggle } from "@/components/layout/sidebar-toggle";
import { ShellBoundary } from "@/components/startup-status";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { requestSidebarSearchFocus } from "@/lib/sidebar-search";

/**
 * The one App Shell (DESIGN.md §9.1, DESIGN-v4): top bar (品牌文字 + 窗口按钮) + left column
 * (开关 · 搜索 → 机器人 / 分区 → 账号) + centre + optional right column (面板卡), for chat, settings and admin
 * alike. One viewport that never scrolls; panes scroll inside it. The left column is 276px,
 * collapsing to the 80px rail, and shares its open state (Ctrl+B) across all three. Page actions
 * live in each page's own header; nothing is portalled into the top bar any more.
 */
export function GlassShell({
  scope,
  sidebar,
  right,
  rightHidden = false,
  banner,
  children,
}: {
  scope: ShellScope;
  sidebar: ReactNode;
  right?: ReactNode;
  /** 右栏留着但不显示（设置 / 管理里），回到聊天时不重新挂载（DESIGN.md §98）。 */
  rightHidden?: boolean;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TopBarOwnsSidebarToggle.Provider value={true}>
      <SidebarShell className="glass-shell h-svh overflow-hidden" iconWidth="80px" width="276px">
        <GlassTopBar scope={scope} />
        <SearchHotkey scope={scope} />
        <DrawerCloser />
        <CloseDrawerOnScope scope={scope} />
        <PhoneGestures />
        {sidebar}
        <div className="glass-body relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-scope={scope}>
          <main className="glass-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {banner}
            <ShellBoundary>{children}</ShellBoundary>
          </main>
          {right ? (
            <div className={rightHidden ? "hidden" : "contents"} data-right-hidden={rightHidden ? "true" : undefined}>
              {/* 藏着的右栏不轮询、不放画面（DESIGN.md §98.3）。 */}
              <KeptVisibleContext.Provider value={!rightHidden}>{right}</KeptVisibleContext.Provider>
            </div>
          ) : null}
        </div>
      </SidebarShell>
    </TopBarOwnsSidebarToggle.Provider>
  );
}

/** 手机上新建机器人后抽屉自己收起，直接看到它的空聊天（成熟度扫查 F6；新建框挂在 _authed，够不着抽屉）。 */
const CLOSE_DRAWER_EVENT = "chisabot-close-drawer";
function DrawerCloser() {
  const sidebar = useOptionalSidebar();
  useEffect(() => {
    const close = () => {
      if (sidebar?.isMobile) sidebar.setOpenMobile(false);
    };
    window.addEventListener(CLOSE_DRAWER_EVENT, close);
    return () => window.removeEventListener(CLOSE_DRAWER_EVENT, close);
  }, [sidebar]);
  return null;
}

/** 地址属于外壳的哪一块（聊天 / 设置 / 管理）。 */
export function scopeOfPath(pathname: string): ShellScope {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  return "app";
}

/**
 * 外壳只有一个（DESIGN.md §98）：手机上抽屉的开关状态不再随外壳卸载而清掉。换区域（聊天 ↔ 设置 ↔ 管理）时
 * 收起抽屉，而且要在**导航开始前**收：新区域的左栏是另一个组件，它的抽屉如果以「开着」挂上、紧接着在 effect
 * 里关掉，退出动画永远不会开始，透明的抽屉就一直盖在页面上、点不动（2026-10-17 预览 390 实测）。
 */
function CloseDrawerOnScope({ scope }: { scope: ShellScope }) {
  const sidebar = useOptionalSidebar();
  const router = useRouter();
  const latest = useRef({ scope, sidebar });
  latest.current = { scope, sidebar };
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ toLocation }) => {
        const { scope: current, sidebar: bar } = latest.current;
        if (scopeOfPath(toLocation.pathname) === current) return;
        if (bar?.isMobile && bar.openMobile) bar.setOpenMobile(false);
      }),
    [router],
  );
  return null;
}

/**
 * Ctrl K / ⌘K：搜索会话在聊天左栏顶部。左栏收起就先展开，在设置 / 管理里就先回到聊天，
 * 然后把焦点交给搜索框（它挂载或收到请求时自己聚焦）。
 */
function SearchHotkey({ scope }: { scope: ShellScope }) {
  const sidebar = useOptionalSidebar();
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (scope !== "app") {
        requestSidebarSearchFocus();
        void navigate({ to: "/" });
        return;
      }
      if (sidebar?.isMobile) sidebar.setOpenMobile(true);
      else if (sidebar && !sidebar.open) sidebar.setOpen(true);
      requestSidebarSearchFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope, sidebar, navigate]);
  return null;
}
