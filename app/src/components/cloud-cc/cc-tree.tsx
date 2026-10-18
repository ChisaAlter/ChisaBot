import { IconAlertTriangle, IconBrandGithub, IconChevronRight, IconDeviceDesktop, IconDots, IconFolder, IconFolderPlus, IconLoader2, IconPlus, IconRefresh, IconSettings, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { type CcSessionStatus, type CcWorkspaceView, SYNC_STATE_ZH } from "../../../../shared/cloud-cc";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { CcNewWorkspaceDialog } from "./cc-github-dialogs";
import { CcSyncDialog } from "./cc-sync";
import { pcSyncBridge } from "@/lib/pc-bridge";
import { useClaudeAuthRecheck } from "@/lib/claude-auth-recheck";
import { ccApi, ccKeys, ccWorkspacesQueryOptions, cloudWorkspaceQueryOptions } from "@/lib/cloud-cc";
import { cn } from "@/lib/utils";

const STATUS_ZH: Record<CcSessionStatus, string> = { idle: "", running: "运行中", waiting: "等你批准", error: "出错" };

/** 同步状态小药丸（DESIGN.md §73.5 / §73.9）。对话头里用可以点的 CcSyncPillButton（cc-sync.tsx）。 */
export function SyncPill({ state }: { state: CcWorkspaceView["syncState"] }) {
  const tone = state === "pc_active" ? "is-ok" : state === "syncing" ? "is-info" : state === "paused" ? "is-warn" : state === "conflict" ? "is-danger" : "";
  return (
    <span className={cn("cc-pill cc-sync-pill", tone)} data-state={state}>
      <i aria-hidden className="cc-dot" />
      <T>{SYNC_STATE_ZH[state]}</T>
    </span>
  );
}

/**
 * 工作区 → 会话的树（左栏 Claude Code 视图，手机上整页）。DESIGN.md §73.2：工作区一行（三角 · 名称 · 同步药丸 · 来源），
 * 展开是会话（状态点：蓝 = 运行中，黄 = 等你批准，灰 = 空闲 · 标题 · 分支 · 状态字），最后「＋新会话」。
 */
export function CcTree({ onNavigate, variant = "rail" }: { onNavigate?: () => void; variant?: "rail" | "page" }) {
  const status = useQuery(cloudWorkspaceQueryOptions());
  const workspaces = useQuery(ccWorkspacesQueryOptions(!!status.data?.node));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [syncWs, setSyncWs] = useState<CcWorkspaceView | null>(null);
  const params = useParams({ strict: false }) as { sessionId?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useAsyncAction(
    async (workspaceId: string) => {
      const session = await ccApi.createSession(workspaceId);
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      onNavigate?.();
      await navigate({ to: "/cc/$sessionId", params: { sessionId: session.id } });
    },
    { errorToast: (e) => `新建会话失败：${e.message}` },
  );
  const archiveSession = async (sessionId: string, title: string) => {
    const ok = await confirmDialog({
      title: `删除会话「${title || "未命名"}」？`,
      description: "会话从列表里去掉；记录归档保留。这一步不能撤销。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await ccApi.archiveSession(sessionId);
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      if (params.sessionId === sessionId) void navigate({ to: "/cc" });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const wsAction = async (ws: CcWorkspaceView, action: "retry" | "delete") => {
    try {
      if (action === "retry") await ccApi.retryClone(ws.id);
      else {
        const ok = await confirmDialog({
          title: `删除工作区「${ws.name}」？`,
          description: "云端的工作目录、所有会话的工作树和没推送的 cc/ 分支都会删掉，GitHub 上的仓库不受影响。会话记录归档保留。这一步不能撤销。",
          confirmLabel: "删除",
          destructive: true,
        });
        if (!ok) return;
        await ccApi.deleteWorkspace(ws.id);
        if (ws.sessions.some((s) => s.id === params.sessionId)) void navigate({ to: "/cc" });
      }
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  if (!status.data?.node) return null;
  if (workspaces.isPending) return <div className="cc-tree-skel" aria-busy />;
  if (workspaces.isError) return <div className="cc-tree-err">{workspaces.error.message}</div>;
  return (
    <div className={cn("cc-tree", variant === "page" && "is-page")} data-testid="cc-tree">
      {workspaces.data.map((ws) => {
        const open = !closed.has(ws.id);
        return (
          <section className="cc-ws" data-open={open ? "" : undefined} key={ws.id}>
            <button
              aria-expanded={open}
              className="cc-ws-head"
              onClick={() => setClosed((c) => (c.has(ws.id) ? new Set([...c].filter((x) => x !== ws.id)) : new Set([...c, ws.id])))}
              type="button"
            >
              <IconChevronRight className="cc-ws-caret size-3.5" />
              {ws.source === "github" ? <IconBrandGithub aria-hidden className="size-3.5 flex-none opacity-60" /> : ws.source === "local" ? <IconFolder aria-hidden className="size-3.5 flex-none opacity-60" /> : null}
              <span className="cc-ws-name">{ws.name}</span>
              {ws.cloneState === "cloning" ? (
                <span className="cc-pill is-info" data-testid="cc-ws-cloning">
                  <IconLoader2 className="size-3 animate-spin" />
                  {"克隆中"}
                </span>
              ) : ws.cloneState === "error" ? (
                <span className="cc-pill is-danger"><T>{"克隆失败"}</T></span>
              ) : (
                <SyncPill state={ws.syncState} />
              )}
            </button>
            {ws.source !== "scratch" ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<button aria-label={`工作区「${ws.name}」的更多操作`} className="cc-ws-more" data-testid="cc-ws-menu" type="button" />}>
                  <IconDots className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-testid="cc-ws-sync" disabled={ws.cloneState !== "ready"} onClick={() => setSyncWs(ws)}>
                    <IconDeviceDesktop className="size-4" />
                    {"电脑同步"}
                  </DropdownMenuItem>
                  {ws.cloneState === "error" ? (
                    <DropdownMenuItem onClick={() => void wsAction(ws, "retry")}>
                      <IconRefresh className="size-4" />
                      {"重试克隆"}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem data-testid="cc-ws-delete" disabled={ws.cloneState === "cloning"} onClick={() => void wsAction(ws, "delete")} variant="destructive">
                    <IconTrash className="size-4" />
                    {"删除工作区"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <div className="cc-ws-src">{ws.sourceLabel}{ws.source === "github" && ws.defaultBranch ? ` · ${ws.defaultBranch}` : ""}</div>
            {ws.cloneState === "error" && ws.cloneError ? (
              <div className="cc-ws-err" role="alert">
                <IconAlertTriangle className="size-3.5 flex-none" />
                <span>{ws.cloneError}</span>
                <button className="cc-ws-retry" data-testid="cc-ws-retry" onClick={() => void wsAction(ws, "retry")} type="button">
                  {"重试"}
                </button>
              </div>
            ) : null}
            <div className="cc-ws-fold" inert={!open || ws.cloneState !== "ready"}>
              <div className="cc-ws-fold-in">
                {ws.sessions.map((s) => (
                  <div className={cn("cc-sess-row", params.sessionId === s.id && "is-active")} data-testid="cc-session-row" key={s.id}>
                    <Link
                      className={cn("cc-sess", params.sessionId === s.id && "is-active")}
                      data-status={s.status}
                      onClick={() => onNavigate?.()}
                      params={{ sessionId: s.id }}
                      to="/cc/$sessionId"
                    >
                      <i aria-hidden className="cc-sess-dot" />
                      <span className="cc-sess-main">
                        <span className="cc-sess-title">{s.title || "新会话"}</span>
                        <span className="cc-sess-sub">{s.branch ?? (ws.source === "scratch" ? "自己的目录" : "")}</span>
                      </span>
                      {s.turns === 0 && s.status === "idle" ? (
                        <span className="cc-sess-state is-empty-draft">{"空草稿"}</span>
                      ) : STATUS_ZH[s.status] ? (
                        <span className="cc-sess-state">{STATUS_ZH[s.status]}</span>
                      ) : null}
                    </Link>
                    <button
                      aria-label={`删除会话「${s.title || "新会话"}」`}
                      className="cc-sess-del"
                      data-testid="cc-session-delete"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void archiveSession(s.id, s.title);
                      }}
                      type="button"
                    >
                      <IconTrash className="size-3.5" />
                    </button>
                  </div>
                ))}
                {ws.cloneState !== "ready" ? null : <Button
                  className="cc-new-sess"
                  data-testid="cc-new-session"
                  feedback={{ pending: "新建中…", success: "已新建", error: "没有建成" }}
                  onClick={() => void create.run(ws.id)}
                  size="sm"
                  state={create.state}
                  variant="ghost"
                >
                  <IconPlus className="size-3.5" />
                  {"新会话"}
                </Button>}
              </div>
            </div>
          </section>
        );
      })}
      <button className="cc-new-ws" data-testid="cc-new-ws" onClick={() => setNewOpen(true)} type="button">
        <IconFolderPlus className="size-4" />
        {"新建工作区"}
        <span className="cc-new-ws-s">{pcSyncBridge() ? "GitHub · 电脑" : "从 GitHub"}</span>
      </button>
      <CcNewWorkspaceDialog onOpenChange={setNewOpen} open={newOpen} />
      {syncWs ? <CcSyncDialog onOpenChange={(o) => !o && setSyncWs(null)} open ws={workspaces.data.find((w) => w.id === syncWs.id) ?? syncWs} /> : null}
    </div>
  );
}

/** 左栏底部的节点状态卡：「云端工作区 · 在线 · Claude Pro · 正在运行 1 / 2」。 */
export function CcNodeCard({ onNavigate }: { onNavigate?: () => void }) {
  const status = useQuery(cloudWorkspaceQueryOptions());
  // 会话页也挂着这张卡：缓存的「未登录」可能过时，在这里后台复查（§73.2）。
  const { checking } = useClaudeAuthRecheck();
  const d = status.data;
  if (!d) return null;
  const online = !!d.node?.online;
  const plan = d.claude.plan
    ? `Claude ${d.claude.plan.charAt(0).toUpperCase()}${d.claude.plan.slice(1)}`
    : d.claude.loggedIn
      ? "Claude 已登录"
      : checking
        ? "正在确认 Claude 登录…"
        : "Claude 未登录";
  return (
    <Link className="cc-node-card" data-testid="cc-node-card" onClick={() => onNavigate?.()} to="/settings/cloud-workspace">
      <i aria-hidden className={cn("cc-node-dot", online ? "is-on" : "is-off")} />
      <span className="min-w-0 flex-1">
        <span className="cc-node-t">{d.node ? `云端工作区 · ${online ? "在线" : "离线"}` : "还没有云端工作区"}</span>
        <span className="cc-node-s">{d.node ? `${plan} · 正在运行 ${d.running} / ${d.maxConcurrent}` : "去设置里看怎么连接"}</span>
      </span>
      <IconSettings aria-label="设置" className="size-4 flex-none opacity-60" />
    </Link>
  );
}
