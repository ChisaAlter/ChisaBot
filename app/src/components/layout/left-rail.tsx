import { type ReactNode, useEffect, useReducer, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { LeftModeSwitch } from "@/components/cloud-cc/left-mode-switch";
import { InLeftRail } from "@/components/layout/rail-sidebar";
import { Sidebar, SidebarRail, useOptionalSidebar } from "@/components/ui/sidebar";
import { type LeftMode, loadCcSidebar, loadedCcSidebar } from "@/lib/left-mode";

/**
 * 机器人 / Claude Code 共用的左栏（DESIGN.md §84）。`Sidebar` 容器只挂一次；两块内容第一次用到时挂上，
 * 之后都留着（滚动位置、展开的工作区、搜索词都还在），只显示当前那块，换的时候交叉淡入（约 200ms，
 * 减少动态效果时直接换）。藏起来的那块 `inert`：点不到、Tab 不进去、读屏不读。
 * Claude Code 那块是单独的分包：还没取到时先留着原来那块（没有原来那块才画左栏骨架），取到再换。
 *
 * 「机器人｜Claude Code」只有一颗，放在两块内容**外面**（2026-10-21）：以前两边各画一颗，Claude Code
 * 那颗还缩在面板卡片里，尺寸和位置都跟机器人那边对不上；现在同一个控件、同一个位置，切换时也不跟着淡入。
 */
export function LeftRail({ mode, className }: { mode: LeftMode; className?: string }) {
  const [, loaded] = useReducer((n: number) => n + 1, 0);
  const [failed, setFailed] = useState(false);
  const sidebar = useOptionalSidebar();
  const CcSidebar = loadedCcSidebar();
  // 收成 80px 图标栏时两颗内容各自只剩图标（机器人头像 / 展开箭头），切换没有位置，藏起来。
  const collapsed = Boolean(sidebar && !sidebar.isMobile && sidebar.state === "collapsed");
  useEffect(() => {
    if (mode !== "cc" || loadedCcSidebar()) return;
    let live = true;
    loadCcSidebar().then(
      () => live && loaded(),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [mode]);

  return (
    <Sidebar className={className} collapsible="icon" variant="floating">
      <div className="left-rail-shell">
        {collapsed ? null : (
          <div className="left-rail-mode">
            <LeftModeSwitch mode={mode} />
          </div>
        )}
        <LeftRailPanes bots={<AppSidebar />} cc={CcSidebar ? <CcSidebar /> : null} ccFailed={failed} mode={mode} />
      </div>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * 两块内容的摆放（单独导出好测）：第一次用到才挂，之后留着；`cc` 为 null = 分包还没到。
 * 分包还在路上、而且机器人那块已经在：先别换，原来的画面留到新的能画为止。
 */
export function LeftRailPanes({ mode, bots, cc, ccFailed = false }: { mode: LeftMode; bots: ReactNode; cc: ReactNode | null; ccFailed?: boolean }) {
  const [mounted, setMounted] = useState<ReadonlySet<LeftMode>>(() => new Set([mode]));
  if (!mounted.has(mode)) setMounted(new Set([...mounted, mode]));
  const shown: LeftMode = mode === "cc" && !cc && !ccFailed && mounted.has("bots") ? "bots" : mode;
  const pane = (which: LeftMode, node: ReactNode) =>
    mounted.has(which) || which === mode ? (
      <div
        aria-hidden={which === shown ? undefined : true}
        className="left-rail-pane"
        data-active={which === shown ? "true" : "false"}
        data-pane={which}
        inert={which !== shown}
        key={which}
      >
        {node}
      </div>
    ) : null;
  return (
    <InLeftRail.Provider value={true}>
      <div className="left-rail-stack" data-mode={shown} data-testid="left-rail">
        {pane("bots", bots)}
        {pane("cc", cc ?? <RailSkeleton failed={ccFailed} />)}
      </div>
    </InLeftRail.Provider>
  );
}

/** 直接打开 `/cc` 而分包还没到时的左栏占位（DESIGN 第②级：局部骨架，不是整页加载）。 */
function RailSkeleton({ failed }: { failed: boolean }) {
  return (
    <div aria-busy={!failed} aria-label={failed ? "左栏没能加载" : "正在加载"} className="glass-side-full flex flex-1 flex-col gap-3 p-2" role="status">
      <span className="sky-skel-block" style={{ height: 40, borderRadius: 999 }} />
      <div className="sky-skel-card" style={{ flex: 1 }}>
        <span className="sky-skel-bar block" style={{ width: "40%", height: 10 }} />
        <span className="sky-skel-bar block" style={{ width: "85%", height: 12 }} />
        <span className="sky-skel-bar block" style={{ width: "70%", height: 12 }} />
      </div>
      {failed ? (
        <button className="glass-list-empty" onClick={() => window.location.reload()} type="button">
          {"左栏没能加载，点这里重新加载"}
        </button>
      ) : null}
    </div>
  );
}
