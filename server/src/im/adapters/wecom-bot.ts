import { errorText } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult, WsLike } from "../types";
import { dataText, LoopAdapter, randomId } from "./base";

/**
 * 企业微信智能机器人（API 模式 · 长连接），wss://openws.work.weixin.qq.com。
 *
 * 帧格式参考 LangBot（Apache-2.0）libs/wecom_ai_bot_api/ws_client.py，都是 JSON：
 * - 订阅：{cmd:"aibot_subscribe", headers:{req_id}, body:{bot_id, secret}} → 回 {headers:{req_id}, errcode:0}
 * - 心跳：{cmd:"ping", headers:{req_id}}，30 秒一次，连续 3 次没回执算断线。
 * - 收消息：{cmd:"aibot_msg_callback", headers:{req_id}, body:{msgid, chatid?, chattype:"single"|"group",
 *   from:{userid}, msgtype:"text", text:{content}}}（群里只推 @ 机器人的消息）。
 * - 回复：{cmd:"aibot_respond_msg", headers:{req_id 原样}, body:{msgtype:"stream", stream:{id, finish, content}}}，
 *   先发一帧空内容（客户端显示转圈），答完发 finish:true 的整段 Markdown。超出一段的部分用
 *   {cmd:"aibot_send_msg", body:{chatid, msgtype:"markdown", markdown:{content}}} 主动发。
 * - 事件：{cmd:"aibot_event_callback"}，disconnected_event = 同一个机器人在别处建了长连接、把我们踢了。
 */

export const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";

// biome-ignore lint/suspicious/noExplicitAny: 企业微信回调报文字段随 msgtype 变化
export function parseWecomMessage(body: any): ImInbound | null {
  if (!body?.msgid) return null;
  const chatType = body.chattype === "group" ? "group" : "private";
  const userId = String(body.from?.userid ?? "");
  let text = "";
  const attachments: ImInbound["attachments"] = [];
  if (body.msgtype === "text") text = String(body.text?.content ?? "");
  else if (body.msgtype === "mixed") {
    for (const item of body.mixed?.msg_item ?? []) {
      if (item.msgtype === "text") text += String(item.text?.content ?? "");
      else if (item.msgtype === "image") attachments.push({ kind: "image", url: item.image?.url });
    }
  } else if (body.msgtype === "image") attachments.push({ kind: "image", url: body.image?.url });
  else if (body.msgtype === "voice") text = String(body.voice?.content ?? "");
  else if (body.msgtype === "file") attachments.push({ kind: "file" });
  // 群消息开头是「@机器人名 」。
  if (chatType === "group") text = text.replace(/^\s*@\S+\s*/, "");
  return {
    messageId: String(body.msgid),
    chatType,
    chatId: chatType === "group" ? String(body.chatid ?? "") : userId,
    userId,
    text: text.trim(),
    mentioned: true,
    reply: { chatid: body.chatid ?? userId },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class WecomBotAdapter extends LoopAdapter {
  readonly platform = "wecom_bot" as const;
  readonly maxChunk = 6000;
  readonly markdown = true;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  // biome-ignore lint/suspicious/noExplicitAny: 企业微信 WS 应答帧 body 形状随 cmd 变化
  private acks = new Map<string, { resolve: (frame: any) => void; timer: ReturnType<typeof setTimeout> }>();
  /** msgid → {req_id, stream_id}：回复时用。 */
  private streams = new Map<string, { reqId: string; streamId: string; at: number }>();
  private kicked = false;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  protected override onStop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [, ack] of this.acks) {
      clearTimeout(ack.timer);
      ack.resolve(null);
    }
    this.acks.clear();
  }

  protected override retryDelay(attempt: number) {
    // 被另一个长连接踢掉时，马上重连只会互踢：等久一点。
    if (this.kicked) {
      this.kicked = false;
      return 5 * 60_000;
    }
    return super.retryDelay(attempt);
  }

  protected async runOnce(): Promise<void> {
    const botId = (this.ctx.config.botId ?? "").trim();
    const secret = (this.ctx.secrets.secret ?? "").trim();
    if (!botId || !secret) throw new Error("请填写 Bot ID 和 Secret");
    let authed = false;
    await this.openSocket(WECOM_WS_URL, {
      onOpen: async () => {
        const frame = await this.request({ cmd: "aibot_subscribe", body: { bot_id: botId, secret } }, "aibot_subscribe");
        if (frame?.errcode !== 0) {
          throw new Error(`企业微信订阅失败：${frame ? `${frame.errcode} ${frame.errmsg ?? ""}` : "10 秒没有回应"}（检查 Bot ID / Secret，机器人是否选了「长连接」）`);
        }
        authed = true;
        this.missed = 0;
        this.heartbeat = setInterval(() => {
          if (this.missed >= 3) {
            this.ctx.log("warn", "企业微信心跳连续 3 次没有回应，重连");
            this.socket?.close(4000, "heartbeat");
            return;
          }
          this.missed++;
          try {
            this.sendJson({ cmd: "ping", headers: { req_id: `ping_${randomId()}` } });
          } catch {}
        }, 30_000);
        this.markConnected(`企业微信机器人 ${botId.slice(0, 8)}…`);
        this.ctx.log("info", "已连上企业微信长连接");
      },
      onMessage: (data) => this.handle(dataText(data)),
    });
    if (!authed) throw new Error("企业微信长连接在订阅前断开了");
  }

  /** 发一帧并等同一个 req_id 的回执。 */
  // biome-ignore lint/suspicious/noExplicitAny: 应答 body 形状随 cmd 变化，调用方按协议取用
  private request(frame: { cmd: string; body?: unknown; headers?: Record<string, string> }, prefix: string, timeoutMs = 10_000): Promise<any> {
    const reqId = frame.headers?.req_id ?? `${prefix}_${randomId()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.acks.set(reqId, { resolve, timer });
      try {
        this.sendJson({ ...frame, headers: { ...(frame.headers ?? {}), req_id: reqId } });
      } catch {
        clearTimeout(timer);
        this.acks.delete(reqId);
        resolve(null);
      }
    });
  }

  private async handle(text: string) {
    const frame = JSON.parse(text);
    const reqId: string = frame.headers?.req_id ?? "";
    if (frame.cmd === "aibot_msg_callback") {
      const inbound = parseWecomMessage(frame.body);
      if (!inbound) return;
      const streamId = `stream_${randomId()}`;
      this.streams.set(inbound.messageId, { reqId, streamId, at: Date.now() });
      for (const [key, value] of this.streams) if (Date.now() - value.at > 30 * 60_000) this.streams.delete(key);
      inbound.reply = { ...inbound.reply, reqId, streamId };
      // 先回一帧空的流式消息：企业微信客户端显示「正在思考」。
      try {
        this.sendJson({ cmd: "aibot_respond_msg", headers: { req_id: reqId }, body: { msgtype: "stream", stream: { id: streamId, finish: false, content: "" } } });
      } catch {}
      this.emit(inbound);
      return;
    }
    if (frame.cmd === "aibot_event_callback") {
      const type = frame.body?.event?.eventtype ?? frame.body?.eventtype;
      if (type === "disconnected_event") {
        this.kicked = true;
        this.ctx.log("error", "同一个企业微信机器人在别处建立了长连接，这里被断开（同一机器人同时只能有一个长连接）");
        this.ctx.setStatus({ state: "error", detail: "被另一个长连接顶掉了，5 分钟后重试" });
      }
      return;
    }
    if (this.acks.has(reqId)) {
      const ack = this.acks.get(reqId)!;
      this.acks.delete(reqId);
      clearTimeout(ack.timer);
      ack.resolve(frame);
      return;
    }
    if (reqId.startsWith("ping")) this.missed = 0;
  }

  async send(reply: ImReply): Promise<undefined> {
    const { inbound } = reply;
    const meta = inbound.reply as { reqId?: string; streamId?: string; chatid?: string };
    const [first, ...rest] = reply.chunks;
    if (first != null) {
      let sent = false;
      if (meta.reqId && meta.streamId) {
        const ack = await this.request(
          { cmd: "aibot_respond_msg", headers: { req_id: meta.reqId }, body: { msgtype: "stream", stream: { id: meta.streamId, finish: true, content: first } } },
          "respond",
        );
        sent = Boolean(ack && ack.errcode === 0);
        if (!sent) this.ctx.log("warn", `流式回复失败（${ack ? `${ack.errcode} ${ack.errmsg ?? ""}` : "没有回执"}），改用主动发送`);
      }
      if (!sent) await this.active(meta.chatid ?? inbound.chatId, first);
    }
    for (const chunk of rest) await this.active(meta.chatid ?? inbound.chatId, chunk);
  }

  private async active(chatid: string, content: string) {
    const ack = await this.request({ cmd: "aibot_send_msg", body: { chatid, msgtype: "markdown", markdown: { content } } }, "send");
    if (ack?.errcode !== 0) throw new Error(`企业微信发送失败：${ack ? `${ack.errcode} ${ack.errmsg ?? ""}` : "没有回执"}`);
  }
}

export async function testWecomBot(ctx: AdapterContext, running?: WecomBotAdapter): Promise<TestResult> {
  if (running) return { ok: true, detail: "长连接在运行（企业微信同一机器人只允许一个长连接，测试不另开连接）" };
  const botId = (ctx.config.botId ?? "").trim();
  const secret = (ctx.secrets.secret ?? "").trim();
  if (!botId || !secret) return { ok: false, detail: "请填写 Bot ID 和 Secret" };
  return await new Promise<TestResult>((resolve) => {
    let socket: WsLike;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      resolve({ ok: false, detail: "15 秒内没有完成订阅" });
    }, 15_000);
    try {
      socket = ctx.ws(WECOM_WS_URL);
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, detail: errorText(error) });
      return;
    }
    const reqId = `aibot_subscribe_${randomId()}`;
    socket.onopen = () => socket.send(JSON.stringify({ cmd: "aibot_subscribe", headers: { req_id: reqId }, body: { bot_id: botId, secret } }));
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(dataText(event.data));
        if (frame.headers?.req_id !== reqId) return;
        clearTimeout(timer);
        socket.close();
        resolve(frame.errcode === 0 ? { ok: true, detail: "凭据有效，长连接订阅成功" } : { ok: false, detail: `订阅失败：${frame.errcode} ${frame.errmsg ?? ""}` });
      } catch {}
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      clearTimeout(timer);
      resolve({ ok: false, detail: "连接被关闭，检查 Bot ID / Secret" });
    };
  });
}
