import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { OPS_CODES } from "../ops-codes";
import { bumpOps } from "../ops-counters";
import {
  checkPublicUrl,
  isBlockedAddress,
  isBlockedAddressAllowPrivate,
} from "./ssrf";

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

function denySsrf(message?: string): never {
  bumpOps(OPS_CODES.SSRF_DENIED, {
    fields: message ? { reason: message.slice(0, 80) } : {},
  });
  throw new BlockedUrlError(message);
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
  /** 可选自定义 fetch 实现（例如测试注入的 mock fetch）；默认走内置 DNS 钉死连接。 */
  fetchImpl?: typeof fetch;
  /** 测试用：替换 DNS 解析。 */
  resolve?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
  /** 测试用：替换「这个 IP 能不能连」。 */
  isBlocked?: (address: string) => boolean;
  /**
   * 自托管 IM 协议端的内网放行（管理员显式开关）：本机 / RFC1918 可以连，
   * 云元数据等地址仍拦（`ssrf.ts` 的 ALLOW_PRIVATE 名单）；只对第一跳生效——重定向目标一律回到普通政策。
   * 用户 / 模型给的网址永远不传这个。
   */
  allowPrivate?: boolean;
};

const defaultFetch = globalThis.fetch;

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
  if (addresses.length === 0) denySsrf("域名解析不到地址");
  if (addresses.some((a) => blocked(a.address))) denySsrf();
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

async function oneHopViaFetch(
  url: URL,
  customFetch: typeof fetch,
  options: GuardedFetchOptions,
  deadline: number,
): Promise<Hop> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("请求超时");
  const timeoutSignal = AbortSignal.timeout(remaining);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const method = (options.method ?? "GET").toUpperCase();
  const res = await customFetch(url.toString(), {
    method,
    headers: options.headers,
    body:
      options.body !== undefined && method !== "GET" && method !== "HEAD"
        ? (options.body as BodyInit)
        : undefined,
    redirect: "manual",
    signal,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const status = res.status;
  if (status >= 300 && status < 400 && headers.location) {
    return {
      status,
      headers,
      body: Buffer.alloc(0),
      truncated: false,
      location: headers.location,
    };
  }
  const ab = await res.arrayBuffer();
  const full = Buffer.from(ab);
  const stopAt = Math.min(
    options.stopAfterBytes ?? options.maxBytes,
    options.maxBytes,
  );
  const truncated =
    full.length > options.maxBytes ||
    (full.length > stopAt && stopAt < options.maxBytes);
  const body = full.length > stopAt ? full.subarray(0, stopAt) : full;
  return {
    status,
    headers,
    body,
    truncated,
  };
}

function stripHeadersCaseInsensitive(
  headers: Record<string, string> | undefined,
  namesLower: readonly string[],
) {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (namesLower.includes(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

/** 只连公网、钉死 IP、逐跳检查重定向。默认 GET；可传 method/body。被拦时抛 {@link BlockedUrlError}。 */
export async function guardedFetch(
  raw: string,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 4;
  let current = raw;
  let currentMethod = (options.method ?? "GET").toUpperCase();
  let currentBody = options.body;
  const currentHeaders: Record<string, string> | undefined = options.headers
    ? { ...options.headers }
    : undefined;
  const useCustomFetch =
    options.fetchImpl !== undefined &&
    options.fetchImpl !== defaultFetch &&
    !options.resolve &&
    !options.isBlocked;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // 内网放行只抵自己配的那一跳：一旦重定向，目标回到普通（纯公网）政策重新判——
    // 否则内网端点 302 一下就能把请求带进任意内网地址（审计 #467 r2）。
    const hopPrivate = options.allowPrivate === true && hop === 0;
    const verdict = checkPublicUrl(current, {
      allowPrivate: hopPrivate,
    });
    if (!verdict.ok) denySsrf(verdict.reason);
    const isBlocked =
      options.isBlocked ??
      (hopPrivate ? isBlockedAddressAllowPrivate : isBlockedAddress);
    const hopOptions: GuardedFetchOptions = {
      ...options,
      method: currentMethod,
      body: currentBody,
      headers: currentHeaders,
    };
    const result = useCustomFetch
      ? await oneHopViaFetch(
          verdict.url,
          options.fetchImpl!,
          hopOptions,
          deadline,
        )
      : await oneHop(
          verdict.url,
          await resolvePublic(verdict.url.hostname, {
            ...options,
            isBlocked,
          }),
          hopOptions,
          deadline,
        );
    if (result.location) {
      const nextUrl = new URL(result.location, verdict.url);
      if (nextUrl.origin !== verdict.url.origin) {
        stripHeadersCaseInsensitive(currentHeaders, [
          "authorization",
          "cookie",
          "proxy-authorization",
        ]);
      }
      if (
        result.status === 303 ||
        ((result.status === 301 || result.status === 302) &&
          currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        stripHeadersCaseInsensitive(currentHeaders, [
          "content-type",
          "content-length",
          "transfer-encoding",
        ]);
      }
      current = nextUrl.toString();
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

/**
 * 把 {@link guardedFetch} 包成标准 fetch 的形状（`(url, init) => Promise<Response>`），给 IM 适配器、
 * 扫码登录这类「本来就该用 fetch」的调用方换底（RV-01）：DNS 解析 → 全部公网 → 钉死 IP → 逐跳检查
 * 重定向，和裸 fetch 的行为差异只剩「连不出去的内网地址直接拒」。
 *
 * `timeoutMs` 是兜底上限——调用方自己的 `init.signal`（AbortSignal.timeout 之类）决定真实时限；
 * 因 init.signal 中止时抛 `AbortError`，和长轮询适配器靠 abort 结束一轮等待的用法兼容。
 */
export function createGuardedFetchLike(defaults: {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  resolve?: GuardedFetchOptions["resolve"];
  isBlocked?: (address: string) => boolean;
  allowPrivate?: boolean;
}): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    let body: string | Buffer | Uint8Array | undefined;
    const rawBody = init.body as unknown;
    if (typeof rawBody === "string") body = rawBody;
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString();
    else if (rawBody instanceof Uint8Array)
      body = Buffer.from(
        rawBody.buffer,
        rawBody.byteOffset,
        rawBody.byteLength,
      );
    else if (rawBody instanceof ArrayBuffer) body = Buffer.from(rawBody);
    else if (rawBody instanceof Blob)
      body = Buffer.from(await rawBody.arrayBuffer());
    else if (rawBody != null)
      throw new TypeError("guarded fetch 不支持这种请求体");
    try {
      const res = await guardedFetch(String(input), {
        method: init.method ?? "GET",
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        signal: init.signal ?? undefined,
        timeoutMs: defaults.timeoutMs,
        maxBytes: defaults.maxBytes,
        maxRedirects: defaults.maxRedirects,
        ...(defaults.resolve ? { resolve: defaults.resolve } : {}),
        ...(defaults.isBlocked ? { isBlocked: defaults.isBlocked } : {}),
        ...(defaults.allowPrivate ? { allowPrivate: true } : {}),
      });
      const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
      const response = new Response(new Uint8Array(res.body), {
        status,
        headers: res.headers,
      });
      Object.defineProperty(response, "url", { value: res.url });
      return response;
    } catch (error) {
      // 调用方主动 abort（长轮询到点收工）：按 fetch 语义抛 AbortError。
      if (init.signal?.aborted) {
        const aborted = new Error("The operation was aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw error;
    }
  };
}
