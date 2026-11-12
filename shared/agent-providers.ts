/**
 * 智能体提供方多实例、ACP 目录、Bot 子代理授权与编排契约。
 *
 * 与 shared/local-agents.ts 双向兼容：
 * - 支持在「服务器本机（server）」或任意已配对「设备节点（deviceId）」宿主下管理多个提供方实例；
 * - 支持 Codex（含影子 Home 账号隔离）、Claude、Antigravity、通用 ACP（Codebuddy / Devin / ACP Registry）、
 *   OpenCode、Gemini CLI、Aider、自定义命令及 ChisaBot 内置循环；
 * - 支持将实例作为子代理（同步 wait / 异步 async / 聊天 @ 点名）调用，或按 Bot 授权暴露为具名工具（agent_<slug>）。
 */

import type { AgentProfile, Isolation, LocalAgentKind } from "./local-agents";

export const SERVER_ENVIRONMENT_ID = "server" as const;
export type AgentEnvironmentId = typeof SERVER_ENVIRONMENT_ID | string;

export const AGENT_DRIVER_KINDS = [
  "codex",
  "claude",
  "antigravity",
  "acp",
  "opencode",
  "gemini",
  "aider",
  "custom",
  "builtin",
] as const satisfies readonly LocalAgentKind[];

export type AgentDriverKind = (typeof AGENT_DRIVER_KINDS)[number];

export function isAgentDriverKind(value: unknown): value is AgentDriverKind {
  return (
    typeof value === "string" &&
    (AGENT_DRIVER_KINDS as readonly string[]).includes(value)
  );
}

export type AcpSourceKind = "registry" | "local";
export type AcpLauncherKind = "npx" | "uvx" | "binary" | "custom";
export type CustomOutputFormat = "text" | "jsonl";

export type AgentDriverFieldSpec = {
  supportsCommandPath: boolean;
  defaultCommand: string | null;
  supportsHomePath: boolean;
  homeEnvName: string | null;
  defaultHomePath: string | null;
  supportsShadowHome: boolean;
  defaultShadowHint: string | null;
  supportsExtraArgs: boolean;
  supportsModel: boolean;
  supportsAcp: boolean;
  supportsCustomIO: boolean;
  supportsReadOnly: boolean;
};

export const AGENT_DRIVER_SPECS: Record<
  AgentDriverKind,
  {
    label: string;
    vendor: string;
    badge: string;
    description: string;
    fields: AgentDriverFieldSpec;
  }
> = {
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    badge: "CLI",
    description:
      "OpenAI Codex 命令行编程智能体，支持自定义 CODEX_HOME 与按账号隔离 auth.json 的影子 Home。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "codex",
      supportsHomePath: true,
      homeEnvName: "CODEX_HOME",
      defaultHomePath: "~/.codex",
      supportsShadowHome: true,
      defaultShadowHint: "~/.codex-chisabot/personal",
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: true,
    },
  },
  claude: {
    label: "Claude Code",
    vendor: "Anthropic",
    badge: "CLI",
    description:
      "Anthropic Claude Code 智能体，支持 CLAUDE_CONFIG_DIR 多账号隔离与 MCP 工具桥。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "claude",
      supportsHomePath: true,
      homeEnvName: "CLAUDE_CONFIG_DIR",
      defaultHomePath: "~/.claude",
      supportsShadowHome: true,
      defaultShadowHint: "~/.claude-chisabot/work",
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: true,
    },
  },
  antigravity: {
    label: "Antigravity",
    vendor: "Google",
    badge: "ACP / CLI",
    description:
      "Google Antigravity 智能体（agy / agy_acp_server），支持原生 ACP 会话与 Windows 代理前缀自动修正。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "agy",
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: true,
      supportsCustomIO: false,
      supportsReadOnly: true,
    },
  },
  acp: {
    label: "ACP 通用提供方",
    vendor: "Agent Client Protocol",
    badge: "ACP",
    description:
      "通过标准 Agent Client Protocol (stdio JSON-RPC) 接入 Codebuddy、Devin 或任意 ACP Registry / 本地智能体。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "",
      supportsHomePath: true,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: true,
      supportsCustomIO: false,
      supportsReadOnly: true,
    },
  },
  opencode: {
    label: "OpenCode",
    vendor: "SST",
    badge: "CLI",
    description: "开源终端编程智能体 OpenCode。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "opencode",
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: false,
    },
  },
  gemini: {
    label: "Gemini CLI",
    vendor: "Google",
    badge: "CLI",
    description: "Google 官方命令行编程智能体 Gemini CLI。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "gemini",
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: false,
    },
  },
  aider: {
    label: "Aider",
    vendor: "Aider",
    badge: "CLI",
    description: "开源 AI 结对编程命令行工具。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "aider",
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: false,
    },
  },
  custom: {
    label: "自定义命令",
    vendor: "Custom",
    badge: "Custom",
    description:
      "任意自定义可执行文件或脚本，支持 {{prompt}} / {{workdir}} 参数模板或标准输入传参。",
    fields: {
      supportsCommandPath: true,
      defaultCommand: "",
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: true,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: true,
      supportsReadOnly: false,
    },
  },
  builtin: {
    label: "ChisaBot 内置",
    vendor: "ChisaBot",
    badge: "内置",
    description:
      "在目标宿主直接运行 ChisaBot 的文件读写与命令工具循环，由服务器模型或本机 Ollama 驱动。",
    fields: {
      supportsCommandPath: false,
      defaultCommand: null,
      supportsHomePath: false,
      homeEnvName: null,
      defaultHomePath: null,
      supportsShadowHome: false,
      defaultShadowHint: null,
      supportsExtraArgs: false,
      supportsModel: true,
      supportsAcp: false,
      supportsCustomIO: false,
      supportsReadOnly: true,
    },
  },
};

export type AgentDriverConfig = {
  /** 可执行文件路径或命令名（留空用驱动默认命令） */
  commandPath?: string | null;
  /** 主 Home / 配置目录（如 ~/.codex 或 ~/.claude） */
  homePath?: string | null;
  /** 影子 Home 目录（独立隔离 auth.json，通过链接共享 sessions/skills/cache 等） */
  shadowHomePath?: string | null;
  /** 额外命令行参数（自定义命令中支持 {{prompt}}、{{workdir}}、{{model}} 占位符） */
  extraArgs?: string[];
  /** 默认模型标识 */
  model?: string | null;
  /** Antigravity：自动补齐 Windows HTTP_PROXY 协议头并清理冲突变量（默认 true） */
  fixProxy?: boolean;
  /** Antigravity：协议选择（默认 auto：优先探测 agy_acp_server 走 ACP，回退 agy CLI） */
  protocolMode?: "auto" | "acp" | "cli";
  /** ACP：来源类型 */
  acpSource?: AcpSourceKind;
  /** ACP Registry 智能体 ID（如 codebuddy、devin） */
  acpAgentId?: string | null;
  /** ACP 启动器类型 */
  acpLauncher?: AcpLauncherKind;
  /** ACP 包名或二进制标识（如 @tencent-ai/codebuddy-code） */
  acpPackage?: string | null;
  /** ACP 偏好的认证方式 ID */
  authMethodId?: string | null;
  /** 自定义命令：是否通过 stdin 传递提示词 */
  stdinPrompt?: boolean;
  /** 自定义命令：输出解析模式 */
  outputFormat?: CustomOutputFormat;
  /** 实例级默认隔离方式覆盖 */
  defaultIsolation?: Isolation | null;
  /** 实例级最高权限档位覆盖（只收紧、不放宽） */
  maxProfile?: AgentProfile | null;
  /** 启动该实例前是否必须先弹人工确认卡（默认 false：在已授权工作区与隔离沙盒内直接启动，越界操作仍需审批） */
  requireStartApproval?: boolean;
};

export type AgentEnvVarInput = {
  name: string;
  value?: string;
  sensitive?: boolean;
  /** 更新已有实例时保留已加密保存的原值（前端未改动密文输入框时传 true） */
  keepExisting?: boolean;
};

export type AgentEnvVarView = {
  name: string;
  /** sensitive=true 时始终返回空字符串脱敏 */
  value: string;
  sensitive: boolean;
  hasValue: boolean;
};

export type AgentAvailability =
  | "available"
  | "missing"
  | "unauthenticated"
  | "error"
  | "unknown";

export type AgentProbeState = {
  status: AgentAvailability;
  version: string | null;
  resolvedPath: string | null;
  authenticated: boolean | null;
  authLabel: string | null;
  message: string | null;
  checkedAt: string;
};

export type AgentInstanceView = {
  id: string;
  slug: string;
  environmentId: AgentEnvironmentId;
  environmentName: string;
  environmentOnline: boolean;
  driver: AgentDriverKind;
  name: string;
  description: string;
  enabled: boolean;
  exposeAsTool: boolean;
  toolName: string;
  isDefaultSeed: boolean;
  sortOrder: number;
  config: AgentDriverConfig;
  envVars: AgentEnvVarView[];
  probe: AgentProbeState | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentEnvironmentSummary = {
  id: AgentEnvironmentId;
  name: string;
  kind: "server" | "device";
  online: boolean;
  platform: string | null;
  profile: AgentProfile;
  isolation: Isolation;
  network: boolean;
  workspaceRoots: string[];
  detectedAt: string | null;
  instanceCount: number;
  enabledCount: number;
};

export type RuntimeInstanceSpec = {
  id: string;
  slug: string;
  name: string;
  driver: AgentDriverKind;
  config: AgentDriverConfig;
  /** 仅服务端在派发任务或探活时解密填入，绝不回传前端 */
  env: Record<string, string>;
};

export const BOT_AGENT_GRANT_MODES = ["all", "selected", "none"] as const;
export type BotAgentGrantMode = (typeof BOT_AGENT_GRANT_MODES)[number];

export type BotAgentGrant = {
  botId: string;
  mode: BotAgentGrantMode;
  instanceIds: string[];
  exposeNamedTools: boolean;
  allowNestedSubagents: boolean;
  maxDepth: number;
  updatedAt: string | null;
};

export function defaultBotAgentGrant(botId: string): BotAgentGrant {
  return {
    botId,
    mode: "all",
    instanceIds: [],
    exposeNamedTools: true,
    allowNestedSubagents: true,
    maxDepth: 3,
    updatedAt: null,
  };
}

export type AcpRegistryEntry = {
  id: string;
  name: string;
  version: string | null;
  description: string;
  vendor: string | null;
  homepage: string | null;
  iconUrl: string | null;
  launcher: "npx" | "uvx" | "binary";
  packageSpec: string | null;
  args: string[];
  binaryUrl?: string | null;
  envHints?: string[];
};

export type AgentProviderPreset = {
  key: string;
  name: string;
  slug: string;
  driver: AgentDriverKind;
  vendor: string;
  description: string;
  config: AgentDriverConfig;
};

export const AGENT_PROVIDER_PRESETS: readonly AgentProviderPreset[] = [
  {
    key: "codex",
    name: "Codex",
    slug: "codex",
    driver: "codex",
    vendor: "OpenAI",
    description: "擅长复杂代码库检索、架构重构、自动化修复与测试验证。",
    config: { commandPath: "codex", homePath: "~/.codex" },
  },
  {
    key: "claude",
    name: "Claude Code",
    slug: "claude",
    driver: "claude",
    vendor: "Anthropic",
    description: "擅长全栈工程实现、深度代码审阅、长上下文分析与精细编辑。",
    config: { commandPath: "claude" },
  },
  {
    key: "antigravity",
    name: "Antigravity",
    slug: "antigravity",
    driver: "antigravity",
    vendor: "Google",
    description:
      "Google Antigravity 智能体，擅长多步工程规划、前后端开发与推理任务。",
    config: { commandPath: "agy", fixProxy: true, protocolMode: "auto" },
  },
  {
    key: "codebuddy",
    name: "Codebuddy Code",
    slug: "codebuddy",
    driver: "acp",
    vendor: "Tencent",
    description:
      "Codebuddy 智能编码助手（ACP 协议），擅长快速代码编写与中文化工程协作。",
    config: {
      acpSource: "registry",
      acpAgentId: "codebuddy",
      acpLauncher: "npx",
      acpPackage: "@tencent-ai/codebuddy-code",
      commandPath: "codebuddy",
      extraArgs: ["--acp"],
    },
  },
  {
    key: "devin",
    name: "Devin",
    slug: "devin",
    driver: "acp",
    vendor: "Cognition",
    description: "Devin 自主软件工程智能体（ACP Registry）。",
    config: {
      acpSource: "registry",
      acpAgentId: "devin",
      acpLauncher: "binary",
      commandPath: "devin",
      extraArgs: ["acp"],
    },
  },
  {
    key: "opencode",
    name: "OpenCode",
    slug: "opencode",
    driver: "opencode",
    vendor: "SST",
    description: "轻量开源命令行编程智能体。",
    config: { commandPath: "opencode" },
  },
  {
    key: "gemini",
    name: "Gemini CLI",
    slug: "gemini",
    driver: "gemini",
    vendor: "Google",
    description: "Google Gemini 命令行助手，适合大上下文资料分析与代码生成。",
    config: { commandPath: "gemini" },
  },
  {
    key: "aider",
    name: "Aider",
    slug: "aider",
    driver: "aider",
    vendor: "Aider",
    description: "专注多文件精准修改的开源结对编程工具。",
    config: { commandPath: "aider" },
  },
  {
    key: "custom",
    name: "自定义命令智能体",
    slug: "custom-agent",
    driver: "custom",
    vendor: "Custom",
    description: "运行自定义脚本或第三方 CLI 智能体。",
    config: { stdinPrompt: true, outputFormat: "text", extraArgs: [] },
  },
  {
    key: "builtin",
    name: "ChisaBot 内置代理",
    slug: "builtin",
    driver: "builtin",
    vendor: "ChisaBot",
    description:
      "无需额外安装外部 CLI，直接使用 ChisaBot 内置文件与命令循环完成任务。",
    config: {},
  },
];

/** 规范化实例唯一标识 slug（仅保留小写字母、数字与连字符，首尾无连字符）。 */
export function normalizeInstanceSlug(raw: string, fallback = "agent"): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

/** 将实例 slug 转为合法的 LLM 工具函数名（agent_<slug>）。 */
export function agentToolName(slug: string): string {
  const safe = normalizeInstanceSlug(slug)
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return `agent_${safe || "instance"}`;
}

export type SubagentInvocationMode = "wait" | "async";

export const SUBAGENT_DIRECT_META_PREFIX = "⟦chisabot:subagent-target:";
