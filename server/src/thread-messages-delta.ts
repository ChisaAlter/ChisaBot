import type { MiddlewareHandler } from "hono";

/**
 * 线程消息的增量读取：GET /api/copilotkit/threads/:id/messages?since=<version>&cursor=<cursor>。
 *
 * 不带这两个参数时响应原样不动（旧客户端照旧拿整份 { messages }）。带了参数：
 * - version 是整份消息的指纹（条数 + 逐条前缀哈希）；since 与它相同时只回 { unchanged: true }，不再传整份历史；
 * - cursor 指向「除最后一条外」的前缀（最后一条可能还在流式增长）；客户端带回来的 cursor 前缀仍吻合时，
 *   只回从那一处起的尾部 { start, messages }；对不上（中间的消息被编辑 / 删除 / 插入）就回整份（start = 0）。
 * 指纹按消息内容算，不靠 updated_at——并非每个写入点都会更新它。
 */
const TAG = "m1";

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
const KNOWN_LIMIT = 64;

function remember(key: string, prefix: readonly string[]) {
  known.delete(key);
  known.set(key, prefix);
  if (known.size <= KNOWN_LIMIT) return;
  const oldest = known.keys().next().value;
  if (oldest !== undefined) known.delete(oldest);
}

/** 套在 /api/copilotkit/* 外面：本地后端和 Intelligence 两条路读出来的 { messages } 都按 since/cursor 改写。 */
export const threadMessagesDelta: MiddlewareHandler = async (context, next) => {
  await next();
  if (context.req.method !== "GET") return;
  const url = new URL(context.req.url);
  if (!url.searchParams.has("since") && !url.searchParams.has("cursor")) return;
  if (!isMessagesRead(url.pathname)) return;
  const response = context.res;
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
  const key = `${Bun.hash(raw).toString(36)}.${raw.length}`;
  const cached = known.get(key);
  let answer: Record<string, unknown> | null = cached
    ? unchangedAnswer(cached, since)
    : null;
  if (!answer) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { messages?: unknown }).messages)
    )
      return;
    const { messages, ...rest } = body as { messages: unknown[] } & Record<
      string,
      unknown
    >;
    const prefix = cached ?? prefixHashes(messages);
    remember(key, prefix);
    answer = {
      ...rest,
      ...messagesDelta(messages, since, url.searchParams.get("cursor"), prefix),
    };
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("cache-control", "no-store");
  context.res = undefined;
  context.res = new Response(JSON.stringify(answer), { status: 200, headers });
};
