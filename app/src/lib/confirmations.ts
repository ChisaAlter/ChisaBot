import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { continuationIsActive } from "@/lib/chat/continuation";
import { client } from "@/lib/client";
import type {
  ConfirmCategory,
  ConfirmMode,
  ConfirmPrefView,
  ConfirmRequestView,
  ConfirmRuleView,
} from "../../../shared/confirmations";

const confirmationIsUnsettled = (request: ConfirmRequestView) =>
  request.status === "pending" || continuationIsActive(request.continuation);

/** 确认卡片 + 审批偏好（DESIGN.md §58，docs/confirmations.md）。 */
export const confirmKeys = {
  all: ["confirmations"] as const,
  prefs: ["confirmations", "prefs"] as const,
  recent: ["confirmations", "recent"] as const,
  thread: (threadId: string) => ["confirmations", "thread", threadId] as const,
};

export function confirmPrefsQueryOptions() {
  return queryOptions({
    queryKey: confirmKeys.prefs,
    queryFn: async ({
      signal,
    }): Promise<{ prefs: ConfirmPrefView[]; rules: ConfirmRuleView[] }> => {
      const response = await client("/api/confirmations/prefs", {
        fallback: "无法加载审批偏好",
        signal,
      });
      return response.json();
    },
    refetchOnWindowFocus: "always",
  });
}

export function recentConfirmationsQueryOptions() {
  return queryOptions({
    queryKey: confirmKeys.recent,
    queryFn: ({ signal }): Promise<ConfirmRequestView[]> =>
      loadConfirmations({ limit: 20 }, signal),
    refetchInterval: (query) =>
      (query.state.data ?? []).some(confirmationIsUnsettled) ? 2000 : false,
    refetchOnWindowFocus: "always",
  });
}

type ConfirmationsPage = {
  requests: ConfirmRequestView[];
  nextCursor: string | null;
};

export function useConfirmationPage(view: "recent" | "actionable") {
  const cache = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = useQuery(
    confirmationPageQueryOptions({ view, cursor: cursors.at(-1) }),
  );
  const nextCursor = query.data?.nextCursor;
  return {
    query,
    pageNumber: cursors.length,
    previous:
      cursors.length > 1
        ? async () => {
            await cache.fetchQuery(
              confirmationPageQueryOptions({ view, cursor: cursors.at(-2) }),
            );
            setCursors((current) => current.slice(0, -1));
          }
        : undefined,
    next: nextCursor
      ? async () => {
          await cache.fetchQuery(
            confirmationPageQueryOptions({ view, cursor: nextCursor }),
          );
          setCursors((current) => [...current, nextCursor]);
        }
      : undefined,
  };
}

export function confirmationPageQueryOptions(options: {
  view: "recent" | "actionable";
  cursor?: string;
  limit?: number;
  threadId?: string;
}) {
  return queryOptions({
    queryKey: [...confirmKeys.all, "page", options] as const,
    queryFn: ({ signal }) => loadConfirmationPage(options, signal),
    refetchInterval: (query) =>
      query.state.data?.requests.some(confirmationIsUnsettled) ? 2000 : false,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

async function loadConfirmationPage(
  options: {
    view: "recent" | "actionable";
    cursor?: string;
    limit?: number;
    threadId?: string;
  },
  signal: AbortSignal,
): Promise<ConfirmationsPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.threadId) params.set("thread", options.threadId);
  if (options.view === "actionable") params.set("view", options.view);
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await client(`/api/confirmations/requests?${params}`, {
    fallback: "无法加载确认状态",
    signal,
  });
  return response.json();
}

/** Chat/account previews read two bounded pages; the inbox/history owns explicit pagination. */
async function loadConfirmations(
  options: { threadId?: string; limit: number },
  signal: AbortSignal,
): Promise<ConfirmRequestView[]> {
  const [recent, outstanding] = await Promise.all([
    loadConfirmationPage({ ...options, view: "recent" }, signal),
    loadConfirmationPage({ ...options, view: "actionable" }, signal),
  ]);
  const merged = new Map(
    [...recent.requests, ...outstanding.requests].map((request) => [
      request.id,
      request,
    ]),
  );
  return [...merged.values()].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}
/**
 * 一段对话里的确认卡片。有卡片在等、或有工具调用还没结果（卡片可能马上出现）时每 1.5 秒取一次；
 * 其余时候只在打开 / 回到窗口时取。所有设备读同一份，所以在手机上点了确认，电脑上的卡片也会跟着变。
 */
export function useThreadConfirmations(
  threadId: string | null | undefined,
  watching: boolean,
) {
  return useQuery({
    queryKey: confirmKeys.thread(threadId ?? ""),
    enabled: Boolean(threadId),
    queryFn: ({ signal }): Promise<ConfirmRequestView[]> =>
      loadConfirmations({ threadId: threadId!, limit: 100 }, signal),
    refetchInterval: (query) =>
      watching || (query.state.data ?? []).some(confirmationIsUnsettled)
        ? 1500
        : false,
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });
}

export function decideConfirmation(
  id: string,
  decision: "approve" | "deny",
): Promise<ConfirmRequestView> {
  return client(
    `/api/confirmations/requests/${encodeURIComponent(id)}`,
    "request",
    {
      method: "POST",
      body: { decision },
      fallback:
        decision === "approve" ? "确认失败，请重试" : "取消失败，请重试",
    },
  );
}

export function retryConfirmation(id: string): Promise<ConfirmRequestView> {
  return client(
    `/api/confirmations/requests/${encodeURIComponent(id)}/retry`,
    "request",
    {
      method: "POST",
      fallback: "继续处理未能提交，请重试",
    },
  );
}

export function setConfirmPref(
  category: ConfirmCategory,
  mode: ConfirmMode,
  note?: string | null,
): Promise<ConfirmPrefView> {
  return client(`/api/confirmations/prefs/${category}`, "pref", {
    method: "PUT",
    body: { mode, ...(note !== undefined ? { note } : {}) },
    fallback: "保存失败，请重试",
  });
}

export function addConfirmRule(input: {
  text: string;
  category: ConfirmCategory;
  mode: ConfirmMode;
  keywords?: string[];
}): Promise<ConfirmRuleView> {
  return client("/api/confirmations/rules", "rule", {
    method: "POST",
    body: input,
    fallback: "添加失败，请重试",
  });
}

export async function deleteConfirmRule(id: string) {
  await client(`/api/confirmations/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "删除失败，请重试",
  });
}
