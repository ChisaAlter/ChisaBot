import { createGuardedFetchLike } from "../../../shared/net/guarded-fetch";
import { openGuardedSocket } from "../../../shared/net/guarded-socket";
import type { FetchLike, WsFactory, WsLike } from "./types";

/**
 * IM 链路的默认出站通道（RV-01）：所有适配器的 HTTP 和 WebSocket 都走这里，解析 DNS → 全部公网 →
 * 钉死 IP → 逐跳检查重定向，解析到内网 / 元数据的域名在连接前就拒掉。
 *
 * timeoutMs 是兜底上限：适配器自己用 AbortSignal 控制长轮询节奏（Telegram 40 秒、微信 45 秒），
 * 这里留到 60 秒，既盖得住长轮询、又挡住没有 signal 的请求挂死。
 */
export const imGuardedFetch: FetchLike = createGuardedFetchLike({
  timeoutMs: 60_000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 5,
});

/**
 * 「允许内网地址」连接的专用 fetch：只给服务里按连接配置裁剪过的调用方用（管理员打开的开关 +
 * 目标是那个连接自己配置的协议端主机名才走到这里）。本机 / 内网可连，云元数据仍拦。
 */
export const imGuardedFetchPrivate: FetchLike = createGuardedFetchLike({
  timeoutMs: 60_000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 5,
  allowPrivate: true,
});

export const imGuardedWs: WsFactory = (url, options): WsLike =>
  openGuardedSocket(url, {
    ...(options?.headers ? { headers: options.headers } : {}),
    ...(options?.allowPrivate ? { allowPrivate: true } : {}),
    handshakeTimeoutMs: 20_000,
  });
