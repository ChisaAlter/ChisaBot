import {
  asJsonArray,
  asJsonRecord,
  asString,
  errorText,
  type JsonRecord,
  parseJsonRecord,
  readJson,
} from "../text";
import type {
  AdapterContext,
  ImDeliveryReceipt,
  ImInbound,
  ImInboundAttachment,
  ImMediaKind,
  ImReply,
  ImReplyFile,
  TestResult,
} from "../types";
import {
  detectPlatformWindowExpired,
  ImWindowExpiredError,
} from "../window-expiry";
import { dataText, LoopAdapter, randomId } from "./base";

/**
 * Slack 官方机器人（Socket Mode + Web API）。
 *
 * 流程：
 * 1. `POST auth.test`（`botToken`）识别自身 `user_id` 与 `bot_id`，防自循环。
 * 2. `POST apps.connections.open`（`appToken`）申请 Socket Mode WSS 地址并建连。
 * 3. 收到带 `envelope_id` 的帧立即回发 `{ envelope_id }` ACK，解析 `events_api` 里的 `message` / `app_mention` 事件：
 *    - 私聊（`im`）自动触发；频道/多人会话仅响应 `app_mention` 或正文中 `@<botUserId>`。
 *    - 同一条消息若同时收到 `message` 与 `app_mention`，通过 `${channel}:${ts}` 去重只处理一次。
 * 4. 回复调用 `POST chat.postMessage`，支持 `thread_ts`，并在遇到 `channel_is_archived` / `cannot_dm_bot` 等窗口失效错误时抛出 `ImWindowExpiredError`。
 */

const SLACK_TERMINAL_WINDOW_ERRORS = new Set([
  "channel_is_archived",
  "cannot_dm_bot",
  "is_archived",
  "account_inactive",
  "user_is_restricted",
]);

export function slackApiBase(config: Record<string, string>): string {
  // __apiBase：只给本地测试替身注入用。
  if (config.__apiBase) return config.__apiBase.replace(/\/+$/, "");
  return (config.apiBase || "https://slack.com/api").replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifySlackFile(file: JsonRecord): ImInboundAttachment {
  const mimeType = asString(file.mimetype);
  const fileType = (asString(file.filetype) ?? "").toLowerCase();
  const fileName = asString(file.name) ?? asString(file.title);
  const url =
    asString(file.url_private_download) ??
    asString(file.url_private) ??
    asString(file.permalink);
  const normalizedMime = (mimeType ?? "").toLowerCase();

  let kind: ImMediaKind = "file";
  if (
    normalizedMime.startsWith("image/") ||
    /^(png|jpe?g|gif|webp|bmp|svg)$/.test(fileType)
  ) {
    kind = "image";
  } else if (
    normalizedMime.startsWith("audio/") ||
    /^(ogg|opus|mp3|wav|m4a|aac|flac)$/.test(fileType)
  ) {
    kind = "voice";
  } else if (
    normalizedMime.startsWith("video/") ||
    /^(mp4|mov|webm|mkv|avi)$/.test(fileType)
  ) {
    kind = "video";
  }

  return {
    kind,
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

/** Slack Events API 事件 → `ImInbound`；bot 自身或系统子类型消息返回 null。 */
export function parseSlackEvent(
  rawEvent: unknown,
  botUserId: string | null,
  botId: string | null = null,
): ImInbound | null {
  const event = asJsonRecord(rawEvent);
  if (!event) return null;
  const eventType = asString(event.type);
  if (eventType !== "message" && eventType !== "app_mention") return null;

  if (event.bot_id) return null;
  if (botId && asString(event.bot_id) === botId) return null;

  const subtype = asString(event.subtype);
  if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") {
    return null;
  }

  const userId = asString(event.user) ?? "";
  if (!userId) return null;
  if (botUserId && userId === botUserId) return null;

  const channel = asString(event.channel) ?? "";
  if (!channel) return null;

  const channelType = asString(event.channel_type) ?? "";
  const isPrivate =
    eventType === "message" &&
    (channelType === "im" || (!channelType && channel.startsWith("D")));

  let text = asString(event.text) ?? "";
  let mentioned = isPrivate || eventType === "app_mention";

  if (botUserId) {
    const mentionTagRe = new RegExp(
      `<@${escapeRegExp(botUserId)}(?:\\|[^>]*)?>`,
      "g",
    );
    if (mentionTagRe.test(text)) {
      mentioned = true;
      text = text.replace(mentionTagRe, "");
    }
  } else if (eventType === "app_mention") {
    text = text.replace(/^\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*/, "");
  }

  const attachments = asJsonArray(event.files)
    .map((item) => asJsonRecord(item))
    .filter((item): item is JsonRecord => item !== null)
    .map(classifySlackFile);

  const ts = asString(event.ts) ?? asString(event.event_ts) ?? "";
  const threadTs =
    asString(event.thread_ts) ?? (isPrivate ? undefined : ts || undefined);
  const messageId = ts ? `${channel}:${ts}` : randomId();

  return {
    messageId,
    chatType: isPrivate ? "private" : "group",
    chatId: isPrivate ? userId : channel,
    userId,
    text: text.trim(),
    mentioned,
    reply: {
      channel,
      ...(threadTs ? { threadTs } : {}),
      ...(ts ? { ts } : {}),
    },
    ...(attachments.length ? { attachments } : {}),
  };
}

function formatSlackFiles(files: ImReplyFile[]): string {
  return files
    .map((file) => {
      const label = file.fileName ?? file.kind;
      return file.url ? `<${file.url}|${label}>` : `[${label}]`;
    })
    .join("\n");
}

export class SlackAdapter extends LoopAdapter {
  readonly platform = "slack" as const;
  readonly maxChunk = 3800;
  readonly markdown = true;

  private botUserId: string | null = null;
  private botId: string | null = null;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private get botToken(): string {
    return (this.ctx.secrets.botToken ?? this.ctx.secrets.token ?? "").trim();
  }

  private get appToken(): string {
    return (this.ctx.secrets.appToken ?? "").trim();
  }

  private get apiBase(): string {
    return slackApiBase(this.ctx.config);
  }

  private async postSlack(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ response: Response; parsed: JsonRecord }> {
    const response = await this.ctx.fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed: JsonRecord = {};
    try {
      parsed = parseJsonRecord(raw);
    } catch {}
    return { response, parsed };
  }

  protected async runOnce(): Promise<void> {
    if (!this.botToken || !this.appToken) {
      throw new Error("请填写 Slack Bot Token 和 App-Level Token");
    }

    const authRes = await this.ctx.fetch(`${this.apiBase}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    const authBody = await readJson(authRes, "Slack auth.test");
    if (!authBody.ok) {
      throw new Error(
        `Slack Bot Token 无效：${asString(authBody.error) ?? authRes.status}`,
      );
    }
    this.botUserId = asString(authBody.user_id) ?? null;
    this.botId = asString(authBody.bot_id) ?? null;
    const accountLabel =
      asString(authBody.user) ?? asString(authBody.bot_id) ?? "Slack 机器人";

    const openRes = await this.ctx.fetch(
      `${this.apiBase}/apps.connections.open`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    const openBody = await readJson(openRes, "Slack apps.connections.open");
    const wssUrl = asString(openBody.url);
    if (!openBody.ok || !wssUrl) {
      throw new Error(
        `打开 Slack Socket Mode 失败：${asString(openBody.error) ?? openRes.status}`,
      );
    }

    await this.openSocket(wssUrl, {
      onOpen: () => {
        this.markConnected(`Slack @${accountLabel}`);
        this.ctx.log("info", `已连上 Slack Socket Mode（@${accountLabel}）`);
      },
      onMessage: (data) => this.handle(dataText(data)),
    });
  }

  private handle(text: string) {
    const frame = parseJsonRecord(text);
    const envelopeId = asString(frame.envelope_id);
    if (envelopeId) {
      try {
        this.sendJson({ envelope_id: envelopeId });
      } catch {}
    }

    const frameType = asString(frame.type);
    if (frameType === "hello") {
      this.ctx.log("info", "Slack Socket Mode 收到 hello 就绪帧");
      return;
    }
    if (frameType === "disconnect") {
      const reason = asString(frame.reason) ?? "disconnect";
      this.ctx.log("info", `Slack Socket Mode 要求重连：${reason}`);
      this.socket?.close(4000, reason);
      return;
    }
    if (frameType === "events_api") {
      const payload = asJsonRecord(frame.payload);
      const inbound = parseSlackEvent(
        payload?.event,
        this.botUserId,
        this.botId,
      );
      if (inbound) this.emit(inbound);
    }
  }

  async send(reply: ImReply): Promise<ImDeliveryReceipt | undefined> {
    if (!this.botToken) throw new Error("请填写 Slack Bot Token");
    const channel =
      asString(reply.inbound.reply.channel) ?? reply.inbound.chatId;
    const threadTs =
      asString(reply.inbound.reply.threadTs) ??
      asString(reply.inbound.reply.thread_ts);
    const linkFiles = (reply.files ?? []).filter((file) => file.url);
    const chunks = reply.chunks.length
      ? [...reply.chunks]
      : reply.text.trim()
        ? [reply.text.trim()]
        : [];
    if (linkFiles.length > 0) {
      const suffix = formatSlackFiles(linkFiles);
      if (chunks.length > 0) {
        const lastIndex = chunks.length - 1;
        const merged = `${chunks[lastIndex] ?? ""}\n${suffix}`.trim();
        if (merged.length <= this.maxChunk) {
          chunks[lastIndex] = merged;
        } else {
          chunks.push(suffix);
        }
      } else {
        chunks.push(suffix);
      }
    }
    if (chunks.length === 0) return undefined;

    const messageIds: string[] = [];
    for (const chunk of chunks) {
      const { response, parsed } = await this.postSlack(
        "chat.postMessage",
        this.botToken,
        {
          channel,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        },
      );
      if (!response.ok || parsed.ok === false) {
        const errCode = asString(parsed.error) ?? "";
        const errDetail = `${errCode} ${asString(parsed.warning) ?? ""}`.trim();
        if (
          SLACK_TERMINAL_WINDOW_ERRORS.has(errCode) ||
          detectPlatformWindowExpired("slack", response.status, errDetail)
        ) {
          throw new ImWindowExpiredError(
            `Slack 发送失败（频道不可达或已归档）：${errCode || response.status}`,
            "slack",
            errCode || response.status,
          );
        }
        throw new Error(
          `Slack chat.postMessage 失败：HTTP ${response.status} ${errCode || "unknown"}`.trim(),
        );
      }
      const sentTs = asString(parsed.ts);
      if (sentTs) messageIds.push(sentTs);
    }
    return { messageIds };
  }
}

export async function testSlack(ctx: AdapterContext): Promise<TestResult> {
  const botToken = (ctx.secrets.botToken ?? ctx.secrets.token ?? "").trim();
  const appToken = (ctx.secrets.appToken ?? "").trim();
  if (!botToken) return { ok: false, detail: "请填写 Bot Token (xoxb-)" };
  if (!appToken) return { ok: false, detail: "请填写 App-Level Token (xapp-)" };
  try {
    const base = slackApiBase(ctx.config);
    const authRes = await ctx.fetch(`${base}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    const authBody = await readJson(authRes, "Slack auth.test");
    if (!authBody.ok) {
      return {
        ok: false,
        detail: `Bot Token 无效：${asString(authBody.error) ?? authRes.status}`,
      };
    }
    const openRes = await ctx.fetch(`${base}/apps.connections.open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const openBody = await readJson(openRes, "Slack apps.connections.open");
    if (!openBody.ok || !asString(openBody.url)) {
      return {
        ok: false,
        detail: `App-Level Token 无效：${asString(openBody.error) ?? openRes.status}`,
      };
    }
    const label = asString(authBody.user) ?? asString(authBody.user_id) ?? "";
    return {
      ok: true,
      detail: `凭据有效，机器人${label ? ` @${label}` : ""}，Socket Mode 可用`,
    };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
