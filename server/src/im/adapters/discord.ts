import {
  asJsonArray,
  asJsonRecord,
  asString,
  errorText,
  type JsonRecord,
  parseJsonRecord,
  readJson,
  readJsonField,
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
import { dataText, LoopAdapter } from "./base";

/**
 * Discord 机器人适配器（Gateway v10 + REST API v10）。
 *
 * 流程：
 * 1. 若未配置 `gatewayUrl`，先调用 `GET /gateway/bot` 获取 WSS 地址。
 * 2. 连接 Gateway 后等 `op 10 HELLO` 提取 `heartbeat_interval` 启动 `op 1` 心跳，并发送 `op 2 IDENTIFY`（断线可续期发 `op 6 RESUME`）。
 * 3. `op 0 DISPATCH` 处理 `READY`、`RESUMED`、`MESSAGE_CREATE`（忽略自身与其它机器人消息；频道需 `@机器人` 或回复机器人消息）。
 * 4. 回复通过 `POST /channels/{id}/messages` 发送，支持长文分段与 `50007` 等窗口关闭 / 拒收错误识别为 `ImWindowExpiredError`。
 */

export const DEFAULT_DISCORD_GATEWAY =
  "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export function discordApiBase(config: Record<string, string>): string {
  // __apiBase：只给本地测试替身注入用。
  if (config.__apiBase) return config.__apiBase.replace(/\/+$/, "");
  return (config.apiBase || "https://discord.com/api/v10").replace(/\/+$/, "");
}

export function discordIntents(config: Record<string, string>): number {
  const raw = (config.intents ?? "").trim();
  if (!raw) return DEFAULT_DISCORD_INTENTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DISCORD_INTENTS;
}

function ensureGatewayQuery(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.has("v")) parsed.searchParams.set("v", "10");
    if (!parsed.searchParams.has("encoding"))
      parsed.searchParams.set("encoding", "json");
    return parsed.toString();
  } catch {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return rawUrl.includes("v=")
      ? rawUrl
      : `${rawUrl.replace(/\/+$/, "")}/${separator}v=10&encoding=json`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyDiscordAttachment(item: JsonRecord): ImInboundAttachment {
  const mimeType = asString(item.content_type);
  const fileName = asString(item.filename);
  const url = asString(item.url) ?? asString(item.proxy_url);
  const durationSecs =
    typeof item.duration_secs === "number" &&
    Number.isFinite(item.duration_secs)
      ? item.duration_secs
      : undefined;
  const normalizedMime = (mimeType ?? "").toLowerCase();
  const normalizedName = (fileName ?? "").toLowerCase();

  let kind: ImMediaKind = "file";
  if (
    normalizedMime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(normalizedName)
  ) {
    kind = "image";
  } else if (
    normalizedMime.startsWith("audio/") ||
    item.waveform != null ||
    durationSecs !== undefined ||
    /\.(ogg|opus|mp3|wav|m4a|aac|flac)$/.test(normalizedName)
  ) {
    kind = "voice";
  } else if (
    normalizedMime.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi)$/.test(normalizedName)
  ) {
    kind = "video";
  }

  return {
    kind,
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(durationSecs !== undefined
      ? { durationMs: Math.round(durationSecs * 1000) }
      : {}),
  };
}

/** Discord `MESSAGE_CREATE` 载荷 → `ImInbound`；bot 自身或其它 bot 消息返回 null。 */
export function parseDiscordMessage(
  rawData: unknown,
  botUserId: string | null,
): ImInbound | null {
  const d = asJsonRecord(rawData);
  const author = asJsonRecord(d?.author);
  if (!d?.id || !author?.id) return null;
  if (author.bot === true || author.system === true || d.webhook_id != null) {
    return null;
  }
  const userId = String(author.id);
  if (botUserId && userId === botUserId) return null;

  const channelId = String(d.channel_id ?? "");
  if (!channelId) return null;
  const isGroup = Boolean(d.guild_id);

  let text = asString(d.content) ?? "";
  let mentioned = !isGroup;

  if (isGroup && botUserId) {
    const mentionListHit = asJsonArray(d.mentions).some(
      (item) => String(readJsonField(item, "id") ?? "") === botUserId,
    );
    const mentionTagRe = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g");
    const mentionTagHit = mentionTagRe.test(text);
    const replyToBot =
      String(readJsonField(d.referenced_message, "author", "id") ?? "") ===
      botUserId;
    if (mentionListHit || mentionTagHit || replyToBot) {
      mentioned = true;
    }
    text = text.replace(mentionTagRe, "");
  }

  const attachments = asJsonArray(d.attachments)
    .map((item) => asJsonRecord(item))
    .filter((item): item is JsonRecord => item !== null)
    .map(classifyDiscordAttachment);

  const userName =
    asString(readJsonField(d.member, "nick")) ??
    asString(author.global_name) ??
    asString(author.username);

  return {
    messageId: String(d.id),
    chatType: isGroup ? "group" : "private",
    chatId: isGroup ? channelId : userId,
    userId,
    ...(userName ? { userName } : {}),
    text: text.trim(),
    mentioned,
    reply: {
      channelId,
      messageId: String(d.id),
      ...(d.guild_id ? { guildId: String(d.guild_id) } : {}),
    },
    ...(attachments.length ? { attachments } : {}),
  };
}

function decodeBase64Bytes(raw: string): Uint8Array {
  const clean = raw.trim().replace(/^data:[^;]+;base64,/i, "");
  return new Uint8Array(Buffer.from(clean, "base64"));
}

function formatFilesFallback(files: ImReplyFile[]): string {
  return files
    .map((file) => {
      const label = file.fileName ?? file.kind;
      return file.url ? `[${label}](${file.url})` : `[${label}]`;
    })
    .join("\n");
}

export class DiscordAdapter extends LoopAdapter {
  readonly platform = "discord" as const;
  readonly maxChunk = 2000;
  readonly markdown = true;

  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private get botToken(): string {
    return (this.ctx.secrets.botToken ?? this.ctx.secrets.token ?? "").trim();
  }

  private get apiBase(): string {
    return discordApiBase(this.ctx.config);
  }

  protected override onStop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async resolveGatewayUrl(): Promise<string> {
    if (this.resumeGatewayUrl && this.sessionId && this.seq != null) {
      return ensureGatewayQuery(this.resumeGatewayUrl);
    }
    const configured = (this.ctx.config.gatewayUrl ?? "").trim();
    if (configured) {
      return ensureGatewayQuery(configured);
    }
    const response = await this.ctx.fetch(`${this.apiBase}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.botToken}` },
    });
    const body = await readJson(response, "获取 Discord Gateway 地址");
    const url = asString(body.url) ?? DEFAULT_DISCORD_GATEWAY;
    return ensureGatewayQuery(url);
  }

  protected async runOnce(): Promise<void> {
    if (!this.botToken) throw new Error("请填写 Discord Bot Token");
    const gatewayUrl = await this.resolveGatewayUrl();
    await this.openSocket(gatewayUrl, {
      onMessage: (data) => this.handle(dataText(data)),
    });
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      try {
        this.sendJson({ op: 1, d: this.seq });
      } catch {}
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  private handle(text: string) {
    const payload = parseJsonRecord(text);
    if (typeof payload.s === "number") this.seq = payload.s;
    const d = asJsonRecord(payload.d);

    switch (payload.op) {
      case 10: {
        const interval = Number(d?.heartbeat_interval) || 41_250;
        this.startHeartbeat(interval);
        if (this.sessionId && this.seq != null) {
          this.sendJson({
            op: 6,
            d: {
              token: this.botToken,
              session_id: this.sessionId,
              seq: this.seq,
            },
          });
        } else {
          this.sendJson({
            op: 2,
            d: {
              token: this.botToken,
              intents: discordIntents(this.ctx.config),
              properties: {
                os: "linux",
                browser: "chisabot",
                device: "chisabot",
              },
            },
          });
        }
        return;
      }
      case 1: {
        try {
          this.sendJson({ op: 1, d: this.seq });
        } catch {}
        return;
      }
      case 11:
        return;
      case 7:
        this.ctx.log("info", "Discord 网关要求重连");
        this.socket?.close(4000, "reconnect");
        return;
      case 9:
        this.ctx.log("warn", "Discord 会话失效，重新登录");
        if (!payload.d) {
          this.sessionId = null;
          this.seq = null;
          this.resumeGatewayUrl = null;
        }
        this.socket?.close(4000, "invalid session");
        return;
      case 0:
        break;
      default:
        return;
    }

    if (payload.t === "READY") {
      this.sessionId = asString(d?.session_id) ?? null;
      this.resumeGatewayUrl = asString(d?.resume_gateway_url) ?? null;
      this.botUserId = asString(readJsonField(d?.user, "id")) ?? null;
      const username = asString(readJsonField(d?.user, "username"));
      this.markConnected(username ? `Discord @${username}` : "Discord 机器人");
      this.ctx.log(
        "info",
        `已连上 Discord Gateway${username ? `（@${username}）` : ""}`,
      );
      return;
    }

    if (payload.t === "RESUMED") {
      this.markConnected(null, "已恢复 Discord 会话");
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      const inbound = parseDiscordMessage(payload.d, this.botUserId);
      if (inbound) this.emit(inbound);
    }
  }

  private async postMessage(
    channelId: string,
    payload: Record<string, unknown>,
    inlineFiles: (ImReplyFile & { dataBase64: string })[] = [],
  ): Promise<JsonRecord> {
    if (!this.botToken) throw new Error("请填写 Discord Bot Token");
    const endpoint = `${this.apiBase}/channels/${encodeURIComponent(channelId)}/messages`;
    let init: RequestInit;
    if (inlineFiles.length > 0) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      inlineFiles.forEach((file, index) => {
        const bytes = decodeBase64Bytes(file.dataBase64);
        const blob = new Blob([Uint8Array.from(bytes)], {
          type: file.mimeType || "application/octet-stream",
        });
        form.append(
          `files[${index}]`,
          blob,
          file.fileName || `attachment-${index}`,
        );
      });
      init = {
        method: "POST",
        headers: { Authorization: `Bot ${this.botToken}` },
        body: form,
      };
    } else {
      init = {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      };
    }

    const response = await this.ctx.fetch(endpoint, init);
    const rawBody = await response.text();
    let parsed: JsonRecord = {};
    try {
      parsed = parseJsonRecord(rawBody);
    } catch {}
    if (!response.ok) {
      const codeStr = parsed.code != null ? String(parsed.code) : "";
      const msgStr = asString(parsed.message) ?? rawBody.slice(0, 200);
      const combined = `${codeStr} ${msgStr}`.trim();
      if (detectPlatformWindowExpired("discord", response.status, combined)) {
        throw new ImWindowExpiredError(
          `Discord 发送被拒（窗口关闭或用户拒收）：${combined || response.status}`,
          "discord",
          codeStr || response.status,
        );
      }
      throw new Error(
        `Discord 发送失败：HTTP ${response.status} ${combined}`.trim(),
      );
    }
    return parsed;
  }

  async typing(inbound: ImInbound): Promise<void> {
    const channelId = asString(inbound.reply.channelId) ?? inbound.chatId;
    if (!channelId || !this.botToken) return;
    try {
      await this.ctx.fetch(
        `${this.apiBase}/channels/${encodeURIComponent(channelId)}/typing`,
        {
          method: "POST",
          headers: { Authorization: `Bot ${this.botToken}` },
        },
      );
    } catch {}
  }

  async send(reply: ImReply): Promise<ImDeliveryReceipt | undefined> {
    const channelId =
      asString(reply.inbound.reply.channelId) ?? reply.inbound.chatId;
    const messageId =
      asString(reply.inbound.reply.messageId) ?? reply.inbound.messageId;
    const allFiles = reply.files ?? [];
    const inlineFiles = allFiles.filter(
      (file): file is ImReplyFile & { dataBase64: string } =>
        typeof file.dataBase64 === "string" &&
        file.dataBase64.trim().length > 0,
    );
    const linkFiles = allFiles.filter((file) => !file.dataBase64 && file.url);
    const chunks = reply.chunks.length
      ? [...reply.chunks]
      : reply.text.trim()
        ? [reply.text.trim()]
        : [];
    if (linkFiles.length > 0) {
      const suffix = formatFilesFallback(linkFiles);
      if (chunks.length > 0) {
        const lastIndex = chunks.length - 1;
        const lastChunk = chunks[lastIndex] ?? "";
        const merged = `${lastChunk}\n${suffix}`.trim();
        if (merged.length <= this.maxChunk) {
          chunks[lastIndex] = merged;
        } else {
          chunks.push(suffix);
        }
      } else {
        chunks.push(suffix);
      }
    }
    if (chunks.length === 0 && inlineFiles.length > 0) {
      chunks.push("");
    }
    if (chunks.length === 0) return undefined;

    const messageIds: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index] ?? "";
      const isFirst = index === 0;
      const isLast = index === chunks.length - 1;
      const payload: Record<string, unknown> = {
        content: chunk,
        ...(isFirst && messageId
          ? {
              message_reference: {
                message_id: messageId,
                fail_if_not_exists: false,
              },
            }
          : {}),
      };
      const result = await this.postMessage(
        channelId,
        payload,
        isLast ? inlineFiles : [],
      );
      const sentId = asString(result.id);
      if (sentId) messageIds.push(sentId);
    }
    return { messageIds };
  }
}

export async function testDiscord(ctx: AdapterContext): Promise<TestResult> {
  const token = (ctx.secrets.botToken ?? ctx.secrets.token ?? "").trim();
  if (!token) return { ok: false, detail: "请填写 Bot Token" };
  try {
    const response = await ctx.fetch(
      `${discordApiBase(ctx.config)}/users/@me`,
      {
        headers: { Authorization: `Bot ${token}` },
      },
    );
    const body = await readJson(response, "Discord /users/@me");
    const username = asString(body.username);
    const id = asString(body.id);
    if (!id && !username) {
      return { ok: false, detail: "Discord 没有返回机器人身份信息" };
    }
    return {
      ok: true,
      detail: `Token 有效，机器人 @${username ?? id}`,
    };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
