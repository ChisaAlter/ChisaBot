import {
  IconChevronRight,
  IconFolderPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useState } from "react";
import { AccountCard } from "@/components/layout/account-menu";
import { RailSidebar, RailSidebarEdge } from "@/components/layout/rail-sidebar";
import {
  type Sidebar,
  SidebarContent,
  useOptionalSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ccWorkspacesQueryOptions, cloudWorkspaceQueryOptions } from "@/lib/cloud-cc";
import { CcNewWorkspaceDialog } from "./cc-github-dialogs";
import { CcNodeCard, CcTree, filterCcTree, railCcWorkspaces } from "./cc-tree";

/**
 * 左栏的 Claude Code 视图（DESIGN.md §105）：搜索 → 工作区与会话 → 节点状态，账号卡在面板外面
 * （和机器人那边同一个位置、同一个尺寸；2026-10-21 用户要求切换时这些共享位置不能动）。
 *
 * 共享的外壳和机器人那边逐像素对齐：切换、面板、搜索框 + 新建按钮、账号卡都在同一位置；
 * 只有面板里的内容不同（这里是工作区树和节点状态）。搜索只过滤会话树，新建工作区收进搜索右边
 * 那颗＋，新会话用工作区那一行的「＋」（2026-10-21 去掉顶部那颗独立的「新建会话」大按钮，
 * 也去掉内置的「草稿」工作区）。「机器人｜Claude Code」切换在左栏顶部、两块内容共用（`LeftRail`）。
 */
export function CcSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const sidebar = useOptionalSidebar();
  const status = useQuery(cloudWorkspaceQueryOptions());
  const workspaces = useQuery(ccWorkspacesQueryOptions(!!status.data?.node));
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
  };
  const collapsed = Boolean(
    sidebar && !sidebar.isMobile && sidebar.state === "collapsed",
  );
  const list = railCcWorkspaces(workspaces.data ?? []);
  const visibleCount = filterCcTree(list, query).length;
  const nodeReady = !!status.data?.node;
  const dialog = newOpen ? (
    <CcNewWorkspaceDialog onOpenChange={setNewOpen} open={newOpen} />
  ) : null;

  if (collapsed)
    return (
      <RailSidebar collapsible="icon" variant="floating" {...props}>
        <nav aria-label="Claude Code" className="glass-mini cc-mini">
          <button
            aria-label="展开 Claude Code 列表"
            className="glass-mini-expand"
            onClick={() => sidebar?.setOpen(true)}
            title="展开 Claude Code 列表"
            type="button"
          >
            <IconChevronRight className="size-4" />
          </button>
        </nav>
        {dialog}
      </RailSidebar>
    );

  return (
    <RailSidebar collapsible="icon" variant="floating" {...props}>
      <SidebarContent className="glass-side-full gap-3 overflow-hidden">
        <div className="cc-rail">
          <div className="side-search-row">
            <label className="side-search">
              <IconSearch aria-hidden className="side-search-ico" />
              <input
                aria-label="搜索会话"
                className="side-search-input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话"
                value={query}
              />
              {query ? (
                <button
                  aria-label="清除搜索"
                  className="side-search-clear"
                  onClick={() => setQuery("")}
                  type="button"
                >
                  <IconX className="size-3.5" />
                </button>
              ) : null}
            </label>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="新建工作区"
                    className="glass-list-add"
                    data-testid="cc-new-ws"
                    disabled={!nodeReady}
                    onClick={() => setNewOpen(true)}
                    type="button"
                  />
                }
              >
                <IconFolderPlus className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6}>
                {"新建工作区"}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="cc-rail-mid">
            <div className="cc-tree-head">
              <span className="cc-section-label">{"工作区"}</span>
              <span className="cc-section-count">{visibleCount}</span>
            </div>
            <section
              aria-label="工作区和会话"
              className="cc-tree-scroll scroll-fade-b"
            >
              <CcTree onNavigate={close} query={query} />
            </section>
          </div>
          <div className="cc-rail-foot">
            <CcNodeCard onNavigate={close} />
          </div>
        </div>
        <AccountCard />
      </SidebarContent>
      <RailSidebarEdge />
      {dialog}
    </RailSidebar>
  );
}
