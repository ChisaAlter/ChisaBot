/**
 * Wave 8 共享契约：
 * 1. AI 自研可执行微应用 / MCP 插件包单 JSON Schema（`chisabot-app/v1`）；
 * 2. 远端 MCP 连接器增强配置（SSE / 自定义加密 Header / OAuth2 / customInstructions / 单工具启停 / mcp-last-good）；
 * 3. 远程执行节点可视化热配置与热切换视图。
 */

export const CHISABOT_APP_FORMAT = "chisabot-app/v1" as const;

/** 单包解码后总字节上限：2 MiB。 */
export const MAX_APP_PACKAGE_BYTES = 2 * 1024 * 1024;
/** 单包文件数上限。 */
export const MAX_APP_PACKAGE_FILES = 128;
/** 单文件解码后字节上限：1 MiB。 */
export const MAX_APP_SINGLE_FILE_BYTES = 1024 * 1024;
/** 图标文件字节上限：250 KiB（仅限 PNG / JPEG / WebP，禁 SVG）。 */
export const MAX_APP_ICON_BYTES = 250 * 1024;
/** 配置项数量上限。 */
export const MAX_APP_CONFIG_FIELDS = 30;
/** 捆绑技能数量上限。 */
export const MAX_APP_SKILLS = 50;
/** 声明的外部网络源上限。 */
export const MAX_APP_NETWORK_ORIGINS = 30;
/** 沙箱进程默认 / 最小 / 最大 V8 堆内存上限（MiB）。 */
export const DEFAULT_APP_MEMORY_LIMIT_MB = 128;
export const MIN_APP_MEMORY_LIMIT_MB = 32;
export const MAX_APP_MEMORY_LIMIT_MB = 512;
/** 沙箱单次工具调用默认 / 最大超时（毫秒）。 */
export const DEFAULT_APP_TIMEOUT_MS = 30_000;
export const MIN_APP_TIMEOUT_MS = 1_000;
export const MAX_APP_TIMEOUT_MS = 60_000;

export const APP_RUNTIME_KINDS = [
  "node-stdio",
  "remote-mcp",
  "skills-only",
] as const;
export type AppRuntimeKind = (typeof APP_RUNTIME_KINDS)[number];

export const APP_PACKAGE_STATUSES = ["draft", "installed", "disabled"] as const;
export type AppPackageStatus = (typeof APP_PACKAGE_STATUSES)[number];

export const MCP_TRANSPORT_MODES = ["auto", "streamable-http", "sse"] as const;
export type McpTransportMode = (typeof MCP_TRANSPORT_MODES)[number];

export type LocalizedText = {
  en: string;
  "zh-CN": string;
};

export type AppPackageFile = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  bytes?: number;
  sha256?: string;
};

export type AppConfigField = {
  key: string;
  name: LocalizedText;
  description?: LocalizedText;
  secret: boolean;
  required: boolean;
  /** 仅非密字段可声明默认值；secret 字段严禁携带默认值。 */
  defaultValue?: string;
};

export type AppOAuthSpec =
  | {
      type: "oauth2";
      authorizationUrl: string;
      tokenUrl: string;
      scopes: string[];
      clientId?: string;
      authorizationParams?: Record<string, string>;
    }
  | {
      type: "bearer";
      headerName?: string;
    }
  | {
      type: "api-key";
      headerName: string;
    };

export type AppRuntimeSpec =
  | {
      kind: "node-stdio";
      entry: string;
      memoryLimitMb?: number;
      timeoutMs?: number;
    }
  | {
      kind: "remote-mcp";
      url: string;
      transport: McpTransportMode;
      /** 仅声明需要用户填写的自定义 Header 名称，严禁包含任何凭据值。 */
      customHeaders?: string[];
    }
  | {
      kind: "skills-only";
    };

export type AppSkillEntry = {
  id: string;
  path: string;
  name: LocalizedText;
  description: LocalizedText;
  requiresTools: string[];
};

export type AppPermissions = {
  /** 精确的外部 HTTPS origin 白名单声明（例如 https://api.github.com）。 */
  network: string[];
  workspace: "none";
};

export type ChisaAppPackage = {
  format: typeof CHISABOT_APP_FORMAT;
  id: string;
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  publisher: string;
  license: string;
  icon?: string;
  runtime: AppRuntimeSpec;
  files: AppPackageFile[];
  configSchema: AppConfigField[];
  oauth?: AppOAuthSpec;
  skills: AppSkillEntry[];
  permissions: AppPermissions;
  dependencies?: Record<string, string>;
  /** 对规范化包内容计算的确定性 SHA-256 十六进制摘要（不含任何用户密文或令牌）。 */
  packageDigest: string;
};

export type AppPackageValidationIssue = {
  path: string;
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type AppPackageValidationResult = {
  valid: boolean;
  errors: AppPackageValidationIssue[];
  warnings: AppPackageValidationIssue[];
  normalized?: ChisaAppPackage;
  digest?: string;
  totalBytes: number;
  fileCount: number;
};

export type AppPackageRevisionSummary = {
  digest: string;
  version: string;
  createdAt: string;
  createdBy: string;
  runtimeKind: AppRuntimeKind;
  fileCount: number;
};

export type AppPackageSummary = {
  id: string;
  status: AppPackageStatus;
  installed: boolean;
  enabled: boolean;
  currentDigest: string;
  /** 用户最后一次显式审阅并批准执行的不可变包摘要；升级未重审时与 currentDigest 不同。 */
  approvedDigest: string | null;
  needsReview: boolean;
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  publisher: string;
  license: string;
  runtime: AppRuntimeSpec;
  permissions: AppPermissions;
  configSchema: AppConfigField[];
  configuredKeys: string[];
  nonSecretValues: Record<string, string>;
  oauth?: AppOAuthSpec;
  oauthConnected: boolean;
  oauthScopes: string[];
  skills: AppSkillEntry[];
  iconDataUrl: string | null;
  revisions: AppPackageRevisionSummary[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type AppPackageFilePreview = {
  path: string;
  encoding: "utf8" | "base64";
  bytes: number;
  sha256: string;
  preview: string | null;
  truncated: boolean;
};

export type AppPackageDetail = AppPackageSummary & {
  files: AppPackageFilePreview[];
  package: ChisaAppPackage;
};

// ── 远端 MCP 连接器增强视图 ───────────────────────────────────────────────

export type McpLastGoodToolSnapshot = {
  name: string;
  description: string;
  effect?: "read" | "write";
  destructive?: boolean;
};

export type McpLastGoodSnapshot = {
  tools: McpLastGoodToolSnapshot[];
  capturedAt: string;
  degraded: boolean;
  lastProbeError: string | null;
};

export type McpCustomOAuthPublicView = {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId?: string;
  hasClientSecret: boolean;
  hasToken: boolean;
  expiresAt: string | null;
};

export type McpServerEnhancementView = {
  serverId: string;
  transport: McpTransportMode;
  customInstructions: string;
  disabledTools: string[];
  customHeaderKeys: string[];
  oauth: McpCustomOAuthPublicView | null;
  lastGood: McpLastGoodSnapshot | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type McpServerEnhancementPatch = {
  transport?: McpTransportMode;
  customInstructions?: string;
  disabledTools?: string[];
  /** 仅传新增或覆写的 Header；空字符串表示删除该 Header。 */
  customHeaders?: Record<string, string>;
  clearHeaderKeys?: string[];
  oauth?: {
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string | null;
  } | null;
};

// ── 远程执行节点热切换视图 ────────────────────────────────────────────────

export type ExecutionNodeHealthStatus = "healthy" | "unhealthy" | "unknown";

export type ExecutionNodeHealthDetail = {
  status?: number;
  latencyMs?: number;
  protocol?: string;
  ready?: boolean;
  services?: Record<string, unknown>;
  error?: string;
};

export type ExecutionNodeView = {
  id: string;
  name: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  hasToken: boolean;
  isActive: boolean;
  lastHealthStatus: ExecutionNodeHealthStatus;
  lastHealthCheckedAt: string | null;
  lastHealthDetail: ExecutionNodeHealthDetail | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionNodeInput = {
  id?: string;
  name: string;
  baseUrl: string;
  token?: string;
  clearToken?: boolean;
  allowPrivateNetwork?: boolean;
};

export type ExecutionNodeHealthResult = {
  ok: boolean;
  status?: number;
  latencyMs: number;
  protocol?: string;
  ready?: boolean;
  services?: Record<string, unknown>;
  error?: string;
};

export type ExecutionNodesListResponse = {
  nodes: ExecutionNodeView[];
  activeNodeId: string | null;
  staticFallbackConfigured: boolean;
  staticFallbackProvider: string | null;
};
