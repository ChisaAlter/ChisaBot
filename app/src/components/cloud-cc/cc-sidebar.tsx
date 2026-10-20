import {
  IconChevronRight,
  IconFolderPlus,
  IconPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { AccountCard } from "@/components/layout/account-menu";
import { RailSidebar, RailSidebarEdge } from "@/components/layout/rail-sidebar";
import { useAsyncAction } from "@/components/ui/async-action";
import {
  type Sidebar,
  SidebarContent,
  useOptionalSidebar,
} from "@/components/ui/sidebar";
import {
  ccApi,
  ccKeys,
  ccWorkspacesQueryOptions,
  cloudWorkspaceQueryOptions,
} from "@/lib/cloud-cc";
import { CcNewWorkspaceDialog } from "./cc-github-dialogs";
import {
  CcNodeCard,
  CcTree,
  filterCcTree,
  recentCcWorkspace,
} from "./cc-tree";
import { LeftModeSwitch } from "./left-mode-switch";

/**
 * 左栏的 Claude Code 视图（DESIGN.md §105）：模式切换 → 新建会话 / 搜索 → 工作区与会话 → 节点状态 → 账号。
 *
 * 和 Claude Code 桌面端一样，左栏先回答「继续哪个会话」，工作区只是分组标题：
 * 新建会话落在最近动过的工作区，搜索只过滤会话树，新建工作区收进「工作区」小节。
 * 整块是一张玻璃面板，不再是散在天空上的几行字。
 */
export function CcSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const sidebar = useOptionalSidebar();
  const status = useQuery(cloudWorkspaceQueryOptions());
  const workspaces = useQuery(ccWorkspacesQueryOptions(!!status.data?.node));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
  };
  const collapsed = Boolean(
    sidebar && !sidebar.isMobile && sidebar.state === "collapsed",
  );
  const list = workspaces.data ?? [];
  const visibleCount = filterCcTree(list, query).length;
  const recent = recentCcWorkspace(list);
  const nodeReady = !!status.data?.node;
  const create = useAsyncAction(
    async (workspaceId: string) => {
      const session = await ccApi.createSession(workspaceId);
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      close();
      await navigate({
        to: "/cc/$sessionId",
        params: { sessionId: session.id },
      });
    },
    { errorToast: (e) => `新建会话失败：${e.message}` },
  );
  const busy = create.state === "pending";
  const blocked = !nodeReady || busy || (list.length > 0 && !recent);
  const label = busy
    ? "正在新建…"
    : !nodeReady
      ? "新建会话"
      : list.length === 0
        ? "新建工作区"
        : recent
          ? "新建会话"
          : "工作区准备中…";
  const start = () => {
    if (recent) void create.run(recent.id);
    else if (nodeReady) setNewOpen(true);
  };
  const dialog = newOpen ? (
    <CcNewWorkspaceDialog onOpenChange={setNewOpen} open={newOpen} />
  ) : null;

  if (collapsed)
    return (
      <RailSidebar collapsible="icon" variant="floating" {...props}>
        <nav aria-label="Claude Code" className="glass-mini cc-mini">
          <button
            aria-label={label}
            className="glass-mini-new"
            disabled={blocked}
            onClick={start}
            title={recent ? `在「${recent.name}」里新建会话` : label}
            type="button"
          >
            <IconPlus className="size-5" />
          </button>
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
          <LeftModeSwitch mode="cc" />
          <button
            aria-label={recent ? `在「${recent.name}」里新建会话` : label}
            className="cc-new-session"
            data-testid="cc-new-session-top"
            disabled={blocked}
            onClick={start}
            title={
              recent
                ? `在「${recent.name}」里新建会话`
                : nodeReady
                  ? label
                  : "先连接云端工作区"
            }
            type="button"
          >
            <span aria-hidden className="cc-new-session-ic">
              <IconPlus className="size-4" />
            </span>
            <span className="cc-new-session-main">
              <span className="cc-new-session-t">{label}</span>
              {recent ? (
                <span className="cc-new-session-s">{recent.name}</span>
              ) : null}
            </span>
          </button>
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
