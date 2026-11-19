/**
 * 多 Webhook 规则管理面板与 7 态执行流水（前后端共用契约）。
 */

export const WEBHOOK_TRIGGER_KINDS = [
  "webhook",
  "github",
  "linear",
  "sentry",
  "pagerduty",
] as const;

export type WebhookTriggerKind = (typeof WEBHOOK_TRIGGER_KINDS)[number];

export const WEBHOOK_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "skipped",
] as const;

export type WebhookRunStatus = (typeof WEBHOOK_RUN_STATUSES)[number];

export const WEBHOOK_RULE_QUOTA_PER_USER = 30;

export type WebhookRuleView = {
  id: string;
  responsibilityId: string;
  title: string;
  agentId: string;
  instruction: string;
  kind: WebhookTriggerKind;
  enabled: boolean;
  hasSecret: boolean;
  ingressPath: string;
  repository?: string;
  eventTypes: string[];
  fieldFilter?: { path: string; equals: string };
  createdAt: string;
  updatedAt: string;
};

export type WebhookRunView = {
  id: string;
  triggerId: string | null;
  responsibilityId: string;
  ruleTitle: string;
  source: string;
  eventType: string;
  status: WebhookRunStatus;
  replyPreview: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WebhookRulesListResponse = {
  rules: WebhookRuleView[];
  quota: { used: number; limit: number };
};

export type WebhookRunsListResponse = {
  runs: WebhookRunView[];
  counts: Record<WebhookRunStatus, number>;
};

export type WebhookVendorMeta = {
  kind: WebhookTriggerKind;
  label: string;
  generatedSecret: boolean;
  signatureHeader: string;
  note: string;
};

export const WEBHOOK_VENDOR_META: Readonly<
  Record<WebhookTriggerKind, WebhookVendorMeta>
> = {
  webhook: {
    kind: "webhook",
    label: "通用 Webhook（Standard / Bearer）",
    generatedSecret: true,
    signatureHeader: "webhook-signature 或 Authorization: Bearer",
    note: "由 ChisaBot 自动生成一次性 whsec_ 签名密钥，支持 Standard Webhooks HMAC-SHA256 与 Bearer Token。",
  },
  github: {
    kind: "github",
    label: "GitHub Webhook",
    generatedSecret: true,
    signatureHeader: "X-Hub-Signature-256",
    note: "由 ChisaBot 自动生成密钥，可限定仓库 owner/name 与事件类型（如 issues、pull_request）。",
  },
  linear: {
    kind: "linear",
    label: "Linear Webhook",
    generatedSecret: false,
    signatureHeader: "Linear-Signature",
    note: "创建规则后复制入口地址到 Linear，再把 Linear 生成的 Signing Secret 粘贴回来即可激活。",
  },
  sentry: {
    kind: "sentry",
    label: "Sentry Webhook",
    generatedSecret: false,
    signatureHeader: "Sentry-Hook-Signature",
    note: "在 Sentry Internal Integration 填写入口地址，再粘贴 Client Secret 启用验签。",
  },
  pagerduty: {
    kind: "pagerduty",
    label: "PagerDuty V3 Webhook",
    generatedSecret: false,
    signatureHeader: "X-PagerDuty-Signature",
    note: "在 PagerDuty V3 Webhook 填写入口地址，再粘贴订阅密钥启用多签名轮换校验。",
  },
};

export const WEBHOOK_RUN_STATUS_LABELS: Readonly<
  Record<WebhookRunStatus, string>
> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  skipped: "已跳过",
};
