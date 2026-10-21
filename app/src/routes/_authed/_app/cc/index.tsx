import { IconCloudComputing, IconKey, IconLoader2, IconTerminal2 } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CcNodeCard, CcTree, railCcWorkspaces } from "@/components/cloud-cc/cc-tree";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { EmptyState, ErrorCard } from "@/components/ui/skyglass";
import { useClaudeAuthRecheck } from "@/lib/claude-auth-recheck";
import { ccWorkspacesQueryOptions, cloudWorkspaceQueryOptions, LAST_CC_SESSION_KEY } from "@/lib/cloud-cc";

export const Route = createFileRoute("/_authed/_app/cc/")({
  component: CcHome,
});

/**
 * /cc：桌面上直接打开最近的会话（没有就是空状态）；手机上这一页就是工作区列表（DESIGN.md §73.6）。
 * 没有节点 / 没登录 Claude 时是空状态卡，带按钮直接去 设置 → 云端工作区。
 */
function CcHome() {
  const sidebar = useOptionalSidebar();
  const phone = !!sidebar?.isMobile;
  const status = useQuery(cloudWorkspaceQueryOptions());
  // 缓存的登录状态可能过时（节点重连 / 检查后才刷新）：打开页面、回到窗口时后台复查（§73.5）。
  const { checking } = useClaudeAuthRecheck();
  const workspaces = useQuery(ccWorkspacesQueryOptions(!!status.data?.node));
  const navigate = useNavigate();
  const latest = railCcWorkspaces(workspaces.data ?? [])
    .flatMap((w) => w.sessions)
    .sort((a, b) => (b.lastTurnAt ?? b.createdAt).localeCompare(a.lastTurnAt ?? a.createdAt))[0];
  useEffect(() => {
    if (phone || !latest) return;
    void navigate({ to: "/cc/$sessionId", params: { sessionId: latest.id }, replace: true });
  }, [phone, latest, navigate]);
  useEffect(() => {
    try {
      localStorage.removeItem(LAST_CC_SESSION_KEY);
    } catch {}
  }, []);

  if (status.isPending) return <PageSkeleton rows={3} />;
  if (status.isError)
    return (
      <div className="cc-center">
        <ErrorCard action={<Button onClick={() => void status.refetch()} variant="outline">{"重试"}</Button>} description={status.error.message} title="读不到云端工作区" />
      </div>
    );
  const d = status.data;
  const gate = !d.node ? (
    <EmptyState
      action={
        <Button render={<Link to="/settings/cloud-workspace" />}>
          {"去设置"}
        </Button>
      }
      description="Claude Code 跑在服务器上一个独立的容器里（云端工作区）。先把它部署并配对好。"
      icon={<IconCloudComputing className="size-6" />}
      title="先连接云端工作区"
    />
  ) : !d.claude.loggedIn && checking ? (
    <EmptyState
      description="正在向云端工作区确认登录状态。"
      icon={<IconLoader2 className="size-6 motion-safe:animate-spin" />}
      title="正在确认 Claude 登录…"
    />
  ) : !d.claude.loggedIn ? (
    <EmptyState
      action={
        <Button data-testid="cc-goto-login" render={<Link to="/settings/cloud-workspace" />}>
          {"登录 Claude"}
        </Button>
      }
      description="用你的 Claude 订阅登录一次（打开授权页，复制授权码，粘回来）。"
      icon={<IconKey className="size-6" />}
      title="登录 Claude"
    />
  ) : null;

  if (phone)
    return (
      <div className="cc-phone-home page-scroll min-h-0 flex-1 overflow-y-auto" data-testid="cc-phone-home">
        {gate ?? (
          <>
            <CcTree variant="page" />
            <CcNodeCard />
          </>
        )}
      </div>
    );
  return (
    <div className="cc-center" data-testid="cc-home">
      {gate ?? (
        <EmptyState
          description="在左边某个工作区下面点「＋」，Claude Code 就会在云端写代码。还没有工作区就先点「工作区」右边的 + 建一个。每个会话有自己的目录，隔天回来接着说。"
          icon={<IconTerminal2 className="size-6" />}
          title={workspaces.isPending ? "正在读取工作区…" : "选一个会话，或者新建一个"}
        />
      )}
    </div>
  );
}
