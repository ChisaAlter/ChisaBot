/**
 * 云端 Claude Code（docs/cloud-claude-code.md，ADR-0014）：服务器和网页共用的类型。
 */
import { maskShareLink, parseShareLink, shareScheme, SHARE_PROTOCOL_ZH, type ShareProtocol } from "./proxy-links";

export type ClaudeAuth = {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  checkedAt: string | null;
  error?: string | null;
};

export type CloudWorkspaceView = {
  /** 没有配对云端节点时为 null。 */
  node: {
    deviceId: string;
    name: string;
    online: boolean;
    claudeVersion: string | null;
    lastSeenAt: string | null;
    /** 节点还在跑旧版节点程序（只在容器启动时下载）：新的登录 / 退出逻辑要节点重启换程序才生效。 */
    scriptStale: boolean;
    /** 节点认得自己的程序指纹（新版）：可以让它自己重启换程序；false = 太旧，只能人工重启容器。 */
    scriptRestartable: boolean;
  } | null;
  claude: ClaudeAuth;
  running: number;
  maxConcurrent: number;
  /** 节点镜像里有浏览器：可以「在云端完成登录」。 */
  browserLogin: boolean;
  /** 「Claude 上游代理」：只给打码后的地址。 */
  proxy: CcProxyView;
};

/**
 * 「Claude 上游代理」的现状（DESIGN.md §73.8、§85）。kind = url：http / https / socks5 代理；link：节点链接，经 sing-box 转换。
 * converter：云端节点里的 sing-box（available = 节点镜像里有；lastError = 最近一次启动 sing-box 的错误）。
 */
export type CcProxyView = {
  configured: boolean;
  masked: string | null;
  kind: "url" | "link" | null;
  /** 节点链接的协议名（Trojan / VLESS…），普通代理为 null。 */
  protocol: string | null;
  converter: { available: boolean; version: string | null; lastError: string | null };
};

/** 「在云端完成登录」的画面流（GET /api/cloud-workspace/claude/login/browser/:id/stream）。 */
export type CcBrowserOp =
  | { op: "frame"; data: string; w: number; h: number }
  | { op: "state"; url?: string; captured?: boolean; popup?: boolean; closed?: boolean; reason?: string; egress?: { browser: string | null; node: string | null; match: boolean; viaProxy: boolean } }
  | { op: "done"; ok: boolean; error: string | null; claude: ClaudeAuth };

/** 网页 → 远程浏览器的输入（坐标是远程画面的像素）。 */
export type CcBrowserInput =
  | { t: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; buttons?: number; clickCount?: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "text"; text: string }
  | { t: "key"; key: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }
  | { t: "nav"; action: "back" | "reload" };

export type CcProxyTest = {
  ok: boolean;
  ip: string | null;
  /** 出口所在国家 / 地区（claude.ai 的 /cdn-cgi/trace 里的 loc，两个字母）。 */
  country?: string | null;
  claudeAi: { ok: boolean; status?: number; error?: string } | null;
  anthropicApi: { ok: boolean; status?: number; error?: string } | null;
  ms: number | null;
  error: string | null;
};

/** 「Claude 上游代理」地址：http / https / socks5(h)://[用户名[:密码]@]主机:端口。不对返回 null。 */
export function parseProxyUrl(text: string) {
  let u: URL;
  try {
    u = new URL(String(text ?? "").trim());
  } catch {
    return null;
  }
  const protocol = u.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https", "socks5", "socks5h"].includes(protocol)) return null;
  if (!u.hostname || u.pathname.replace(/\/+$/, "") || u.search || u.hash) return null;
  const port = Number(u.port || (protocol === "http" ? 80 : protocol === "https" ? 443 : 1080));
  if (!port || port > 65535) return null;
  return { protocol: protocol === "socks5h" ? "socks5" : protocol, host: u.hostname, port, username: decodeURIComponent(u.username), hasPassword: !!u.password };
}
/** 打码：密码换成 ••••。 */
export function maskProxyUrl(text: string) {
  const p = parseProxyUrl(text);
  if (!p) return null;
  return `${p.protocol}://${p.username ? `${encodeURIComponent(p.username)}${p.hasPassword ? ":••••" : ""}@` : ""}${p.host}:${p.port}`;
}

/** 填进来的是什么：普通代理地址 / 节点链接 / 都不是。网页用来决定要不要显示「用 sing-box 转换此链接」。 */
export type ProxyInputKind =
  | { kind: "url"; masked: string }
  | { kind: "link"; protocol: ShareProtocol; protocolZh: string; masked: string | null; error: string | null }
  | { kind: "invalid" }
  | { kind: "empty" };

export function classifyProxyInput(text: string): ProxyInputKind {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "empty" };
  const proto = shareScheme(t);
  if (proto) {
    const r = parseShareLink(t);
    return { kind: "link", protocol: proto, protocolZh: SHARE_PROTOCOL_ZH[proto], masked: r.ok ? maskShareLink(t) : null, error: r.ok ? null : r.error };
  }
  const masked = maskProxyUrl(t);
  return masked ? { kind: "url", masked } : { kind: "invalid" };
}

/** 已保存的值打码：普通代理 → 打码地址；节点链接 → 协议 · 主机:端口 · 节点名。 */
export function maskProxyValue(text: string): string | null {
  return shareScheme(text) ? maskShareLink(text) : maskProxyUrl(text);
}

/** 两个字母的国家 / 地区代码 → 中文名（不认识就原样）。 */
export function countryZh(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export type CcLoginStart = { id: string; url: string; expiresAt: string };

export type CcSyncState = "cloud_only" | "syncing" | "pc_active" | "paused" | "conflict";
export const SYNC_STATE_ZH: Record<CcSyncState, string> = {
  cloud_only: "仅云端",
  syncing: "同步中",
  pc_active: "PC 正在使用",
  paused: "已暂停",
  conflict: "冲突",
};

/** 工作区的电脑同步面板（GET /api/claude-code/workspaces/:id/sync，网页 / 手机只读 + 电脑离线时强制收回）。 */
export type CcSyncView = {
  workspaceId: string;
  state: CcSyncState;
  binding: {
    id: string;
    enabled: boolean;
    deviceId: string;
    deviceName: string;
    online: boolean;
    offlineMs: number | null;
    label: string | null;
    lastSyncedAt: string | null;
    detail: string | null;
    epoch: number;
  } | null;
  lease: { holder: string; since: string };
  tunnels: number;
  conflicts: string[];
  handoff: string | null;
  canForceReclaim: boolean;
};

export type CcSessionStatus = "idle" | "running" | "waiting" | "error";

export type CcSessionView = {
  id: string;
  workspaceId: string;
  title: string;
  status: CcSessionStatus;
  branch: string | null;
  model: string | null;
  effort: string | null;
  turns: number;
  resumable: boolean;
  lastTurnAt: string | null;
  createdAt: string;
  lastError: string | null;
  /** 「推送并开 PR」开出来的 PR（P3）。 */
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: string | null;
};

/** GitHub 工作区的克隆状态（P3）：新建后先「克隆中」，成功「就绪」，失败「出错」（可以重试或删除）。 */
export type CcCloneState = "cloning" | "ready" | "error";

export type CcWorkspaceView = {
  id: string;
  name: string;
  source: "scratch" | "github" | "local";
  sourceLabel: string;
  repoFullName: string | null;
  isGit: boolean;
  syncState: CcSyncState;
  cloneState: CcCloneState;
  cloneError: string | null;
  /** PR 的目标分支 = 新建时选的分支（默认是仓库的默认分支）。 */
  defaultBranch: string | null;
  sessions: CcSessionView[];
};

export type CcGithubStatus = { connected: boolean; login: string | null; invalid: boolean };
export type CcGithubRepo = { fullName: string; private: boolean; description: string; defaultBranch: string; updatedAt: string | null };

export type CcGitState = "fast_forward" | "merged" | "applied" | "up_to_date" | "conflict" | "pr_opened" | "pr_exists" | "push_failed";
/** 「推送并开 PR」之前给你看的：要推的提交、还没提交的文件、目标分支。 */
export type CcPushPreview = {
  repo: string;
  branch: string | null;
  base: string;
  commits: { sha: string; subject: string }[];
  uncommitted: number;
  started: boolean;
  title: string;
  prUrl: string | null;
};

export type CcToolStatus = "running" | "done" | "error" | "denied";
export type CcApprovalState = "pending" | "approved" | "denied" | "expired";

export type CcPart =
  | { type: "text"; text: string }
  | { type: "tool"; id: string | null; name: string; input: Record<string, unknown>; status: CcToolStatus; result?: string; reason?: string }
  | {
      type: "approval";
      id: string;
      tool: string;
      summary: string;
      input: Record<string, unknown>;
      canAlways: boolean;
      state: CcApprovalState;
      always?: boolean;
      expiresAt: string;
    }
  | { type: "changes"; turnId: string; files: CcChangedFile[] }
  | { type: "error"; text: string }
  | { type: "notice"; text: string }
  | {
      type: "git";
      action: "merge" | "push";
      state: CcGitState;
      branch: string;
      target: string;
      files?: string[];
      commits?: number;
      prUrl?: string | null;
      prNumber?: number | null;
      text?: string | null;
    };

export type CcChangedFile = { path: string; add: number | null; del: number | null; status: string };

export type CcMessage = {
  id: string;
  turnId: string | null;
  role: "user" | "assistant" | "system";
  parts: CcPart[];
  status: "done" | "running" | "stopped" | "error" | "queued";
  meta: { costUsd?: number | null; turns?: number | null; undone?: boolean; durationMs?: number | null } | null;
  createdAt: string;
};

/** 会话流（GET /api/claude-code/sessions/:id/stream）里的一条。 */
export type CcStreamOp =
  | { op: "snapshot"; seq: number; message: CcMessage | null; status: CcSessionStatus; statusText: string | null }
  | { op: "text"; seq: number; messageId: string; index: number; append: string }
  | { op: "part"; seq: number; messageId: string; index: number; part: CcPart }
  | { op: "status"; seq: number; text: string | null; status: CcSessionStatus }
  | { op: "done"; seq: number; message: CcMessage }
  | { op: "message"; seq: number; message: CcMessage };

export type CcTreeEntry = { name: string; dir: boolean; size: number | null };

export const CC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CC_EFFORT_ZH: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
export const CC_MODELS = [
  { id: "", label: "默认模型" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
] as const;

/** 工具名 → 干活行的中文说法。 */
export function ccToolLine(name: string, input: Record<string, unknown>): string {
  const file = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  const short = file ? file.split("/").slice(-2).join("/") : "";
  switch (name) {
    case "Read":
      return `读取 ${short || "文件"}`;
    case "Write":
      return `写入 ${short || "文件"}`;
    case "Edit":
    case "MultiEdit":
      return `修改 ${short || "文件"}`;
    case "Grep":
      return `搜索「${String(input.pattern ?? "").slice(0, 40)}」`;
    case "Glob":
      return `查找文件 ${String(input.pattern ?? "").slice(0, 40)}`;
    case "LS":
      return `列出 ${short || "目录"}`;
    case "Bash":
      return `运行 ${String(input.command ?? "").slice(0, 80)}`;
    case "WebFetch":
      return `打开网页 ${String(input.url ?? "").slice(0, 60)}`;
    case "WebSearch":
      return `搜索网页「${String(input.query ?? "").slice(0, 40)}」`;
    case "TodoWrite":
      return "更新待办清单";
    case "Task":
    case "Agent":
      return `交给子 agent：${String(input.description ?? "").slice(0, 40)}`;
    default:
      return `使用 ${name}`;
  }
}
