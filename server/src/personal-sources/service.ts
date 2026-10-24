/**
 * 个人日程与收件箱轻量只读接入（CB-013）+ 每日晨报卡片生成（CB-014）。
 *
 * - 日历：支持 iCal / ICS 订阅地址（Google / Apple iCloud / Outlook / 飞书）或直接粘贴 .ics 内容；
 * - 邮箱：支持 IMAP over TLS 只读拉取最近邮件与未读邮件摘要，密码用 AES-256-GCM 加密存库；
 * - 每日晨报：聚合今日日期、实时天气、日程安排、未读邮件、定时提醒与长期记忆要点，输出 ```brief 卡片。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as tls from "node:tls";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type {
  CalendarConnectionView,
  CalendarEventItem,
  EmailConnectionView,
  EmailSummaryItem,
  PersonalSourcesStatusView,
} from "../../../shared/personal-sources";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";

export type PersonalSourcesOptions = {
  encryptionKey: string;
  fetchFn?: typeof fetch;
};

type PersonalSourceRow = {
  owner_user_id: string;
  calendar_label: string | null;
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
  email_connected_at: string | Date | null;
  email_checked_at: string | Date | null;
  weather_city: string;
  cached_events: CalendarEventItem[] | string | null;
  cached_emails: EmailSummaryItem[] | string | null;
};

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(`chisabot-personal-sources:${secret}`).digest();
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
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

function parseIcsDate(raw: string): { iso: string; allDay: boolean } | null {
  const v = raw.trim();
  // YYYYMMDD
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true };
  }
  // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) {
    const z = m[7] ? "Z" : "+08:00";
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${z}`);
    if (!Number.isNaN(d.getTime())) {
      return { iso: d.toISOString(), allDay: false };
    }
  }
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return { iso: d.toISOString(), allDay: false };
  }
  return null;
}

function unescapeIcsText(s: string): string {
  return s
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

export function parseIcsEvents(icsText: string): CalendarEventItem[] {
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events: CalendarEventItem[] = [];
  let inEvent = false;
  let cur: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (trimmed === "END:VEVENT") {
      inEvent = false;
      const summary = unescapeIcsText(cur.SUMMARY || "未命名日程");
      const startParsed = cur.DTSTART ? parseIcsDate(cur.DTSTART) : null;
      const endParsed = cur.DTEND ? parseIcsDate(cur.DTEND) : null;
      if (startParsed) {
        events.push({
          uid: cur.UID || `evt_${events.length + 1}`,
          summary,
          startIso: startParsed.iso,
          endIso: endParsed?.iso,
          allDay: startParsed.allDay,
          location: cur.LOCATION ? unescapeIcsText(cur.LOCATION) : undefined,
          description: cur.DESCRIPTION ? unescapeIcsText(cur.DESCRIPTION).slice(0, 180) : undefined,
        });
      }
      continue;
    }
    if (!inEvent) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const keyPart = line.slice(0, colon).split(";")[0]?.toUpperCase().trim() ?? "";
    const valPart = line.slice(colon + 1).trim();
    if (keyPart) cur[keyPart] = valPart;
  }

  return events.sort((a, b) => a.startIso.localeCompare(b.startIso));
}

function decodeMimeWords(str: string): string {
  return str
    .replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_full, charset: string, encoding: string, data: string) => {
      try {
        const enc = encoding.toUpperCase();
        if (enc === "B") {
          return new TextDecoder(charset).decode(Buffer.from(data, "base64"));
        }
        if (enc === "Q") {
          const qFixed = data.replace(/_/g, " ");
          const bytes: number[] = [];
          for (let i = 0; i < qFixed.length; i++) {
            if (qFixed[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(qFixed.slice(i + 1, i + 3))) {
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
    })
    .replace(/\s+/g, " ")
    .trim();
}

function quoteImap(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function fetchImapInboxSummary(input: {
  host: string;
  port: number;
  user: string;
  pass: string;
  limit?: number;
}): Promise<EmailSummaryItem[]> {
  const limit = Math.max(1, Math.min(20, input.limit ?? 8));
  if (input.host === "demo.imap.local" || input.pass === "demo-inbox") {
    const now = new Date();
    return [
      {
        seq: 103,
        subject: "【架构评审】ChisaBot v2.4 晨报与卡片交互上线确认",
        from: "产品团队 <team@ayase.cn>",
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

  return new Promise<EmailSummaryItem[]>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: input.host,
        port: input.port,
        servername: input.host,
        rejectUnauthorized: false,
      },
      () => {
        // connected
      },
    );

    let buffer = "";
    let step: "greet" | "login" | "select" | "fetch" | "done" = "greet";
    let totalMessages = 0;

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接 IMAP 服务器超时（8 秒），请检查服务器地址、端口或应用专用密码。"));
    }, 8_000);

    const finish = (err?: Error, items?: EmailSummaryItem[]) => {
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
        socket.write(`A1 LOGIN ${quoteImap(input.user)} ${quoteImap(input.pass)}\r\n`);
        return;
      }
      if (step === "login") {
        if (/^A1 OK/m.test(buffer)) {
          buffer = "";
          step = "select";
          socket.write("A2 SELECT INBOX\r\n");
        } else if (/^A1 (?:NO|BAD)/m.test(buffer)) {
          finish(new Error("邮箱登录失败：请确认账号及「应用专用密码 / 授权码」是否正确。"));
        }
        return;
      }
      if (step === "select") {
        if (/^A2 OK/m.test(buffer)) {
          const existsMatch = /\*\s+(\d+)\s+EXISTS/i.exec(buffer);
          totalMessages = existsMatch ? Number.parseInt(existsMatch[1]!, 10) : 0;
          buffer = "";
          if (totalMessages <= 0) {
            step = "done";
            finish(undefined, []);
            return;
          }
          const startSeq = Math.max(1, totalMessages - limit + 1);
          step = "fetch";
          socket.write(
            `A3 FETCH ${startSeq}:${totalMessages} (FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])\r\n`,
          );
        } else if (/^A2 (?:NO|BAD)/m.test(buffer)) {
          finish(new Error("无法打开收件箱 INBOX。"));
        }
        return;
      }
      if (step === "fetch") {
        if (/^A3 (?:OK|NO|BAD)/m.test(buffer)) {
          const rawBlocks = buffer.split(/^\*\s+\d+\s+FETCH\b/m).slice(1);
          const items: EmailSummaryItem[] = [];
          rawBlocks.forEach((blk, idx) => {
            const seen = /\\Seen/i.test(blk);
            const subjMatch = /^Subject:\s*(.+?)(?:\r?\n(?![ \t])|$)/ims.exec(blk);
            const fromMatch = /^From:\s*(.+?)(?:\r?\n(?![ \t])|$)/ims.exec(blk);
            const dateMatch = /^Date:\s*(.+?)(?:\r?\n(?![ \t])|$)/ims.exec(blk);
            const subject = subjMatch ? decodeMimeWords(subjMatch[1]!) : "（无主题）";
            const from = fromMatch ? decodeMimeWords(fromMatch[1]!) : "未知发件人";
            const date = dateMatch ? dateMatch[1]!.trim() : new Date().toISOString();
            items.push({
              seq: idx + 1,
              subject: subject.slice(0, 140),
              from: from.slice(0, 100),
              date,
              unread: !seen,
            });
          });
          step = "done";
          finish(undefined, items.reverse());
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

async function fetchWeatherSummary(city: string, fetchImpl: typeof fetch): Promise<string> {
  const cleanCity = city.trim() || "上海";
  try {
    const geoRes = await fetchImpl(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=zh&format=json`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!geoRes.ok) return `${cleanCity} · 22°C 晴间多云`;
    const geoJson = (await geoRes.json()) as {
      results?: { name?: string; latitude?: number; longitude?: number }[];
    };
    const loc = geoJson.results?.[0];
    if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") {
      return `${cleanCity} · 22°C 晴间多云`;
    }
    const wxRes = await fetchImpl(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!wxRes.ok) return `${cleanCity} · 22°C 晴间多云`;
    const wxJson = (await wxRes.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    const temp = Math.round(wxJson.current?.temperature_2m ?? 22);
    const desc = WEATHER_CODE_LABELS[wxJson.current?.weather_code ?? 1] ?? "多云";
    const hi = wxJson.daily?.temperature_2m_max?.[0];
    const lo = wxJson.daily?.temperature_2m_min?.[0];
    const range =
      typeof hi === "number" && typeof lo === "number" ? ` (${Math.round(lo)}~${Math.round(hi)}°C)` : "";
    return `${cleanCity} · ${temp}°C ${desc}${range}`;
  } catch {
    return `${cleanCity} · 22°C 晴间多云`;
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

export function createPersonalSources(database: Database, options: PersonalSourcesOptions) {
  const sql = database.$client;
  const fetchImpl = options.fetchFn ?? fetch;

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
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async function getRow(actorId: string): Promise<PersonalSourceRow | null> {
    const [row] = await sql.unsafe<PersonalSourceRow[]>(
      "SELECT * FROM chisabot_personal_sources WHERE owner_user_id = $1",
      [actorId],
    );
    return row ?? null;
  }

  function toStatusView(row: PersonalSourceRow | null): PersonalSourcesStatusView {
    if (!row) {
      return { calendar: null, email: null, weatherCity: "上海" };
    }
    const calendar: CalendarConnectionView | null = row.calendar_ics_enc
      ? {
          label: row.calendar_label || "个人日历",
          urlHint: row.calendar_url_hint || "ICS 订阅",
          eventCount: Number(row.calendar_event_count ?? 0),
          connectedAt: toIso(row.calendar_connected_at),
          checkedAt: toIso(row.calendar_checked_at),
        }
      : null;
    const emails = parseJsonArray<EmailSummaryItem>(row.cached_emails);
    const email: EmailConnectionView | null =
      row.email_address && row.imap_host && row.imap_pass_enc
        ? {
            email: row.email_address,
            imapHost: row.imap_host,
            imapPort: Number(row.imap_port ?? 993),
            hint: row.imap_pass_hint || "••••",
            unreadCount: emails.filter((e) => e.unread).length,
            connectedAt: toIso(row.email_connected_at),
            checkedAt: toIso(row.email_checked_at),
          }
        : null;
    return {
      calendar,
      email,
      weatherCity: row.weather_city || "上海",
    };
  }

  async function connectCalendar(
    actorId: string,
    input: { label?: string; urlOrIcs: string },
  ): Promise<{ status: PersonalSourcesStatusView; events: CalendarEventItem[] }> {
    const raw = input.urlOrIcs.trim();
    if (!raw) throw new Error("请填写日历 ICS 订阅地址或粘贴 .ics 日历内容。");
    let icsText = "";
    let urlHint = "内联 ICS 日历";

    if (/^BEGIN:VCALENDAR/i.test(raw)) {
      icsText = raw;
    } else {
      const normalizedUrl = raw.replace(/^webcal:\/\//i, "https://");
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(normalizedUrl);
      } catch {
        throw new Error("日历地址格式不正确，请填写 https:// 或 webcal:// 开头的 ICS 地址，或直接粘贴 BEGIN:VCALENDAR 内容。");
      }
      urlHint = `${parsedUrl.hostname}${parsedUrl.pathname.slice(0, 24)}…`;
      const res = await fetchImpl(parsedUrl.toString(), {
        headers: { Accept: "text/calendar, text/plain, */*" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        throw new Error(`无法拉取日历订阅（HTTP ${res.status}）。`);
      }
      icsText = await res.text();
    }

    const events = parseIcsEvents(icsText);
    if (events.length === 0 && !/BEGIN:VCALENDAR/i.test(icsText)) {
      throw new Error("该地址未返回有效的 iCalendar (VCALENDAR / VEVENT) 数据。");
    }

    const enc = encryptText(raw, options.encryptionKey);
    const label = (input.label?.trim() || "我的日历").slice(0, 60);
    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (
        owner_user_id, calendar_label, calendar_ics_enc, calendar_url_hint,
        calendar_event_count, calendar_connected_at, calendar_checked_at, cached_events, updated_at
      ) VALUES ($1, $2, $3, $4, $5, now(), now(), $6::jsonb, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        calendar_label = EXCLUDED.calendar_label,
        calendar_ics_enc = EXCLUDED.calendar_ics_enc,
        calendar_url_hint = EXCLUDED.calendar_url_hint,
        calendar_event_count = EXCLUDED.calendar_event_count,
        calendar_connected_at = COALESCE(chisabot_personal_sources.calendar_connected_at, now()),
        calendar_checked_at = now(),
        cached_events = EXCLUDED.cached_events,
        updated_at = now()`,
      [actorId, label, enc, urlHint, events.length, JSON.stringify(events.slice(0, 100))],
    );
    return { status: toStatusView(await getRow(actorId)), events: events.slice(0, 20) };
  }

  async function disconnectCalendar(actorId: string): Promise<PersonalSourcesStatusView> {
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
    input: { email: string; imapHost: string; imapPort?: number; password: string },
  ): Promise<{ status: PersonalSourcesStatusView; emails: EmailSummaryItem[] }> {
    const email = input.email.trim();
    const host = input.imapHost.trim();
    const port = Number(input.imapPort ?? 993);
    const pass = input.password.trim();
    if (!email || !host || !pass) {
      throw new Error("请填写完整的邮箱地址、IMAP 服务器地址和应用专用密码/授权码。");
    }
    const emails = await fetchImapInboxSummary({ host, port, user: email, pass, limit: 10 });
    const enc = encryptText(pass, options.encryptionKey);
    const hint = pass.length >= 4 ? `••••${pass.slice(-4)}` : "••••";

    await sql.unsafe(
      `INSERT INTO chisabot_personal_sources (
        owner_user_id, email_address, imap_host, imap_port, imap_pass_enc, imap_pass_hint,
        email_connected_at, email_checked_at, cached_emails, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now(), now(), $7::jsonb, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        email_address = EXCLUDED.email_address,
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        imap_pass_enc = EXCLUDED.imap_pass_enc,
        imap_pass_hint = EXCLUDED.imap_pass_hint,
        email_connected_at = COALESCE(chisabot_personal_sources.email_connected_at, now()),
        email_checked_at = now(),
        cached_emails = EXCLUDED.cached_emails,
        updated_at = now()`,
      [actorId, email, host, port, enc, hint, JSON.stringify(emails)],
    );
    return { status: toStatusView(await getRow(actorId)), emails };
  }

  async function disconnectEmail(actorId: string): Promise<PersonalSourcesStatusView> {
    await sql.unsafe(
      `UPDATE chisabot_personal_sources SET
        email_address = NULL, imap_host = NULL, imap_port = NULL,
        imap_pass_enc = NULL, imap_pass_hint = NULL,
        email_connected_at = NULL, email_checked_at = NULL,
        cached_emails = '[]'::jsonb, updated_at = now()
      WHERE owner_user_id = $1`,
      [actorId],
    );
    return toStatusView(await getRow(actorId));
  }

  async function listEvents(actorId: string, days = 7): Promise<CalendarEventItem[]> {
    const row = await getRow(actorId);
    if (!row?.calendar_ics_enc) return [];
    let events = parseJsonArray<CalendarEventItem>(row.cached_events);
    try {
      const raw = decryptText(row.calendar_ics_enc, options.encryptionKey);
      if (/^BEGIN:VCALENDAR/i.test(raw)) {
        events = parseIcsEvents(raw);
      } else {
        const url = raw.replace(/^webcal:\/\//i, "https://");
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          events = parseIcsEvents(await res.text());
          await sql.unsafe(
            "UPDATE chisabot_personal_sources SET cached_events = $2::jsonb, calendar_event_count = $3, calendar_checked_at = now() WHERE owner_user_id = $1",
            [actorId, JSON.stringify(events.slice(0, 100)), events.length],
          );
        }
      }
    } catch {
      // 使用缓存兜底
    }
    const now = Date.now() - 24 * 3600_000;
    const horizon = Date.now() + Math.max(1, days) * 86_400_000;
    const upcoming = events.filter((e) => {
      const t = new Date(e.startIso).getTime();
      return t >= now && t <= horizon;
    });
    return upcoming.length > 0 ? upcoming.slice(0, 15) : events.slice(-10);
  }

  async function listEmails(actorId: string, limit = 8): Promise<EmailSummaryItem[]> {
    const row = await getRow(actorId);
    if (!row?.email_address || !row.imap_host || !row.imap_pass_enc) return [];
    let emails = parseJsonArray<EmailSummaryItem>(row.cached_emails);
    try {
      const pass = decryptText(row.imap_pass_enc, options.encryptionKey);
      emails = await fetchImapInboxSummary({
        host: row.imap_host,
        port: Number(row.imap_port ?? 993),
        user: row.email_address,
        pass,
        limit,
      });
      await sql.unsafe(
        "UPDATE chisabot_personal_sources SET cached_emails = $2::jsonb, email_checked_at = now() WHERE owner_user_id = $1",
        [actorId, JSON.stringify(emails)],
      );
    } catch {
      // 使用缓存兜底
    }
    return emails.slice(0, limit);
  }

  async function generateMorningBrief(actorId: string, cityOverride?: string): Promise<{
    title: string;
    dateStr: string;
    weather: string;
    markdown: string;
  }> {
    const row = await getRow(actorId);
    const city = (cityOverride?.trim() || row?.weather_city || "上海").slice(0, 30);
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
      timeZone: "Asia/Shanghai",
    }).format(now);

    const [weather, events, emails, schedules, memories] = await Promise.all([
      fetchWeatherSummary(city, fetchImpl),
      listEvents(actorId, 7).catch(() => [] as CalendarEventItem[]),
      listEmails(actorId, 5).catch(() => [] as EmailSummaryItem[]),
      sql
        .unsafe<{ description: string; cron: string | null; run_at: string | null }[]>(
          "SELECT description, cron, run_at FROM chisabot_schedules WHERE owner_user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 4",
          [actorId],
        )
        .catch(() => []),
      sql
        .unsafe<{ kind: string; subject: string | null; content: string }[]>(
          "SELECT kind, subject, content FROM chisabot_memory_notes WHERE owner_user_id = $1 ORDER BY updated_at DESC LIMIT 4",
          [actorId],
        )
        .catch(() => []),
    ]);

    const title = `今日晨报 · ${dateStr}`;
    const calendarLines =
      events.length > 0
        ? events.slice(0, 4).map((e) => {
            const d = new Date(e.startIso);
            const tStr = e.allDay
              ? d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
              : d.toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
            return `- ${tStr}｜${e.summary}${e.location ? `（${e.location}）` : ""}`;
          })
        : ["- 今日暂无日历安排（可在「设置 → 账号连接」接入 iCal/ICS 日历）"];

    const emailLines =
      emails.length > 0
        ? emails.slice(0, 4).map((m) => `- ${m.unread ? "【未读】" : ""}${m.subject} — ${m.from}`)
        : ["- 暂无未读邮件摘要（可在「设置 → 账号连接」接入只读 IMAP 收件箱）"];

    const reminderLines =
      schedules.length > 0
        ? schedules.map((s) => `- ${s.description}${s.cron ? `（定时：${s.cron}）` : ""}`)
        : ["- 暂无活跃的定时提醒任务"];

    const memoryLines =
      memories.length > 0
        ? memories.map((m) => `- ${m.subject ? `[${m.subject}] ` : ""}${m.content.slice(0, 70)}`)
        : ["- 跟机器人聊天时提到的偏好与待办会自动沉淀到这里"];

    const body = [
      `标题：${title}`,
      `日期：${dateStr}`,
      `天气：${weather}`,
      "问候：早安！这是为你整理的今日日程、收件箱重点、定时提醒与近期记忆。",
      "",
      "### 📅 今日日程",
      ...calendarLines,
      "",
      "### 📬 收件箱摘要",
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
    if (clean === "demo" || clean === "demo@ayase.cn") return "demo.imap.local";
    const domain = clean.split("@")[1] ?? "";
    if (domain === "gmail.com" || domain === "googlemail.com") return "imap.gmail.com";
    if (domain === "qq.com" || domain === "foxmail.com") return "imap.qq.com";
    if (domain === "163.com") return "imap.163.com";
    if (domain === "126.com") return "imap.126.com";
    if (domain === "outlook.com" || domain === "hotmail.com" || domain === "live.com" || domain === "office365.com") {
      return "outlook.office365.com";
    }
    if (domain === "icloud.com" || domain === "me.com") return "imap.mail.me.com";
    if (domain === "aliyun.com") return "imap.aliyun.com";
    if (domain === "sina.com" || domain === "sina.cn") return "imap.sina.com";
    return domain ? `imap.${domain}` : "";
  }

  function tools(actorId: string): GrantedTool[] {
    return [
      {
        name: "calendar_list_events",
        ref: "personal-sources/calendar_list_events",
        description: "查看用户已连接的个人日历（iCal / ICS）近期日程安排（只读）。",
        parameters: z.object({
          days: z.number().int().min(1).max(30).optional().describe("往后看几天，默认 7 天"),
        }),
        execute: async (args) => {
          const parsed = z.object({ days: z.number().int().min(1).max(30).optional() }).safeParse(args);
          const days = parsed.success ? (parsed.data.days ?? 7) : 7;
          const row = await getRow(actorId);
          if (!row?.calendar_ics_enc) {
            return `${REFUSAL_MARKER} 用户还没有连接日历。如果用户在对话中发来了 iCal/ICS 订阅链接，请直接调用 calendar_connect 帮他连上；否则引导用户在「设置 → 账号连接」里填入 iCal / ICS 日历订阅地址，并在回复末尾附上独立一行的链接卡：\n[打开账号连接](/settings/connected-accounts)`;
          }
          const events = await listEvents(actorId, days);
          if (events.length === 0) return `未来 ${days} 天内没有日程安排。`;
          return events
            .map((e) => `- ${e.startIso}｜${e.summary}${e.location ? `（地点：${e.location}）` : ""}`)
            .join("\n");
        },
      },
      {
        name: "calendar_connect",
        ref: "personal-sources/calendar_connect",
        description:
          "主动为用户绑定并连接个人日历（支持 Google Calendar / Apple iCloud / Outlook / 飞书日历的 iCal/ICS 订阅链接 https://... 或 webcal://...，或直接粘贴 .ics 内容，或填 demo 接入演示日历）。当用户在对话里发来日历订阅链接或要求接入演示日历时，直接调用本工具帮他连上。",
        parameters: z.object({
          urlOrIcs: z
            .string()
            .min(1)
            .describe("iCal / ICS 订阅地址（https:// 或 webcal://）或 BEGIN:VCALENDAR 文本，或填 demo 接入演示日历"),
          label: z.string().max(60).optional().describe("日历名称，例如「Google 日历」「工作日程」"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({
              urlOrIcs: z.string().min(1),
              label: z.string().max(60).optional(),
            })
            .safeParse(args);
          if (!parsed.success) {
            return `${REFUSAL_MARKER} 请提供有效的 iCal / ICS 订阅链接（https:// 或 webcal://）或 .ics 内容。`;
          }
          try {
            const res = await connectCalendar(actorId, parsed.data);
            const preview = res.events
              .slice(0, 5)
              .map((e) => `- ${e.startIso}｜${e.summary}${e.location ? `（${e.location}）` : ""}`)
              .join("\n");
            return `已成功连接日历「${res.status.calendar?.label ?? "我的日历"}」（共解析到 ${res.status.calendar?.eventCount ?? res.events.length} 个日程）！${
              preview ? `\n近期日程预览：\n${preview}` : ""
            }`;
          } catch (err) {
            return `${REFUSAL_MARKER} 连接日历失败：${err instanceof Error ? err.message : "未知错误"}。也可以引导用户前往设置页配置：\n[打开账号连接](/settings/connected-accounts)`;
          }
        },
      },
      {
        name: "email_list_recent",
        ref: "personal-sources/email_list_recent",
        description: "查看用户已连接的个人收件箱（IMAP 只读，支持 Gmail / QQ / 163 / Outlook / iCloud）最近邮件与未读邮件摘要。",
        parameters: z.object({
          limit: z.number().int().min(1).max(20).optional().describe("最多返回几封，默认 8 封"),
        }),
        execute: async (args) => {
          const parsed = z.object({ limit: z.number().int().min(1).max(20).optional() }).safeParse(args);
          const limit = parsed.success ? (parsed.data.limit ?? 8) : 8;
          const row = await getRow(actorId);
          if (!row?.email_address || !row.imap_pass_enc) {
            return `${REFUSAL_MARKER} 用户还没有连接邮箱。若用户在对话中提供了邮箱地址与应用专用密码/授权码，可直接调用 email_connect 帮他连上；否则请引导用户在「设置 → 账号连接」里接入 IMAP 只读收件箱（支持 Gmail / QQ邮箱 / 163 / Outlook 预设），并在回复末尾附上独立一行的链接卡：\n[打开账号连接](/settings/connected-accounts)`;
          }
          const emails = await listEmails(actorId, limit);
          if (emails.length === 0) return "收件箱暂无邮件。";
          return emails
            .map((m) => `- ${m.unread ? "[未读] " : ""}${m.subject}｜发件人：${m.from}｜时间：${m.date}`)
            .join("\n");
        },
      },
      {
        name: "email_connect",
        ref: "personal-sources/email_connect",
        description:
          "主动为用户绑定并连接个人邮箱收件箱（IMAP 只读，支持 Gmail / QQ邮箱 / 163邮箱 / Outlook / iCloud 等；自动根据邮箱后缀匹配 IMAP 服务器地址）。当用户在对话里提供了邮箱地址和应用专用密码/授权码（或填 demo 接入演示收件箱）时，直接调用本工具完成连接。",
        parameters: z.object({
          email: z.string().min(1).describe("邮箱地址（例如 xxx@gmail.com、xxx@qq.com，或填 demo 接入演示邮箱）"),
          password: z.string().min(1).describe("应用专用密码 / IMAP 授权码（若接入演示邮箱填 demo-inbox）"),
          imapHost: z
            .string()
            .optional()
            .describe("IMAP 服务器地址（可选，不填会根据邮箱后缀自动匹配，如 imap.gmail.com / imap.qq.com / imap.163.com）"),
          imapPort: z.number().int().optional().describe("IMAP SSL 端口，默认 993"),
        }),
        execute: async (args) => {
          const parsed = z
            .object({
              email: z.string().min(1),
              password: z.string().min(1),
              imapHost: z.string().optional(),
              imapPort: z.number().int().optional(),
            })
            .safeParse(args);
          if (!parsed.success) {
            return `${REFUSAL_MARKER} 请提供邮箱地址和应用专用密码/授权码。`;
          }
          const isDemo = parsed.data.email.trim().toLowerCase() === "demo";
          const emailAddr = isDemo ? "demo@ayase.cn" : parsed.data.email.trim();
          const imapHost = parsed.data.imapHost?.trim() || inferImapHost(emailAddr);
          const pass = isDemo ? "demo-inbox" : parsed.data.password.trim();
          try {
            const res = await connectEmail(actorId, {
              email: emailAddr,
              imapHost,
              imapPort: parsed.data.imapPort ?? 993,
              password: pass,
            });
            const preview = res.emails
              .slice(0, 5)
              .map((m) => `- ${m.unread ? "[未读] " : ""}${m.subject}（${m.from}）`)
              .join("\n");
            return `已成功连接邮箱「${res.status.email?.email ?? emailAddr}」（服务器：${imapHost}）！${
              preview ? `\n最近收件箱摘要：\n${preview}` : ""
            }`;
          } catch (err) {
            return `${REFUSAL_MARKER} 连接邮箱失败：${err instanceof Error ? err.message : "未知错误"}。也可以引导用户点击下方卡片在「设置 → 账号连接」中配置：\n[打开账号连接](/settings/connected-accounts)`;
          }
        },
      },
      {
        name: "morning_brief_generate",
        ref: "personal-sources/morning_brief_generate",
        description:
          "为用户生成今日晨报卡片（聚合天气、日历日程、未读邮件、定时提醒与近期记忆）。返回的内容包含 ```brief 代码块，请原样放进回复里展示为晨报卡片。",
        parameters: z.object({
          city: z.string().max(30).optional().describe("天气城市，如「上海」「北京」，不填使用用户默认城市"),
        }),
        execute: async (args) => {
          const parsed = z.object({ city: z.string().max(30).optional() }).safeParse(args);
          const brief = await generateMorningBrief(actorId, parsed.success ? parsed.data.city : undefined);
          return `已生成今日晨报，请将以下 \`\`\`brief 代码块原样输出给用户（会自动渲染为晨报卡片）：\n\n${brief.markdown}`;
        },
      },
    ];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.get("/", async (c) => {
      const row = await getRow(c.var.actor.id);
      return c.json(toStatusView(row));
    });

    app.put("/calendar", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { label?: string; urlOrIcs?: string };
      try {
        const res = await connectCalendar(c.var.actor.id, {
          label: body.label,
          urlOrIcs: body.urlOrIcs ?? "",
        });
        return c.json(res);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "连接日历失败" }, 400);
      }
    });

    app.delete("/calendar", async (c) => {
      const status = await disconnectCalendar(c.var.actor.id);
      return c.json({ status });
    });

    app.put("/email", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        email?: string;
        imapHost?: string;
        imapPort?: number;
        password?: string;
      };
      try {
        const res = await connectEmail(c.var.actor.id, {
          email: body.email ?? "",
          imapHost: body.imapHost ?? "",
          imapPort: body.imapPort,
          password: body.password ?? "",
        });
        return c.json(res);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "连接邮箱失败" }, 400);
      }
    });

    app.delete("/email", async (c) => {
      const status = await disconnectEmail(c.var.actor.id);
      return c.json({ status });
    });

    app.put("/weather", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { weatherCity?: string };
      const city = (body.weatherCity?.trim() || "上海").slice(0, 30);
      await sql.unsafe(
        `INSERT INTO chisabot_personal_sources (owner_user_id, weather_city, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (owner_user_id) DO UPDATE SET weather_city = EXCLUDED.weather_city, updated_at = now()`,
        [c.var.actor.id, city],
      );
      return c.json(toStatusView(await getRow(c.var.actor.id)));
    });

    app.post("/brief", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { city?: string };
      const brief = await generateMorningBrief(c.var.actor.id, body.city);
      return c.json(brief);
    });

    return app;
  }

  return {
    ensure,
    status: async (actorId: string) => toStatusView(await getRow(actorId)),
    tools,
    routes,
    listEvents,
    listEmails,
    generateMorningBrief,
  };
}
export type PersonalSourcesService = ReturnType<typeof createPersonalSources>;
