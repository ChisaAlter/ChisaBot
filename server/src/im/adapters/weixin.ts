import { errorText, readJson } from "../text";
import type {
  AdapterContext,
  FetchLike,
  ImInbound,
  ImReply,
  TestResult,
} from "../types";
import { LoopAdapter, randomId } from "./base";

/**
 * 个人微信：微信官方给 AI 助手的 ClawBot 插件接口（iLink Bot API，https://ilinkai.weixin.qq.com）。
 *
 * 协议参考 LangBot（Apache-2.0）libs/openclaw_weixin_api/client.py（它又参考了 epiral/weixin-bot）：
 * - 扫码授权：GET ilink/bot/get_bot_qrcode?bot_type=3 → {qrcode, qrcode_img_content（要转成二维码的链接）}；
 *   轮询 GET ilink/bot/get_qrcode_status?qrcode=…（头 iLink-App-ClientVersion: 1）→ status wait / scaned /
 *   confirmed（带 bot_token、baseurl、ilink_bot_id）/ expired。
 * - 收消息：POST ilink/bot/getupdates {get_updates_buf}（长轮询约 35 秒），返回 msgs 和新的 get_updates_buf；
 *   errcode / ret = -14 表示授权过期。
 * - 发消息：POST ilink/bot/sendmessage {msg:{to_user_id, client_id, message_type:2, message_state:2,
 *   item_list:[{type:1, text_item:{text}}], context_token}}，context_token 用收到那条消息里的。
 * - 每个请求带 base_info:{channel_version}，头 AuthorizationType: ilink_bot_token、Authorization: Bearer、
 *   X-WECHAT-UIN（随机 uint32 的十进制字符串再 base64）。
 */

export const WEIXIN_DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const SESSION_EXPIRED = -14;

function randomUin() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return Buffer.from(String(value)).toString("base64");
}

export function weixinBase(config: Record<string, string>) {
  return (config.baseUrl || WEIXIN_DEFAULT_BASE).replace(/\/+$/, "");
}

function headers(token: string) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function weixinFetchQr(
  fetcher: FetchLike,
  base: string,
): Promise<{ qrcode: string; url: string }> {
  const response = await fetcher(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`);
  const body = await readJson(response, "获取微信授权二维码");
  if (!body.qrcode || !body.qrcode_img_content)
    throw new Error("微信没有返回二维码");
  return { qrcode: String(body.qrcode), url: String(body.qrcode_img_content) };
}

export async function weixinQrStatus(
  fetcher: FetchLike,
  base: string,
  qrcode: string,
  timeoutMs = 25_000,
): Promise<{
  status: string;
  token?: string;
  baseUrl?: string;
  botId?: string;
  userId?: string;
}> {
  try {
    const response = await fetcher(
      `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const body = await readJson(response, "查询微信扫码状态");
    return {
      status: String(body.status ?? "wait"),
      token: body.bot_token ? String(body.bot_token) : undefined,
      baseUrl: body.baseurl ? String(body.baseurl) : undefined,
      botId: body.ilink_bot_id ? String(body.ilink_bot_id) : undefined,
      userId: body.ilink_user_id ? String(body.ilink_user_id) : undefined,
    };
  } catch (error) {
    if (
      (error as Error)?.name === "TimeoutError" ||
      (error as Error)?.name === "AbortError"
    )
      return { status: "wait" };
    throw error;
  }
}

/** getupdates 里的一条消息 → ImInbound（只要用户发来的；群消息这一版不接）。 */
// biome-ignore lint/suspicious/noExplicitAny: ilink getupdates 消息载荷字段随 message_type 变化
export function parseWeixinMessage(msg: any): ImInbound | null {
  if (msg?.message_type !== 1) return null;
  if (msg.group_id) return null;
  const userId = String(msg.from_user_id ?? "");
  if (!userId) return null;
  let text = "";
  const attachments: ImInbound["attachments"] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      const quoted = item.ref_msg?.message_item?.text_item?.text;
      text += quoted
        ? `「${quoted}」\n${item.text_item.text}`
        : item.text_item.text;
    } else if (item.type === 2) attachments.push({ kind: "image" });
    else if (item.type === 3) {
      if (item.voice_item?.text) text += item.voice_item.text;
      else attachments.push({ kind: "voice" });
    } else if (item.type === 4) attachments.push({ kind: "file" });
    else if (item.type === 5) attachments.push({ kind: "video" });
  }
  return {
    messageId: String(msg.message_id ?? msg.seq ?? msg.client_id ?? randomId()),
    chatType: "private",
    chatId: userId,
    userId,
    text: text.trim(),
    mentioned: true,
    reply: { contextToken: msg.context_token ?? "" },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class WeixinAdapter extends LoopAdapter {
  readonly platform = "weixin" as const;
  readonly maxChunk = 2000;
  readonly markdown = false;
  private cursor = "";
  private expired = false;
  private readonly requests = new Set<AbortController>();

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private get token() {
    return (this.ctx.secrets.token ?? "").trim();
  }

  protected override onStop() {
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }

  protected override retryDelay(attempt: number) {
    // 授权过期：不狂刷，30 分钟再试一次（用户重新扫码会重启连接）。
    if (this.expired) return 30 * 60_000;
    return super.retryDelay(attempt);
  }

  private async post(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs = 15_000,
  ) {
    if (this.stopped) throw new Error("连接已停止");
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.ctx.fetch(
        `${weixinBase(this.ctx.config)}/${endpoint}`,
        {
          method: "POST",
          headers: headers(this.token),
          body: JSON.stringify({
            ...payload,
            base_info: { channel_version: "1.0.0" },
          }),
          signal: controller.signal,
        },
      );
      return await readJson(response, `微信 ${endpoint}`);
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  protected async runOnce(): Promise<void> {
    if (!this.token) {
      this.expired = true;
      throw new Error("还没有扫码授权：在连接里点「扫码授权」");
    }
    this.expired = false;
    let first = true;
    while (!this.stopped) {
      // biome-ignore lint/suspicious/noExplicitAny: ilink 接口回包 JSON 形状按协议字段取用
      let body: any;
      try {
        body = await this.post(
          "ilink/bot/getupdates",
          { get_updates_buf: this.cursor },
          45_000,
        );
      } catch (error) {
        if (this.stopped) return;
        if ((error as Error)?.name === "AbortError") continue;
        throw error;
      }
      if (this.stopped) return;
      const code = body.errcode ?? body.ret;
      if (code === SESSION_EXPIRED) {
        this.expired = true;
        throw new Error("微信授权已过期，请在连接里重新「扫码授权」");
      }
      if (code && code !== 0)
        throw new Error(
          `微信 getupdates 出错：${code} ${body.errmsg ?? ""}`.trim(),
        );
      if (first) {
        this.markConnected(
          this.ctx.config.accountId
            ? `微信 ${this.ctx.config.accountId}`
            : "个人微信",
        );
        this.ctx.log("info", "已连上微信 ClawBot 接口");
        first = false;
      }
      if (typeof body.get_updates_buf === "string" && body.get_updates_buf)
        this.cursor = body.get_updates_buf;
      for (const msg of body.msgs ?? []) {
        const inbound = parseWeixinMessage(msg);
        if (inbound) this.emit(inbound);
      }
    }
  }

  async typing(inbound: ImInbound) {
    try {
      const contextToken = String(
        (inbound.reply as { contextToken?: string }).contextToken ?? "",
      );
      const config = await this.post(
        "ilink/bot/getconfig",
        { ilink_user_id: inbound.userId, context_token: contextToken || null },
        8000,
      );
      if (config.typing_ticket)
        await this.post(
          "ilink/bot/sendtyping",
          {
            ilink_user_id: inbound.userId,
            typing_ticket: config.typing_ticket,
            status: 1,
          },
          8000,
        );
    } catch {}
  }

  async send(reply: ImReply): Promise<undefined> {
    const contextToken = String(
      (reply.inbound.reply as { contextToken?: string }).contextToken ?? "",
    );
    for (const chunk of reply.chunks) {
      const body = await this.post("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: reply.inbound.chatId,
          client_id: `chisabot-${randomId()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
          context_token: contextToken || null,
        },
      });
      const code = body.errcode ?? body.ret;
      if (code && code !== 0)
        throw new Error(`微信发送失败：${code} ${body.errmsg ?? ""}`.trim());
    }
  }
}

export async function testWeixin(
  ctx: AdapterContext,
  running?: WeixinAdapter,
): Promise<TestResult> {
  if (!(ctx.secrets.token ?? "").trim())
    return { ok: false, detail: "还没有扫码授权" };
  if (running)
    return {
      ok: true,
      detail: "已授权，正在收消息（测试不另开轮询，免得抢消息）",
    };
  try {
    const response = await ctx.fetch(
      `${weixinBase(ctx.config)}/ilink/bot/getconfig`,
      {
        method: "POST",
        headers: headers(ctx.secrets.token ?? ""),
        body: JSON.stringify({
          ilink_user_id: "",
          base_info: { channel_version: "1.0.0" },
        }),
      },
    );
    const body = await readJson(response, "微信 getconfig");
    const code = body.errcode ?? body.ret;
    if (code === SESSION_EXPIRED)
      return { ok: false, detail: "授权已过期，请重新扫码" };
    return { ok: true, detail: "授权有效" };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}
