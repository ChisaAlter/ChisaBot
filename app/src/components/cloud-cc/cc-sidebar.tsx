import { IconChevronRight, IconFolderPlus, IconSearch, IconX } from "@tabler/icons-react";
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
import { ccWorkspacesQueryOptions, cloudWorkspaceQueryOptions } from "@/lib/cloud-cc";
import { CcNewWorkspaceDialog } from "./cc-github-dialogs";
import { CcNodeCard, CcTree, filterCcTree, railCcWorkspaces } from "./cc-tree";

/**
 * 左栏的 Claude Code 视图（DESIGN.md §105）：搜索 → 工作区与会话 → 节点状态 → 账号。
 *
 * 和 Claude Code 桌面端一样，左栏先回答「继续哪个会话」，工作区只是分组标题：搜索只过滤会话树，
 * 新建工作区收进「工作区」小节，新会话用工作区那一行的「＋」（2026-10-21 去掉顶部那颗独立的
 * 「新建会话」大按钮，也去掉内置的「草稿」工作区）。「机器人｜Claude Code」切换在左栏顶部、
 * 两块内容共用（`LeftRail`），这里不再有自己的开关，两边看到的是同一个控件。
 * 整块是一张玻璃面板，不再是散在天空上的几行字。
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
      <SidebarContent className="glass-side-full cc-rail">
        <div className="cc-rail-head">
          <search className="cc-rail-search">
            <IconSearch aria-hidden className="cc-rail-search-ic size-4" />
            <input
              aria-label="搜索会话"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              type="search"
              value={query}
            />
            {query ? (
              <button
                aria-label="清除搜索"
                className="cc-rail-search-x"
                onClick={() => setQuery("")}
                type="button"
              >
                <IconX className="size-3.5" />
              </button>
            ) : null}
          </search>
        </div>
        <div className="cc-rail-mid">
          <div className="cc-tree-head">
            <span className="cc-section-label">{"工作区"}</span>
            <span className="cc-section-count">{visibleCount}</span>
            <button
              aria-label="新建工作区"
              className="cc-section-add"
              data-testid="cc-new-ws"
              disabled={!nodeReady}
              onClick={() => setNewOpen(true)}
              title="新建工作区"
              type="button"
            >
              <IconFolderPlus className="size-4" />
            </button>
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
          <AccountCard />
        </div>
      </SidebarContent>
      <RailSidebarEdge />
      {dialog}
    </RailSidebar>
  );
}
