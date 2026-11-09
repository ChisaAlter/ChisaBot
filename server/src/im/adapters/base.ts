import type { ImPlatform } from "../../../../shared/im";
import { backoffMs, errorText } from "../text";
import type {
  AdapterContext,
  ImAdapter,
  ImDeliveryReceipt,
  ImInbound,
  ImReply,
  WsLike,
} from "../types";

/**
 * 所有适配器共用的「连上 → 断了 → 退避 → 再连」循环。
 *
 * 子类只写 `runOnce()`：建一次连接，连接结束（断开 / 出错）时返回或抛错。`stop()` 会叫醒正在等待
 * 的退避，关掉当前连接，循环退出。连上超过 60 秒才算「稳定」，退避计数清零。
 */
export abstract class LoopAdapter implements ImAdapter {
  abstract readonly platform: ImPlatform;
  abstract readonly maxChunk: number;
  abstract readonly markdown: boolean;
  protected stopped = true;
  protected socket: WsLike | null = null;
  private attempt = 0;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;
  protected connectedAt = 0;
  /** 去重：平台偶尔会重投同一条消息。 */
  private seen = new Map<string, number>();

  constructor(protected readonly ctx: AdapterContext) {}

  protected abstract runOnce(): Promise<void>;
  abstract send(reply: ImReply): Promise<void | ImDeliveryReceipt>;

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.socket?.close(1000, "stop");
    } catch {}
    this.socket = null;
    this.onStop();
    this.wake?.();
    await Promise.race([
      this.loopDone,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  /** 子类的清理（心跳计时器等）。 */
  protected onStop() {}

  protected markConnected(account?: string | null, detail?: string | null) {
    this.connectedAt = Date.now();
    this.ctx.setStatus({
      state: "connected",
      account: account ?? null,
      detail: detail ?? null,
    });
  }

  /** 收到一条消息：去重后交给服务。 */
  protected emit(message: ImInbound) {
    if (this.stopped) return;
    const now = Date.now();
    if (message.messageId) {
      if (this.seen.has(message.messageId)) return;
      this.seen.set(message.messageId, now);
      if (this.seen.size > 500) {
        for (const [key, at] of this.seen) {
          if (now - at > 10 * 60_000 || this.seen.size > 400)
            this.seen.delete(key);
          else break;
        }
      }
    }
    this.ctx.onMessage(message);
  }

  private async loop() {
    while (!this.stopped) {
      this.ctx.setStatus({
        state: "connecting",
        detail: this.attempt ? `第 ${this.attempt + 1} 次连接…` : "正在连接…",
      });
      try {
        await this.runOnce();
        if (!this.stopped) this.ctx.log("warn", "连接断开了，稍后重连");
      } catch (error) {
        if (this.stopped) break;
        const text = errorText(error);
        this.ctx.log("error", `连接出错：${text}`);
        this.ctx.setStatus({ state: "error", detail: text });
      }
      this.onStop();
      if (this.stopped) break;
      if (this.connectedAt && Date.now() - this.connectedAt > 60_000)
        this.attempt = 0;
      this.connectedAt = 0;
      const wait = this.retryDelay(this.attempt++);
      await this.sleep(wait);
    }
  }

  /** 子类可以改退避（例如授权过期时等很久）。 */
  protected retryDelay(attempt: number) {
    return backoffMs(attempt);
  }

  protected sleep(ms: number) {
    if (this.ctx.sleep) return this.ctx.sleep(ms);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /**
   * 打开一个 WebSocket，返回一个在它关闭时结束的 Promise。握手 20 秒没完成算失败。
   * `onOpen` / `onMessage` 里抛的错会关掉连接、让 Promise 失败。
   */
  protected openSocket(
    url: string,
    handlers: {
      onOpen?: (socket: WsLike) => void | Promise<void>;
      onMessage: (data: unknown, socket: WsLike) => void | Promise<void>;
      binary?: boolean;
      headers?: Record<string, string>;
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        if (error) reject(error);
        else resolve();
      };
      let socket: WsLike;
      try {
        socket = this.ctx.ws(
          url,
          handlers.headers ? { headers: handlers.headers } : undefined,
        );
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      if (handlers.binary) socket.binaryType = "arraybuffer";
      const handshake = setTimeout(() => {
        try {
          socket.close();
        } catch {}
        finish(new Error("连接超时（20 秒没有握手成功）"));
      }, 20_000);
      const fail = (error: unknown) => {
        try {
          socket.close(4000, "error");
        } catch {}
        finish(error);
      };
      socket.onopen = () => {
        clearTimeout(handshake);
        Promise.resolve(handlers.onOpen?.(socket)).catch(fail);
      };
      socket.onmessage = (event) => {
        Promise.resolve(handlers.onMessage(event.data, socket)).catch(
          (error) => {
            this.ctx.log("warn", `处理平台消息出错：${errorText(error)}`);
          },
        );
      };
      socket.onerror = () => {
        // 细节在随后的 close 里；有的运行时 error 之后不再发 close。
        setTimeout(() => finish(new Error("WebSocket 出错")), 1000);
      };
      socket.onclose = (event) => {
        if (this.socket === socket) this.socket = null;
        if (
          event?.code &&
          event.code !== 1000 &&
          event.code !== 1005 &&
          !this.stopped
        )
          finish(
            new Error(
              `连接被关闭（${event.code}${event.reason ? ` ${event.reason}` : ""}）`,
            ),
          );
        else finish();
      };
    });
  }

  protected sendJson(payload: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new Error("还没有连上平台");
    socket.send(JSON.stringify(payload));
  }
}

/** WebSocket 收到的数据 → 字符串。 */
export function dataText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data))
    return new TextDecoder().decode(data as Uint8Array);
  return String(data);
}

/** WebSocket 收到的数据 → 字节。 */
export function dataBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(
      (data as Uint8Array).buffer,
      (data as Uint8Array).byteOffset,
      (data as Uint8Array).byteLength,
    );
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new Error("收到不认识的二进制数据");
}

export const randomId = () =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 16);
