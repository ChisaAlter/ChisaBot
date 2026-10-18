import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { checkPublicUrl, isBlockedAddress } from "./ssrf";

/**
 * 只连公网的 GET（链接预览卡和预览截图共用，2026-10-13）。
 *
 * 和普通 fetch 的区别：
 * - 先自己解析 DNS，所有解析结果都必须是公网地址（`ssrf.ts`），然后把连接**钉死在刚检查过的那个 IP 上**
 *   （node:http 的 `lookup` 钩子，Bun 实测会用它），所以不存在「检查时是公网、连接时变内网」的 DNS 重绑定窗口；
 *   HTTPS 仍按原主机名校验证书（SNI / servername 不变）。
 * - 重定向不自动跟：每一跳都重新走一遍上面的检查，最多 {@link GuardedFetchOptions.maxRedirects} 跳。
 * - 有总时限、有字节上限（解压后计），超了就截断并标 `truncated`，不会把大文件读进内存。
 * - 只允许 http / https，网址里不能带账号密码。
 */

export class BlockedUrlError extends Error {
  constructor(message = "不能访问内网地址") {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export type GuardedResponse = {
  /** 最后一跳的网址（跟完重定向之后）。 */
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  /** 超过 maxBytes 被截断。 */
  truncated: boolean;
};

export type GuardedFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 读到这么多字节就够了（例如 HTML 只要 <head>），可以提前停；默认 = maxBytes。 */
  stopAfterBytes?: number;
  /** 默认 GET。vault api_request 等需要 POST/PUT 时传入（CR #215 残留）。 */
  method?: string;
  /** 与 method 一起用；只在非 GET/HEAD 时发送。 */
  body?: string | Buffer | Uint8Array;
  /** 测试用：替换 DNS 解析。 */
  resolve?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
  /** 测试用：替换「这个 IP 能不能连」。 */
  isBlocked?: (address: string) => boolean;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ChisaBot-LinkPreview/0.1";

async function defaultResolve(hostname: string) {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map(
    (a) => ({ address: a.address, family: a.family }),
  );
}

/** 解析并检查一个主机名，返回钉死要连的地址；任何一个解析结果是内网都整体拒绝。 */
export async function resolvePublic(
  hostname: string,
  options: Pick<GuardedFetchOptions, "resolve" | "isBlocked"> = {},
): Promise<{ address: string; family: number }> {
  const blocked = options.isBlocked ?? isBlockedAddress;
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  const addresses = literal
    ? [{ address: bare, family: literal }]
    : await (options.resolve ?? defaultResolve)(bare);
  if (addresses.length === 0) throw new BlockedUrlError("域名解析不到地址");
  if (addresses.some((a) => blocked(a.address))) throw new BlockedUrlError();
  return addresses[0]!;
}

function decoderFor(encoding: string | undefined) {
  const e = (encoding ?? "").trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return createGunzip();
  if (e === "deflate") return createInflate();
  if (e === "br") return createBrotliDecompress();
  return null;
}

type Hop = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  location?: string;
};

function flatHeaders(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }
  return out;
}

function oneHop(
  url: URL,
  pinned: { address: string; family: number },
  options: GuardedFetchOptions,
  deadline: number,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error("请求超时"));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const req = send(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: (options.method ?? "GET").toUpperCase(),
        servername: isIP(hostname) ? undefined : hostname,
        headers: {
          "user-agent": DEFAULT_UA,
          accept:
            "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          ...options.headers,
          host: url.host,
        },
        // 钉死：不管系统 DNS 现在说什么，只连刚才检查过的地址。
        lookup: ((
          _host: string,
          opts: { all?: boolean } | undefined,
          cb: (...args: unknown[]) => void,
        ) => {
          const callback =
            typeof opts === "function"
              ? (opts as (...args: unknown[]) => void)
              : cb;
          if (typeof opts === "object" && opts?.all)
            callback(null, [
              { address: pinned.address, family: pinned.family },
            ]);
          else callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        const headers = flatHeaders(res);
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && headers.location) {
          res.resume();
          return finish(() =>
            resolve({
              status,
              headers,
              body: Buffer.alloc(0),
              truncated: false,
              location: headers.location,
            }),
          );
        }
        const decoder = decoderFor(headers["content-encoding"]);
        const stream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const stopAt = Math.min(
          options.stopAfterBytes ?? options.maxBytes,
          options.maxBytes,
        );
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > stopAt) {
            chunks.push(
              chunk.subarray(0, Math.max(0, chunk.length - (size - stopAt))),
            );
            truncated = size > options.maxBytes || stopAt < options.maxBytes;
            req.destroy();
            return finish(() =>
              resolve({
                status,
                headers,
                body: Buffer.concat(chunks),
                truncated,
              }),
            );
          }
          chunks.push(chunk);
        });
        stream.on("end", () =>
          finish(() =>
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks),
              truncated,
            }),
          ),
        );
        stream.on("error", (error: Error) =>
          finish(() =>
            chunks.length
              ? resolve({
                  status,
                  headers,
                  body: Buffer.concat(chunks),
                  truncated: true,
                })
              : reject(error),
          ),
        );
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error("请求超时")));
    }, remaining);
    const onAbort = () => {
      req.destroy();
      finish(() => reject(new Error("已取消")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => finish(() => reject(error)));
    const method = (options.method ?? "GET").toUpperCase();
    if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

/** 只连公网、钉死 IP、逐跳检查重定向。默认 GET；可传 method/body。被拦时抛 {@link BlockedUrlError}。 */
export async function guardedFetch(
  raw: string,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 4;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = checkPublicUrl(current);
    if (!verdict.ok) throw new BlockedUrlError(verdict.reason);
    const pinned = await resolvePublic(verdict.url.hostname, options);
    const result = await oneHop(verdict.url, pinned, options, deadline);
    if (result.location) {
      current = new URL(result.location, verdict.url).toString();
      continue;
    }
    return {
      url: verdict.url.toString(),
      status: result.status,
      headers: result.headers,
      contentType: (result.headers["content-type"] ?? "").toLowerCase(),
      body: result.body,
      truncated: result.truncated,
    };
  }
  throw new Error("重定向次数太多");
}
