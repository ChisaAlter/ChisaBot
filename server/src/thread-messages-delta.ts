import type { MiddlewareHandler } from "hono";

/**
 * 线程消息的增量读取：GET /api/conversations/threads/:id/messages?since=<version>&cursor=<cursor>。
 *
 * 不带这两个参数时响应原样不动（旧客户端照旧拿整份 { messages }）。带了参数：
 * - version 是整份消息的指纹（条数 + 逐条前缀哈希）；since 与它相同时只回 { unchanged: true }，不再传整份历史；
 * - cursor 指向「除最后一条外」的前缀（最后一条可能还在流式增长）；客户端带回来的 cursor 前缀仍吻合时，
 *   只回从那一处起的尾部 { start, messages }；对不上（中间的消息被编辑 / 删除 / 插入）就回整份（start = 0）。
 * 指纹按消息内容算，不靠 updated_at——并非每个写入点都会更新它。
 */
const TAG = "m1";
const MAX_TAIL_MESSAGES = 500;
const MAX_TAIL_BYTES = 512 * 1024;
const MIN_TAIL_MESSAGES = 20;

/**
 * 内部跳过标记：当下游（如本地后端 `GET /threads/:id/messages`）已原生完成
 * `tail` / `since` / `cursor` 处理时挂此头，中间件剥离后直接放行，
 * 防止对已截尾响应二次 `sliceTailMessages` 或错算 `total` / `prefixHashes`。
 */
export const THREAD_MESSAGES_DELTA_HANDLED_HEADER =
  "x-chisabot-messages-delta-handled";

export function parseTailLimit(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_TAIL_MESSAGES);
}

/**
 * 截取最近 limit 条消息，同时限制序列化体积上限（默认 512 KiB）；
 * 即使单条包含超长内容，也至少保留末尾 min(20, slice.length) 条保证首屏可渲染。
 */
export function sliceTailMessages(
  messages: readonly unknown[],
  limit: number,
  maxBytes = MAX_TAIL_BYTES,
): unknown[] {
  if (messages.length === 0 || limit <= 0) return [];
  const capped = Math.min(limit, MAX_TAIL_MESSAGES);
  const start = Math.max(0, messages.length - capped);
  const slice = messages.slice(start);
  const minKeep = Math.min(MIN_TAIL_MESSAGES, slice.length);
  let bytes = 2;
  let kept = 0;
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    const encoded = JSON.stringify(slice[index]) ?? "null";
    const stepBytes = Buffer.byteLength(encoded) + (kept > 0 ? 1 : 0);
    if (kept >= minKeep && bytes + stepBytes > maxBytes) break;
    bytes += stepBytes;
    kept += 1;
  }
  return slice.slice(slice.length - kept);
}

function hashText(text: string): string {
  return Bun.hash(text).toString(36);
}

/** prefix[k] 是前 k 条消息的指纹；prefix[0] 是空前缀。 */
export function prefixHashes(messages: readonly unknown[]): string[] {
  let acc = hashText("");
  const prefix = [acc];
  for (const message of messages) {
    acc = hashText(`${acc}|${JSON.stringify(message) ?? "null"}`);
    prefix.push(acc);
  }
  return prefix;
}

function token(prefix: readonly string[], at: number): string {
  return `${TAG}.${at}.${prefix[at]}`;
}

function parseToken(value: string | null): { at: number; hash: string } | null {
  const parts = value?.split(".") ?? [];
  const [tag, at, hash] = parts;
  if (parts.length !== 3 || tag !== TAG || !at || !hash || !/^\d+$/.test(at))
    return null;
  return { at: Number(at), hash };
}

export type MessagesDelta =
  | { unchanged: true; version: string; cursor: string }
  | { version: string; cursor: string; start: number; messages: unknown[] };

function unchangedAnswer(
  prefix: readonly string[],
  since: string | null,
): MessagesDelta | null {
  const count = prefix.length - 1;
  const version = token(prefix, count);
  return since && since === version
    ? {
        unchanged: true,
        version,
        cursor: token(prefix, Math.max(0, count - 1)),
      }
    : null;
}

export function messagesDelta(
  messages: readonly unknown[],
  since: string | null,
  cursor: string | null,
  prefix: readonly string[] = prefixHashes(messages),
): MessagesDelta {
  const unchanged = unchangedAnswer(prefix, since);
  if (unchanged) return unchanged;
  const count = messages.length;
  const version = token(prefix, count);
  const next = token(prefix, Math.max(0, count - 1));
  const base = parseToken(cursor);
  const start =
    base && base.at <= count && prefix[base.at] === base.hash ? base.at : 0;
  return { version, cursor: next, start, messages: messages.slice(start) };
}

function isMessagesRead(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  const count = parts.length;
  return (
    count >= 3 &&
    parts[count - 1] === "messages" &&
    parts[count - 3] === "threads"
  );
}

/**
 * 原始响应体的哈希 → 它的前缀指纹。轮询多半读到同一份记录：命中时不用再解析、逐条哈希，
 * 「没变」直接回 unchanged。只存哈希，不存消息内容；条数有上限。
 */
const known = new Map<string, readonly string[]>();
const KNOWN_LIMIT = 256;

const knownTail = new Map<string, string>();
const KNOWN_TAIL_LIMIT = 128;

function remember(key: string, prefix: readonly string[]) {
  known.delete(key);
  known.set(key, prefix);
  if (known.size <= KNOWN_LIMIT) return;
  const oldest = known.keys().next().value;
  if (oldest !== undefined) known.delete(oldest);
}

function rememberTail(key: string, serialized: string) {
  knownTail.delete(key);
  knownTail.set(key, serialized);
  if (knownTail.size <= KNOWN_TAIL_LIMIT) return;
  const oldest = knownTail.keys().next().value;
  if (oldest !== undefined) knownTail.delete(oldest);
}

/** 套在 /api/conversations/* 外面：本地后端和 Intelligence 两条路读出来的 { messages } 都按 since/cursor 或 tail 改写。 */
export const threadMessagesDelta: MiddlewareHandler = async (context, next) => {
  await next();
  if (context.req.method !== "GET") return;
  const response = context.res;
  if (response.headers.has(THREAD_MESSAGES_DELTA_HANDLED_HEADER)) {
    const headers = new Headers(response.headers);
    headers.delete(THREAD_MESSAGES_DELTA_HANDLED_HEADER);
    context.res = undefined;
    context.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return;
  }
  const url = new URL(context.req.url);
  if (
    !url.searchParams.has("since") &&
    !url.searchParams.has("cursor") &&
    !url.searchParams.has("tail")
  )
    return;
  if (!isMessagesRead(url.pathname)) return;
  if (
    response.status !== 200 ||
    !(response.headers.get("content-type") ?? "").includes("application/json")
  )
    return;
  let raw: string;
  try {
    raw = await response.clone().text();
  } catch {
    return;
  }
  const since = url.searchParams.get("since");
  const cursor = url.searchParams.get("cursor");
  const tail = !since && !cursor ? parseTailLimit(url.searchParams.get("tail")) : null;
  const key = `${Bun.hash(raw).toString(36)}.${raw.length}`;
  if (tail !== null) {
    const tailKey = `${key}:${tail}`;
    const cachedTail = knownTail.get(tailKey);
    if (cachedTail !== undefined) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("cache-control", "no-store");
      context.res = undefined;
      context.res = new Response(cachedTail, { status: 200, headers });
      return;
    }
  }
  const cached = known.get(key);
  let answer: Record<string, unknown> | null = cached
    ? unchangedAnswer(cached, since)
    : null;
  let cacheTailKey: string | null = null;
  if (!answer) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return;
    }
    if (!body || typeof body !== "object") return;
    const record = body as Record<string, unknown>;
    if (
      record.partial === true ||
      record.unchanged === true ||
      typeof record.version === "string"
    )
      return;
    if (!Array.isArray(record.messages)) return;
    const { messages, ...rest } = record as { messages: unknown[] } & Record<
      string,
      unknown
    >;
    if (tail !== null) {
      const tailed = sliceTailMessages(messages, tail);
      if (tailed.length < messages.length) {
        answer = {
          ...rest,
          messages: tailed,
          total: messages.length,
          partial: true,
        };
        cacheTailKey = `${key}:${tail}`;
      }
    }
    if (!answer) {
      const prefix = cached ?? prefixHashes(messages);
      remember(key, prefix);
      answer = {
        ...rest,
        ...messagesDelta(messages, since, cursor, prefix),
      };
    }
  }
  const serialized = JSON.stringify(answer);
  if (cacheTailKey) rememberTail(cacheTailKey, serialized);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("cache-control", "no-store");
  context.res = undefined;
  context.res = new Response(serialized, { status: 200, headers });
};
