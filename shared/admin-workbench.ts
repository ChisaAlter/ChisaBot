/**
 * 白盒可观测与能力控制共享契约：
 * - 本地时区 + 按用途（kind）+ 思考 Token（reasoning）细分用量账本
 * - 按需脱敏抓包观测器
 * - Harness 高影响 AI 能力热开关台
 */

import type { ResolvedReasoningEffort } from "./model-routing";

export const USAGE_KINDS = [
  "chat",
  "summary",
  "classifier",
  "review",
  "test",
  "suggestions",
  "completion",
  "title",
  "vision",
  "automation",
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  chat: "对话回复",
  summary: "历史摘要",
  classifier: "难度路由分类",
  review: "内容审查",
  test: "连通性 / 试跑测试",
  suggestions: "输入建议",
  completion: "行内补全",
  title: "标题生成",
  vision: "图像理解",
  automation: "自动化任务",
};

export type UsageBucketTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
};

export type UsageModelBreakdown = UsageBucketTotals & {
  modelId: string;
};

export type UsageDayBreakdown = UsageBucketTotals & {
  day: string;
};

export type UsageWindowBreakdown = {
  startDay: string;
  endDay: string;
  totals: UsageBucketTotals;
  byKind: Record<UsageKind, UsageBucketTotals>;
  byModel: UsageModelBreakdown[];
  byDay: UsageDayBreakdown[];
};

export type UsageBreakdownResponse = {
  timeZone: string;
  generatedAt: string;
  today: UsageWindowBreakdown;
  last7Days: UsageWindowBreakdown;
  last30Days: UsageWindowBreakdown;
};

export type ObservedImageDigest = {
  sha256: string;
  mediaType: string;
  bytes: number;
};

export type ObservedToolSummary = {
  name: string;
  durationMs?: number;
};

export type ModelObservationRecord = {
  id: string;
  recordedAt: string;
  provider: string;
  model: string;
  effort: ResolvedReasoningEffort | null;
  status: number | null;
  durationMs: number;
  requestId: string | null;
  tools: ObservedToolSummary[];
  images: ObservedImageDigest[];
  redactedSummary: string;
  errorCode: string | null;
};

export type ModelObservationSnapshot = {
  enabled: boolean;
  capacity: number;
  count: number;
  items: ModelObservationRecord[];
};

export const HARNESS_FLAG_KEYS = [
  "memoryDreaming",
  "interactiveForms",
  "browserSubagent",
  "cookieImport",
  "passkeyForward",
  "desktopControl",
  "teachByDemo",
] as const;

export type HarnessFlagKey = (typeof HARNESS_FLAG_KEYS)[number];

export type HarnessFlags = Record<HarnessFlagKey, boolean>;

export type HarnessFlagDescriptor = {
  key: HarnessFlagKey;
  title: string;
  description: string;
  defaultValue: boolean;
  consumesTokens?: boolean;
};

export const DEFAULT_HARNESS_FLAGS: Readonly<HarnessFlags> = Object.freeze({
  memoryDreaming: false,
  interactiveForms: true,
  browserSubagent: true,
  cookieImport: true,
  passkeyForward: true,
  desktopControl: true,
  teachByDemo: true,
});

/** 已接入真实后端运行时的 Harness 能力开关列表（隐藏未实现的假开关，数据库列仍保留以保证回滚安全）。 */
export const HARNESS_FLAG_DESCRIPTORS: readonly HarnessFlagDescriptor[] = [
  {
    key: "browserSubagent",
    title: "浏览器子 Agent（Browser Subagent）",
    description: "允许机器人调度隔离云端浏览器执行网页浏览、截图与表单操作。",
    defaultValue: true,
  },
  {
    key: "cookieImport",
    title: "浏览器登录态导入（Cookie Import）",
    description: "允许从受信任的桌面端导入指定站点的浏览器登录状态。",
    defaultValue: true,
  },
  {
    key: "passkeyForward",
    title: "通行密钥转发（Passkey Forward）",
    description: "经配对客户端转发 WebAuthn / Passkey 认证流程。",
    defaultValue: true,
  },
  {
    key: "desktopControl",
    title: "桌面图形操作（Desktop Control）",
    description: "允许在已授权的本机桌面节点执行鼠标点击、键盘输入与窗口控制。",
    defaultValue: true,
  },
  {
    key: "teachByDemo",
    title: "演示教学录制（Teach by Demo）",
    description: "录制人工操作演示并自动整理为可复用的技能与步骤流程。",
    defaultValue: true,
  },
];

export type HarnessSettingsView = {
  flags: HarnessFlags;
  updatedAt: string | null;
  updatedBy: string | null;
  descriptors: readonly HarnessFlagDescriptor[];
};
