import {
  IconAlertTriangle,
  IconArchive,
  IconBrandGithub,
  IconChevronRight,
  IconDeviceDesktop,
  IconDots,
  IconFolder,
  IconFolderPlus,
  IconLoader2,
  IconPencil,
  IconPin,
  IconPinFilled,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { confirmDialog } from "@/components/ui/confirm";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useClaudeAuthRecheck } from "@/lib/claude-auth-recheck";
import {
  ccApi,
  ccKeys,
  ccWorkspacesQueryOptions,
  cloudWorkspaceQueryOptions,
} from "@/lib/cloud-cc";
import { pcSyncBridge } from "@/lib/pc-bridge";
import { cn } from "@/lib/utils";
import type {
  CcSessionView,
  CcWorkspaceView,
} from "../../../../shared/cloud-cc";
import { CcNewWorkspaceDialog } from "./cc-github-dialogs";
import { CcSyncDialog } from "./cc-sync";

export const CC_PINNED_KEY = "chisabot-cc-pinned";

/** 置顶是这台机器上的浏览偏好，不进服务器（DESIGN.md §105.1）。 */
export function parsePinnedSessions(raw: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function togglePinnedSession(
  pinned: ReadonlySet<string>,
  sessionId: string,
): Set<string> {
  const next = new Set(pinned);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  return next;
}

/** 置顶的排前面；其余保持服务器给的顺序（sort 在现代 JS 里是稳定的）。 */
export function sortPinnedSessions(
  sessions: readonly CcSessionView[],
  pinned: ReadonlySet<string>,
): CcSessionView[] {
  return [...sessions].sort(
    (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)),
  );
}

/**
 * 搜索工作区 / 会话（DESIGN.md §105.1）。命中工作区名时保留它全部会话；否则只留标题命中的会话。
 * 纯函数，方便单测。
 */
export function filterCcTree(
  workspaces: readonly CcWorkspaceView[],
  query: string,
): { ws: CcWorkspaceView; sessions: CcSessionView[] }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return workspaces.map((ws) => ({ ws, sessions: ws.sessions }));
  return workspaces
    .map((ws) => {
      const groupHit = [ws.name, ws.repoFullName ?? "", ws.sourceLabel]
        .join(" ")
        .toLowerCase()
        .includes(needle);
      const sessions = groupHit
        ? ws.sessions
        : ws.sessions.filter((s) =>
            (s.title || "新会话").toLowerCase().includes(needle),
          );
      return { ws, sessions, groupHit };
    })
    .filter((g) => g.groupHit || g.sessions.length > 0)
    .map(({ ws, sessions }) => ({ ws, sessions }));
}

/** 最近动过的工作区：新建会话默认落在这里（DESIGN.md §105.1）。 */
export function recentCcWorkspace(
  workspaces: readonly CcWorkspaceView[],
): CcWorkspaceView | null {
  let best: CcWorkspaceView | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const ws of workspaces) {
    if (ws.cloneState !== "ready") continue;
    const at = ws.sessions.reduce(
      (max, s) => Math.max(max, Date.parse(s.lastTurnAt ?? s.createdAt) || 0),
      0,
    );
    if (at > bestAt || (at === bestAt && best === null)) {
      best = ws;
      bestAt = at;
    }
  }
  return best;
}

/**
 * 工作区 → 会话的树（左栏 Claude Code 视图，手机上整页）。工作区是分组标题，右上角「＋ / ⋯」；
 * 会话只有标题，悬停才露置顶 / 归档，右键是重命名 / 置顶 / 归档菜单。页面版仍保留底部「新建工作区」。
 */
export function CcTree({
  onNavigate,
  variant = "rail",
  query = "",
}: {
  onNavigate?: () => void;
  variant?: "rail" | "page";
  /** 左栏搜索框里的词；手机上不传。 */
  query?: string;
}) {
  const status = useQuery(cloudWorkspaceQueryOptions());
  const workspaces = useQuery(ccWorkspacesQueryOptions(!!status.data?.node));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [syncWs, setSyncWs] = useState<CcWorkspaceView | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => {
    try {
      return parsePinnedSessions(localStorage.getItem(CC_PINNED_KEY));
    } catch {
      return new Set<string>();
    }
  });
  const params = useParams({ strict: false }) as { sessionId?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const renameRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(CC_PINNED_KEY, JSON.stringify([...pinned]));
    } catch {}
  }, [pinned]);
  useEffect(() => {
    if (!renamingId) return;
    const timer = window.setTimeout(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [renamingId]);
  const create = useAsyncAction(
    async (workspaceId: string) => {
      const session = await ccApi.createSession(workspaceId);
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      onNavigate?.();
      await navigate({
        to: "/cc/$sessionId",
        params: { sessionId: session.id },
      });
    },
    { errorToast: (e) => `新建会话失败：${e.message}` },
  );
  const createIn = async (workspaceId: string) => {
    setCreatingId(workspaceId);
    try {
      await create.run(workspaceId);
    } finally {
      setCreatingId(null);
    }
  };
  const togglePin = (sessionId: string) => {
    setPinned((current) => togglePinnedSession(current, sessionId));
  };
  const startRename = (session: CcSessionView) => {
    cancelRenameRef.current = false;
    setRenamingId(session.id);
    setDraftTitle(session.title || "");
  };
  const commitRename = async () => {
    const sessionId = renamingId;
    if (!sessionId) return;
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenamingId(null);
      setDraftTitle("");
      return;
    }
    const title = draftTitle.trim();
    setRenamingId(null);
    setDraftTitle("");
    const current = workspaces.data
      ?.flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === sessionId);
    if (!title || !current || current.title === title) return;
    try {
      await ccApi.patchSession(sessionId, { title });
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const archiveSession = async (
    sessionId: string,
    title: string,
    mode: "archive" | "delete" = "archive",
  ) => {
    const removing = mode === "delete";
    const ok = await confirmDialog({
      title: `${removing ? "删除" : "归档"}会话「${title || "未命名"}」？`,
      description: removing
        ? "从左栏移走；服务器上的会话记录会归档保留。这里暂时没有撤销入口。"
        : "从左栏移走，目录和记录都保留。这里暂时没有撤销入口。",
      confirmLabel: removing ? "删除" : "归档",
      destructive: removing,
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
          description:
            "云端的工作目录、所有会话的工作树和没推送的 cc/ 分支都会删掉，GitHub 上的仓库不受影响。会话记录归档保留。这一步不能撤销。",
          confirmLabel: "删除",
          destructive: true,
        });
        if (!ok) return;
        await ccApi.deleteWorkspace(ws.id);
        if (ws.sessions.some((s) => s.id === params.sessionId))
          void navigate({ to: "/cc" });
      }
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  if (!status.data?.node) return null;
  if (workspaces.isPending) return <div className="cc-tree-skel" aria-busy />;
  if (workspaces.isError)
    return <div className="cc-tree-err">{workspaces.error.message}</div>;
  const groups = filterCcTree(workspaces.data, query);
  const searching = query.trim().length > 0;
  return (
    <div
      className={cn("cc-tree", variant === "page" && "is-page")}
      data-testid="cc-tree"
    >
      {variant === "page" ? (
        <div className="cc-tree-page-head">
          <span className="cc-section-label">{"工作区"}</span>
          <span className="cc-section-count">{workspaces.data.length}</span>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="cc-tree-empty">
          {searching ? `没有找到「${query.trim()}」` : "还没有工作区"}
        </p>
      ) : null}
      {groups.map(({ ws, sessions }) => {
        const open = !closed.has(ws.id) || searching;
        const hasActive = ws.sessions.some((s) => s.id === params.sessionId);
        const orderedSessions = sortPinnedSessions(sessions, pinned);
        return (
          <section
            className={cn("cc-ws", hasActive && "is-active")}
            data-open={open ? "" : undefined}
            key={ws.id}
          >
            <button
              aria-expanded={open}
              className="cc-ws-head"
              onClick={() =>
                setClosed((c) =>
                  c.has(ws.id)
                    ? new Set([...c].filter((x) => x !== ws.id))
                    : new Set([...c, ws.id]),
                )
              }
              type="button"
            >
              <IconChevronRight className="cc-ws-caret size-3.5" />
              {ws.source === "github" ? (
                <IconBrandGithub
                  aria-hidden
                  className="size-3.5 flex-none opacity-60"
                />
              ) : ws.source === "local" ? (
                <IconFolder
                  aria-hidden
                  className="size-3.5 flex-none opacity-60"
                />
              ) : null}
              <span className="cc-ws-name">{ws.name}</span>
              {ws.cloneState === "cloning" ? (
                <span
                  aria-label="克隆中"
                  className="cc-ws-spin"
                  data-testid="cc-ws-cloning"
                  role="status"
                >
                  <IconLoader2 className="size-3.5 animate-spin" />
                </span>
              ) : null}
            </button>
            <div className="cc-ws-actions">
              {ws.cloneState === "ready" ? (
                <button
                  aria-label={`在「${ws.name}」里新建会话`}
                  className="cc-ws-add"
                  data-testid="cc-new-session"
                  disabled={create.state === "pending"}
                  onClick={() => void createIn(ws.id)}
                  title={`在「${ws.name}」里新建会话`}
                  type="button"
                >
                  {creatingId === ws.id ? (
                    <IconLoader2 className="size-4 animate-spin" />
                  ) : (
                    <IconPlus className="size-4" />
                  )}
                </button>
              ) : null}
              {ws.source !== "scratch" ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        aria-label={`工作区「${ws.name}」的更多操作`}
                        className="cc-ws-more"
                        data-testid="cc-ws-menu"
                        type="button"
                      />
                    }
                  >
                    <IconDots className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      data-testid="cc-ws-sync"
                      disabled={ws.cloneState !== "ready"}
                      onClick={() => setSyncWs(ws)}
                    >
                      <IconDeviceDesktop className="size-4" />
                      {"电脑同步"}
                    </DropdownMenuItem>
                    {ws.cloneState === "error" ? (
                      <DropdownMenuItem
                        onClick={() => void wsAction(ws, "retry")}
                      >
                        <IconRefresh className="size-4" />
                        {"重试克隆"}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      data-testid="cc-ws-delete"
                      disabled={ws.cloneState === "cloning"}
                      onClick={() => void wsAction(ws, "delete")}
                      variant="destructive"
                    >
                      <IconTrash className="size-4" />
                      {"删除工作区"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            {ws.cloneState === "error" && ws.cloneError ? (
              <div className="cc-ws-err" role="alert">
                <IconAlertTriangle className="size-3.5 flex-none" />
                <span>{ws.cloneError}</span>
                <button
                  className="cc-ws-retry"
                  data-testid="cc-ws-retry"
                  onClick={() => void wsAction(ws, "retry")}
                  type="button"
                >
                  {"重试"}
                </button>
              </div>
            ) : null}
            <div
              className="cc-ws-fold"
              inert={!open || ws.cloneState !== "ready"}
            >
              <div className="cc-ws-fold-in">
                {sessions.length === 0 && searching ? (
                  <p className="cc-ws-empty">{"没有匹配的会话"}</p>
                ) : null}
                {orderedSessions.map((s) => {
                  const active = params.sessionId === s.id;
                  const isPinned = pinned.has(s.id);
                  return (
                    <ContextMenu key={s.id}>
                      <ContextMenuTrigger
                        className={cn(
                          "cc-sess-row",
                          active && "is-active",
                          renamingId === s.id && "is-renaming",
                        )}
                        data-testid="cc-session-row"
                      >
                        {renamingId === s.id ? (
                          <input
                            aria-label="会话名称"
                            className="cc-sess-rename"
                            onBlur={() => void commitRename()}
                            onChange={(e) => setDraftTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelRenameRef.current = true;
                                e.currentTarget.blur();
                              }
                            }}
                            ref={renameRef}
                            value={draftTitle}
                          />
                        ) : (
                          <>
                            <Link
                              aria-current={active ? "page" : undefined}
                              className={cn("cc-sess", active && "is-active")}
                              data-status={s.status}
                              onClick={() => onNavigate?.()}
                              params={{ sessionId: s.id }}
                              to="/cc/$sessionId"
                            >
                              <span className="cc-sess-title">
                                {s.title || "新会话"}
                              </span>
                            </Link>
                            <span className="cc-sess-actions">
                              <button
                                aria-label={isPinned ? "取消置顶" : "置顶"}
                                className={cn(
                                  "cc-sess-act",
                                  isPinned && "is-pinned",
                                )}
                                data-testid="cc-session-pin"
                                onClick={() => togglePin(s.id)}
                                title={isPinned ? "取消置顶" : "置顶"}
                                type="button"
                              >
                                {isPinned ? (
                                  <IconPinFilled className="size-3.5" />
                                ) : (
                                  <IconPin className="size-3.5" />
                                )}
                              </button>
                              <button
                                aria-label="归档会话"
                                className="cc-sess-act"
                                data-testid="cc-session-archive"
                                onClick={() => void archiveSession(s.id, s.title)}
                                title="归档"
                                type="button"
                              >
                                <IconArchive className="size-3.5" />
                              </button>
                            </span>
                          </>
                        )}
                      </ContextMenuTrigger>
                      <ContextMenuContent className="cc-sess-menu">
                        <ContextMenuItem
                          data-testid="cc-session-rename"
                          onClick={() => startRename(s)}
                        >
                          <IconPencil className="size-4" />
                          {"重命名"}
                        </ContextMenuItem>
                        <ContextMenuItem
                          data-testid="cc-session-pin-menu"
                          onClick={() => togglePin(s.id)}
                        >
                          {isPinned ? (
                            <IconPinFilled className="size-4" />
                          ) : (
                            <IconPin className="size-4" />
                          )}
                          {isPinned ? "取消置顶" : "置顶"}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          data-testid="cc-session-delete-menu"
                          onClick={() =>
                            void archiveSession(s.id, s.title, "delete")
                          }
                          variant="destructive"
                        >
                          <IconTrash className="size-4" />
                          {"删除…"}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
      {variant === "page" ? (
        <>
          <button
            className="cc-new-ws"
            data-testid="cc-new-ws"
            onClick={() => setNewOpen(true)}
            type="button"
          >
            <IconFolderPlus className="size-4" />
            {"新建工作区"}
            <span className="cc-new-ws-s">
              {pcSyncBridge() ? "GitHub · 电脑" : "从 GitHub"}
            </span>
          </button>
          <CcNewWorkspaceDialog onOpenChange={setNewOpen} open={newOpen} />
        </>
      ) : null}
      {syncWs ? (
        <CcSyncDialog
          onOpenChange={(o) => !o && setSyncWs(null)}
          open
          ws={workspaces.data.find((w) => w.id === syncWs.id) ?? syncWs}
        />
      ) : null}
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
    <Link
      className="cc-node-card"
      data-testid="cc-node-card"
      onClick={() => onNavigate?.()}
      title={d.node ? `云端工作区 · ${online ? "在线" : "离线"} · ${plan}` : "去设置里连接云端工作区"}
      to="/settings/cloud-workspace"
    >
      <i
        aria-hidden
        className={cn("cc-node-dot", online ? "is-on" : "is-off")}
      />
      <span className="min-w-0 flex-1">
        <span className="cc-node-t">
          {d.node
            ? `云端工作区 · ${online ? "在线" : "离线"}`
            : "还没有云端工作区"}
        </span>
        <span className="cc-node-s">
          {d.node
            ? `${plan} · ${d.running}/${d.maxConcurrent} 运行中`
            : "去设置里看怎么连接"}
        </span>
      </span>
      <IconSettings aria-label="设置" className="size-4 flex-none opacity-60" />
    </Link>
  );
}
