/**
 * 个人日程与收件箱轻量只读接入（CB-013）+ 每日晨报卡片生成（CB-014）。
 *
 * - 日历：支持 iCal / ICS 订阅地址（Google / Apple iCloud / Outlook / 飞书）或直接粘贴 .ics 内容；
 * - 邮箱：支持 IMAP over TLS 只读拉取最近邮件与未读邮件摘要，密码用 AES-256-GCM 加密存库；
 * - 每日晨报：聚合今日日期、实时天气、日程安排、未读邮件、定时提醒与长期记忆要点，输出 ```brief 卡片。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as tls from "node:tls";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { guardedFetch, resolvePublic } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl, isBlockedHostname } from "../../../shared/net/ssrf";
import type {
  CalendarConnectionView,
  CalendarEventItem,
  EmailConnectionInput,
  EmailConnectionView,
  EmailSummaryItem,
  InboundWebhookView,
  NotifyWebhookView,
  PersonalDeliveryEvidence,
  PersonalSourcesStatusView,
  SourceRead,
} from "../../../shared/personal-sources";
import type { AppVariables } from "../auth/guards";
import {
  currentConfirmToolCall,
  currentConfirmTurn,
  currentToolAbort,
} from "../confirmations/context";
import type { Database } from "../db/client";
import {
  DeliveryOutcomeUnknownError,
  DeliveryRejectedError,
} from "../delivery/durable-dispatch";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { parseIcsEvents } from "./calendar";
import { createPersonalDelivery, type PersonalSendContext } from "./delivery";
import { sendWebhook } from "./notify";
import {
  type SmtpMessage,
  sendSmtpMessage,
  verifySmtpConnection,
} from "./smtp";

export { parseIcsEvents } from "./calendar";

export type PersonalSourcesOptions = {
  encryptionKey: string;
  fetchFn?: typeof fetch;
  allowDemo?: boolean;
  readInbox?: typeof fetchImapInboxSummary;
  sendMail?: (message: SmtpMessage) => Promise<string[]>;
  verifyMail?: typeof verifySmtpConnection;
};

type PersonalSourceRow = {
  owner_user_id: string;
  calendar_label: string | null;
  calendar_timezone?: string;
  calendar_ics_enc: string | null;
  calendar_url_hint: string | null;
  calendar_event_count: number;
  calendar_connected_at: string | Date | null;
  calendar_checked_at: string | Date | null;
  email_address: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_pass_enc: string | null;
  imap_pass_hint: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  smtp_checked_at: string | Date | null;
  email_connected_at: string | Date | null;
  email_checked_at: string | Date | null;
  weather_city: string;
  cached_events: CalendarEventItem[] | string | null;
  cached_emails: EmailSummaryItem[] | string | null;
  notify_webhook_enc?: string | null;
  notify_webhook_kind?: string | null;
  notify_webhook_label?: string | null;
  notify_webhook_hint?: string | null;
  notify_connected_at?: string | Date | null;
  inbound_webhook_token?: string | null;
  inbound_last_at?: string | Date | null;
  inbound_last_summary?: string | null;
};

function deriveKey(secret: string): Buffer {
  return createHash("sha256")
    .update(`chisabot-personal-sources:${secret}`)
    .digest();
}

function encryptText(plain: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decryptText(payload: string, secret: string): string {
  const [ivB64, tagB64, encB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("密文格式损坏");
  const key = deriveKey(secret);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

function decodeMimeWords(str: string): string {
  return str
    .replace(
      /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g,
      (_full, charset: string, encoding: string, data: string) => {
        try {
          const enc = encoding.toUpperCase();
          if (enc === "B") {
            return new TextDecoder(charset).decode(Buffer.from(data, "base64"));
          }
          if (enc === "Q") {
            const qFixed = data.replace(/_/g, " ");
            const bytes: number[] = [];
            for (let i = 0; i < qFixed.length; i++) {
              if (
                qFixed[i] === "=" &&
                /^[0-9A-Fa-f]{2}$/.test(qFixed.slice(i + 1, i + 3))
              ) {
                bytes.push(Number.parseInt(qFixed.slice(i + 1, i + 3), 16));
                i += 2;
              } else {
                bytes.push(qFixed.charCodeAt(i));
              }
            }
            return new TextDecoder(charset).decode(new Uint8Array(bytes));
          }
        } catch {
          // fallback
        }
        return data;
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

function quoteImap(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class WebhookRateLimitError extends Error {
  constructor(message = "Webhook 请求过于频繁，请稍后再试。") {
    super(message);
    this.name = "WebhookRateLimitError";
  }
}

export type ScannedEmailSummary = EmailSummaryItem & {
  messageId?: string;
  mailboxUid?: string;
};

export function parseImapSummaryResponse(
  buffer: string,
  uidValidity: string,
): ScannedEmailSummary[] {
  if (/^A3 (?:NO|BAD)/m.test(buffer))
    throw new Error("IMAP 服务器拒绝读取邮件摘要。");
  if (!/^A3 OK/m.test(buffer))
    throw new Error("IMAP 服务器未完成读取邮件摘要。");
  const rawBlocks = [
    ...buffer.matchAll(
      /^\*\s+(\d+)\s+FETCH\b([\s\S]*?)(?=^\*\s+\d+\s+FETCH\b|^A3\s|$(?![\s\S]))/gm,
    ),
  ];
  return rawBlocks
    .map((match) => {
      const block = match[2] ?? "";
      const metadata = block.slice(
        0,
        block.indexOf("\n") < 0 ? block.length : block.indexOf("\n"),
      );
      const header = (name: string) =>
        new RegExp(`^${name}:\\s*(.+?)(?:\\r?\\n(?![ \\t])|$)`, "ims")
          .exec(block)?.[1]
          ?.trim();
      const messageId = header("Message-ID");
      const uid = /\bUID\s+(\d+)/i.exec(metadata)?.[1];
      return {
        seq: Number(match[1]),
        subject: decodeMimeWords(header("Subject") ?? "（无主题）").slice(
          0,
          140,
        ),
        from: decodeMimeWords(header("From") ?? "未知发件人").slice(0, 100),
        date: header("Date") ?? "",
        unread: !/FLAGS\s*\([^)]*\\Seen\b/i.test(metadata),
        ...(messageId ? { messageId } : {}),
        ...(uid && uidValidity ? { mailboxUid: `${uidValidity}:${uid}` } : {}),
      };
    })
    .reverse();
}

/** 隔离验收用的演示收件箱。只有 `allowDemo`（测试环境）才会走到这里；真实连接函数不认演示地址。 */
function demoInboxSummary(limit: number): ScannedEmailSummary[] {
  const now = new Date();
  return [
    {
      seq: 103,
      subject: "【架构评审】ChisaBot v2.4 晨报与卡片交互上线确认",
      from: "产品团队 <team@chisabot.example>",
      date: now.toISOString(),
      unread: true,
    },
    {
      seq: 102,
      subject: "GitHub 安全周报：本周依赖扫描 0 高危漏洞",
      from: "GitHub <noreply@github.com>",
      date: new Date(now.getTime() - 3600_000 * 3).toISOString(),
      unread: true,
    },
    {
      seq: 101,
      subject: "云服务器月度账单与资源续费提醒",
      from: "云平台通知 <billing@cloud.example.com>",
      date: new Date(now.getTime() - 3600_000 * 18).toISOString(),
      unread: false,
    },
  ].slice(0, limit);
}

/** IMAP over TLS (993) or the registered IMAP port (143); anything else is not a mail server. */
export const IMAP_PORTS: ReadonlySet<number> = new Set([143, 993]);

export async function fetchImapInboxSummary(input: {
  host: string;
  port: number;
  user: string;
  pass: string;
  limit?: number;
  /** Test seam for DNS; production uses the system resolver. */
  resolve?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
}): Promise<ScannedEmailSummary[]> {
  const limit = Math.max(1, Math.min(20, input.limit ?? 8));
  if (
    /[\r\n\0]/.test(input.host) ||
    /[\r\n\0]/.test(input.user) ||
    /[\r\n\0]/.test(input.pass)
  ) {
    throw new Error("邮箱配置参数不能包含换行或控制字符。");
  }

  if (!IMAP_PORTS.has(input.port))
    throw new Error("IMAP 端口只能是 993（TLS）或 143。");
  const cleanHost = input.host.trim();
  if (isBlockedHostname(cleanHost))
    throw new Error("不能连接内网或本机 IMAP 服务器地址。");
  // 解析一次、检查全部解析结果，再钉死连这个地址（防 DNS 重绑定）；证书仍按主机名校验。
  let pinned: { address: string; family: number };
  try {
    pinned = await (input.resolve
      ? resolvePublic(cleanHost, { resolve: input.resolve })
      : resolvePublic(cleanHost));
  } catch {
    throw new Error("不能连接内网或本机 IMAP 服务器地址。");
  }

  return new Promise<ScannedEmailSummary[]>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: pinned.address,
        port: input.port,
        servername: cleanHost,
        rejectUnauthorized: true,
      },
      () => {
        // connected
      },
    );

    let buffer = "";
    let step: "greet" | "login" | "select" | "fetch" | "done" = "greet";
    let totalMessages = 0;
    let uidValidity = "";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          "连接 IMAP 服务器超时（8 秒），请检查服务器地址、端口或应用专用密码。",
        ),
      );
    }, 8_000);

    const finish = (err?: Error, items?: ScannedEmailSummary[]) => {
      clearTimeout(timer);
      try {
        socket.end("A9 LOGOUT\r\n");
        socket.destroy();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(items ?? []);
    };

    socket.on("error", (err) => {
      finish(new Error(`IMAP 连接失败：${err.message}`));
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (step === "greet" && /\r?\n/.test(buffer)) {
        buffer = "";
        step = "login";
        socket.write(
          `A1 LOGIN ${quoteImap(input.user)} ${quoteImap(input.pass)}\r\n`,
        );
        return;
      }
      if (step === "login") {
        if (/^A1 OK/m.test(buffer)) {
          buffer = "";
          step = "select";
          socket.write("A2 EXAMINE INBOX\r\n");
        } else if (/^A1 (?:NO|BAD)/m.test(buffer)) {
          finish(
            new Error(
              "邮箱登录失败：请确认账号及「应用专用密码 / 授权码」是否正确。",
            ),
          );
        }
        return;
      }
      if (step === "select") {
        if (/^A2 OK/m.test(buffer)) {
          const existsMatch = /\*\s+(\d+)\s+EXISTS/i.exec(buffer);
          totalMessages = Number.parseInt(existsMatch?.[1] ?? "0", 10);
          uidValidity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(buffer)?.[1] ?? "";
          buffer = "";
          if (totalMessages <= 0) {
            step = "done";
            finish(undefined, []);
            return;
          }
          const startSeq = Math.max(1, totalMessages - limit + 1);
          step = "fetch";
          socket.write(
            `A3 FETCH ${startSeq}:${totalMessages} (UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)])\r\n`,
          );
        } else if (/^A2 (?:NO|BAD)/m.test(buffer)) {
          finish(new Error("无法打开收件箱 INBOX。"));
        }
        return;
      }
      if (step === "fetch") {
        if (/^A3 (?:OK|NO|BAD)/m.test(buffer)) {
          step = "done";
          try {
            finish(undefined, parseImapSummaryResponse(buffer, uidValidity));
          } catch (error) {
            finish(
              error instanceof Error ? error : new Error("邮件摘要无法解析。"),
            );
          }
        }
      }
    });
  });
}

const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "晴朗",
  1: "晴间多云",
  2: "多云",
  3: "阴天",
  45: "有雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "小雨",
  55: "中雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  80: "阵雨",
  95: "雷阵雨",
};

async function fetchWeatherSummary(
  city: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const cleanCity = city.trim() || "上海";
  try {
    const geoRes = await fetchImpl(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=zh&format=json`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!geoRes.ok) return `${cleanCity} · 天气暂时无法获取`;
    const geoJson = (await geoRes.json()) as {
      results?: { name?: string; latitude?: number; longitude?: number }[];
    };
    const loc = geoJson.results?.[0];
    if (
      !loc ||
      typeof loc.latitude !== "number" ||
      typeof loc.longitude !== "number"
    ) {
      return `${cleanCity} · 天气暂时无法获取`;
    }
    const wxRes = await fetchImpl(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!wxRes.ok) return `${cleanCity} · 天气暂时无法获取`;
    const wxJson = (await wxRes.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    if (
      typeof wxJson.current?.temperature_2m !== "number" ||
      typeof wxJson.current?.weather_code !== "number"
    )
      return `${cleanCity} · 天气数据不完整`;
    const temp = Math.round(wxJson.current.temperature_2m);
    const desc =
      WEATHER_CODE_LABELS[wxJson.current.weather_code] ?? "天气状况未知";
    const hi = wxJson.daily?.temperature_2m_max?.[0];
    const lo = wxJson.daily?.temperature_2m_min?.[0];
    const range =
      typeof hi === "number" && typeof lo === "number"
        ? ` (${Math.round(lo)}~${Math.round(hi)}°C)`
        : "";
    return `${cleanCity} · ${temp}°C ${desc}${range}`;
  } catch {
    return `${cleanCity} · 天气暂时无法获取`;
  }
}

function parseJsonArray<T>(val: unknown): T[] {
  if (Array.isArray(val)) return val as T[];
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIso(d: string | Date | null | undefined): string {
  if (!d) return new Date().toISOString();
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function createPersonalSources(
  database: Database,
  options: PersonalSourcesOptions,
) {
  const sql = database.$client;
  const fetchImpl = options.fetchFn ?? fetch;
  const readRealInbox = options.readInbox ?? fetchImapInboxSummary;
  const readInbox: typeof fetchImapInboxSummary = async (input) =>
    options.allowDemo &&
    (input.host === "demo.imap.local" || input.pass === "demo-inbox")
      ? demoInboxSummary(input.limit ?? 8)
      : readRealInbox(input);
  const delivery = createPersonalDelivery(database);

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_personal_sources (
        owner_user_id text PRIMARY KEY,
        calendar_label text,
        calendar_ics_enc text,
        calendar_url_hint text,
        calendar_event_count integer NOT NULL DEFAULT 0,
        calendar_connected_at timestamptz,
        calendar_checked_at timestamptz,
        email_address text,
        imap_host text,
        imap_port integer,
        imap_pass_enc text,
        imap_pass_hint text,
        email_connected_at timestamptz,
        email_checked_at timestamptz,
        weather_city text NOT NULL DEFAULT '上海',
        cached_events jsonb NOT NULL DEFAULT '[]'::jsonb,
        cached_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
        notify_webhook_enc text,
        notify_webhook_kind text,
        notify_webhook_label text,
        notify_webhook_hint text,
        notify_connected_at timestamptz,
        inbound_webhook_token text,
        inbound_last_at timestamptz,
        inbound_last_summary text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS calendar_timezone text NOT NULL DEFAULT 'Asia/Shanghai';
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS smtp_host text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS smtp_port integer;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS smtp_user text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS smtp_pass_enc text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS smtp_checked_at timestamptz;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS notify_webhook_enc text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS notify_webhook_kind text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS notify_webhook_label text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS notify_webhook_hint text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS notify_connected_at timestamptz;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS inbound_webhook_token text;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS inbound_last_at timestamptz;
      ALTER TABLE chisabot_personal_sources ADD COLUMN IF NOT EXISTS inbound_last_summary text;
    `);
    await delivery.ensure();
  }

  async function getRow(actorId: string): Promise<PersonalSourceRow | null> {
    const [row] = await sql.unsafe<PersonalSourceRow[]>(
      "SELECT * FROM chisabot_personal_sources WHERE owner_user_id = $1",
      [actorId],
    );
    return row ?? null;
  }

  function inferSmtpServer(emailOrImap: string): {
    host: string;
    port: number;
  } {
    const clean = emailOrImap.trim().toLowerCase();
    if (clean.includes("demo")) return { host: "demo.smtp.local", port: 465 };
    const domain = clean.includes("@")
      ? (clean.split("@")[1] ?? "")
      : clean.replace(/^imap\./, "");
    if (domain.includes("gmail") || domain.includes("googlemail"))
      return { host: "smtp.gmail.com", port: 465 };
    if (domain.includes("qq.com") || domain.includes("foxmail.com"))
      return { host: "smtp.qq.com", port: 465 };
    if (domain.includes("163.com")) return { host: "smtp.163.com", port: 465 };
    if (domain.includes("126.com")) return { host: "smtp.126.com", port: 465 };
    if (domain.includes("aliyun.com"))
      return { host: "smtp.aliyun.com", port: 465 };
    if (domain.includes("sina.")) return { host: "smtp.sina.com", port: 465 };
    if (domain.includes("icloud.com") || domain.includes("me.com"))
      return { host: "smtp.mail.me.com", port: 465 };
    if (
      domain.includes("outlook") ||
      domain.includes("hotmail") ||
      domain.includes("office365")
    ) {
      return { host: "smtp.office365.com", port: 587 };
    }
    return { host: domain ? `smtp.${domain}` : "smtp.qq.com", port: 465 };
  }

  function toStatusView(
    row: PersonalSourceRow | null,
  ): PersonalSourcesStatusView {
    if (!row) {
      return {
        calendar: null,
        email: null,
        weatherCity: "上海",
        notifyWebhook: null,
        inboundWebhook: null,
      };
    }
    const calendar: CalendarConnectionView | null = row.calendar_ics_enc
      ? {
          label: row.calendar_label || "个人日历",
          urlHint: row.calendar_url_hint?.split("/")[0] || "ICS 订阅",
          eventCount: Number(row.calendar_event_count ?? 0),
          connectedAt: toIso(row.calendar_connected_at),
          checkedAt: toIso(row.calendar_checked_at),
          timeZone: row.calendar_timezone || "Asia/Shanghai",
        }
      : null;
    const emails = parseJsonArray<EmailSummaryItem>(row.cached_emails);
    const smtp = row.smtp_host
      ? { host: row.smtp_host, port: Number(row.smtp_port) }
      : row.email_address
        ? inferSmtpServer(row.email_address)
        : null;
    const email: EmailConnectionView | null =
      row.email_address && row.imap_host && row.imap_pass_enc
        ? {
            email: row.email_address,
            imapHost: row.imap_host,
            imapPort: Number(row.imap_port ?? 993),
            ...(smtp ? { smtpHost: smtp.host, smtpPort: smtp.port } : {}),
            ...(row.smtp_user ? { smtpUser: row.smtp_user } : {}),
            ...(row.smtp_checked_at
              ? { smtpCheckedAt: toIso(row.smtp_checked_at) }
              : {}),
            hint: "已加密保存",
            unreadCount: emails.filter((e) => e.unread).length,
            connectedAt: toIso(row.email_connected_at),
            checkedAt: toIso(row.email_checked_at),
          }
        : null;
    const notifyWebhook: NotifyWebhookView | null = row.notify_webhook_enc
      ? {
          kind:
            (row.notify_webhook_kind as NotifyWebhookView["kind"]) || "custom",
          label: row.notify_webhook_label || "随身通知推送",
          urlHint: row.notify_webhook_hint?.split("/")[0] || "Webhook",
          connectedAt: toIso(row.notify_connected_at),
        }
      : null;
    const inboundWebhook: InboundWebhookView | null = row.inbound_webhook_token
      ? {
          token: row.inbound_webhook_token,
          path: `/api/personal-sources/webhook/${row.inbound_webhook_token}`,
          lastTriggeredAt: row.inbound_last_at
            ? toIso(row.inbound_last_at)
            : null,
          lastSummary: row.inbound_last_summary ?? null,
        }
      : null;
    return {
      calendar,
      email,
      weatherCity: row.weather_city || "上海",
      notifyWebhook,
      inboundWebhook,
    };
  }

  async function connectCalendar(
    actorId: string,
    input: { label?: string; urlOrIcs: string; timeZone?: string },
  ): Promise<{
    status: PersonalSourcesStatusView;
    events: CalendarEventItem[];
  }> {
    const raw = input.urlOrIcs.trim();
    if (!raw) throw new Error("请填写日历 ICS 订阅地址或粘贴 .ics 日历内容。");
    const timeZone = input.timeZone || "Asia/Shanghai";
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format();
    } catch {
      throw new Error("请填写有效的 IANA 时区，例如 Asia/Shanghai。");
    }
    let icsText = "";
    let urlHint = "内联 ICS 日历";

    if (raw.toLowerCase() === "demo") {
      if (!options.allowDemo)
        throw new Error("请连接真实日历；演示连接只在隔离验收环境使用。");
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      icsText = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:demo-standup@chisabot",
        `DTSTART:${y}${m}${d}T100000`,
        `DTEND:${y}${m}${d}T103000`,
        "SUMMARY:产品体验走查 & 晨会同步",
        "LOCATION:飞书会议室 A",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:demo-review@chisabot",
        `DTSTART:${y}${m}${d}T150000`,
        `DTEND:${y}${m}${d}T160000`,
        "SUMMARY:ChisaBot 个人助理架构评审",
        "LOCATION:线上 Room 302",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      urlHint = "演示日历 (ICS)";
    } else if (/^BEGIN:VCALENDAR/i.test(raw)) {
      icsText = raw;
    } else {
      const normalizedUrl = raw.replace(/^webcal:\/\//i, "https://");
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(normalizedUrl);
      } catch {
        throw new Error(
          "日历地址格式不正确，请填写 https:// 或 webcal:// 开头的 ICS 地址，或直接粘贴 BEGIN:VCALENDAR 内容。",
        );
      }
      const verdict = checkPublicUrl(parsedUrl.toString());
      if (!verdict.ok) {
        throw new Error(`日历订阅地址不安全：${verdict.reason}`);
      }
      urlHint = parsedUrl.hostname;
      const res = await guardedFetch(parsedUrl.toString(), {
        fetchImpl,
        headers: { Accept: "text/calendar, text/plain, */*" },
        timeoutMs: 8_000,
        maxBytes: 2 * 1024 * 1024,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`无法拉取日历订阅（HTTP ${res.status}）。`);
      }
      icsText = res.body.toString("utf8");
    }

    const events = parseIcsEvents(icsText, { timeZone });
    if (events.length === 0 && !/BEGIN:VCALENDAR/i.test(icsText)) {
      throw new Error(
        "该地址未返回有效的 iCalendar (VCALENDAR / VEVENT) 数据。",
      );
    }

    const enc = encryptText(
      raw.toLowerCase() === "demo" ? icsText : raw,
      options.encryptionKey,
    );
    const label = (input.label?.trim() || "我的日历").slice(0, 60);
    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (
        owner_user_id, calendar_label, calendar_ics_enc, calendar_url_hint, calendar_timezone,
        calendar_event_count, calendar_connected_at, calendar_checked_at, cached_events, updated_at
      ) VALUES ($1, $2, $3, $4, $7, $5, now(), now(), $6::text::jsonb, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        calendar_label = EXCLUDED.calendar_label,
        calendar_timezone = EXCLUDED.calendar_timezone,
        calendar_ics_enc = EXCLUDED.calendar_ics_enc,
        calendar_url_hint = EXCLUDED.calendar_url_hint,
        calendar_event_count = EXCLUDED.calendar_event_count,
        calendar_connected_at = COALESCE(chisabot_personal_sources.calendar_connected_at, now()),
        calendar_checked_at = now(),
        cached_events = EXCLUDED.cached_events,
        updated_at = now()`,
      [
        actorId,
        label,
        enc,
        urlHint,
        events.length,
        JSON.stringify(events.slice(0, 100)),
        timeZone,
      ],
    );
    return {
      status: toStatusView(await getRow(actorId)),
      events: events.slice(0, 20),
    };
  }

  async function disconnectCalendar(
    actorId: string,
  ): Promise<PersonalSourcesStatusView> {
    await sql.unsafe(
      `UPDATE chisabot_personal_sources SET
        calendar_label = NULL, calendar_ics_enc = NULL, calendar_url_hint = NULL,
        calendar_event_count = 0, calendar_connected_at = NULL, calendar_checked_at = NULL,
        cached_events = '[]'::jsonb, updated_at = now()
      WHERE owner_user_id = $1`,
      [actorId],
    );
    return toStatusView(await getRow(actorId));
  }

  async function connectEmail(
    actorId: string,
    input: EmailConnectionInput,
  ): Promise<{
    status: PersonalSourcesStatusView;
    emails: EmailSummaryItem[];
  }> {
    const email = input.email.trim();
    const host = input.imapHost.trim();
    const port = Number(input.imapPort ?? 993);
    const pass = input.password.trim();
    if (!email || !host || !pass) {
      throw new Error(
        "请填写完整的邮箱地址、IMAP 服务器地址和应用专用密码/授权码。",
      );
    }
    if (
      !options.allowDemo &&
      (host === "demo.imap.local" || pass === "demo-inbox")
    )
      throw new Error("请连接真实邮箱；演示连接只在隔离验收环境使用。");
    const smtp =
      input.smtp === undefined
        ? undefined
        : z
            .object({
              host: z.string().trim().min(1, "请填写 SMTP 发信服务器。"),
              port: z.union([z.literal(465), z.literal(587)], {
                error: "SMTP 端口请选择 465（TLS）或 587（STARTTLS）。",
              }),
              user: z.string().trim().min(1, "请填写 SMTP 用户名。").optional(),
              password: z
                .string()
                .min(1, "请填写 SMTP 专用密码，或留空使用收信密码。")
                .optional(),
            })
            .parse(input.smtp);
    const emails = await readInbox({
      host,
      port,
      user: email,
      pass,
      limit: 10,
    });
    const enc = encryptText(pass, options.encryptionKey);
    const hint = "已加密保存";
    if (smtp) {
      await (options.verifyMail ?? verifySmtpConnection)({
        host: smtp.host,
        port: smtp.port,
        user: smtp.user ?? email,
        pass: smtp.password ?? pass,
      });
    }

    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (
        owner_user_id, email_address, imap_host, imap_port, imap_pass_enc, imap_pass_hint,
        email_connected_at, email_checked_at, cached_emails,
        smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_checked_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now(), now(), $7::text::jsonb,
        $8, $9, $10, $11, CASE WHEN $8::text IS NOT NULL THEN now() ELSE NULL END, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        email_address = EXCLUDED.email_address,
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        imap_pass_enc = EXCLUDED.imap_pass_enc,
        imap_pass_hint = EXCLUDED.imap_pass_hint,
        smtp_host = EXCLUDED.smtp_host,
        smtp_port = EXCLUDED.smtp_port,
        smtp_user = EXCLUDED.smtp_user,
        smtp_pass_enc = EXCLUDED.smtp_pass_enc,
        smtp_checked_at = EXCLUDED.smtp_checked_at,
        email_connected_at = now(),
        email_checked_at = now(),
        cached_emails = EXCLUDED.cached_emails,
        updated_at = now()`,
      [
        actorId,
        email,
        host,
        port,
        enc,
        hint,
        JSON.stringify(emails),
        smtp?.host ?? null,
        smtp?.port ?? null,
        smtp ? (smtp.user ?? email) : null,
        smtp?.password
          ? encryptText(smtp.password, options.encryptionKey)
          : null,
      ],
    );
    return { status: toStatusView(await getRow(actorId)), emails };
  }

  async function disconnectEmail(
    actorId: string,
  ): Promise<PersonalSourcesStatusView> {
    await sql.unsafe(
      `UPDATE chisabot_personal_sources SET
        email_address = NULL, imap_host = NULL, imap_port = NULL,
        imap_pass_enc = NULL, imap_pass_hint = NULL,
        smtp_host = NULL, smtp_port = NULL, smtp_user = NULL,
        smtp_pass_enc = NULL, smtp_checked_at = NULL,
        email_connected_at = NULL, email_checked_at = NULL,
        cached_emails = '[]'::jsonb, updated_at = now()
      WHERE owner_user_id = $1`,
      [actorId],
    );
    return toStatusView(await getRow(actorId));
  }

  async function readEvents(
    actorId: string,
    days = 7,
  ): Promise<SourceRead<CalendarEventItem>> {
    const row = await getRow(actorId);
    if (!row?.calendar_ics_enc)
      return { state: "not_connected", items: [], checkedAt: null };
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(
      Date.now() + Math.min(30, Math.max(1, days)) * 86_400_000,
    );
    const inWindow = (event: CalendarEventItem) =>
      Date.parse(event.endIso ?? event.startIso) >= +from &&
      Date.parse(event.startIso) <= +to;
    try {
      const raw = decryptText(row.calendar_ics_enc, options.encryptionKey);
      let ics = raw;
      if (!/^BEGIN:VCALENDAR/i.test(raw)) {
        const response = await guardedFetch(
          raw.replace(/^webcal:\/\//i, "https://"),
          { fetchImpl, timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024 },
        );
        if (response.status < 200 || response.status >= 300)
          throw new Error("calendar read failed");
        ics = response.body.toString("utf8");
      }
      const items = parseIcsEvents(ics, {
        from,
        to,
        timeZone: row.calendar_timezone || "Asia/Shanghai",
      });
      await sql.unsafe(
        "UPDATE chisabot_personal_sources SET cached_events=$2::text::jsonb,calendar_event_count=$3,calendar_checked_at=now() WHERE owner_user_id=$1",
        [actorId, JSON.stringify(items.slice(0, 100)), items.length],
      );
      return {
        state: "fresh",
        items: items.slice(0, 100),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      const items = parseJsonArray<CalendarEventItem>(row.cached_events).filter(
        inWindow,
      );
      return {
        state: row.calendar_checked_at ? "cached" : "unavailable",
        items,
        checkedAt: row.calendar_checked_at
          ? toIso(row.calendar_checked_at)
          : null,
        error: "日历读取失败，请检查订阅连接。",
      };
    }
  }

  async function readEmails(
    actorId: string,
    limit = 8,
  ): Promise<SourceRead<ScannedEmailSummary>> {
    const row = await getRow(actorId);
    if (!row?.email_address || !row.imap_host || !row.imap_pass_enc)
      return { state: "not_connected", items: [], checkedAt: null };
    try {
      const pass = decryptText(row.imap_pass_enc, options.encryptionKey);
      if (
        !options.allowDemo &&
        (row.imap_host === "demo.imap.local" || pass === "demo-inbox")
      )
        throw new Error("demo source");
      const items = await readInbox({
        host: row.imap_host,
        port: Number(row.imap_port ?? 993),
        user: row.email_address,
        pass,
        limit,
      });
      await sql.unsafe(
        "UPDATE chisabot_personal_sources SET cached_emails=$2::text::jsonb,email_checked_at=now() WHERE owner_user_id=$1",
        [actorId, JSON.stringify(items)],
      );
      return { state: "fresh", items, checkedAt: new Date().toISOString() };
    } catch {
      return {
        state: row.email_checked_at ? "cached" : "unavailable",
        items: parseJsonArray<ScannedEmailSummary>(row.cached_emails).slice(
          0,
          limit,
        ),
        checkedAt: row.email_checked_at ? toIso(row.email_checked_at) : null,
        error: "收件箱读取失败，请检查邮箱连接。",
      };
    }
  }

  function fresh<T>(source: SourceRead<T>, label: string): T[] {
    if (source.state === "not_connected")
      throw new Error(`尚未连接${label}，请先在账号连接中设置。`);
    if (source.state !== "fresh")
      throw new Error(source.error || `${label}读取失败。`);
    return source.items;
  }
  // Keep the existing list/scan entry points strict; consumers wanting cached data must read its state.
  const listEvents = async (actorId: string, days = 7) =>
    fresh(await readEvents(actorId, days), "日历");
  const listEmails = async (actorId: string, limit = 8) =>
    fresh(await readEmails(actorId, limit), "邮箱");
  const scanCalendar = async (actorId: string, days = 7) =>
    (await listEvents(actorId, days))
      .filter((event) => Date.parse(event.startIso) >= Date.now())
      .slice(0, 50);
  const scanEmails = async (actorId: string, limit = 20) =>
    listEmails(actorId, limit);

  function sourceLine<T>(label: string, source: SourceRead<T>): string {
    if (source.state === "not_connected")
      return `${label}尚未连接。请在「设置 → 账号连接」接入。`;
    if (source.state === "unavailable")
      return source.error || `${label}暂时无法读取。`;
    if (source.state === "cached")
      return `${source.error}以下仅为上次缓存（${source.checkedAt}），不代表当前状态。`;
    return `${label}已更新（${source.checkedAt}）。`;
  }

  async function generateMorningBrief(
    actorId: string,
    cityOverride?: string,
  ): Promise<{
    title: string;
    dateStr: string;
    weather: string;
    markdown: string;
  }> {
    const row = await getRow(actorId);
    const city = (cityOverride?.trim() || row?.weather_city || "上海").slice(
      0,
      30,
    );
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
      timeZone: row?.calendar_timezone || "Asia/Shanghai",
    }).format(now);

    const [weather, calendarRead, emailRead, schedules, memories] =
      await Promise.all([
        fetchWeatherSummary(city, fetchImpl),
        readEvents(actorId, 1),
        readEmails(actorId, 5),
        sql
          .unsafe<
            {
              title: string | null;
              instruction: string | null;
              cron: string | null;
              run_at: string | null;
            }[]
          >(
            "SELECT title, instruction, cron, run_at FROM chisabot_schedules WHERE owner_user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 4",
            [actorId],
          )
          .catch(() => null),
        sql
          .unsafe<{ kind: string; subject: string | null; content: string }[]>(
            "SELECT kind, subject, content FROM chisabot_memory_notes WHERE owner_user_id = $1 ORDER BY updated_at DESC LIMIT 4",
            [actorId],
          )
          .catch(() => null),
      ]);

    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: row?.calendar_timezone || "Asia/Shanghai",
    }).format(now);
    const events = calendarRead.items.filter((event) =>
      event.allDay
        ? event.startDate === day
        : new Intl.DateTimeFormat("en-CA", {
            timeZone: row?.calendar_timezone || "Asia/Shanghai",
          }).format(new Date(event.startIso)) === day,
    );
    const emails = emailRead.items;
    const title = `今日晨报 · ${dateStr}`;
    const calendarLines =
      events.length > 0
        ? events.slice(0, 4).map((e) => {
            const d = new Date(e.startIso);
            const tStr = e.allDay
              ? d.toLocaleDateString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  timeZone: "UTC",
                })
              : d.toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: row?.calendar_timezone || "Asia/Shanghai",
                });
            return `- ${tStr}｜${e.summary}${e.location ? `（${e.location}）` : ""}`;
          })
        : [
            calendarRead.state === "fresh"
              ? "- 今日没有日历安排。"
              : "- 暂时无法确认今日安排。",
          ];

    const emailLines =
      emails.length > 0
        ? emails
            .slice(0, 4)
            .map(
              (m) => `- ${m.unread ? "【未读】" : ""}${m.subject} — ${m.from}`,
            )
        : [
            emailRead.state === "fresh"
              ? "- 当前收件箱查询范围内没有邮件。"
              : "- 暂时无法确认收件箱状态。",
          ];

    const reminderLines =
      schedules && schedules.length > 0
        ? schedules.map(
            (s) =>
              `- ${s.title || s.instruction || "未命名提醒"}${s.cron ? `（定时：${s.cron}）` : ""}`,
          )
        : [
            schedules
              ? "- 暂无活跃的定时提醒任务"
              : "- 定时提醒读取失败，暂时无法确认任务状态。",
          ];

    const memoryLines =
      memories && memories.length > 0
        ? memories.map(
            (m) =>
              `- ${m.subject ? `[${m.subject}] ` : ""}${m.content.slice(0, 70)}`,
          )
        : [memories ? "- 暂无已保存的近期记忆。" : "- 近期记忆读取失败。"];

    const body = [
      `标题：${title}`,
      `日期：${dateStr}`,
      `天气：${weather}`,
      "问候：早安！这是为你整理的今日日程、收件箱重点、定时提醒与近期记忆。",
      "",
      "### 📅 今日日程",
      sourceLine("日历", calendarRead),
      ...calendarLines,
      "",
      "### 📬 收件箱摘要",
      sourceLine("邮箱", emailRead),
      ...emailLines,
      "",
      "### ⏰ 提醒与定时任务",
      ...reminderLines,
      "",
      "### 💡 重点关注与记忆",
      ...memoryLines,
    ].join("\n");

    const markdown = `\`\`\`brief\n${body}\n\`\`\``;
    return { title, dateStr, weather, markdown };
  }

  function inferImapHost(email: string): string {
    const clean = email.trim().toLowerCase();
    if (clean === "demo" || clean === "demo@chisabot.example")
      return "demo.imap.local";
    const domain = clean.split("@")[1] ?? "";
    if (domain === "gmail.com" || domain === "googlemail.com")
      return "imap.gmail.com";
    if (domain === "qq.com" || domain === "foxmail.com") return "imap.qq.com";
    if (domain === "163.com") return "imap.163.com";
    if (domain === "126.com") return "imap.126.com";
    if (
      domain === "outlook.com" ||
      domain === "hotmail.com" ||
      domain === "live.com" ||
      domain === "office365.com"
    ) {
      return "outlook.office365.com";
    }
    if (domain === "icloud.com" || domain === "me.com")
      return "imap.mail.me.com";
    if (domain === "aliyun.com") return "imap.aliyun.com";
    if (domain === "sina.com" || domain === "sina.cn") return "imap.sina.com";
    return domain ? `imap.${domain}` : "";
  }

  function toolSendContext(): PersonalSendContext {
    const turn = currentConfirmTurn();
    const call = currentConfirmToolCall();
    if (!call || !turn)
      throw new DeliveryRejectedError(
        "发送缺少可恢复的工具调用标识，请从原对话重试。",
      );
    if (turn.stopped() || currentToolAbort()?.aborted)
      throw new DeliveryRejectedError("用户已停止，未发送。");
    return {
      id: `tool:${turn.runId}:${call.toolCallId}`,
      threadId: turn.threadId,
      runId: turn.runId,
    };
  }

  async function dispatchPersonal(id: string) {
    return delivery.dispatch(id, async (record) => {
      const row = await getRow(record.owner_user_id);
      const version =
        record.kind === "smtp"
          ? row?.email_connected_at
          : row?.notify_connected_at;
      if (!version || toIso(version) !== record.connection_version)
        return "cancelled";
      // What this send may use, read once from the row whose connection version was checked.
      const mailbox =
        record.kind === "smtp" && row?.email_address && row.imap_pass_enc
          ? {
              address: row.email_address,
              passEnc: row.smtp_pass_enc ?? row.imap_pass_enc,
              user: row.smtp_user ?? row.email_address,
              ...(row.smtp_host
                ? { host: row.smtp_host, port: Number(row.smtp_port) }
                : inferSmtpServer(row.email_address)),
            }
          : null;
      const webhook =
        record.kind === "notify" && row?.notify_webhook_enc
          ? { urlEnc: row.notify_webhook_enc, kind: row.notify_webhook_kind }
          : null;
      if (!mailbox && !webhook) return "cancelled";
      return {
        send: async () => {
          let providerMessageIds: string[];
          const signal = currentToolAbort();
          if (signal?.aborted || currentConfirmTurn()?.stopped())
            throw new DeliveryRejectedError("用户已停止，未发送。");
          if (mailbox) {
            if (
              isBlockedHostname(mailbox.host) ||
              mailbox.host === "demo.smtp.local"
            )
              throw new DeliveryRejectedError("SMTP 连接地址无效，未发送。");
            providerMessageIds = await (options.sendMail ?? sendSmtpMessage)({
              host: mailbox.host,
              port: mailbox.port,
              user: mailbox.user,
              from: mailbox.address,
              pass: decryptText(mailbox.passEnc, options.encryptionKey),
              to: record.payload.target,
              subject: record.payload.title,
              body: record.payload.body,
              id,
              ...(signal ? { signal } : {}),
            });
          } else if (webhook) {
            const url = decryptText(webhook.urlEnc, options.encryptionKey);
            const kind = (webhook.kind ||
              "custom") as NotifyWebhookView["kind"];
            if (kind === "demo")
              throw new DeliveryRejectedError("演示渠道不能产生真实发送凭据。");
            providerMessageIds = await sendWebhook({
              url,
              kind,
              title: record.payload.title,
              body: record.payload.body,
              id,
              fetchImpl,
              ...(signal ? { signal } : {}),
            });
          } else throw new DeliveryRejectedError("发送渠道已断开，未发送。");
          return {
            type: "personal_delivery",
            id,
            channel: record.kind,
            state: "accepted",
            providerMessageIds,
            summary:
              record.kind === "smtp"
                ? `SMTP 已接受发往 ${record.payload.target} 的邮件「${record.payload.title}」；收件人阅读状态未知。`
                : `「${record.payload.target}」通知接口已接受请求；收件人阅读状态未知。`,
          };
        },
      };
    });
  }

  async function sendSmtpEmail(
    actorId: string,
    input: { to: string; subject: string; body: string },
    context: PersonalSendContext = {},
  ): Promise<PersonalDeliveryEvidence> {
    if (/[\r\n\0]/.test(input.to) || /[\r\n\0]/.test(input.subject))
      throw new DeliveryRejectedError("邮件头字段不能包含换行或控制字符。");
    const row = await getRow(actorId);
    if (!row?.email_address || !row.imap_pass_enc || !row.email_connected_at)
      throw new DeliveryRejectedError(
        "还没有连接邮箱，请先在「设置 → 账号连接」连接。",
      );
    const to = input.to.trim();
    if (
      !/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(to) ||
      /[\r\n\0]/.test(input.subject) ||
      !input.subject.trim() ||
      !input.body.trim()
    )
      throw new DeliveryRejectedError(
        "请提供有效的收件人、主题和正文；邮件头不能包含换行。",
      );
    const id = await delivery.stage(
      actorId,
      "smtp",
      toIso(row.email_connected_at),
      {
        target: to,
        title: input.subject.trim().slice(0, 200),
        body: input.body.slice(0, 10_000),
      },
      context,
    );
    await dispatchPersonal(id);
    return delivery.accepted(id);
  }

  function detectWebhookKind(url: string): {
    kind: NotifyWebhookView["kind"];
    defaultLabel: string;
  } {
    const clean = url.trim().toLowerCase();
    if (clean === "demo" || clean.includes("demo.webhook.local"))
      return { kind: "demo", defaultLabel: "演示随身通知" };
    if (clean.includes("feishu.cn") || clean.includes("larksuite.com"))
      return { kind: "feishu", defaultLabel: "飞书群机器人通知" };
    if (clean.includes("dingtalk.com"))
      return { kind: "dingtalk", defaultLabel: "钉钉群机器人通知" };
    if (clean.includes("qyapi.weixin.qq.com"))
      return { kind: "wecom", defaultLabel: "企业微信机器人通知" };
    if (clean.includes("api.day.app"))
      return { kind: "bark", defaultLabel: "Bark iOS 推送" };
    if (clean.includes("sctapi.ftqq.com"))
      return { kind: "serverchan", defaultLabel: "Server酱微信通知" };
    return { kind: "custom", defaultLabel: "自定义 Webhook 通知" };
  }

  async function connectNotifyWebhook(
    actorId: string,
    input: { url: string; label?: string },
  ): Promise<PersonalSourcesStatusView> {
    const raw = input.url.trim();
    if (!raw)
      throw new Error(
        "请填写通知 Webhook 地址（支持飞书、钉钉、企业微信、Bark、Server酱或自定义 JSON Webhook，或填 demo）。",
      );
    const isDemo =
      raw.toLowerCase() === "demo" || raw.includes("demo.webhook.local");
    if (isDemo && !options.allowDemo)
      throw new Error("请绑定真实通知渠道；演示连接只在隔离验收环境使用。");
    const normalizedUrl = isDemo ? "https://demo.webhook.local/push" : raw;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error(
        "Webhook 地址格式不正确，请填写 https:// 开头的链接或 demo。",
      );
    }
    if (!isDemo) {
      const verdict = checkPublicUrl(normalizedUrl);
      if (!verdict.ok) {
        throw new Error(`Webhook 地址不安全：${verdict.reason}`);
      }
    }
    const { kind, defaultLabel } = detectWebhookKind(normalizedUrl);
    const label = (input.label?.trim() || defaultLabel).slice(0, 60);
    const hint = isDemo ? "demo.webhook.local" : parsedUrl.hostname;
    const enc = encryptText(normalizedUrl, options.encryptionKey);
    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (
        owner_user_id, notify_webhook_enc, notify_webhook_kind, notify_webhook_label, notify_webhook_hint, notify_connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, now(), now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        notify_webhook_enc = EXCLUDED.notify_webhook_enc,
        notify_webhook_kind = EXCLUDED.notify_webhook_kind,
        notify_webhook_label = EXCLUDED.notify_webhook_label,
        notify_webhook_hint = EXCLUDED.notify_webhook_hint,
        notify_connected_at = now(),
        updated_at = now()`,
      [actorId, enc, kind, label, hint],
    );
    return toStatusView(await getRow(actorId));
  }

  async function disconnectNotifyWebhook(
    actorId: string,
  ): Promise<PersonalSourcesStatusView> {
    await sql.unsafe(
      `UPDATE chisabot_personal_sources SET
        notify_webhook_enc = NULL, notify_webhook_kind = NULL, notify_webhook_label = NULL,
        notify_webhook_hint = NULL, notify_connected_at = NULL, updated_at = now()
      WHERE owner_user_id = $1`,
      [actorId],
    );
    return toStatusView(await getRow(actorId));
  }

  async function stageNotification(
    actorId: string,
    input: { title?: string; message: string },
    context: PersonalSendContext,
  ) {
    const row = await getRow(actorId);
    if (!row?.notify_webhook_enc || !row.notify_connected_at) return null;
    const message = input.message.trim().slice(0, 2000);
    if (!message) throw new DeliveryRejectedError("通知内容不能为空。");
    return delivery.stage(
      actorId,
      "notify",
      toIso(row.notify_connected_at),
      {
        target: row.notify_webhook_label || "随身通知",
        title: (input.title?.trim() || "ChisaBot 提醒").slice(0, 80),
        body: message,
      },
      context,
    );
  }

  async function pushNotifyMessage(
    actorId: string,
    input: { title?: string; message: string },
    context: PersonalSendContext = {},
  ): Promise<PersonalDeliveryEvidence> {
    const id = await stageNotification(actorId, input, context);
    if (!id)
      throw new DeliveryRejectedError(
        "还没有绑定随身通知，请先在「设置 → 账号连接」绑定 Webhook。",
      );
    await dispatchPersonal(id);
    return delivery.accepted(id);
  }

  async function notify(
    actorId: string,
    input: {
      id: string;
      title?: string;
      message: string;
      threadId?: string;
      runId?: string;
      agentId?: string;
      notificationSource?: PersonalSendContext["notificationSource"];
    },
  ) {
    const id = await stageNotification(actorId, input, input);
    if (!id) return { state: "not_configured" as const };
    await dispatchPersonal(id);
    const record = await delivery.get(id);
    return { id, state: record?.state ?? "queued" };
  }

  async function flushNotifications() {
    for (const { id } of await delivery.queuedNotifications())
      await dispatchPersonal(id);
  }

  async function status(actorId: string): Promise<PersonalSourcesStatusView> {
    return {
      ...toStatusView(await getRow(actorId)),
      deliveries: await delivery.history(actorId),
    };
  }

  async function ensureInboundToken(
    actorId: string,
    rotate = false,
  ): Promise<PersonalSourcesStatusView> {
    const row = await getRow(actorId);
    if (row?.inbound_webhook_token && !rotate) {
      return toStatusView(row);
    }
    const token = `whk_${randomBytes(16).toString("hex")}`;
    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (owner_user_id, inbound_webhook_token, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (owner_user_id) DO UPDATE SET inbound_webhook_token = EXCLUDED.inbound_webhook_token, updated_at = now()`,
      [actorId, token],
    );
    return toStatusView(await getRow(actorId));
  }

  const webhookRateLimits = new Map<
    string,
    { count: number; resetAt: number }
  >();

  async function triggerInboundWebhook(
    token: string,
    payload: {
      title?: string;
      message?: string;
      text?: string;
      source?: string;
      event?: string;
    },
  ): Promise<{ ok: boolean; summary: string } | null> {
    if (!token || !/^whk_[a-zA-Z0-9_-]{8,64}$/.test(token)) return null;
    const nowMs = Date.now();
    if (webhookRateLimits.size > 5000) webhookRateLimits.clear();
    const bucket = webhookRateLimits.get(token);
    if (bucket && bucket.resetAt > nowMs) {
      if (bucket.count >= 30) {
        throw new WebhookRateLimitError(
          "Webhook 调用过于频繁（每分钟最多 30 次），请稍后再试。",
        );
      }
      bucket.count += 1;
    } else {
      webhookRateLimits.set(token, { count: 1, resetAt: nowMs + 60_000 });
    }

    const [row] = await sql.unsafe<PersonalSourceRow[]>(
      "SELECT * FROM chisabot_personal_sources WHERE inbound_webhook_token = $1 LIMIT 1",
      [token],
    );
    if (!row) return null;
    const src = (payload.source || payload.event || "外部 Webhook")
      .replace(/[\r\n\0]+/g, " ")
      .slice(0, 40);
    const title = (payload.title || "").replace(/[\r\n\0]+/g, " ").slice(0, 80);
    const body = (payload.message || payload.text || JSON.stringify(payload))
      .replace(/[\r\n\0]+/g, " ")
      .slice(0, 400);
    const rawSummary = `[${src}] ${title ? `${title}：` : ""}${body}`.slice(
      0,
      300,
    );
    const summary = rawSummary.replace(/<\/?untrusted_data[^>]*>/gi, "").trim();

    await sql.unsafe(
      "UPDATE chisabot_personal_sources SET inbound_last_at = now(), inbound_last_summary = $2, updated_at = now() WHERE owner_user_id = $1",
      [row.owner_user_id, summary],
    );

    // 同步记入用户今日日志（chisabot_memory_notes，按日合并并受单用户 200 条上限约束）
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(new Date());
    const entryLine = `- [Webhook 事件｜外部数据] ${summary}`;
    await (async () => {
      const [same] = await sql.unsafe<{ id: string; content: string }[]>(
        "SELECT id, content FROM chisabot_memory_notes WHERE owner_user_id = $1 AND kind = 'daily' AND lower(subject) = lower($2) AND shared = false LIMIT 1",
        [row.owner_user_id, today],
      );
      if (same) {
        const merged = `${same.content}\n${entryLine}`.slice(-2000);
        await sql.unsafe(
          "UPDATE chisabot_memory_notes SET content = $2, updated_at = now() WHERE id = $1 AND owner_user_id = $3",
          [same.id, merged, row.owner_user_id],
        );
        return;
      }
      const [{ n }] = await sql.unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_memory_notes WHERE owner_user_id = $1",
        [row.owner_user_id],
      );
      if (n < 180) {
        await sql.unsafe(
          `INSERT INTO chisabot_memory_notes (id, owner_user_id, kind, subject, content, context)
           VALUES ($1, $2, 'daily', $3, $4, 'webhook_trigger')`,
          [
            `mem_${randomBytes(10).toString("hex")}`,
            row.owner_user_id,
            today,
            entryLine,
          ],
        );
      }
    })().catch(() => {});

    // 如果用户绑定了随身通知 Webhook，自动转发推送
    if (row.notify_webhook_enc) {
      await notify(row.owner_user_id, {
        id: `inbound:${randomUUID()}`,
        title: title || `${src} 事件触发`,
        message: body,
      });
    }

    return { ok: true, summary };
  }

  async function checkProactiveUpdates(actorId: string): Promise<{
    unreadEmails: EmailSummaryItem[];
    upcomingEvents: CalendarEventItem[];
    lastWebhookEvent: { at: string; summary: string } | null;
    summaryText: string;
  }> {
    const [emailRead, calendarRead, row] = await Promise.all([
      readEmails(actorId, 8),
      readEvents(actorId, 2),
      getRow(actorId),
    ]);
    const emails = emailRead.items;
    const events = calendarRead.items;
    const unreadEmails = emails.filter((e) => e.unread);
    const now = Date.now();
    const twoHoursLater = now + 2 * 3600_000;
    const upcomingEvents = events.filter((e) => {
      const t = new Date(e.startIso).getTime();
      return t >= now - 15 * 60_000 && t <= twoHoursLater;
    });
    const lastWebhookEvent =
      row?.inbound_last_at && row?.inbound_last_summary
        ? { at: toIso(row.inbound_last_at), summary: row.inbound_last_summary }
        : null;

    const lines: string[] = [
      sourceLine("日历", calendarRead),
      sourceLine("邮箱", emailRead),
    ];
    if (upcomingEvents.length > 0) {
      lines.push(
        `⏰ **即将开始的日程（2 小时内）**：\n${upcomingEvents.map((e) => `- ${e.startIso}｜${e.summary}`).join("\n")}`,
      );
    }
    if (unreadEmails.length > 0) {
      lines.push(
        `📬 **未读邮件（${unreadEmails.length} 封）**：\n${unreadEmails
          .slice(0, 5)
          .map((m) => `- ${m.subject}（${m.from}）`)
          .join("\n")}`,
      );
    }
    if (lastWebhookEvent) {
      lines.push(
        `🔔 **最近外部 Webhook 触发（${lastWebhookEvent.at}）**：\n- ${lastWebhookEvent.summary}`,
      );
    }
    if (
      !upcomingEvents.length &&
      !unreadEmails.length &&
      calendarRead.state === "fresh" &&
      emailRead.state === "fresh"
    ) {
      lines.push("当前查询范围内没有 2 小时内日程或未读邮件提醒。");
    }

    return {
      unreadEmails,
      upcomingEvents,
      lastWebhookEvent,
      summaryText: lines.join("\n\n"),
    };
  }

  function tools(actorId: string): GrantedTool[] {
    return [
      {
        name: "calendar_list_events",
        ref: "personal-sources/calendar_list_events",
        description:
          "查看用户已连接的个人日历（iCal / ICS）近期日程安排（只读）。",
        parameters: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe("往后看几天，默认 7 天"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({ days: z.number().int().min(1).max(30).optional() })
            .safeParse(args);
          const days = parsed.success ? (parsed.data.days ?? 7) : 7;
          const row = await getRow(actorId);
          if (!row?.calendar_ics_enc) {
            return `${REFUSAL_MARKER} 用户还没有连接日历。请通过「设置 → 账号连接」的安全表单接入，不要在聊天中提供私密订阅链接：\n[打开账号连接](/settings/connected-accounts)`;
          }
          const source = await readEvents(actorId, days);
          return [
            source.state === "fresh"
              ? sourceLine("日历", source)
              : `${REFUSAL_MARKER} ${sourceLine("日历", source)}`,
            ...source.items.map(
              (e) =>
                `- ${e.startIso}｜${e.summary}${e.location ? `（地点：${e.location}）` : ""}`,
            ),
            ...(source.state === "fresh" && !source.items.length
              ? [`未来 ${days} 天内没有日程安排。`]
              : []),
          ].join("\n");
        },
      },
      {
        name: "calendar_connect",
        ref: "personal-sources/calendar_connect",
        description:
          "打开日历的安全连接入口。凭据只在账号连接设置中输入，不要向用户索要密码或私密订阅链接。",
        parameters: z.object({}).strict(),
        execute: async () =>
          "请在安全设置中连接日历，完成后我会读取连接状态。不要在聊天中发送密码或带密钥的链接。\n[打开账号连接](/settings/connected-accounts)",
      },
      {
        name: "email_list_recent",
        ref: "personal-sources/email_list_recent",
        description:
          "查看用户已连接的个人收件箱（IMAP 只读，支持 Gmail / QQ / 163 / Outlook / iCloud）最近邮件与未读邮件摘要。",
        parameters: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("最多返回几封，默认 8 封"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({ limit: z.number().int().min(1).max(20).optional() })
            .safeParse(args);
          const limit = parsed.success ? (parsed.data.limit ?? 8) : 8;
          const row = await getRow(actorId);
          if (!row?.email_address || !row.imap_pass_enc) {
            return `${REFUSAL_MARKER} 用户还没有连接邮箱。请在「设置 → 账号连接」的安全表单中接入 IMAP，不要在聊天中提供授权码：\n[打开账号连接](/settings/connected-accounts)`;
          }
          const source = await readEmails(actorId, limit);
          return [
            source.state === "fresh"
              ? sourceLine("邮箱", source)
              : `${REFUSAL_MARKER} ${sourceLine("邮箱", source)}`,
            ...source.items.map(
              (m) =>
                `- ${m.unread ? "[未读] " : ""}${m.subject}｜发件人：${m.from}｜时间：${m.date}`,
            ),
            ...(source.state === "fresh" && !source.items.length
              ? ["当前查询范围内没有邮件。"]
              : []),
          ].join("\n");
        },
      },
      {
        name: "email_connect",
        ref: "personal-sources/email_connect",
        description:
          "打开邮箱的安全连接入口。凭据只在账号连接设置中输入，不要向用户索要密码或私密订阅链接。",
        parameters: z.object({}).strict(),
        execute: async () =>
          "请在安全设置中连接邮箱，完成后我会读取连接状态。不要在聊天中发送密码或带密钥的链接。\n[打开账号连接](/settings/connected-accounts)",
      },
      {
        name: "email_send",
        ref: "personal-sources/email_send",
        description:
          "通过用户已连接的个人邮箱（SMTP over TLS）发送或回复电子邮件。调用时系统会自动按用户的审批偏好在聊天里弹出确认卡片（展示收件人、主题与正文），用户确认后即刻发出，无需在聊天里先用文字询问。",
        parameters: z.object({
          to: z.string().min(3).max(200).describe("收件人邮箱地址"),
          subject: z.string().min(1).max(200).describe("邮件主题"),
          body: z.string().min(1).max(10000).describe("邮件正文内容（纯文本）"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({
              to: z.string().min(3).max(200),
              subject: z.string().min(1).max(200),
              body: z.string().min(1).max(10000),
            })
            .safeParse(args);
          if (!parsed.success)
            return `${REFUSAL_MARKER} 请提供完整的收件人邮箱 (to)、主题 (subject) 和正文 (body)。`;
          try {
            return JSON.stringify(
              await sendSmtpEmail(actorId, parsed.data, toolSendContext()),
            );
          } catch (err) {
            if (!(err instanceof DeliveryRejectedError)) throw err;
            return `${REFUSAL_MARKER} 发送邮件失败：${err instanceof Error ? err.message : "未知错误"}`;
          }
        },
      },
      {
        name: "notify_webhook_connect",
        ref: "personal-sources/notify_webhook_connect",
        description:
          "打开通知推送的安全连接入口。凭据只在账号连接设置中输入，不要向用户索要密码或私密订阅链接。",
        parameters: z.object({}).strict(),
        execute: async () =>
          "请在安全设置中连接通知推送，完成后我会读取连接状态。不要在聊天中发送密码或带密钥的链接。\n[打开账号连接](/settings/connected-accounts)",
      },
      {
        name: "notify_push",
        ref: "personal-sources/notify_push",
        description:
          "向用户已绑定的随身通知渠道（飞书 / 钉钉 / 企业微信 / Bark / Server酱 / 自定义 Webhook）发送即时推送提醒。适合长任务完成通知、重要日程告警、每日简报摘要推送。",
        parameters: z.object({
          title: z
            .string()
            .max(80)
            .optional()
            .describe("通知标题，如「今日晨报」「会议即将开始」"),
          message: z.string().min(1).max(2000).describe("通知正文内容"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({
              title: z.string().max(80).optional(),
              message: z.string().min(1).max(2000),
            })
            .safeParse(args);
          if (!parsed.success)
            return `${REFUSAL_MARKER} 请提供通知内容 message。`;
          try {
            return JSON.stringify(
              await pushNotifyMessage(actorId, parsed.data, toolSendContext()),
            );
          } catch (err) {
            if (!(err instanceof DeliveryRejectedError)) throw err;
            return `${REFUSAL_MARKER} ${err instanceof Error ? err.message : "推送失败"}`;
          }
        },
      },
      {
        name: "webhook_trigger_info",
        ref: "personal-sources/webhook_trigger_info",
        description:
          "打开入站 Webhook 的安全设置入口，复制或重置地址均在账号连接设置中完成。",
        parameters: z.object({}).strict(),
        execute: async () =>
          "请在账号连接设置中复制或重置入站 Webhook 地址，带密钥的地址不会进入聊天记录。\n[打开账号连接](/settings/connected-accounts)",
      },
      {
        name: "personal_check_updates",
        ref: "personal-sources/personal_check_updates",
        description:
          "主动巡检用户的最新动态：检查 2 小时内即将开始的日历会议、重要未读邮件以及最近收到的外部 Webhook 事件。",
        parameters: z.object({}),
        execute: async () => {
          const res = await checkProactiveUpdates(actorId);
          return res.summaryText;
        },
      },
      {
        name: "morning_brief_generate",
        ref: "personal-sources/morning_brief_generate",
        description:
          "为用户生成今日晨报卡片（聚合天气、日历日程、未读邮件、定时提醒与近期记忆）。返回的内容包含 ```brief 代码块，请原样放进回复里展示为晨报卡片。",
        parameters: z.object({
          city: z
            .string()
            .max(30)
            .optional()
            .describe("天气城市，如「上海」「北京」，不填使用用户默认城市"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({ city: z.string().max(30).optional() })
            .safeParse(args);
          const brief = await generateMorningBrief(
            actorId,
            parsed.success ? parsed.data.city : undefined,
          );
          return `已生成今日晨报，请将以下 \`\`\`brief 代码块原样输出给用户（会自动渲染为晨报卡片）：\n\n${brief.markdown}`;
        },
      },
    ];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();

    // 公开入站 Webhook（凭专属 whk_... token 鉴权，不走登录 Cookie）
    app.post("/webhook/:token", async (c) => {
      const token = c.req.param("token");
      const body = (await c.req.json().catch(() => ({}))) as {
        title?: string;
        message?: string;
        text?: string;
        source?: string;
        event?: string;
      };
      try {
        const res = await triggerInboundWebhook(token, body);
        if (!res) return c.json({ error: "Webhook token 无效或已失效。" }, 404);
        return c.json(res);
      } catch (err) {
        if (err instanceof WebhookRateLimitError) {
          return c.json({ error: err.message }, 429);
        }
        throw err;
      }
    });

    app.use("*", requireUser);

    app.get("/", async (c) => {
      await ensureInboundToken(c.var.actor.id, false);
      return c.json(await status(c.var.actor.id));
    });

    const handleCalendarSave = async (
      c: import("hono").Context<{ Variables: AppVariables }>,
    ) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        label?: string;
        urlOrIcs?: string;
        icsUrl?: string;
        icsText?: string;
        timeZone?: string;
      };
      try {
        const raw =
          body.urlOrIcs?.trim() ||
          body.icsText?.trim() ||
          body.icsUrl?.trim() ||
          "";
        const res = await connectCalendar(c.var.actor.id, {
          label: body.label,
          urlOrIcs: raw,
          timeZone: body.timeZone,
        });
        return c.json({
          ...res.status,
          status: res.status,
          events: res.events,
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "连接日历失败" },
          400,
        );
      }
    };
    app.put("/calendar", handleCalendarSave);
    app.post("/calendar", handleCalendarSave);

    app.delete("/calendar", async (c) => {
      const status = await disconnectCalendar(c.var.actor.id);
      return c.json({ ...status, status });
    });

    const handleEmailSave = async (
      c: import("hono").Context<{ Variables: AppVariables }>,
    ) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        email?: string;
        imapHost?: string;
        imapPort?: number;
        password?: string;
        smtp?: EmailConnectionInput["smtp"];
      };
      try {
        const emailAddr = (body.email ?? "").trim();
        const imapHost =
          (body.imapHost ?? "").trim() || inferImapHost(emailAddr);
        const res = await connectEmail(c.var.actor.id, {
          email: emailAddr,
          imapHost,
          imapPort: body.imapPort,
          password: body.password ?? "",
          smtp: body.smtp,
        });
        return c.json({
          ...res.status,
          status: res.status,
          emails: res.emails,
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "连接邮箱失败" },
          400,
        );
      }
    };
    app.put("/email", handleEmailSave);
    app.post("/email", handleEmailSave);

    app.delete("/email", async (c) => {
      const status = await disconnectEmail(c.var.actor.id);
      return c.json({ ...status, status });
    });

    app.post("/email/send", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        to?: string;
        subject?: string;
        body?: string;
        requestId?: string;
      };
      try {
        const res = await sendSmtpEmail(
          c.var.actor.id,
          {
            to: body.to ?? "",
            subject: body.subject ?? "",
            body: body.body ?? "",
          },
          { id: body.requestId || randomUUID() },
        );
        return c.json(res);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "发送邮件失败" },
          err instanceof DeliveryOutcomeUnknownError ? 409 : 400,
        );
      }
    });

    const handleNotifySave = async (
      c: import("hono").Context<{ Variables: AppVariables }>,
    ) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        url?: string;
        label?: string;
      };
      try {
        const status = await connectNotifyWebhook(c.var.actor.id, {
          url: body.url ?? "",
          label: body.label,
        });
        return c.json({ ...status, status });
      } catch (err) {
        return c.json(
          {
            error: err instanceof Error ? err.message : "绑定通知 Webhook 失败",
          },
          400,
        );
      }
    };
    app.put("/notify-webhook", handleNotifySave);
    app.post("/notify-webhook", handleNotifySave);

    app.delete("/notify-webhook", async (c) => {
      const status = await disconnectNotifyWebhook(c.var.actor.id);
      return c.json({ ...status, status });
    });

    app.post("/notify-test", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        title?: string;
        message?: string;
        requestId?: string;
      };
      try {
        const res = await pushNotifyMessage(
          c.var.actor.id,
          {
            title: body.title || "ChisaBot 测试通知",
            message: body.message || "这是一条 ChisaBot 连接测试通知。",
          },
          { id: body.requestId || randomUUID() },
        );
        return c.json(res);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "发送测试通知失败" },
          err instanceof DeliveryOutcomeUnknownError ? 409 : 400,
        );
      }
    });

    app.post("/inbound-webhook/rotate", async (c) => {
      const status = await ensureInboundToken(c.var.actor.id, true);
      return c.json({ ...status, status });
    });

    app.post("/check-updates", async (c) => {
      const res = await checkProactiveUpdates(c.var.actor.id);
      return c.json({ ...res, markdown: res.summaryText });
    });

    const handleWeatherSave = async (
      c: import("hono").Context<{ Variables: AppVariables }>,
    ) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        weatherCity?: string;
        city?: string;
      };
      const city = (
        body.weatherCity?.trim() ||
        body.city?.trim() ||
        "上海"
      ).slice(0, 30);
      await sql.unsafe(
        `INSERT INTO chisabot_personal_sources (owner_user_id, weather_city, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (owner_user_id) DO UPDATE SET weather_city = EXCLUDED.weather_city, updated_at = now()`,
        [c.var.actor.id, city],
      );
      const status = toStatusView(await getRow(c.var.actor.id));
      return c.json({ ...status, status });
    };
    app.put("/weather", handleWeatherSave);
    app.put("/weather-city", handleWeatherSave);

    const handleBrief = async (
      c: import("hono").Context<{ Variables: AppVariables }>,
    ) => {
      const qCity = c.req.query("city");
      const body = (await c.req.json().catch(() => ({}))) as { city?: string };
      const brief = await generateMorningBrief(
        c.var.actor.id,
        body.city || qCity,
      );
      return c.json(brief);
    };
    app.post("/brief", handleBrief);
    app.post("/morning-brief", handleBrief);

    return app;
  }

  return {
    ensure,
    status,
    notify,
    flushNotifications,
    tools,
    routes,
    listEvents,
    listEmails,
    readEvents,
    readEmails,
    scanCalendar,
    scanEmails,
    sendSmtpEmail,
    connectNotifyWebhook,
    pushNotifyMessage,
    triggerInboundWebhook,
    checkProactiveUpdates,
    generateMorningBrief,
  };
}
export type PersonalSourcesService = ReturnType<typeof createPersonalSources>;
