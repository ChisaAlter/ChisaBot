import { errorText, readJson } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult } from "../types";
import { dataText, LoopAdapter } from "./base";

/**
 * 钉钉企业内部应用机器人，Stream 模式（钉钉开放平台「Stream 模式」协议，dingtalk-stream-sdk 同一套）：
 * 1. POST https://api.dingtalk.com/v1.0/gateway/connections/open {clientId, clientSecret, subscriptions} → {endpoint, ticket}
 * 2. 连 `${endpoint}?ticket=…`，帧都是 JSON：{specVersion, type:"SYSTEM"|"CALLBACK"|"EVENT", headers:{topic, messageId…}, data}
 * 3. SYSTEM ping → 原样回 {code:200, headers, message:"OK", data}；disconnect → 重连。
 * 4. CALLBACK /v1.0/im/bot/messages/get → 机器人消息；回执 {code:200, headers:{contentType, messageId}, message:"OK", data:"{\"response\":null}"}
 * 5. 回复：POST 消息里的 sessionWebhook {msgtype:"markdown", markdown:{title, text}}。
 */

const BOT_TOPIC = "/v1.0/im/bot/messages/get";

// biome-ignore lint/suspicious/noExplicitAny: 钉钉 Stream 回调报文无官方类型，按协议文档字段取用
export function parseDingtalkMessage(data: any): ImInbound | null {
  if (!data?.msgId) return null;
  const group = String(data.conversationType) === "2";
  const userId = String(data.senderStaffId || data.senderId || "");
  let text = "";
  const attachments: ImInbound["attachments"] = [];
  if (data.msgtype === "text") text = String(data.text?.content ?? "");
  else if (data.msgtype === "richText") {
    for (const item of data.content?.richText ?? []) if (item.text) text += item.text;
  } else if (data.msgtype === "picture") attachments.push({ kind: "image" });
  else if (data.msgtype === "audio") text = String(data.content?.recognition ?? "");
  else if (data.msgtype === "file") attachments.push({ kind: "file" });
  return {
    messageId: String(data.msgId),
    chatType: group ? "group" : "private",
    chatId: group ? String(data.conversationId) : userId,
    userId,
    userName: data.senderNick,
    text: text.trim(),
    mentioned: !group || data.isInAtList !== false,
    reply: { sessionWebhook: data.sessionWebhook, expiresAt: data.sessionWebhookExpiredTime },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class DingtalkAdapter extends LoopAdapter {
  readonly platform = "dingtalk" as const;
  readonly maxChunk = 4000;
  readonly markdown = true;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  protected async runOnce(): Promise<void> {
    const clientId = (this.ctx.config.clientId ?? "").trim();
    const clientSecret = (this.ctx.secrets.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) throw new Error("请填写 Client ID 和 Client Secret");
    const response = await this.ctx.fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientId, clientSecret, subscriptions: [{ type: "CALLBACK", topic: BOT_TOPIC }], ua: "chisabot-im/1.0", localIp: "" }),
    });
    const body = await readJson(response, "打开钉钉 Stream 连接");
    if (!body.endpoint || !body.ticket) throw new Error(`钉钉没有返回连接地址：${body.message ?? body.code ?? JSON.stringify(body).slice(0, 120)}`);
    await this.openSocket(`${body.endpoint}?ticket=${encodeURIComponent(body.ticket)}`, {
      onOpen: () => {
        this.markConnected(`钉钉应用 ${clientId}`);
        this.ctx.log("info", "已连上钉钉 Stream");
      },
      onMessage: (data) => this.handle(dataText(data)),
    });
  }

  private async handle(text: string) {
    const frame = JSON.parse(text);
    const headers = frame.headers ?? {};
    if (frame.type === "SYSTEM") {
      if (headers.topic === "ping") this.sendJson({ code: 200, headers, message: "OK", data: frame.data });
      else if (headers.topic === "disconnect") {
        this.ctx.log("info", "钉钉要求重连");
        this.socket?.close(4000, "disconnect");
      }
      return;
    }
    if (frame.type === "CALLBACK" && headers.topic === BOT_TOPIC) {
      this.sendJson({ code: 200, headers: { contentType: "application/json", messageId: headers.messageId }, message: "OK", data: JSON.stringify({ response: null }) });
      // biome-ignore lint/suspicious/noExplicitAny: 钉钉回调 data 字段为任意 JSON
      let data: any = {};
      try {
        data = typeof frame.data === "string" ? JSON.parse(frame.data) : frame.data;
      } catch {}
      const inbound = parseDingtalkMessage(data);
      if (inbound) this.emit(inbound);
      return;
    }
    if (headers.messageId) this.sendJson({ code: 200, headers: { contentType: "application/json", messageId: headers.messageId }, message: "OK", data: "{}" });
  }

  async send(reply: ImReply): Promise<undefined> {
    const webhook = String((reply.inbound.reply as { sessionWebhook?: string }).sessionWebhook ?? "");
    if (!webhook) throw new Error("这条钉钉消息没有 sessionWebhook，无法回复");
    for (const chunk of reply.chunks) {
      const title = chunk.replace(/[#*`>\-\n]+/g, " ").trim().slice(0, 20) || "回复";
      const response = await this.ctx.fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { title, text: chunk } }),
      });
      const body = await readJson(response, "钉钉回复");
      if (body.errcode && body.errcode !== 0) throw new Error(`钉钉回复失败：${body.errcode} ${body.errmsg ?? ""}`);
    }
  }
}

export async function testDingtalk(ctx: AdapterContext): Promise<TestResult> {
  try {
    const response = await ctx.fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: ctx.config.clientId ?? "", appSecret: ctx.secrets.clientSecret ?? "" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.accessToken) return { ok: false, detail: `凭据无效：${body.message ?? body.code ?? response.status}` };
    return { ok: true, detail: "凭据有效" };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
