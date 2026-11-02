import { createHash, randomBytes } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { OPS_CODES } from "../ops-codes";
import { bumpOps } from "../ops-counters";
import {
  BlockedUrlError,
  type GuardedFetchOptions,
  resolvePublic,
} from "./guarded-fetch";
import { isBlockedHostname } from "./ssrf";

/**
 * 只连公网的 WebSocket 客户端（IM 适配器共用，2026-11-02，RV-01）。
 *
 * 和裸 `new WebSocket(url)` 的区别：
 * - 先自己解析 DNS，所有解析结果都必须是公网地址（`ssrf.ts`），然后把 TCP 连接**钉死在刚检查过的
 *   那个 IP 上**——不再走系统 DNS，不存在「检查时是公网、连接时变内网」的 DNS 重绑定窗口；
 *   wss 的证书仍按原主机名校验（SNI / servername 不变）。
 * - 握手返回 3xx 不自动跟：每一跳都重新走一遍上面的检查，最多 {@link GuardedSocketOptions.maxRedirects} 跳；
 *   跨源跳转时丢掉 Authorization / Cookie。
 * - 只允许 ws / wss，地址里不能带账号密码，主机名一眼是内网的直接拒。
 *
 * 帧收发是最小实现：客户端帧必须打掩码、服务端来的 ping 自动回 pong、close 帧互答。
 */

export class GuardedSocketBlockedError extends BlockedUrlError {}

function denyWs(message?: string): never {
  bumpOps(OPS_CODES.SSRF_DENIED, {
    fields: message ? { reason: message.slice(0, 80) } : {},
  });
  throw new GuardedSocketBlockedError(message);
}

/** 和 server/src/im/types.ts 的 WsLike 同形；放在 shared 里不反向依赖 server。 */
export type GuardedSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type GuardedSocketOptions = {
  /** 追加到握手请求里的头（Authorization、Sec-WebSocket-Protocol 等）。 */
  headers?: Record<string, string>;
  /** 握手跟随重定向的次数；默认 3。 */
  maxRedirects?: number;
  /** 建连 + 握手的总时限（毫秒）；默认 20 秒。 */
  handshakeTimeoutMs?: number;
  /** 单个 WS 帧的最大字节数；默认 32 MiB。 */
  maxFrameBytes?: number;
  /** 测试用：替换 DNS 解析。 */
  resolve?: GuardedFetchOptions["resolve"];
  /** 测试用：替换「这个 IP 能不能连」。 */
  isBlocked?: (address: string) => boolean;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HANDSHAKE_LIMIT = 64 * 1024;
const PROTECTED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
]);

type WsVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** 只放行 ws / wss、没有账号密码、主机名不是内网的地址。DNS 之后的检查在连接前做。 */
export function checkPublicWsUrl(raw: string): WsVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "不是有效的 WebSocket 地址" };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    return { ok: false, reason: "只支持 ws / wss 地址" };
  if (url.username || url.password)
    return { ok: false, reason: "地址里不能带账号密码" };
  if (isBlockedHostname(url.hostname))
    return { ok: false, reason: "不能访问内网地址" };
  return { ok: true, url };
}

type Head = {
  status: number;
  headers: Record<string, string>;
  location?: string;
  /** 响应头之后已经读到的帧字节。 */
  rest: Buffer;
};

function openStream(
  url: URL,
  pinned: { address: string; family: number },
): Promise<Socket | TLSSocket> {
  const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    if (url.protocol === "wss:") {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const socket = tlsConnect({
        // 钉死：不管系统 DNS 现在说什么，只连刚才检查过的地址。
        host: pinned.address,
        port,
        servername: isIP(hostname) ? undefined : hostname,
      });
      socket.once("secureConnect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
      socket.once("error", onError);
      return;
    }
    const socket = netConnect({ host: pinned.address, port });
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}

/** 发握手请求并读响应头（到 \r\n\r\n 为止），返回状态、头和剩余字节；101 时校验 Sec-WebSocket-Accept。 */
function sendHandshake(
  socket: Socket | TLSSocket,
  url: URL,
  headers: Record<string, string>,
  deadline: number,
): Promise<Head> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error("连接超时"));
    const key = randomBytes(16).toString("base64");
    const extra = Object.entries(headers)
      .filter(([name]) => !PROTECTED_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    const request =
      `GET ${url.pathname || "/"}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n" +
      extra +
      "\r\n";
    let head = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error("连接超时（握手没有回应）")));
    }, remaining);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      fn();
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length > HANDSHAKE_LIMIT) {
        socket.destroy();
        return finish(() => reject(new Error("握手响应太大")));
      }
      const mark = head.indexOf("\r\n\r\n");
      if (mark < 0) return;
      const text = head.subarray(0, mark).toString("latin1");
      const rest = Buffer.from(head.subarray(mark + 4));
      const lines = text.split("\r\n");
      const statusMatch = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/.exec(lines[0] ?? "");
      if (!statusMatch)
        return finish(() => reject(new Error("握手响应不是 HTTP")));
      const status = Number(statusMatch[1]);
      const responseHeaders: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const sep = line.indexOf(":");
        if (sep <= 0) continue;
        const name = line.slice(0, sep).trim().toLowerCase();
        const value = line.slice(sep + 1).trim();
        responseHeaders[name] = responseHeaders[name]
          ? `${responseHeaders[name]}, ${value}`
          : value;
      }
      if (status === 101) {
        const expected = createHash("sha1")
          .update(key + WS_GUID)
          .digest("base64");
        if (responseHeaders["sec-websocket-accept"] !== expected) {
          socket.destroy();
          return finish(() =>
            reject(new Error("握手失败：Sec-WebSocket-Accept 不对")),
          );
        }
      }
      finish(() =>
        resolve({
          status,
          headers: responseHeaders,
          ...(responseHeaders.location
            ? { location: responseHeaders.location }
            : {}),
          rest,
        }),
      );
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(request);
  });
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  // 客户端帧必须打掩码（RFC 6455 §5.3）。
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1)
    masked[index] = (masked[index] ?? 0) ^ (key[index & 3] ?? 0);
  return Buffer.concat([header, key, masked]);
}

class PinnedSocket implements GuardedSocketLike {
  readyState = 0;
  binaryType?: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private stream: Socket | TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private fragOpcode = 0;
  private frags: Buffer[] = [];
  private closeSent = false;
  private closedEmitted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closeWait: ReturnType<typeof setTimeout> | null = null;

  constructor(
    raw: string,
    private readonly options: GuardedSocketOptions,
  ) {
    queueMicrotask(() => void this.connect(raw));
  }

  private get maxFrameBytes() {
    return this.options.maxFrameBytes ?? 32 * 1024 * 1024;
  }

  private async connect(raw: string) {
    const timeoutMs = this.options.handshakeTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    this.timer = setTimeout(() => {
      this.stream?.destroy();
      this.fail(new Error(`连接超时（${timeoutMs / 1000} 秒没有握手成功）`));
    }, timeoutMs);
    try {
      const maxRedirects = this.options.maxRedirects ?? 3;
      let current = raw;
      const headers: Record<string, string> = {
        ...(this.options.headers ?? {}),
      };
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        if (this.readyState !== 0) return;
        const verdict = checkPublicWsUrl(current);
        if (!verdict.ok) denyWs(verdict.reason);
        const pinned = await resolvePublic(verdict.url.hostname, {
          ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
          ...(this.options.isBlocked
            ? { isBlocked: this.options.isBlocked }
            : {}),
        });
        if (this.readyState !== 0) return;
        const socket = await openStream(verdict.url, pinned);
        if (this.readyState !== 0) {
          socket.destroy();
          return;
        }
        this.stream = socket;
        const head = await sendHandshake(
          socket,
          verdict.url,
          headers,
          deadline,
        );
        if (this.readyState !== 0) {
          socket.destroy();
          return;
        }
        const isRedirect =
          head.status >= 300 && head.status < 400 && Boolean(head.location);
        if (!isRedirect && head.status !== 101) {
          socket.destroy();
          throw new Error(`握手失败：对方回了 HTTP ${head.status}`);
        }
        if (isRedirect) {
          socket.destroy();
          this.stream = null;
          const next = new URL(head.location ?? "", verdict.url);
          if (next.origin !== verdict.url.origin) {
            for (const name of Object.keys(headers)) {
              if (
                ["authorization", "cookie", "proxy-authorization"].includes(
                  name.toLowerCase(),
                )
              )
                delete headers[name];
            }
          }
          current = next.toString();
          continue;
        }
        this.attach(socket);
        this.buffer = head.rest.length
          ? Buffer.from(head.rest)
          : Buffer.alloc(0);
        this.readyState = 1;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.onopen?.({});
        this.pump();
        return;
      }
      throw new Error("重定向次数太多");
    } catch (error) {
      this.fail(error);
    }
  }

  private attach(socket: Socket | TLSSocket) {
    this.stream = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : chunk;
      this.pump();
    });
    socket.on("error", (error: Error) => {
      this.onerror?.({ error });
      this.emitClose(1006);
    });
    socket.on("close", () => {
      if (this.readyState !== 3) this.emitClose(1006);
    });
  }

  /** 解析 buffer 里所有完整的帧。 */
  private pump() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const b0 = buf[0] ?? 0;
      const b1 = buf[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxFrameBytes)) return this.protocolClose(1009);
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxFrameBytes) return this.protocolClose(1009);
      const maskLength = masked ? 4 : 0;
      if (buf.length < offset + maskLength + length) return;
      const payload = Buffer.from(
        buf.subarray(offset + maskLength, offset + maskLength + length),
      );
      if (masked) {
        const key = buf.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = (payload[index] ?? 0) ^ (key[index & 3] ?? 0);
      }
      this.buffer = Buffer.from(buf.subarray(offset + maskLength + length));
      this.frame(fin, opcode, payload);
      if (this.readyState !== 1) return;
    }
  }

  private frame(fin: boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason =
          payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent && this.stream) {
          this.closeSent = true;
          try {
            this.stream.write(encodeFrame(0x8, payload));
          } catch {}
        }
        this.stream?.destroy();
        this.emitClose(code === 1005 ? 1006 : code, reason);
        return;
      }
      case 0x9: {
        try {
          this.stream?.write(encodeFrame(0xa, payload));
        } catch {}
        return;
      }
      case 0xa:
        return;
      case 0x0: {
        if (!this.fragOpcode) return this.protocolClose(1002);
        this.frags.push(payload);
        if (this.fragsSize() > this.maxFrameBytes)
          return this.protocolClose(1009);
        if (fin) {
          const opcode0 = this.fragOpcode;
          const body = Buffer.concat(this.frags);
          this.fragOpcode = 0;
          this.frags = [];
          this.deliver(opcode0, body);
        }
        return;
      }
      case 0x1:
      case 0x2: {
        if (this.fragOpcode) return this.protocolClose(1002);
        if (fin) return this.deliver(opcode, payload);
        this.fragOpcode = opcode;
        this.frags = [payload];
        return;
      }
      default:
        return this.protocolClose(1002);
    }
  }

  private fragsSize() {
    return this.frags.reduce((total, item) => total + item.length, 0);
  }

  private deliver(opcode: number, payload: Buffer) {
    if (!this.onmessage) return;
    if (opcode === 0x1) {
      this.onmessage({ data: payload.toString("utf8") });
      return;
    }
    if (this.binaryType === "arraybuffer") {
      const view = new Uint8Array(payload);
      this.onmessage({
        data: view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ),
      });
      return;
    }
    this.onmessage({ data: new Uint8Array(payload) });
  }

  private protocolClose(code: number) {
    this.close(code, "protocol error");
  }

  private emitClose(code: number, reason = "") {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.readyState = 3;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closeWait) {
      clearTimeout(this.closeWait);
      this.closeWait = null;
    }
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      stream.removeAllListeners();
      stream.destroy();
    }
    this.onclose?.({ code, reason });
  }

  private fail(error: unknown) {
    if (this.closedEmitted) return;
    this.onerror?.({ error });
    this.emitClose(1006);
  }

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (this.readyState !== 1 || !this.stream) return;
    const isText = typeof data === "string";
    const payload = isText
      ? Buffer.from(data, "utf8")
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
    try {
      this.stream.write(encodeFrame(isText ? 0x1 : 0x2, payload));
    } catch {}
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3 || this.readyState === 2) return;
    const wasOpen = this.readyState === 1 && this.stream;
    this.readyState = 2;
    if (wasOpen) {
      this.closeSent = true;
      const reasonBytes = Buffer.from(String(reason).slice(0, 123), "utf8");
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      try {
        this.stream?.write(encodeFrame(0x8, payload));
      } catch {}
      // 对方 1 秒内不回 close 帧就直接断开。
      this.closeWait = setTimeout(() => this.emitClose(1000), 1000);
      return;
    }
    // 还没握上手就关掉：废掉正在进行的连接。
    this.emitClose(code);
  }
}

/**
 * 建一个钉死 IP 的 WebSocket：校验地址 → 解析 → 全部公网才连 → 连接固定到已校验的地址。
 * 被拦 / 连不上时按 WebSocket 的语义发 onerror 再 onclose（不会同步抛错）。
 */
export function openGuardedSocket(
  url: string,
  options: GuardedSocketOptions = {},
): GuardedSocketLike {
  return new PinnedSocket(url, options);
}
