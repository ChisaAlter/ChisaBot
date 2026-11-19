import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * HTTP 安全边界与流式防护（Wave 10 §2.3–§2.7）：
 *
 * 1. `resolveRateLimitPrincipal`：优先取认证后主体（actor.id / deviceId / peerId），仅在显式可信代理配置下读
 *    `X-Forwarded-For`，绝不把 loopback 隧道下全部不同请求折成单一 `127.0.0.1` 桶互相打满。
 * 2. `createPerPrincipalQuota`：统一按主体限额封装，防单主体打满全局配额。
 * 3. `createLiveConnectionRegistry`：按主体追踪全部活跃 SSE / WS / 长轮询连接，吊销即刻掐断活流。
 * 4. `stripProxyHeaders`：除标准 hop-by-hop 黑名单外，解析并一并剥离 `Connection:` 点名的全部头，响应剥离 `set-cookie`。
 * 5. `createBoundedSseReader`：64 MiB 级 SSE 帧/流上限保护，防止恶意大帧耗尽内存。
 */

export const MAX_SSE_BYTES = 64 * 1024 * 1024;

const STANDARD_HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_SENSITIVE_FORWARD_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
]);

function isLoopbackIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizePrincipalSegment(value: string): string {
  return value.trim().slice(0, 128);
}

export type RateLimitPrincipalInput = {
  actorId?: string | null;
  deviceId?: string | null;
  peerId?: string | null;
  remoteAddress?: string | null;
  headers?: Headers | Record<string, string | undefined> | null;
  /** 仅当请求确实经过本部署信任的反向代理时设为 true。 */
  trustForwardedHeaders?: boolean;
  /** 可选显式可信代理源 IP 白名单；传入时仅当 remoteAddress 在白名单内才信任 X-Forwarded-For。 */
  trustedProxies?: ReadonlySet<string>;
  /** 可选业务侧调用者回退键（如隧道 peer 标识或已验会话指纹）。 */
  fallbackKey?: string | null;
};

function readHeaderCaseInsensitive(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function isHonoContext(value: unknown): value is Context {
  return (
    typeof value === "object" &&
    value !== null &&
    "req" in value &&
    typeof (value as { req?: { header?: unknown } }).req?.header === "function"
  );
}

/**
 * 解析限流主体键：
 * - 优先取认证后身份 `actor.id` / `deviceId` / `peerId`；
 * - 仅在显式可信代理下才读取 `X-Real-IP` / `X-Forwarded-For`；
 * - 绝不把 loopback 隧道下不同会话/令牌折成单一 `127.0.0.1` 互相打满。
 */
export function resolveRateLimitPrincipal(
  contextOrInput: Context | RateLimitPrincipalInput,
  options: {
    deviceId?: string | null;
    peerId?: string | null;
    remoteAddress?: string | null;
    trustForwardedHeaders?: boolean;
    trustedProxies?: ReadonlySet<string>;
    fallbackKey?: string | null;
  } = {},
): string {
  let actorId: string | null | undefined;
  let deviceId: string | null | undefined = options.deviceId;
  let peerId: string | null | undefined = options.peerId;
  let remoteAddress: string | null | undefined = options.remoteAddress;
  let headers: Headers | Record<string, string | undefined> | null | undefined;
  let trustForwardedHeaders = options.trustForwardedHeaders === true;
  let trustedProxies = options.trustedProxies;
  let fallbackKey = options.fallbackKey;

  if (isHonoContext(contextOrInput)) {
    const vars = contextOrInput.var as Record<string, unknown> | undefined;
    const actor = vars?.actor as { id?: unknown } | undefined;
    if (typeof actor?.id === "string" && actor.id.trim()) {
      actorId = actor.id;
    }
    if (
      !deviceId &&
      typeof vars?.deviceId === "string" &&
      vars.deviceId.trim()
    ) {
      deviceId = vars.deviceId;
    }
    if (!peerId && typeof vars?.peerId === "string" && vars.peerId.trim()) {
      peerId = vars.peerId;
    }
    headers = contextOrInput.req.raw.headers;
  } else {
    actorId = contextOrInput.actorId;
    deviceId = deviceId ?? contextOrInput.deviceId;
    peerId = peerId ?? contextOrInput.peerId;
    remoteAddress = remoteAddress ?? contextOrInput.remoteAddress;
    headers = contextOrInput.headers;
    trustForwardedHeaders =
      options.trustForwardedHeaders ??
      contextOrInput.trustForwardedHeaders === true;
    trustedProxies = trustedProxies ?? contextOrInput.trustedProxies;
    fallbackKey = fallbackKey ?? contextOrInput.fallbackKey;
  }

  if (actorId?.trim()) {
    return `user:${sanitizePrincipalSegment(actorId)}`;
  }
  if (deviceId?.trim()) {
    return `device:${sanitizePrincipalSegment(deviceId)}`;
  }
  if (peerId?.trim()) {
    return `peer:${sanitizePrincipalSegment(peerId)}`;
  }

  const trimmedRemote = remoteAddress?.trim() ?? "";
  const proxyTrusted =
    trustForwardedHeaders &&
    (!trustedProxies ||
      (trimmedRemote.length > 0 && trustedProxies.has(trimmedRemote)));

  if (proxyTrusted) {
    const forwarded =
      readHeaderCaseInsensitive(headers, "x-real-ip")?.trim() ||
      readHeaderCaseInsensitive(headers, "x-forwarded-for")
        ?.split(",")[0]
        ?.trim();
    if (forwarded && !isLoopbackIp(forwarded)) {
      return `ip:${sanitizePrincipalSegment(forwarded)}`;
    }
  }

  if (trimmedRemote && !isLoopbackIp(trimmedRemote)) {
    return `ip:${sanitizePrincipalSegment(trimmedRemote)}`;
  }

  // Loopback 隧道/反代入口下，若无认证主体，不能直接把不同来源全折到单一 "127.0.0.1"。
  if (fallbackKey?.trim()) {
    return `principal:${sanitizePrincipalSegment(fallbackKey)}`;
  }
  const authHeader = readHeaderCaseInsensitive(
    headers,
    "authorization",
  )?.trim();
  if (authHeader) {
    return `auth:${shortHash(authHeader)}`;
  }
  const cookieHeader = readHeaderCaseInsensitive(headers, "cookie")?.trim();
  if (cookieHeader) {
    return `session:${shortHash(cookieHeader)}`;
  }
  const peerHeader = readHeaderCaseInsensitive(
    headers,
    "x-chisabot-peer-id",
  )?.trim();
  if (peerHeader) {
    return `loopback-peer:${shortHash(peerHeader)}`;
  }
  const ua = readHeaderCaseInsensitive(headers, "user-agent")?.trim();
  if (ua) {
    return `loopback-client:${shortHash(ua)}`;
  }
  return "loopback:anonymous";
}

export class PrincipalQuotaExceededError extends Error {
  readonly status = 429;
  constructor(
    readonly principalId: string,
    readonly limit: number,
    message = `主体配额已达上限（最大 ${limit}）。`,
  ) {
    super(message);
    this.name = "PrincipalQuotaExceededError";
  }
}

export type PerPrincipalQuota = {
  readonly maxPerPrincipal: number;
  count(principalId: string): number;
  remaining(principalId: string): number;
  assertWithinLimit(principalId: string, currentCount?: number): void;
  acquire(principalId: string): () => void;
  withQuota<T>(principalId: string, fn: () => Promise<T> | T): Promise<T>;
  reset(principalId?: string): void;
};

/**
 * 统一按主体（user / device / peer）限额封装，防止坏主体占满全局配额导致全员 429。
 */
export function createPerPrincipalQuota(
  maxPerPrincipal: number,
  options: { label?: string } = {},
): PerPrincipalQuota {
  if (!Number.isInteger(maxPerPrincipal) || maxPerPrincipal < 1) {
    throw new Error("maxPerPrincipal 必须为正整数。");
  }
  const active = new Map<string, number>();
  const label = options.label?.trim() || "资源";

  const count = (principalId: string): number => active.get(principalId) ?? 0;

  const assertWithinLimit = (
    principalId: string,
    currentCount?: number,
  ): void => {
    const used = currentCount ?? count(principalId);
    if (used >= maxPerPrincipal) {
      throw new PrincipalQuotaExceededError(
        principalId,
        maxPerPrincipal,
        `${label}按主体配额已满（上限 ${maxPerPrincipal}）。`,
      );
    }
  };

  const acquire = (principalId: string): (() => void) => {
    const key = principalId.trim();
    if (!key) {
      throw new Error("principalId 不能为空。");
    }
    const used = count(key);
    assertWithinLimit(key, used);
    active.set(key, used + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (active.get(key) ?? 1) - 1;
      if (next <= 0) active.delete(key);
      else active.set(key, next);
    };
  };

  return {
    maxPerPrincipal,
    count,
    remaining(principalId: string) {
      return Math.max(0, maxPerPrincipal - count(principalId));
    },
    assertWithinLimit,
    acquire,
    async withQuota<T>(
      principalId: string,
      fn: () => Promise<T> | T,
    ): Promise<T> {
      const release = acquire(principalId);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    reset(principalId?: string) {
      if (principalId === undefined) active.clear();
      else active.delete(principalId);
    },
  };
}

export type PrincipalRateLimiter = {
  check(
    principalId: string,
    nowMs?: number,
  ): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  };
  reset(principalId?: string): void;
};

/** 有界 per-principal 固定窗口速率限制器，绝不按裸 loopback IP 共享单桶。 */
export function createPrincipalRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxBuckets?: number;
  now?: () => number;
}): PrincipalRateLimiter {
  const { limit, windowMs } = options;
  const maxBuckets = options.maxBuckets ?? 10_000;
  const nowFn = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(principalId: string, nowMs = nowFn()) {
      const key = principalId.trim() || "loopback:anonymous";
      const current = buckets.get(key);
      if (!current || nowMs >= current.resetAt) {
        if (buckets.size >= maxBuckets) {
          for (const [bucketKey, bucket] of buckets) {
            if (nowMs >= bucket.resetAt) buckets.delete(bucketKey);
          }
          if (buckets.size >= maxBuckets) {
            const oldest = buckets.keys().next().value;
            if (oldest !== undefined) buckets.delete(oldest);
          }
        }
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return {
          allowed: true,
          remaining: Math.max(0, limit - 1),
          retryAfterMs: 0,
        };
      }
      if (current.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(0, current.resetAt - nowMs),
        };
      }
      current.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, limit - current.count),
        retryAfterMs: 0,
      };
    },
    reset(principalId?: string) {
      if (principalId === undefined) buckets.clear();
      else buckets.delete(principalId);
    },
  };
}

export type LiveConnectionHandle =
  | {
      kind?: "sse" | "ws" | "long-poll" | "stream";
      close: (reason?: string) => void;
    }
  | AbortController;

export type LiveConnectionRegistry = {
  /** 登记某个主体（或主体列表，如同时按 userId 和 deviceId）的活跃流连接，返回幂等注销函数。 */
  track(
    principalIds: string | readonly string[],
    handle: LiveConnectionHandle,
  ): () => void;
  /** 吊销主体后立刻掐断其名下所有活流，返回被终止的连接数。 */
  revokePrincipal(principalId: string, reason?: string): number;
  /** 查询当前活跃连接数（按主体或全量）。 */
  activeCount(principalId?: string): number;
  /** 关闭注册表中全部连接（停机/测试清理用）。 */
  closeAll(reason?: string): number;
};

type TrackedEntry = {
  principals: readonly string[];
  close: (reason?: string) => void;
  closed: boolean;
};

/**
 * 活流连接注册表（§2.5）：
 * 按主体追踪所有 SSE / WebSocket / 长轮询连接；设备/用户/令牌吊销时调用 `revokePrincipal`
 * 立即 `close()` / `abort()` 掐断在途流，不再只拦下一次请求。
 */
export function createLiveConnectionRegistry(): LiveConnectionRegistry {
  const byPrincipal = new Map<string, Set<TrackedEntry>>();
  const allEntries = new Set<TrackedEntry>();

  const detachEntry = (entry: TrackedEntry): void => {
    allEntries.delete(entry);
    for (const principal of entry.principals) {
      const bucket = byPrincipal.get(principal);
      if (!bucket) continue;
      bucket.delete(entry);
      if (bucket.size === 0) byPrincipal.delete(principal);
    }
  };

  const closeEntry = (entry: TrackedEntry, reason?: string): boolean => {
    if (entry.closed) return false;
    entry.closed = true;
    detachEntry(entry);
    try {
      entry.close(reason);
    } catch {
      // 忽略已关闭 socket/controller 的二次关闭异常。
    }
    return true;
  };

  return {
    track(principalIds, handle) {
      const list = (Array.isArray(principalIds) ? principalIds : [principalIds])
        .map((id) => id.trim())
        .filter(Boolean);
      const uniquePrincipals = [...new Set(list)];
      if (uniquePrincipals.length === 0) {
        return () => {};
      }
      const closeFn =
        handle instanceof AbortController
          ? (reason?: string) => handle.abort(reason ?? "principal_revoked")
          : (reason?: string) => handle.close(reason);
      const entry: TrackedEntry = {
        principals: uniquePrincipals,
        close: closeFn,
        closed: false,
      };
      allEntries.add(entry);
      for (const principal of uniquePrincipals) {
        let bucket = byPrincipal.get(principal);
        if (!bucket) {
          bucket = new Set();
          byPrincipal.set(principal, bucket);
        }
        bucket.add(entry);
      }
      return () => {
        if (entry.closed) return;
        entry.closed = true;
        detachEntry(entry);
      };
    },

    revokePrincipal(principalId, reason = "revoked") {
      const key = principalId.trim();
      if (!key) return 0;
      const bucket = byPrincipal.get(key);
      if (!bucket || bucket.size === 0) return 0;
      const snapshot = [...bucket];
      let closedCount = 0;
      for (const entry of snapshot) {
        if (closeEntry(entry, reason)) closedCount += 1;
      }
      return closedCount;
    },

    activeCount(principalId?: string) {
      if (principalId === undefined) return allEntries.size;
      return byPrincipal.get(principalId.trim())?.size ?? 0;
    },

    closeAll(reason = "shutdown") {
      const snapshot = [...allEntries];
      let closedCount = 0;
      for (const entry of snapshot) {
        if (closeEntry(entry, reason)) closedCount += 1;
      }
      return closedCount;
    },
  };
}

/** 进程级默认活流注册表，供设备、频道 WebSocket、SSE 与吊销路由共享接线。 */
export const liveConnections = createLiveConnectionRegistry();

export type StripProxyHeadersOptions = {
  /** 请求转发到上游（request）或上游响应回到客户端（response），默认 response。 */
  direction?: "request" | "response";
  /** 响应方向默认剥离 `set-cookie`。 */
  stripSetCookie?: boolean;
  /** 请求方向是否剥离客户端凭据与转发头（authorization/cookie/x-forwarded-*），默认 true。 */
  stripClientCredentials?: boolean;
  /** 额外要剥离的头名（大小写不敏感）。 */
  extraStrip?: readonly string[];
};

export type HeaderLikeInput =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>;

function toHeaderPairs(input: HeaderLikeInput): Array<[string, string]> {
  if (input instanceof Headers) {
    const pairs: Array<[string, string]> = [];
    input.forEach((value, key) => {
      pairs.push([key, value]);
    });
    return pairs;
  }
  if (Array.isArray(input)) {
    return input.map(([k, v]) => [String(k), String(v)]);
  }
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([key, String(item)]);
    } else {
      pairs.push([key, String(value)]);
    }
  }
  return pairs;
}

/**
 * 代理头剥离（§2.6，RFC 7230 §6.1）：
 * - 除标准 hop-by-hop 头外，解析所有 `Connection:` 头中逗号点名的字段名一并剥离；
 * - 响应方向默认强制剥离 `set-cookie`；
 * - 请求方向默认剥离客户端凭据与不可信 `X-Forwarded-*` 头，由代理显式注入上游凭据。
 */
export function stripProxyHeaders(
  headers: HeaderLikeInput,
  options: StripProxyHeadersOptions = {},
): Headers {
  const direction = options.direction ?? "response";
  const stripSetCookie = options.stripSetCookie ?? direction === "response";
  const stripClientCredentials =
    options.stripClientCredentials ?? direction === "request";

  const pairs = toHeaderPairs(headers);
  const excluded = new Set<string>(STANDARD_HOP_BY_HOP_HEADERS);

  for (const [key, value] of pairs) {
    if (key.toLowerCase() === "connection") {
      for (const rawName of value.split(",")) {
        const token = rawName.trim().toLowerCase();
        if (token) excluded.add(token);
      }
    }
  }

  if (stripSetCookie) {
    excluded.add("set-cookie");
  }
  if (stripClientCredentials) {
    for (const name of REQUEST_SENSITIVE_FORWARD_HEADERS) {
      excluded.add(name);
    }
  }
  for (const extra of options.extraStrip ?? []) {
    const lower = extra.trim().toLowerCase();
    if (lower) excluded.add(lower);
  }

  const sanitized = new Headers();
  for (const [key, value] of pairs) {
    if (excluded.has(key.toLowerCase())) continue;
    sanitized.append(key, value);
  }
  return sanitized;
}

export class SseLimitExceededError extends Error {
  readonly status = 413;
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    message = `SSE 流超过安全上限（${limitBytes} 字节），已中止读取。`,
  ) {
    super(message);
    this.name = "SseLimitExceededError";
  }
}

export type SseFrame = {
  event: string;
  data: string;
  id?: string;
  retry?: number;
  raw: string;
};

export type BoundedSseReader = AsyncIterable<SseFrame> & {
  readonly maxBytes: number;
  readAll(): Promise<SseFrame[]>;
  cancel(reason?: unknown): Promise<void>;
};

function parseSseBlock(rawBlock: string): SseFrame | null {
  const lines = rawBlock.split(/\r?\n/);
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id" && !value.includes("\u0000")) {
      id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      retry = Number(value);
    }
  }

  if (
    dataLines.length === 0 &&
    event === "message" &&
    id === undefined &&
    retry === undefined
  ) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
    raw: rawBlock,
  };
}

/**
 * 64 MiB 级有界 SSE 流读取器（§2.7）：
 * 同时约束单帧未闭合缓冲区字节数与累计读取字节数，任一超限立刻 cancel 上游流并抛出 `SseLimitExceededError`。
 */
export function createBoundedSseReader(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_SSE_BYTES,
): BoundedSseReader {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes 必须为正整数。");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const cancel = async (reason?: unknown): Promise<void> => {
    cancelled = true;
    if (reader) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
      reader = null;
    } else {
      await stream.cancel(reason).catch(() => {});
    }
  };

  const iterator = async function* (): AsyncGenerator<SseFrame> {
    reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let totalBytes = 0;
    let buffered = "";
    const boundaryRe = /\r?\n\r?\n/;

    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("sse_limit_exceeded").catch(() => {});
          throw new SseLimitExceededError(maxBytes, totalBytes);
        }

        buffered += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffered, "utf8") > maxBytes) {
          await reader.cancel("sse_frame_limit_exceeded").catch(() => {});
          throw new SseLimitExceededError(
            maxBytes,
            Buffer.byteLength(buffered, "utf8"),
          );
        }

        let match = boundaryRe.exec(buffered);
        while (match) {
          const block = buffered.slice(0, match.index);
          buffered = buffered.slice(match.index + match[0].length);
          const frame = parseSseBlock(block);
          if (frame) yield frame;
          match = boundaryRe.exec(buffered);
        }
      }

      if (!cancelled) {
        buffered += decoder.decode();
        if (Buffer.byteLength(buffered, "utf8") > maxBytes) {
          throw new SseLimitExceededError(
            maxBytes,
            Buffer.byteLength(buffered, "utf8"),
          );
        }
        if (buffered.trim().length > 0) {
          const tail = parseSseBlock(buffered);
          if (tail) yield tail;
        }
      }
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = null;
      }
    }
  };

  return {
    maxBytes,
    [Symbol.asyncIterator]: iterator,
    async readAll() {
      const frames: SseFrame[] = [];
      for await (const frame of iterator()) {
        frames.push(frame);
      }
      return frames;
    },
    cancel,
  };
}
