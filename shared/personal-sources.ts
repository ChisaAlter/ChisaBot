/**
 * 个人日程与收件箱只读接入（CB-013）+ 每日晨报（CB-014）。
 */

export type CalendarConnectionView = {
  label: string;
  urlHint: string;
  eventCount: number;
  connectedAt: string;
  checkedAt: string;
  timeZone?: string;
};

export type EmailConnectionView = {
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost?: string;
  smtpPort?: number;
  hint: string;
  unreadCount: number;
  connectedAt: string;
  checkedAt: string;
};

export type NotifyWebhookView = {
  kind:
    | "feishu"
    | "dingtalk"
    | "wecom"
    | "bark"
    | "serverchan"
    | "custom"
    | "demo";
  label: string;
  urlHint: string;
  connectedAt: string;
};

export type InboundWebhookView = {
  token: string;
  path: string;
  lastTriggeredAt: string | null;
  lastSummary: string | null;
};

export type PersonalSourcesStatusView = {
  calendar: CalendarConnectionView | null;
  email: EmailConnectionView | null;
  weatherCity: string;
  notifyWebhook?: NotifyWebhookView | null;
  inboundWebhook?: InboundWebhookView | null;
  deliveries?: PersonalDeliveryView[];
};

export type CalendarEventItem = {
  uid: string;
  summary: string;
  startIso: string;
  endIso?: string | undefined;
  allDay: boolean;
  timeZone?: string;
  startDate?: string;
  location?: string | undefined;
  description?: string | undefined;
};

export type SourceRead<T> = {
  state: "fresh" | "cached" | "unavailable" | "not_connected";
  items: T[];
  checkedAt: string | null;
  error?: string;
};

export type PersonalDeliveryEvidence = {
  type: "personal_delivery";
  id: string;
  channel: "smtp" | "notify";
  state: "accepted";
  providerMessageIds: string[];
  summary: string;
};

export function parsePersonalDeliveryEvidence(
  content: unknown,
): PersonalDeliveryEvidence | null {
  try {
    const value = typeof content === "string" ? JSON.parse(content) : content;
    return value &&
      value.type === "personal_delivery" &&
      typeof value.id === "string" &&
      value.id.length > 0 &&
      (value.channel === "smtp" || value.channel === "notify") &&
      value.state === "accepted" &&
      Array.isArray(value.providerMessageIds) &&
      value.providerMessageIds.every((id: unknown) => typeof id === "string") &&
      typeof value.summary === "string"
      ? (value as PersonalDeliveryEvidence)
      : null;
  } catch {
    return null;
  }
}

export type PersonalDeliveryView = {
  id: string;
  kind: "smtp" | "notify";
  state:
    | "queued"
    | "sending"
    | "sent"
    | "failed"
    | "outcome_unknown"
    | "cancelled";
  title: string;
  target: string;
  error: string | null;
  createdAt: string;
};

export type EmailSummaryItem = {
  seq: number;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
};

export const IMAP_PRESETS: Record<
  string,
  { host: string; port: number; label: string }
> = {
  "qq.com": { host: "imap.qq.com", port: 993, label: "QQ 邮箱" },
  "foxmail.com": { host: "imap.qq.com", port: 993, label: "Foxmail" },
  "163.com": { host: "imap.163.com", port: 993, label: "网易 163" },
  "126.com": { host: "imap.126.com", port: 993, label: "网易 126" },
  "gmail.com": { host: "imap.gmail.com", port: 993, label: "Gmail" },
  "outlook.com": { host: "outlook.office365.com", port: 993, label: "Outlook" },
  "hotmail.com": { host: "outlook.office365.com", port: 993, label: "Hotmail" },
  "icloud.com": { host: "imap.mail.me.com", port: 993, label: "iCloud Mail" },
};
