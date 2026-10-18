/**
 * 会话正文搜索（FIX-03）：Ctrl+K 除了标题 / 摘要 / 最后一条，还搜消息正文。
 */
import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/client";

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

export const channelSearchKeys = {
  all: ["channels", "search"] as const,
  query: (q: string) => ["channels", "search", q] as const,
};

export async function searchChannelMessages(query: string): Promise<ChannelSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const response = await client(`/api/channels/search?q=${encodeURIComponent(q)}`, {
    fallback: "搜索失败",
  });
  const body = (await response.json()) as { hits?: ChannelSearchHit[] };
  return body.hits ?? [];
}

export function useChannelMessageSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: channelSearchKeys.query(q),
    queryFn: () => searchChannelMessages(q),
    enabled: q.length > 0,
    staleTime: 15_000,
  });
}

/** 把 snippet 按 highlight 拆成三段，中间那段画高亮。 */
export function highlightParts(
  snippet: string,
  highlight: { start: number; end: number } | undefined,
): { before: string; match: string; after: string } {
  if (!highlight || highlight.start < 0 || highlight.end <= highlight.start) {
    return { before: snippet, match: "", after: "" };
  }
  const start = Math.max(0, Math.min(snippet.length, highlight.start));
  const end = Math.max(start, Math.min(snippet.length, highlight.end));
  return {
    before: snippet.slice(0, start),
    match: snippet.slice(start, end),
    after: snippet.slice(end),
  };
}
