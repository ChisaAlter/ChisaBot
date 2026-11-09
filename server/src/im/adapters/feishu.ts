import { decodeFrame, encodeFrame, type FeishuFrame, headerOf } from "../feishu-proto";
import { errorText, readJson } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult } from "../types";
import { dataBytes, LoopAdapter } from "./base";

/**
 * 飞书 / Lark 自建应用机器人，长连接（WebSocket）收事件，不需要公网回调地址。
 *
 * 长连接协议照飞书官方 Node SDK（MIT，github.com/larksuite/node-sdk ws-client）：
 * 1. POST {域名}/callback/ws/endpoint {AppID, AppSecret} → data.URL（带 device_id、service_id）+ ClientConfig
 *    （PingInterval 秒、ReconnectInterval…）。
 * 2. 连上 URL，收发二进制 pbbp2.Frame（feishu-proto.ts）。method 0 = 控制帧（ping / pong，pong 的 payload
 *    里有新的 ClientConfig），method 1 = 数据帧（header type=event，大事件按 sum/seq 分片）。
 * 3. 每 PingInterval 发一个控制帧 header type=ping、service = service_id。
 * 4. 每个数据帧原样回一帧：headers 加 biz_rt，payload = {"code":200}，否则飞书会重投。
 * 事件 im.message.receive_v1；回复用 POST /open-apis/im/v1/messages/{message_id}/reply，msg_type=post
 * 的 md 标签（飞书客户端会渲染 Markdown），失败再退回纯文本。
 */

export function feishuBase(config: Record<string, string>) {
  // __apiBase：只给测试工具用（接口不接受这个字段），把请求指到本地假服务器。
  if (config.__apiBase) return config.__apiBase;
  return config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export async function feishuTenantToken(ctx: Pick<AdapterContext, "fetch" | "config" | "secrets">) {
  const appId = (ctx.config.appId ?? "").trim();
  const appSecret = (ctx.secrets.appSecret ?? "").trim();
  if (!appId || !appSecret) throw new Error("请填写 App ID 和 App Secret");
  const response = await ctx.fetch(`${feishuBase(ctx.config)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await readJson(response, "获取飞书 tenant_access_token");
  if (body.code !== 0 || !body.tenant_access_token) throw new Error(`飞书凭据无效：${body.code} ${body.msg ?? ""}`.trim());
  return { token: String(body.tenant_access_token), expiresAt: Date.now() + (Number(body.expire) || 7200) * 1000 };
}

export async function feishuBotInfo(ctx: Pick<AdapterContext, "fetch" | "config">, token: string) {
  const response = await ctx.fetch(`${feishuBase(ctx.config)}/open-apis/bot/v3/info`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await readJson(response, "读取飞书机器人信息");
  if (body.code !== 0) throw new Error(`读取飞书机器人信息失败：${body.code} ${body.msg ?? ""}（应用是否已添加「机器人」能力并发布？）`);
  return { openId: String(body.bot?.open_id ?? ""), name: String(body.bot?.app_name ?? "") };
}

/** 富文本（post）内容 → 文字。 */
function postText(content: any): string {
  const body = content?.zh_cn ?? content?.en_us ?? content?.ja_jp ?? content;
  const rows: any[] = Array.isArray(body?.content) ? body.content : [];
  const lines = rows.map((row) =>
    (Array.isArray(row) ? row : [])
      .map((item: any) => (item.tag === "text" || item.tag === "md" ? item.text : item.tag === "a" ? `${item.text}（${item.href}）` : item.tag === "at" ? `@${item.user_name ?? ""}` : ""))
      .join(""),
  );
  return [body?.title, ...lines].filter(Boolean).join("\n");
}

/** im.message.receive_v1 事件 → ImInbound。 */
export function parseFeishuMessage(event: any, botOpenId: string | null): ImInbound | null {
  const message = event?.message;
  if (!message?.message_id) return null;
  if (event.sender?.sender_type && event.sender.sender_type !== "user") return null;
  let content: any = {};
  try {
    content = JSON.parse(message.content ?? "{}");
  } catch {}
  const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];
  let text = "";
  const attachments: ImInbound["attachments"] = [];
  if (message.message_type === "text") text = String(content.text ?? "");
  else if (message.message_type === "post") text = postText(content);
  else if (message.message_type === "image") attachments.push({ kind: "image" });
  else if (message.message_type === "file") attachments.push({ kind: "file" });
  else if (message.message_type === "audio") attachments.push({ kind: "voice" });
  else if (message.message_type === "media") attachments.push({ kind: "video" });
  let mentioned = message.chat_type === "p2p";
  for (const mention of mentions) {
    const isBot = botOpenId ? mention.id?.open_id === botOpenId : false;
    if (isBot) mentioned = true;
    text = text.split(mention.key).join(isBot ? "" : `@${mention.name ?? ""}`);
  }
  // 不知道机器人自己的 open_id 时：群里有任何 @ 都当作 @ 了机器人（飞书默认只把 @ 机器人的群消息推过来）。
  if (!botOpenId && mentions.length) mentioned = true;
  const userId = String(event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? "");
  const group = message.chat_type !== "p2p";
  return {
    messageId: String(message.message_id),
    chatType: group ? "group" : "private",
    chatId: group ? String(message.chat_id) : userId,
    userId,
    text: text.replace(/\s+/g, (space) => (space.includes("\n") ? "\n" : " ")).trim(),
    mentioned,
    reply: { messageId: message.message_id, chatId: message.chat_id },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class FeishuAdapter extends LoopAdapter {
  readonly platform = "feishu" as const;
  readonly maxChunk = 8000;
  readonly markdown = true;
  private token: { token: string; expiresAt: number } | null = null;
  private botOpenId: string | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval = 120_000;
  private serviceId = 0;
  private fragments = new Map<string, { parts: Uint8Array[]; at: number }>();

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private async tenantToken() {
    if (!this.token || this.token.expiresAt - Date.now() < 120_000) this.token = await feishuTenantToken(this.ctx);
    return this.token.token;
  }

  protected override onStop() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    this.fragments.clear();
  }

  protected async runOnce(): Promise<void> {
    let account: string | null = null;
    try {
      const info = await feishuBotInfo(this.ctx, await this.tenantToken());
      this.botOpenId = info.openId || null;
      account = info.name ? `飞书机器人「${info.name}」` : null;
    } catch (error) {
      this.ctx.log("warn", errorText(error));
    }
    const response = await this.ctx.fetch(`${feishuBase(this.ctx.config)}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: this.ctx.config.appId ?? "", AppSecret: this.ctx.secrets.appSecret ?? "" }),
    });
    const body = await readJson(response, "获取飞书长连接地址");
    if (body.code !== 0 || !body.data?.URL) throw new Error(`获取飞书长连接地址失败：${body.code} ${body.msg ?? ""}`.trim());
    const url = String(body.data.URL);
    const query = new URL(url).searchParams;
    this.serviceId = Number(query.get("service_id")) || 0;
    this.pingInterval = (Number(body.data.ClientConfig?.PingInterval) || 120) * 1000;
    await this.openSocket(url, {
      binary: true,
      onOpen: () => {
        this.markConnected(account);
        this.ctx.log("info", `已连上飞书长连接${account ? `（${account}）` : ""}`);
        this.schedulePing();
      },
      onMessage: (data) => this.handle(dataBytes(data)),
    });
  }

  private schedulePing() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      try {
        this.sendFrame({ SeqID: 0n, LogID: 0n, service: this.serviceId, method: 0, headers: [{ key: "type", value: "ping" }] });
      } catch {}
      this.schedulePing();
    }, this.pingInterval);
  }

  private sendFrame(frame: FeishuFrame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new Error("飞书长连接没有连上");
    socket.send(encodeFrame(frame));
  }

  private async handle(bytes: Uint8Array) {
    const frame = decodeFrame(bytes);
    const type = headerOf(frame, "type");
    if (frame.method === 0) {
      if (type === "pong" && frame.payload) {
        try {
          const config = JSON.parse(new TextDecoder().decode(frame.payload));
          if (Number(config.PingInterval)) this.pingInterval = Number(config.PingInterval) * 1000;
        } catch {}
      }
      return;
    }
    if (type !== "event") return;
    const started = Date.now();
    const messageId = headerOf(frame, "message_id") ?? "";
    const sum = Number(headerOf(frame, "sum") ?? "1") || 1;
    const seq = Number(headerOf(frame, "seq") ?? "0") || 0;
    let payload = frame.payload ?? new Uint8Array();
    if (sum > 1) {
      const entry = this.fragments.get(messageId) ?? { parts: new Array<Uint8Array>(sum), at: Date.now() };
      entry.parts[seq] = payload;
      this.fragments.set(messageId, entry);
      for (const [key, value] of this.fragments) if (Date.now() - value.at > 10_000) this.fragments.delete(key);
      if (entry.parts.filter(Boolean).length < sum) return;
      this.fragments.delete(messageId);
      const total = entry.parts.reduce((n, part) => n + part.length, 0);
      payload = new Uint8Array(total);
      let offset = 0;
      for (const part of entry.parts) {
        payload.set(part, offset);
        offset += part.length;
      }
    }
    let code = 200;
    try {
      const event = JSON.parse(new TextDecoder().decode(payload));
      const eventType = event.header?.event_type ?? event.event?.type;
      if (eventType === "im.message.receive_v1") {
        const inbound = parseFeishuMessage(event.event, this.botOpenId);
        if (inbound) this.emit(inbound);
      }
    } catch (error) {
      code = 500;
      this.ctx.log("warn", `解析飞书事件失败：${errorText(error)}`);
    }
    this.sendFrame({
      ...frame,
      headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify({ code })),
    });
  }

  private async reply(messageId: string, msgType: string, content: unknown) {
    const response = await this.ctx.fetch(`${feishuBase(this.ctx.config)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.tenantToken()}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ msg_type: msgType, content: JSON.stringify(content) }),
    });
    const body = await readJson(response, "飞书回复");
    if (body.code !== 0) throw new Error(`飞书回复失败：${body.code} ${body.msg ?? ""}`.trim());
  }

  async send(reply: ImReply): Promise<undefined> {
    const messageId = String((reply.inbound.reply as { messageId?: string }).messageId ?? reply.inbound.messageId);
    for (const chunk of reply.chunks) {
      try {
        await this.reply(messageId, "post", { zh_cn: { content: [[{ tag: "md", text: chunk }]] } });
      } catch (error) {
        this.ctx.log("warn", `Markdown 回复失败（${errorText(error)}），改用纯文本`);
        await this.reply(messageId, "text", { text: chunk });
      }
    }
  }
}

export async function testFeishu(ctx: AdapterContext): Promise<TestResult> {
  try {
    const { token } = await feishuTenantToken(ctx);
    let name = "";
    try {
      name = (await feishuBotInfo(ctx, token)).name;
    } catch (error) {
      return { ok: false, detail: `App ID / Secret 正确，但${errorText(error)}` };
    }
    const response = await ctx.fetch(`${feishuBase(ctx.config)}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: ctx.config.appId ?? "", AppSecret: ctx.secrets.appSecret ?? "" }),
    });
    const body = await readJson(response, "获取飞书长连接地址");
    if (body.code !== 0) return { ok: false, detail: `凭据正确，但长连接不可用：${body.code} ${body.msg ?? ""}` };
    return { ok: true, detail: `凭据有效，机器人「${name || "未命名"}」，长连接可用` };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
