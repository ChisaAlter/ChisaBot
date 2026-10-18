import { queryOptions } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  CcGithubRepo,
  CcGithubStatus,
  CcGitState,
  CcPushPreview,
  CcLoginStart,
  CcMessage,
  CcSessionStatus,
  CcSessionView,
  CcStreamOp,
  CcTreeEntry,
  CcWorkspaceView,
  ClaudeAuth,
  CloudWorkspaceView,
  CcSyncView,
} from "../../../shared/cloud-cc";
import { client } from "@/lib/client";

/** 云端 Claude Code（docs/cloud-claude-code.md，DESIGN.md §73）。 */
/** 右栏看哪一份：会话目录，或 GitHub 工作区的工作目录 work/（P3）。 */
export type CcRef = "session" | "work";
export const ccKeys = {
  status: ["cloud-workspace"] as const,
  workspaces: ["claude-code", "workspaces"] as const,
  session: (id: string) => ["claude-code", "session", id] as const,
  files: (id: string, path: string, ref: CcRef = "session") => ["claude-code", "files", id, path, ref] as const,
  file: (id: string, path: string, ref: CcRef = "session") => ["claude-code", "file", id, path, ref] as const,
  diff: (id: string, turn: string | null, mode: "turn" | "base" = "turn") => ["claude-code", "diff", id, mode === "base" ? "base" : (turn ?? "last")] as const,
  github: ["claude-code", "github"] as const,
  repos: ["claude-code", "github", "repos"] as const,
  push: (id: string) => ["claude-code", "push", id] as const,
  rules: ["cloud-workspace", "rules"] as const,
};

export function ccSyncQueryOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: ["claude-code", "sync", workspaceId] as const,
    queryFn: () => ccApi.syncView(workspaceId),
    enabled,
    refetchInterval: 5000,
  });
}

export function cloudWorkspaceQueryOptions() {
  return queryOptions({
    queryKey: ccKeys.status,
    queryFn: ({ signal }) => client("/api/cloud-workspace", { fallback: "读不到云端工作区", signal }).then((r) => r.json() as Promise<CloudWorkspaceView>),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function ccWorkspacesQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: ccKeys.workspaces,
    queryFn: ({ signal }): Promise<CcWorkspaceView[]> => client("/api/claude-code/workspaces", "workspaces", { fallback: "读不到工作区", signal }),
    enabled,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((w) => w.cloneState === "cloning")
        ? 2000
        : (query.state.data ?? []).some((w) => w.sessions.some((s) => s.status === "running" || s.status === "waiting"))
          ? 3000
          : 12_000,
    refetchOnWindowFocus: "always",
  });
}

export type SessionDetail = { session: CcSessionView; messages: CcMessage[]; live: { seq: number; statusText: string | null } | null };

export function ccSessionQueryOptions(id: string) {
  return queryOptions({
    queryKey: ccKeys.session(id),
    queryFn: ({ signal }) => client(`/api/claude-code/sessions/${encodeURIComponent(id)}`, { fallback: "读不到这个会话", signal }).then((r) => r.json() as Promise<SessionDetail>),
    refetchOnWindowFocus: false,
  });
}

export function ccFilesQueryOptions(id: string, path: string, enabled: boolean, ref: CcRef = "session") {
  return queryOptions({
    queryKey: ccKeys.files(id, path, ref),
    queryFn: ({ signal }) =>
      client(`/api/claude-code/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}${ref === "work" ? "&ref=work" : ""}`, { fallback: "读不到目录", signal }).then(
        (r) => r.json() as Promise<{ path: string; entries: CcTreeEntry[] }>,
      ),
    enabled,
  });
}

export function ccFileQueryOptions(id: string, path: string, enabled: boolean, ref: CcRef = "session") {
  return queryOptions({
    queryKey: ccKeys.file(id, path, ref),
    queryFn: ({ signal }) =>
      client(`/api/claude-code/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${ref === "work" ? "&ref=work" : ""}`, { fallback: "读不到文件", signal }).then(
        (r) => r.json() as Promise<{ path: string; size: number; binary?: boolean; tooLarge?: boolean; text: string | null }>,
      ),
    enabled,
  });
}

export type CcDiff = {
  turnId?: string | null;
  files: { path: string; add: number | null; del: number | null; status: string }[];
  patch: string;
  /** mode=base 时：目标分支、会话是否已经开始（有工作树）、比目标分支多几个提交。 */
  base?: string;
  started?: boolean;
  commits?: number;
};
export function ccDiffQueryOptions(id: string, turn: string | null, enabled: boolean, mode: "turn" | "base" = "turn") {
  return queryOptions({
    queryKey: ccKeys.diff(id, turn, mode),
    queryFn: ({ signal }) =>
      client(`/api/claude-code/sessions/${encodeURIComponent(id)}/diff${mode === "base" ? "?mode=base" : turn ? `?turn=${encodeURIComponent(turn)}` : ""}`, { fallback: "读不到改动", signal }).then(
        (r) => r.json() as Promise<CcDiff>,
      ),
    enabled,
  });
}

export function ccGithubQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: ccKeys.github,
    queryFn: ({ signal }) => client("/api/claude-code/github", { fallback: "读不到 GitHub 连接", signal }).then((r) => r.json() as Promise<CcGithubStatus>),
    enabled,
    staleTime: 10_000,
  });
}
export function ccReposQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: ccKeys.repos,
    queryFn: ({ signal }): Promise<CcGithubRepo[]> => client("/api/claude-code/github/repos", "repos", { fallback: "读不到仓库列表", signal }),
    enabled,
    staleTime: 60_000,
  });
}
export function ccPushPreviewQueryOptions(id: string, enabled: boolean) {
  return queryOptions({
    queryKey: ccKeys.push(id),
    queryFn: ({ signal }) => client(`/api/claude-code/sessions/${encodeURIComponent(id)}/push`, { fallback: "读不到要推送的内容", signal }).then((r) => r.json() as Promise<CcPushPreview>),
    enabled,
    staleTime: 0,
  });
}

export const ccApi = {
  loginStart: () => client("/api/cloud-workspace/claude/login", { method: "POST", fallback: "开始登录失败" }).then((r) => r.json() as Promise<CcLoginStart>),
  loginCode: (id: string, code: string) =>
    client(`/api/cloud-workspace/claude/login/${encodeURIComponent(id)}/code`, { method: "POST", body: { code }, fallback: "登录失败" }).then(
      (r) => r.json() as Promise<{ ok: boolean; error: string | null; claude: ClaudeAuth }>,
    ),
  loginCancel: (id: string) => client(`/api/cloud-workspace/claude/login/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "取消失败" }),
  logout: () => client("/api/cloud-workspace/claude/logout", { method: "POST", fallback: "退出失败" }),
  check: () => client("/api/cloud-workspace/claude/check", { method: "POST", fallback: "检查失败" }).then((r) => r.json() as Promise<{ claude: ClaudeAuth }>),
  createSession: (workspaceId: string, body: { title?: string } = {}) =>
    client<CcSessionView>(`/api/claude-code/workspaces/${encodeURIComponent(workspaceId)}/sessions`, "session", { method: "POST", body, fallback: "新建会话失败" }),
  patchSession: (id: string, body: { title?: string; model?: string | null; effort?: string | null; archived?: boolean }) =>
    client<CcSessionView>(`/api/claude-code/sessions/${encodeURIComponent(id)}`, "session", { method: "PATCH", body, fallback: "保存失败" }),
  /** FIX-15：归档会话（空草稿 / 不要的会话从列表消失）。 */
  archiveSession: (id: string) =>
    client<CcSessionView>(`/api/claude-code/sessions/${encodeURIComponent(id)}`, "session", { method: "PATCH", body: { archived: true }, fallback: "删除失败" }),
  send: (id: string, text: string) =>
    client(`/api/claude-code/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: { text }, fallback: "发送失败" }).then((r) => r.json() as Promise<{ message: CcMessage; queued: boolean }>),
  stop: (id: string) => client(`/api/claude-code/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", fallback: "停止失败" }),
  newClaudeSession: (id: string) => client(`/api/claude-code/sessions/${encodeURIComponent(id)}/new-claude-session`, { method: "POST", fallback: "操作失败" }),
  undoTurn: (id: string) => client(`/api/claude-code/sessions/${encodeURIComponent(id)}/undo-turn`, { method: "POST", fallback: "撤销失败" }),
  createWorkspace: (body: { repo: string; branch?: string | null; name?: string | null }) =>
    client<CcWorkspaceView>("/api/claude-code/workspaces", "workspace", { method: "POST", body: { source: "github", ...body }, fallback: "新建工作区失败" }),
  retryClone: (id: string) => client<CcWorkspaceView>(`/api/claude-code/workspaces/${encodeURIComponent(id)}/retry`, "workspace", { method: "POST", fallback: "重试失败" }),
  deleteWorkspace: (id: string) => client(`/api/claude-code/workspaces/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "删除失败" }),
  merge: (id: string) =>
    client(`/api/claude-code/sessions/${encodeURIComponent(id)}/merge`, { method: "POST", fallback: "合入失败" }).then((r) => r.json() as Promise<{ result: CcGitState; message: CcMessage }>),
  push: (id: string, body: { title: string; body?: string; draft?: boolean }) =>
    client(`/api/claude-code/sessions/${encodeURIComponent(id)}/push`, { method: "POST", body, fallback: "推送失败" }).then(
      (r) => r.json() as Promise<{ ok: boolean; error?: string; prUrl?: string; prNumber?: number | null; message: CcMessage }>,
    ),
  syncView: (workspaceId: string) => client(`/api/claude-code/workspaces/${encodeURIComponent(workspaceId)}/sync`, { fallback: "读不到同步状态" }).then((r) => r.json() as Promise<CcSyncView>),
  /** 旧客户端（同步桥 version 1）重新导入时网页替它建电脑文件夹工作区（DESIGN.md §87）。 */
  createLocalWorkspace: (body: { name: string; label: string }) =>
    client<{ id: string; name: string }>("/api/claude-code/local-workspaces", "workspace", { method: "POST", body, fallback: "新建工作区失败" }),
  /** 撤销一次没成功的「电脑上的文件夹」新建（还没开过会话的才行）。 */
  abandonLocalWorkspace: (workspaceId: string) =>
    client(`/api/claude-code/workspaces/${encodeURIComponent(workspaceId)}/sync/abandon`, { method: "POST", fallback: "撤销失败" }).then((r) => r.json() as Promise<{ abandoned: boolean; gone: boolean }>),
  forceReclaim: (workspaceId: string) =>
    client(`/api/claude-code/workspaces/${encodeURIComponent(workspaceId)}/sync/force-reclaim`, { method: "POST", fallback: "强制收回失败" }).then((r) => r.json() as Promise<CcSyncView>),
  decide: (approvalId: string, decision: "approve" | "deny", always = false) =>
    client(`/api/claude-code/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: { decision, always }, fallback: "操作失败" }),
};

/** 「机器人｜Claude Code」左栏切换（ADR-0014）：记住上次的选择和上次打开的会话。 */
export const LEFT_MODE_KEY = "chisabot-left-mode";
export const LAST_CC_SESSION_KEY = "chisabot-cc-last-session";
export function rememberLeftMode(mode: "bots" | "cc") {
  try {
    localStorage.setItem(LEFT_MODE_KEY, mode);
  } catch {}
}
export function lastLeftMode(): "bots" | "cc" {
  try {
    return localStorage.getItem(LEFT_MODE_KEY) === "cc" ? "cc" : "bots";
  } catch {
    return "bots";
  }
}

/**
 * 一个会话的消息 + 正在写的那一轮（DESIGN.md §73.4）：先读历史，再连 /stream（先给快照，再一条条增量）。
 * 刷新、切后台回来、换设备都会重新连，拿到快照接着往下写（同 §64）。
 */
export function useCcSessionStream(sessionId: string, initial: SessionDetail | undefined) {
  const [messages, setMessages] = useState<CcMessage[]>(initial?.messages ?? []);
  const [status, setStatus] = useState<CcSessionStatus>(initial?.session.status ?? "idle");
  const [statusText, setStatusText] = useState<string | null>(initial?.live?.statusText ?? null);
  const [connected, setConnected] = useState(false);
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    if (!initial) return;
    // 只在换会话 / 第一次拿到数据时整份替换；之后由流来改。
    if (seeded.current !== sessionId) {
      seeded.current = sessionId;
      setMessages(initial.messages);
      setStatus(initial.session.status);
      setStatusText(initial.live?.statusText ?? null);
    }
  }, [initial, sessionId]);

  useEffect(() => {
    if (!initial) return;
    let source: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const upsert = (message: CcMessage) =>
      setMessages((list) => {
        const i = list.findIndex((m) => m.id === message.id);
        if (i < 0) return [...list, message];
        const next = list.slice();
        next[i] = message;
        return next;
      });
    const open = () => {
      if (closed) return;
      source = new EventSource(`/api/claude-code/sessions/${encodeURIComponent(sessionId)}/stream`, { withCredentials: true });
      source.onopen = () => setConnected(true);
      source.onmessage = (event) => {
        let op: CcStreamOp | { op: "ping" };
        try {
          op = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (op.op) {
          case "snapshot":
            setStatus(op.status);
            setStatusText(op.statusText);
            if (op.message) upsert(op.message);
            break;
          case "message":
            upsert(op.message);
            if (op.message.role === "assistant" && op.message.status === "running") setStatus("running");
            break;
          case "text":
            setMessages((list) =>
              list.map((m) => {
                if (m.id !== op.messageId) return m;
                const parts = m.parts.slice();
                const part = parts[op.index];
                parts[op.index] = part && part.type === "text" ? { ...part, text: part.text + op.append } : { type: "text", text: op.append };
                return { ...m, parts };
              }),
            );
            break;
          case "part":
            setMessages((list) =>
              list.map((m) => {
                if (m.id !== op.messageId) return m;
                const parts = m.parts.slice();
                parts[op.index] = op.part;
                return { ...m, parts };
              }),
            );
            break;
          case "status":
            setStatus(op.status);
            setStatusText(op.text);
            break;
          case "done":
            upsert(op.message);
            setStatus("idle");
            setStatusText(null);
            break;
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (!closed) retry = setTimeout(open, 1500);
      };
    };
    open();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !source) {
        if (retry) clearTimeout(retry);
        open();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // initial 只用来判断「历史读到了」；换会话时重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, Boolean(initial)]);

  return { messages, status, statusText, connected, setMessages };
}
