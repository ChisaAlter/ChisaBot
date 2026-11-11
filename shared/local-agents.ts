/**
 * 本地 agent 与权限档位（docs/local-agents.md，DESIGN.md §66，ADR-0010）。
 *
 * 默认路径不变：云端机器人通过 device_* 工具一步一步操作电脑，电脑上不用装任何 agent。
 * 这里多两件事：
 * 1. 权限档位（每台设备一个，任务可以再收紧）：只读 / 工作区 / 完全访问。档位只会「收紧」能力开关——
 *    档位之外的操作即使能力是「允许」也改成「询问」（走原来的审批卡片），从不把「关闭」放宽。
 * 2. 本地 agent：云端机器人把一整件事交给电脑上的 agent（Claude Code、Codex、OpenCode…或者 ChisaBot 内置循环），
 *    进度流回聊天里的任务卡片。
 *
 * 服务器、网页、PC / 无界面节点读同一份定义（节点那份是 pc/src/agent-runtime/profile.js，逐条对应）。
 */

import type { AgentProbeState, RuntimeInstanceSpec } from "./agent-providers";

export const AGENT_PROFILES = ["readonly", "workspace", "full"] as const;
export type AgentProfile = (typeof AGENT_PROFILES)[number];

export const PROFILE_INFO: Record<
  AgentProfile,
  { label: string; short: string; description: string; rank: number }
> = {
  readonly: {
    label: "只读",
    short: "只读",
    description:
      "只能看：读文件、列目录、截图、系统信息。改文件、运行命令、鼠标键盘都要你逐次批准。",
    rank: 0,
  },
  workspace: {
    label: "工作区",
    short: "工作区",
    description:
      "在你选的文件夹里可以读写、运行命令；文件夹之外的写入和命令、鼠标键盘要你批准。",
    rank: 1,
  },
  full: {
    label: "完全访问",
    short: "完全访问",
    description:
      "按能力开关执行，不再额外收紧。本地 agent 可以跳过它自己的逐条确认。只在信任的任务上用。",
    rank: 2,
  },
};

export function isAgentProfile(value: unknown): value is AgentProfile {
  return (
    typeof value === "string" &&
    (AGENT_PROFILES as readonly string[]).includes(value)
  );
}

/** 任务档位不能高于设备档位：取两者中更严的那个。 */
export function narrowerProfile(
  device: AgentProfile,
  requested: AgentProfile | null | undefined,
): AgentProfile {
  if (!requested) return device;
  return PROFILE_INFO[requested].rank < PROFILE_INFO[device].rank
    ? requested
    : device;
}

/** 隔离方式。worktree / copy 是「一次性副本」（改动要你点「应用改动」才回到原文件夹），其余是系统级沙盒。 */
export const ISOLATIONS = [
  "none",
  "worktree",
  "copy",
  "bwrap",
  "sandbox-exec",
  "docker",
  "podman",
  "wsl",
] as const;
export type Isolation = (typeof ISOLATIONS)[number];

export const ISOLATION_INFO: Record<
  Isolation,
  { label: string; description: string; sandbox: boolean; disposable: boolean }
> = {
  none: {
    label: "直接在文件夹里",
    description: "直接改原文件夹（只在 工作区 / 完全访问 档位可用）。",
    sandbox: false,
    disposable: false,
  },
  worktree: {
    label: "Git worktree",
    description: "在一个新的 git worktree 里做，做完你决定要不要合回去。",
    sandbox: false,
    disposable: true,
  },
  copy: {
    label: "临时副本",
    description: "把文件夹复制到临时目录里做，做完你决定要不要拷回去。",
    sandbox: false,
    disposable: true,
  },
  bwrap: {
    label: "bubblewrap 沙盒",
    description: "Linux：整个系统只读，只有工作文件夹可写，可断网。",
    sandbox: true,
    disposable: false,
  },
  "sandbox-exec": {
    label: "macOS 沙盒",
    description: "macOS sandbox-exec：只有工作文件夹可写，可断网。",
    sandbox: true,
    disposable: false,
  },
  docker: {
    label: "Docker 容器",
    description:
      "内置 agent 的命令在一次性容器里跑，只挂载工作文件夹，可断网。",
    sandbox: true,
    disposable: false,
  },
  podman: {
    label: "Podman 容器",
    description: "同 Docker，用 podman。",
    sandbox: true,
    disposable: false,
  },
  wsl: {
    label: "WSL",
    description: "Windows：在 WSL 的 Linux 里运行（agent 需要装在 WSL 里）。",
    sandbox: false,
    disposable: false,
  },
};

export function isIsolation(value: unknown): value is Isolation {
  return (
    typeof value === "string" &&
    (ISOLATIONS as readonly string[]).includes(value)
  );
}

export const LOCAL_AGENT_KINDS = [
  "builtin",
  "claude",
  "codex",
  "antigravity",
  "acp",
  "opencode",
  "gemini",
  "aider",
  "custom",
] as const;
export type LocalAgentKind = (typeof LOCAL_AGENT_KINDS)[number];

export const LOCAL_AGENT_INFO: Record<
  LocalAgentKind,
  { label: string; vendor: string; coding: boolean; hint: string }
> = {
  builtin: {
    label: "ChisaBot 内置",
    vendor: "ChisaBot",
    coding: false,
    hint: "在电脑上跑 ChisaBot 的工具循环（读写文件、命令），模型用你在服务器上配置的那个，或电脑上的本地模型。",
  },
  claude: {
    label: "Claude Code",
    vendor: "Anthropic",
    coding: true,
    hint: "Anthropic 的命令行编程 agent，用它自己登录的账号（Claude Pro / API key）。",
  },
  codex: {
    label: "Codex CLI",
    vendor: "OpenAI",
    coding: true,
    hint: "OpenAI 的命令行编程 agent，用它自己登录的账号。",
  },
  antigravity: {
    label: "Antigravity",
    vendor: "Google",
    coding: true,
    hint: "Google Antigravity 智能体（agy / agy_acp_server），支持 ACP 协议与多步推理。",
  },
  acp: {
    label: "ACP 智能体",
    vendor: "ACP",
    coding: true,
    hint: "通过 Agent Client Protocol 接入的智能体（如 Codebuddy、Devin 等）。",
  },
  opencode: {
    label: "OpenCode",
    vendor: "sst",
    coding: true,
    hint: "开源命令行编程 agent。",
  },
  gemini: {
    label: "Gemini CLI",
    vendor: "Google",
    coding: true,
    hint: "Google 的命令行 agent。",
  },
  aider: {
    label: "Aider",
    vendor: "aider",
    coding: true,
    hint: "开源结对编程工具。",
  },
  custom: {
    label: "自定义命令",
    vendor: "Custom",
    coding: true,
    hint: "用户自定义命令行可执行程序或脚本。",
  },
};

export function isLocalAgentKind(value: unknown): value is LocalAgentKind {
  return (
    typeof value === "string" &&
    (LOCAL_AGENT_KINDS as readonly string[]).includes(value)
  );
}

export type DetectedAgent = {
  kind: LocalAgentKind;
  version: string | null;
  path: string | null;
  inWsl?: boolean;
};
export type DetectedSandboxes = Partial<
  Record<Isolation | "git" | "windows-sandbox", boolean>
>;

export type DeviceAgentDetection = {
  agents: DetectedAgent[];
  sandboxes: DetectedSandboxes;
  platform: string | null;
  /** 节点以 root 运行（Claude Code 跳过确认需要 IS_SANDBOX=1）。 */
  root?: boolean;
  checkedAt: string;
};

/** 内置 agent 用哪个模型：服务器上配置的（默认，密钥不出服务器），或电脑上的 OpenAI 兼容本地模型（Ollama / LM Studio）。 */
export type BuiltinModel =
  | { kind: "server" }
  | { kind: "local"; baseUrl: string; model: string };

export type DeviceAgentSettings = {
  deviceId: string;
  profile: AgentProfile;
  /** 「工作区」档位的文件夹；空 = 沿用设备的「允许的文件夹」。 */
  workspaceRoots: string[];
  /** 本地 agent 任务能不能联网（内置 agent 的命令；CLI agent 自己要联网访问它的模型）。 */
  network: boolean;
  /** 默认隔离方式。 */
  isolation: Isolation;
  defaultAgent: LocalAgentKind;
  builtinModel: BuiltinModel;
  /** Docker / Podman 隔离用的镜像。 */
  containerImage: string;
  detected: DeviceAgentDetection | null;
  /** 有没有保存过（没有 = 全是默认值）。 */
  saved: boolean;
  updatedAt: string | null;
};

export const DEFAULT_CONTAINER_IMAGE = "debian:bookworm-slim";

export function defaultAgentSettings(deviceId: string): DeviceAgentSettings {
  return {
    deviceId,
    profile: "workspace",
    workspaceRoots: [],
    network: true,
    isolation: "worktree",
    defaultAgent: "builtin",
    builtinModel: { kind: "server" },
    containerImage: DEFAULT_CONTAINER_IMAGE,
    detected: null,
    saved: false,
    updatedAt: null,
  };
}

/** 有效的工作区文件夹：自己设了就用自己的，否则沿用设备的「允许的文件夹」。 */
export function effectiveRoots(
  settings: Pick<DeviceAgentSettings, "workspaceRoots">,
  allowedRoots: readonly string[],
): string[] {
  return settings.workspaceRoots.length
    ? [...settings.workspaceRoots]
    : [...allowedRoots];
}

// ── 档位判定 ────────────────────────────────────────────────────────────────

function normalizePath(path: string, windows: boolean): string {
  let value = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  // 去掉 . 和 ..（只做字面规整；节点那边还会按真实路径 / 符号链接再判一次）。
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "." || (part === "" && parts.length > 0)) continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  value = parts.join("/") || "/";
  return windows ? value.toLowerCase() : value;
}

export function isInsideRoots(
  path: string | null | undefined,
  roots: readonly string[],
  platform?: string | null,
): boolean {
  if (!path || !roots.length) return false;
  const windows = platform === "win32" || /^[a-zA-Z]:[\\/]/.test(path);
  const absolute = windows
    ? /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")
    : path.startsWith("/");
  // 相对路径：节点按第一个文件夹解析。
  const target = normalizePath(
    absolute ? path : `${roots[0]}/${path}`,
    windows,
  );
  return roots.some((root) => {
    const base = normalizePath(root, windows);
    return (
      target === base ||
      target.startsWith(base.endsWith("/") ? base : `${base}/`)
    );
  });
}

/** 只读的操作（cb-devices 新加的搜索 / git 状态之类按名字归类）。 */
const READ_OPERATIONS = new Set([
  "system_info",
  "list_files",
  "read_file",
  "screenshot",
  "clipboard_read",
  "search_files",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "git_log",
  "shell_output",
  "shell_status",
  "background_output",
]);

function looksReadOnly(operation: string): boolean {
  if (READ_OPERATIONS.has(operation)) return true;
  return /(^|_)(read|list|search|grep|glob|status|info|log|output|diff|view|get)$/u.test(
    operation,
  );
}

/**
 * 一个设备操作在某个档位里算不算「档位之内」。之外的操作：能力是「允许」也要先审批；能力「关闭」照旧拒绝。
 * 未知操作按最严处理（只读和工作区里都算档位之外，除非名字明显是只读的）。
 */
export function profileAllows(
  profile: AgentProfile,
  operation: string,
  args: Record<string, unknown>,
  roots: readonly string[],
  platform?: string | null,
): { inside: boolean; reason: string | null } {
  if (profile === "full") return { inside: true, reason: null };
  if (looksReadOnly(operation)) return { inside: true, reason: null };
  if (profile === "readonly")
    return { inside: false, reason: "当前是「只读」档位，这个操作会改动电脑" };
  // 工作区
  const pathOf = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : null;
  switch (operation) {
    case "write_file":
    case "edit_file":
    case "apply_patch":
    case "patch":
    case "delete_file":
    case "move_file":
    case "make_dir": {
      const paths = [
        pathOf("path"),
        pathOf("to"),
        pathOf("from"),
        pathOf("target"),
      ].filter(Boolean) as string[];
      if (
        paths.length &&
        paths.every((path) => isInsideRoots(path, roots, platform))
      )
        return { inside: true, reason: null };
      return { inside: false, reason: "要改的文件不在工作区文件夹里" };
    }
    case "shell":
    case "shell_start":
    case "background_shell":
    case "git": {
      const cwd = pathOf("cwd");
      if (cwd && isInsideRoots(cwd, roots, platform))
        return { inside: true, reason: null };
      return {
        inside: false,
        reason: cwd
          ? "命令的工作目录不在工作区文件夹里"
          : "命令没有指定工作区里的工作目录",
      };
    }
    case "open": {
      const target = pathOf("target") ?? "";
      if (/^https?:\/\//i.test(target)) return { inside: true, reason: null };
      return {
        inside: false,
        reason: "工作区档位只直接打开网址，打开文件要批准",
      };
    }
    case "clipboard_write":
      return { inside: true, reason: null };
    case "input":
      return { inside: false, reason: "鼠标键盘不在工作区档位里" };
    default: {
      const path = pathOf("path") ?? pathOf("cwd");
      if (path && isInsideRoots(path, roots, platform))
        return { inside: true, reason: null };
      return { inside: false, reason: "这个操作不在工作区档位里" };
    }
  }
}

// ── 本地 agent 任务 ─────────────────────────────────────────────────────────

export type LocalAgentTaskStatus =
  | "pending_approval"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "cancelled";
export const ACTIVE_LOCAL_TASK: readonly LocalAgentTaskStatus[] = [
  "pending_approval",
  "starting",
  "running",
];

export type LocalAgentLine = {
  at: string;
  kind: "text" | "tool" | "status" | "stderr" | "approval";
  text: string;
};

export type LocalAgentDiffFile = {
  path: string;
  added: number;
  removed: number;
  status: "modified" | "added" | "deleted";
};
export type LocalAgentDiff = {
  files: LocalAgentDiffFile[];
  added: number;
  removed: number;
  /** 改动在一次性副本里（worktree / copy），要用户点「应用改动」才回到原文件夹。 */
  pending: boolean;
  applied: boolean;
  /** 用户放弃了一次性副本里的改动。 */
  discarded?: boolean;
  /** 截断后的补丁文本（只给卡片展开看；完整补丁留在电脑上）。 */
  patch?: string;
};

export type LocalAgentTaskView = {
  id: string;
  deviceId: string;
  deviceName: string;
  environmentId?: string;
  instanceId?: string | null;
  instanceName?: string | null;
  parentTaskId?: string | null;
  depth?: number;
  invocationMode?: "wait" | "async" | "direct";
  agent: LocalAgentKind;
  title: string;
  profile: AgentProfile;
  isolation: Isolation;
  network: boolean;
  cwd: string | null;
  status: LocalAgentTaskStatus;
  step: string | null;
  /** 最后几十行输出（卡片里看）；完整记录 GET /api/local-agents/tasks/:id。 */
  lines: LocalAgentLine[];
  lineCount: number;
  summary: string | null;
  diff: LocalAgentDiff | null;
  error: string | null;
  /** 正在等用户批准的审批 id（任务启动或档位之外的一步），卡片上直接给「允许 / 拒绝」。 */
  approvalId: string | null;
  approvalSummary: string | null;
  resultMessageId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export const LOCAL_AGENT_RESULT_MARKER = "⟦chisabot:local-agent-result:";

export const LOCAL_TASK_STATUS_ZH: Record<LocalAgentTaskStatus, string> = {
  pending_approval: "等待你批准",
  starting: "正在启动",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

/** 卡片上那一行档位说明：「工作区 · Git worktree · 断网」。 */
export function profileLine(
  task: Pick<LocalAgentTaskView, "profile" | "isolation" | "network">,
): string {
  return [
    PROFILE_INFO[task.profile].short,
    task.isolation === "none" ? null : ISOLATION_INFO[task.isolation].label,
    task.network ? null : "断网",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── 节点协议（在 shared/devices.ts 的协议之外，hub 把不认识的消息转给本地 agent 服务）────────────────

export type LocalAgentRunMessage = {
  type: "agent_run";
  taskId: string;
  agent: LocalAgentKind;
  prompt: string;
  cwd: string | null;
  profile: AgentProfile;
  isolation: Isolation;
  network: boolean;
  roots: string[];
  /** CLI agent 可以跳过它自己的逐条确认（完全访问，或在系统级沙盒里）。 */
  skipPermissions: boolean;
  builtinModel: BuiltinModel;
  containerImage: string;
  timeoutMs: number;
  /** 可选实例运行时配置（自定义可执行路径、影子 Home、环境变量、ACP 参数等）。 */
  instance?: RuntimeInstanceSpec;
  /** 可选外部 Agent 嵌套互调配置。 */
  subagentBridge?: {
    enabled: boolean;
    depth: number;
    maxDepth: number;
  };
};

export type ServerToNodeAgent =
  | { type: "agent_detect" }
  | { type: "agent_probe"; reqId: string; instance: RuntimeInstanceSpec }
  | LocalAgentRunMessage
  | { type: "agent_stop"; taskId: string }
  | { type: "agent_apply"; taskId: string }
  | { type: "agent_discard"; taskId: string }
  | {
      type: "agent_llm_result";
      reqId: string;
      ok: boolean;
      content?: LlmContentPart[];
      error?: string;
    }
  | {
      type: "agent_approval_result";
      reqId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: "agent_subcall_result";
      reqId: string;
      ok: boolean;
      data?: unknown;
      error?: string;
    };

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

/** 内置 agent 的对话（节点保存，每一步整段发给服务器代调模型）。 */
export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; content: LlmContentPart[] }
  | { role: "tool"; toolCallId: string; toolName: string; output: string };

export type NodeSubcallAction = "list" | "run" | "status" | "stop";

export type NodeAgentToServer =
  | {
      type: "agents_detected";
      detection: Omit<DeviceAgentDetection, "checkedAt">;
    }
  | {
      type: "agent_probe_result";
      reqId: string;
      probe: Omit<AgentProbeState, "checkedAt">;
    }
  | {
      type: "agent_event";
      taskId: string;
      kind: LocalAgentLine["kind"];
      text: string;
      step?: string;
    }
  | { type: "agent_started"; taskId: string; workdir?: string }
  | {
      type: "agent_done";
      taskId: string;
      ok: boolean;
      exitCode?: number | null;
      summary?: string;
      diff?: LocalAgentDiff | null;
      error?: string;
      stopped?: boolean;
    }
  | {
      type: "agent_applied";
      taskId: string;
      ok: boolean;
      discarded?: boolean;
      error?: string;
    }
  | {
      type: "agent_llm";
      taskId: string;
      reqId: string;
      messages: LlmMessage[];
      system?: string;
    }
  | {
      type: "agent_approval";
      taskId: string;
      reqId: string;
      operation: string;
      summary: string;
    }
  | {
      type: "agent_subcall";
      taskId: string;
      reqId: string;
      action: NodeSubcallAction;
      params: Record<string, unknown>;
    };

export const LOCAL_AGENT_MESSAGE_TYPES = new Set([
  "agents_detected",
  "agent_probe_result",
  "agent_event",
  "agent_started",
  "agent_done",
  "agent_applied",
  "agent_llm",
  "agent_approval",
  "agent_subcall",
]);
