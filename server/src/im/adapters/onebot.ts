import { errorText } from "../text";
import type { AdapterContext, ImInbound, ImReply, TestResult, WsLike } from "../types";
import { dataText, LoopAdapter, randomId } from "./base";

/**
 * QQ 个人号：OneBot 11（NapCat、LLOneBot、Lagrange.OneBot……）。
 *
 * 两种连接方式（OneBot 11 标准，github.com/botuniverse/onebot-11）：
 * - 正向 WebSocket：协议端开 WebSocket 服务端，我们作为客户端连上去（ws://host:port，token 用
 *   `Authorization: Bearer` 头，同时放进 `?access_token=` 兼容老实现）。
 * - 反向 WebSocket：我们开端点（/api/im/onebot/<连接 id>），协议端作为客户端连进来。路由把连上来的
 *   socket 交给 {@link OneBotAdapter.attach}。
 *
 * 事件：`post_type: "message"`，`message_type: "private" | "group"`；消息是段数组（array 格式）或
 * CQ 码字符串（string 格式），两种都认。群里有 `{type:"at", data:{qq:<自己>}}` 才算 @ 了机器人。
 * 动作：`send_private_msg` / `send_group_msg`，带 `echo` 等回执；群回复第一段带 `reply` 段引用原消息。
 */

type Segment = { type: string; data?: Record<string, unknown> };

export function parseCqString(message: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const unescapeCq = (text: string) => text.replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",").replace(/&amp;/g, "&");
  for (match = re.exec(message); match; match = re.exec(message)) {
    if (match.index > last) out.push({ type: "text", data: { text: unescapeCq(message.slice(last, match.index)) } });
    const data: Record<string, unknown> = {};
    for (const pair of (match[2] ?? "").split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1));
    }
    out.push({ type: match[1]!, data });
    last = re.lastIndex;
  }
  if (last < message.length) out.push({ type: "text", data: { text: unescapeCq(message.slice(last)) } });
  return out;
}

/** OneBot 消息事件 → ImInbound；不是消息、或是自己发的，返回 null。 */
export function parseOneBotEvent(event: Record<string, any>, selfId: string | null): ImInbound | null {
  if (event.post_type !== "message" && event.post_type !== "message_sent") return null;
  if (event.post_type === "message_sent") return null;
  const self = String(event.self_id ?? selfId ?? "");
  const userId = String(event.user_id ?? event.sender?.user_id ?? "");
  if (!userId || userId === self) return null;
  const segments: Segment[] = Array.isArray(event.message)
    ? event.message
    : parseCqString(typeof event.message === "string" ? event.message : String(event.raw_message ?? ""));
  let mentioned = event.message_type === "private";
  let text = "";
  const attachments: ImInbound["attachments"] = [];
  for (const segment of segments) {
    const data = segment.data ?? {};
    if (segment.type === "text") text += String(data.text ?? "");
    else if (segment.type === "at") {
      if (String(data.qq) === self) mentioned = true;
      else if (String(data.qq) === "all") text += "@全体成员 ";
      else text += `@${String(data.name ?? data.qq)} `;
    } else if (segment.type === "image") attachments.push({ kind: "image", url: typeof data.url === "string" ? data.url : undefined });
    else if (segment.type === "record") attachments.push({ kind: "voice" });
    else if (segment.type === "video") attachments.push({ kind: "video" });
    else if (segment.type === "file") attachments.push({ kind: "file" });
    else if (segment.type === "face") text += "[表情]";
  }
  const group = event.message_type === "group";
  const name = event.sender?.card || event.sender?.nickname;
  return {
    messageId: String(event.message_id ?? ""),
    chatType: group ? "group" : "private",
    chatId: group ? String(event.group_id) : userId,
    userId,
    userName: name ? String(name) : undefined,
    text: text.trim(),
    mentioned,
    reply: { messageId: event.message_id },
    attachments: attachments.length ? attachments : undefined,
  };
}

export class OneBotAdapter extends LoopAdapter {
  readonly platform = "onebot" as const;
  readonly maxChunk = 3000;
  readonly markdown = false;
  private selfId: string | null = null;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private reverseClosed: (() => void) | null = null;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  private get reverse() {
    return this.ctx.config.mode === "reverse";
  }

  protected async runOnce(): Promise<void> {
    if (this.reverse) {
      // 反向：等协议端连进来（attach），连接断了再等。
      if (!this.socket) this.ctx.setStatus({ state: "waiting", detail: "等待协议端连入反向 WebSocket 地址" });
      await new Promise<void>((resolve) => {
        this.reverseClosed = resolve;
      });
      return;
    }
    const raw = (this.ctx.config.url ?? "").trim();
    if (!/^wss?:\/\//.test(raw)) throw new Error("请填写协议端的 WebSocket 地址（ws:// 或 wss:// 开头）");
    const token = this.ctx.secrets.accessToken ?? "";
    const url = token ? `${raw}${raw.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : raw;
    await this.openSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      onOpen: () => this.afterOpen(),
      onMessage: (data) => this.handle(dataText(data)),
    });
  }

  /** 反向连接：路由把协议端连上来的 socket 交给这里。返回 false = 拒绝（已停用）。 */
  attach(socket: WsLike, selfIdHeader?: string | null): boolean {
    if (this.stopped || !this.reverse) return false;
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close(1000, "replaced");
      } catch {}
    }
    this.socket = socket;
    if (selfIdHeader) this.selfId = selfIdHeader;
    socket.onmessage = (event) => {
      void this.handle(dataText(event.data)).catch((error) => this.ctx.log("warn", `处理协议端消息出错：${errorText(error)}`));
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
        this.ctx.log("warn", "协议端断开了反向连接");
        this.ctx.setStatus({ state: "waiting", detail: "协议端断开了，等待重新连入" });
        this.reverseClosed?.();
      }
    };
    socket.onerror = () => {};
    void this.afterOpen().catch((error) => this.ctx.log("warn", `读取账号信息失败：${errorText(error)}`));
    return true;
  }

  protected override retryDelay(attempt: number) {
    return this.reverse ? 0 : super.retryDelay(attempt);
  }

  protected override onStop() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("连接已断开"));
    }
    this.pending.clear();
    if (this.stopped) this.reverseClosed?.();
  }

  private async afterOpen() {
    this.markConnected(this.selfId ? `QQ ${this.selfId}` : null);
    this.ctx.log("info", "已连上协议端");
    try {
      const info = await this.call("get_login_info", {});
      if (info?.user_id) {
        this.selfId = String(info.user_id);
        this.markConnected(`${info.nickname ? `${info.nickname} ` : ""}(QQ ${this.selfId})`);
      }
    } catch (error) {
      this.ctx.log("warn", `读取登录账号失败：${errorText(error)}`);
    }
  }

  private async handle(text: string) {
    const payload = JSON.parse(text) as Record<string, any>;
    if (payload.echo != null && this.pending.has(String(payload.echo))) {
      const entry = this.pending.get(String(payload.echo))!;
      this.pending.delete(String(payload.echo));
      clearTimeout(entry.timer);
      if (payload.status === "failed" || (typeof payload.retcode === "number" && payload.retcode !== 0))
        entry.reject(new Error(`协议端返回错误 ${payload.retcode ?? ""} ${payload.wording ?? payload.message ?? payload.msg ?? ""}`.trim()));
      else entry.resolve(payload.data);
      return;
    }
    if (payload.post_type === "meta_event") {
      if (payload.self_id && !this.selfId) {
        this.selfId = String(payload.self_id);
        this.markConnected(`QQ ${this.selfId}`);
      }
      return;
    }
    if (payload.self_id && !this.selfId) this.selfId = String(payload.self_id);
    const inbound = parseOneBotEvent(payload, this.selfId);
    if (inbound) this.emit(inbound);
  }

  call(action: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    const echo = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`协议端 ${timeoutMs / 1000} 秒没有回应 ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.sendJson({ action, params, echo });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error as Error);
      }
    });
  }

  async send(reply: ImReply): Promise<void> {
    const { inbound } = reply;
    let first = true;
    for (const chunk of reply.chunks) {
      const message: Segment[] = [];
      if (first && inbound.chatType === "group" && inbound.reply.messageId != null)
        message.push({ type: "reply", data: { id: String(inbound.reply.messageId) } });
      message.push({ type: "text", data: { text: chunk } });
      if (inbound.chatType === "group") await this.call("send_group_msg", { group_id: Number(inbound.chatId) || inbound.chatId, message });
      else await this.call("send_private_msg", { user_id: Number(inbound.chatId) || inbound.chatId, message });
      first = false;
    }
  }
}

export async function testOneBot(ctx: AdapterContext, running?: OneBotAdapter): Promise<TestResult> {
  if (ctx.config.mode === "reverse") {
    if (!running) return { ok: false, detail: "这个连接已停用。启用后在协议端填反向连接地址。" };
    try {
      const info = await running.call("get_login_info", {}, 8000);
      return { ok: true, detail: `协议端已连入，登录的是 ${info?.nickname ?? ""}（QQ ${info?.user_id ?? "?"}）` };
    } catch (error) {
      return { ok: false, detail: `协议端还没有连进来：${errorText(error)}` };
    }
  }
  if (running) {
    try {
      const info = await running.call("get_login_info", {}, 8000);
      return { ok: true, detail: `连接正常，登录的是 ${info?.nickname ?? ""}（QQ ${info?.user_id ?? "?"}）` };
    } catch {}
  }
  // 临时连一次，问一下登录信息。
  const probe = new OneBotAdapter({ ...ctx, setStatus: () => {}, onMessage: () => {}, log: () => {} });
  return await new Promise<TestResult>((resolve) => {
    const timer = setTimeout(() => {
      void probe.stop();
      resolve({ ok: false, detail: "15 秒内没有连上协议端，检查地址、端口和防火墙" });
    }, 15_000);
    const raw = (ctx.config.url ?? "").trim();
    if (!/^wss?:\/\//.test(raw)) {
      clearTimeout(timer);
      resolve({ ok: false, detail: "请填写协议端的 WebSocket 地址（ws:// 或 wss:// 开头）" });
      return;
    }
    const token = ctx.secrets.accessToken ?? "";
    const url = token ? `${raw}${raw.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : raw;
    let socket: WsLike;
    try {
      socket = ctx.ws(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, detail: errorText(error) });
      return;
    }
    const echo = randomId();
    socket.onopen = () => socket.send(JSON.stringify({ action: "get_login_info", params: {}, echo }));
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(dataText(event.data));
        if (payload.echo !== echo) return;
        clearTimeout(timer);
        socket.close();
        if (payload.retcode && payload.retcode !== 0) resolve({ ok: false, detail: `协议端返回错误 ${payload.retcode}` });
        else resolve({ ok: true, detail: `连接正常，登录的是 ${payload.data?.nickname ?? ""}（QQ ${payload.data?.user_id ?? "?"}）` });
      } catch {}
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `连接被关闭${event?.code ? `（${event.code}）` : ""}：检查地址和 token` });
    };
  });
}
