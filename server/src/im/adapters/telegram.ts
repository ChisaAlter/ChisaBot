import { errorText, readJson } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult } from "../types";
import { LoopAdapter } from "./base";

/**
 * Telegram Bot API，长轮询 getUpdates（core.telegram.org/bots/api）。群里 @机器人、回复机器人的消息、
 * 或 /命令@机器人 才算叫到它。
 */

export function telegramBase(config: Record<string, string>, token: string) {
  return `${(config.apiBase || "https://api.telegram.org").replace(/\/+$/, "")}/bot${token}`;
}

export function parseTelegramUpdate(update: any, me: { id: number; username: string } | null): ImInbound | null {
  const message = update?.message;
  if (!message?.chat || !message.from || message.from.is_bot) return null;
  const group = message.chat.type !== "private";
  let text = String(message.text ?? message.caption ?? "");
  let mentioned = !group;
  const username = me?.username ? `@${me.username}` : null;
  if (group && username) {
    if (text.toLowerCase().includes(username.toLowerCase())) {
      mentioned = true;
      text = text.replace(new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
    }
    if (me && message.reply_to_message?.from?.id === me.id) mentioned = true;
  }
  const attachments: ImInbound["attachments"] = [];
  if (message.photo) attachments.push({ kind: "image" });
  if (message.document) attachments.push({ kind: "file" });
  if (message.voice) attachments.push({ kind: "voice" });
  if (message.video) attachments.push({ kind: "video" });
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username;
  return {
    messageId: `${message.chat.id}:${message.message_id}`,
    chatType: group ? "group" : "private",
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    userName: name,
    text: text.trim(),
    mentioned,
    reply: { messageId: message.message_id },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class TelegramAdapter extends LoopAdapter {
  readonly platform = "telegram" as const;
  readonly maxChunk = 4000;
  readonly markdown = false;
  private offset = 0;
  private me: { id: number; username: string } | null = null;
  private readonly requests = new Set<AbortController>();

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private get base() {
    return telegramBase(this.ctx.config, (this.ctx.secrets.token ?? "").trim());
  }

  protected override onStop() {
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }

  private async call(method: string, body: Record<string, unknown>, timeoutMs = 15_000) {
    if (this.stopped) throw new Error("连接已停止");
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.ctx.fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = await response.json().catch(() => ({}));
      if (!parsed.ok) {
        if (response.status === 409) throw new Error("另一个程序正在用这个 Token 收消息（或设置了 webhook）：同一个 Token 只能有一个地方收消息");
        throw new Error(`Telegram ${method} 失败：${parsed.error_code ?? response.status} ${parsed.description ?? ""}`.trim());
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  protected async runOnce(): Promise<void> {
    if (!(this.ctx.secrets.token ?? "").trim()) throw new Error("请填写 Bot Token");
    const me = await this.call("getMe", {});
    if (this.stopped) return;
    this.me = { id: Number(me.id), username: String(me.username ?? "") };
    this.markConnected(`@${this.me.username}`);
    this.ctx.log("info", `已连上 Telegram（@${this.me.username}）`);
    while (!this.stopped) {
      let updates: any[];
      try {
        updates = await this.call("getUpdates", { offset: this.offset, timeout: 30, allowed_updates: ["message"] }, 40_000);
      } catch (error) {
        if (this.stopped) return;
        if ((error as Error)?.name === "AbortError") continue;
        throw error;
      }
      if (this.stopped) return;
      for (const update of updates ?? []) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        const inbound = parseTelegramUpdate(update, this.me);
        if (inbound) this.emit(inbound);
      }
    }
  }

  async typing(inbound: ImInbound) {
    try {
      await this.call("sendChatAction", { chat_id: inbound.chatId, action: "typing" }, 8000);
    } catch {}
  }

  async send(reply: ImReply): Promise<void> {
    const messageId = (reply.inbound.reply as { messageId?: number }).messageId;
    let first = true;
    for (const chunk of reply.chunks) {
      await this.call("sendMessage", {
        chat_id: reply.inbound.chatId,
        text: chunk,
        ...(first && messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}),
      });
      first = false;
    }
  }
}

export async function testTelegram(ctx: AdapterContext): Promise<TestResult> {
  try {
    const response = await ctx.fetch(`${telegramBase(ctx.config, (ctx.secrets.token ?? "").trim())}/getMe`);
    const body = await readJson(response, "Telegram getMe").catch((error) => ({ ok: false, description: errorText(error) }));
    if (!body.ok) return { ok: false, detail: `Token 无效：${body.description ?? ""}` };
    return { ok: true, detail: `Token 有效，机器人 @${body.result?.username}` };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
