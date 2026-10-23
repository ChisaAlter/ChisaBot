/**
 * 个人日程与收件箱只读接入（CB-013）+ 每日晨报（CB-014）。
 */

export type CalendarConnectionView = {
  label: string;
  urlHint: string;
  eventCount: number;
  connectedAt: string;
  checkedAt: string;
};

export type EmailConnectionView = {
  email: string;
  imapHost: string;
  imapPort: number;
  hint: string;
  unreadCount: number;
  connectedAt: string;
  checkedAt: string;
};

export type PersonalSourcesStatusView = {
  calendar: CalendarConnectionView | null;
  email: EmailConnectionView | null;
  weatherCity: string;
};

export type CalendarEventItem = {
  uid: string;
  summary: string;
  startIso: string;
  endIso?: string | undefined;
  allDay: boolean;
  location?: string | undefined;
  description?: string | undefined;
};

export type EmailSummaryItem = {
  seq: number;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
};

export const IMAP_PRESETS: Record<string, { host: string; port: number; label: string }> = {
  "qq.com": { host: "imap.qq.com", port: 993, label: "QQ 邮箱" },
  "foxmail.com": { host: "imap.qq.com", port: 993, label: "Foxmail" },
  "163.com": { host: "imap.163.com", port: 993, label: "网易 163" },
  "126.com": { host: "imap.126.com", port: 993, label: "网易 126" },
  "gmail.com": { host: "imap.gmail.com", port: 993, label: "Gmail" },
  "outlook.com": { host: "outlook.office365.com", port: 993, label: "Outlook" },
  "hotmail.com": { host: "outlook.office365.com", port: 993, label: "Hotmail" },
  "icloud.com": { host: "imap.mail.me.com", port: 993, label: "iCloud Mail" },
};
