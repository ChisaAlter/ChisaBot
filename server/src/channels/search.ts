/**
 * 会话全文搜索（FIX-03）：在用户有权限的对话消息正文里找关键词，返回摘要 + 命中偏移。
 * Ctrl+K 以前只扫标题 / 摘要 / 最后一条，正文里的「电车」「市值」会假阴性。
 */
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";

export type ChannelSearchHit = {
  channelId: string;
  threadId: string;
  name: string;
  summary: string | null;
  snippet: string;
  highlight: { start: number; end: number };
  messageId: string | null;
  role: string | null;
};

type StoredMessage = {
  id?: string;
  role?: string;
  content?: unknown;
};

type SearchRow = {
  channel_id: string;
  name: string;
  summary: string | null;
  thread_id: string;
  messages: StoredMessage[] | string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

/** 从消息正文里抽出含 needle 的一小段，并标出高亮区间。 */
export function snippetAround(
  haystack: string,
  needle: string,
  radius = 48,
): { snippet: string; highlight: { start: number; end: number } } | null {
  const lower = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const at = lower.indexOf(n);
  if (at < 0) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(haystack.length, at + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  const slice = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const snippet = `${prefix}${slice}${suffix}`;
  const hi = snippet.toLowerCase().indexOf(n);
  if (hi < 0) {
    return { snippet, highlight: { start: prefix.length, end: prefix.length + needle.length } };
  }
  return { snippet, highlight: { start: hi, end: hi + needle.length } };
}

export async function searchChannelMessages(
  database: Database,
  actor: AgentActor,
  query: string,
  limit = 25,
): Promise<ChannelSearchHit[]> {
  const needle = query.trim();
  if (!needle || needle.length > 100) return [];
  const max = Math.min(Math.max(limit, 1), 50);
  const pattern = `%${needle.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const rows = await database.$client.unsafe<SearchRow[]>(
    `SELECT c.id AS channel_id, c.name, c.summary, m.thread_id, t.messages
     FROM channels c
     INNER JOIN channel_memberships cm ON cm.channel_id = c.id AND cm.user_id = $1
     INNER JOIN intelligence_channel_mappings m ON m.channel_id = c.id AND m.user_id = $1
     INNER JOIN openbot_local_threads t ON t.id = m.thread_id AND t.owner_user_id = $1
     WHERE c.deleted_at IS NULL
       AND t.messages::text ILIKE $2 ESCAPE '\\'
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
     LIMIT $3`,
    [actor.id, pattern, max * 3],
  );

  const hits: ChannelSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (hits.length >= max) break;
    let messages: StoredMessage[] = [];
    if (Array.isArray(row.messages)) messages = row.messages;
    else if (typeof row.messages === "string") {
      try {
        const parsed = JSON.parse(row.messages) as unknown;
        if (Array.isArray(parsed)) messages = parsed as StoredMessage[];
      } catch {
        messages = [];
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      const body = textOf(message.content);
      if (!body) continue;
      const searchable = body.startsWith("⟦chisabot:") ? body.replace(/^⟦[^⟧]*⟧\n?/, "") : body;
      const found = snippetAround(searchable, needle);
      if (!found) continue;
      const key = `${row.channel_id}:${message.id ?? i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        channelId: row.channel_id,
        threadId: row.thread_id,
        name: row.name,
        summary: row.summary,
        snippet: found.snippet,
        highlight: found.highlight,
        messageId: typeof message.id === "string" ? message.id : null,
        role: typeof message.role === "string" ? message.role : null,
      });
      break;
    }
  }
  return hits;
}
