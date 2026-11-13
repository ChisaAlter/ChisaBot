import { errorText, readJson } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult } from "../types";
import { dataText, LoopAdapter } from "./base";

/**
 * QQ 官方机器人（QQ 开放平台，q.qq.com），WebSocket 网关。
 *
 * 协议（QQ 机器人文档 bot.q.qq.com/wiki；LangBot 的 qqofficial 适配器同一套流程）：
 * 1. POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret} → access_token（约 7200 秒）。
 * 2. GET {api}/gateway（`Authorization: QQBot <token>`）→ wss 地址。
 * 3. 收到 op 10 Hello → 发 op 2 Identify {token:"QQBot <token>", intents, shard:[0,1]}（有会话就 op 6 Resume），
 *    按 heartbeat_interval 发 op 1 心跳（d = 最后一个序号）。op 0 是事件，op 7 要求重连，op 9 会话失效。
 * 4. 事件：C2C_MESSAGE_CREATE（私聊）、GROUP_AT_MESSAGE_CREATE（群 @）、AT_MESSAGE_CREATE（频道 @）、
 *    DIRECT_MESSAGE_CREATE（频道私信）。
 * 5. 被动回复带 msg_id + 递增的 msg_seq：/v2/users/{openid}/messages、/v2/groups/{group_openid}/messages、
 *    /channels/{channel_id}/messages、/dms/{guild_id}/messages。
 */

const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
const INTENT_DIRECT_MESSAGE = 1 << 12;

export function qqApiBase(config: Record<string, string>) {
  // __apiBase / __tokenUrl：只给测试工具用（接口不接受这些字段）。
  if (config.__apiBase) return config.__apiBase;
  return config.sandbox === "sandbox" ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
}

export function qqIntents(config: Record<string, string>) {
  return config.scope === "all" ? INTENT_GROUP_AND_C2C | INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE : INTENT_GROUP_AND_C2C;
}

export async function qqAccessToken(ctx: Pick<AdapterContext, "fetch" | "config" | "secrets">): Promise<{ token: string; expiresAt: number }> {
  const appId = (ctx.config.appId ?? "").trim();
  const secret = (ctx.secrets.appSecret ?? "").trim();
  if (!appId || !secret) throw new Error("请填写 AppID 和 AppSecret");
  const response = await ctx.fetch(ctx.config.__tokenUrl || "https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const body = await readJson(response, "获取 QQ 机器人令牌");
  if (!body.access_token) throw new Error(`获取 QQ 机器人令牌失败：${body.message ?? body.msg ?? JSON.stringify(body).slice(0, 160)}`);
  return { token: String(body.access_token), expiresAt: Date.now() + (Number(body.expires_in) || 7200) * 1000 };
}

/** QQ 事件 → ImInbound。 */
// biome-ignore lint/suspicious/noExplicitAny: QQ 开放平台事件 d 载荷字段随事件类型变化
export function parseQqEvent(type: string, d: Record<string, any>): ImInbound | null {
  const content = String(d.content ?? "");
  const attachments = Array.isArray(d.attachments)
    // biome-ignore lint/suspicious/noExplicitAny: 附件元素按官方协议字段取用
    ? d.attachments.map((item: any) => ({ kind: String(item.content_type ?? "").startsWith("image") ? ("image" as const) : ("file" as const), url: item.url }))
    : undefined;
  const base = { messageId: String(d.id ?? ""), attachments: attachments?.length ? attachments : undefined };
  switch (type) {
    case "C2C_MESSAGE_CREATE": {
      const user = String(d.author?.user_openid ?? d.author?.id ?? "");
      return { ...base, chatType: "private", chatId: user, userId: user, text: content.trim(), mentioned: true, reply: { kind: "c2c", msgId: d.id } };
    }
    case "GROUP_AT_MESSAGE_CREATE": {
      const group = String(d.group_openid ?? d.group_id ?? "");
      const user = String(d.author?.member_openid ?? d.author?.id ?? "");
      return { ...base, chatType: "group", chatId: group, userId: user, text: content.trim(), mentioned: true, reply: { kind: "group", msgId: d.id } };
    }
    case "AT_MESSAGE_CREATE": {
      return {
        ...base,
        chatType: "group",
        chatId: String(d.channel_id),
        userId: String(d.author?.id ?? ""),
        userName: d.author?.username,
        text: content.replace(/<@!?\d+>/g, "").trim(),
        mentioned: true,
        reply: { kind: "channel", msgId: d.id, channelId: d.channel_id },
      };
    }
    case "DIRECT_MESSAGE_CREATE": {
      return {
        ...base,
        chatType: "private",
        chatId: `dms:${d.guild_id}`,
        userId: String(d.author?.id ?? ""),
        userName: d.author?.username,
        text: content.trim(),
        mentioned: true,
        reply: { kind: "dms", msgId: d.id, guildId: d.guild_id },
      };
    }
    default:
      return null;
  }
}

export class QqOfficialAdapter extends LoopAdapter {
  readonly platform = "qq_official" as const;
  readonly maxChunk = 1800;
  readonly markdown = false;
  private token: { token: string; expiresAt: number } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private async accessToken() {
    if (!this.token || this.token.expiresAt - Date.now() < 60_000) this.token = await qqAccessToken(this.ctx);
    return this.token.token;
  }

  protected override onStop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  protected async runOnce(): Promise<void> {
    const token = await this.accessToken();
    const response = await this.ctx.fetch(`${qqApiBase(this.ctx.config)}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
    const gateway = await readJson(response, "获取 QQ 网关地址");
    if (!gateway.url) throw new Error(`获取 QQ 网关地址失败：${gateway.message ?? JSON.stringify(gateway).slice(0, 160)}`);
    await this.openSocket(String(gateway.url), { onMessage: (data) => this.handle(dataText(data)) });
  }

  private async handle(text: string) {
    // biome-ignore lint/suspicious/noExplicitAny: QQ 网关帧 d 载荷字段随 op/t 变化
    const payload = JSON.parse(text) as { op: number; d?: any; s?: number; t?: string };
    if (typeof payload.s === "number") this.seq = payload.s;
    switch (payload.op) {
      case 10: {
        const interval = Number(payload.d?.heartbeat_interval) || 41_250;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          try {
            this.sendJson({ op: 1, d: this.seq });
          } catch {}
        }, interval);
        const token = await this.accessToken();
        if (this.sessionId && this.seq != null) this.sendJson({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } });
        else this.sendJson({ op: 2, d: { token: `QQBot ${token}`, intents: qqIntents(this.ctx.config), shard: [0, 1], properties: {} } });
        return;
      }
      case 11:
        return;
      case 7:
        this.ctx.log("info", "QQ 网关要求重连");
        this.socket?.close(4000, "reconnect");
        return;
      case 9:
        this.ctx.log("warn", "QQ 会话失效，重新登录");
        this.sessionId = null;
        this.seq = null;
        this.socket?.close(4000, "invalid session");
        return;
      case 0:
        break;
      default:
        return;
    }
    if (payload.t === "READY") {
      this.sessionId = payload.d?.session_id ?? null;
      const name = payload.d?.user?.username;
      this.markConnected(name ? `QQ 机器人「${name}」` : "QQ 机器人");
      this.ctx.log("info", `已连上 QQ 网关${name ? `（${name}）` : ""}`);
      return;
    }
    if (payload.t === "RESUMED") {
      this.markConnected(null, "已恢复会话");
      return;
    }
    const inbound = parseQqEvent(String(payload.t), payload.d ?? {});
    if (inbound) this.emit(inbound);
  }

  private async post(path: string, body: Record<string, unknown>) {
    const token = await this.accessToken();
    const response = await this.ctx.fetch(`${qqApiBase(this.ctx.config)}${path}`, {
      method: "POST",
      headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    // biome-ignore lint/suspicious/noExplicitAny: 开放平台接口回包 JSON 形状按文档字段取用
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {}
    if (!response.ok || (parsed.code && parsed.code !== 0 && !parsed.id))
      throw new Error(`QQ 发送失败：HTTP ${response.status} ${parsed.code ?? ""} ${parsed.message ?? text.slice(0, 160)}`.trim());
    return parsed;
  }

  private pathFor(inbound: ImInbound) {
    const reply = inbound.reply as { kind: string; channelId?: string; guildId?: string };
    if (reply.kind === "c2c") return { path: `/v2/users/${inbound.chatId}/messages`, v2: true };
    if (reply.kind === "group") return { path: `/v2/groups/${inbound.chatId}/messages`, v2: true };
    if (reply.kind === "channel") return { path: `/channels/${reply.channelId}/messages`, v2: false };
    return { path: `/dms/${reply.guildId}/messages`, v2: false };
  }

  async send(reply: ImReply): Promise<undefined> {
    const { path, v2 } = this.pathFor(reply.inbound);
    const msgId = (reply.inbound.reply as { msgId?: string }).msgId;
    let seq = 1;
    for (const chunk of reply.chunks) {
      const body = v2 ? { content: chunk, msg_type: 0, msg_id: msgId, msg_seq: seq } : { content: chunk, msg_id: msgId };
      try {
        await this.post(path, body);
      } catch (error) {
        // QQ 群 / 私聊不允许未报备的网址：把网址换掉再发一次。
        if (/https?:\/\//.test(chunk)) {
          const stripped = chunk.replace(/https?:\/\/\S+/g, "[链接已省略]");
          this.ctx.log("warn", `发送被拒（${errorText(error)}），去掉网址重发`);
          await this.post(path, { ...body, content: stripped, ...(v2 ? { msg_seq: ++seq } : {}) });
        } else throw error;
      }
      seq++;
    }
  }
}

export async function testQqOfficial(ctx: AdapterContext): Promise<TestResult> {
  try {
    const { token } = await qqAccessToken(ctx);
    const response = await ctx.fetch(`${qqApiBase(ctx.config)}/users/@me`, { headers: { Authorization: `QQBot ${token}` } });
    const me = await response.json().catch(() => ({}));
    return { ok: true, detail: `凭据有效${me?.username ? `，机器人「${me.username}」` : ""}` };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
