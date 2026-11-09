import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { tryClient } from "@/lib/client";

/**
 * 输入框「上下文」读数（DESIGN.md §25），来自服务器：
 * `GET /api/conversations/threads/:id/context` 读这条对话最近一次带用量的 RUN_FINISHED。
 *
 * - measured：最后一次模型调用的实测输入 + 输出（服务器在每一步上计量，server/src/context-usage.ts）；
 * - run-total：旧事件只有整次运行的累加用量，有工具调用时偏大 → 显示「约」；
 * - estimate：提供方没给用量，按消息文字粗估（不含系统提示与工具定义）→ 显示「约」。
 */
export type ThreadContextReading = {
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  source: "measured" | "run-total" | "estimate";
  at?: string;
};

/** null = 这条对话还没有内容；undefined = 还在读 / 读不到。 */
export type ThreadContextState = {
  reading: ThreadContextReading | null;
  available: boolean;
};

export const threadContextKeys = {
  thread: (agentId: string, threadId: string) =>
    ["thread-context", agentId, threadId] as const,
};

async function loadThreadContext(
  agentId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadContextState> {
  const response = await tryClient(
    `/api/conversations/threads/${encodeURIComponent(threadId)}/context?agentId=${encodeURIComponent(agentId)}`,
    { signal },
  );
  // 新对话在第一条消息之前服务器里还没有这条线程：就是「空」，不是错误。
  if (response.status === 404) return { reading: null, available: true };
  if (!response.ok) return { reading: null, available: false };
  const body = (await response.json().catch(() => null)) as {
    context?: ThreadContextReading | null;
  } | null;
  if (!body || !("context" in body)) return { reading: null, available: false };
  const reading = body.context;
  if (
    reading &&
    (typeof reading.tokens !== "number" || !Number.isFinite(reading.tokens))
  )
    return { reading: null, available: false };
  return { reading: reading ?? null, available: true };
}

/**
 * 读一条对话的上下文占用；机器人这一轮答完（running 从 true 变 false）后重新读一次。
 * 不轮询：读数只在一轮结束时变。
 */
export function useThreadContext(
  agentId: string,
  threadId: string | undefined,
  running: boolean,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: threadContextKeys.thread(agentId, threadId ?? ""),
    queryFn: ({ signal }) => loadThreadContext(agentId, threadId ?? "", signal),
    enabled: Boolean(agentId && threadId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const wasRunning = useRef(running);
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (!finished || !threadId) return;
    // RUN_FINISHED 先落库再发给浏览器；稍等一下再读，避开同一时刻的快照写入。
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({
        queryKey: threadContextKeys.thread(agentId, threadId),
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [running, agentId, threadId, queryClient]);
  return query;
}

/** 12345 → 12.3k；262144 → 256k；1048576 → 1M；200000 → 200k。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  const trim = (text: string) =>
    text.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
  // 上下文窗口常按 2 的幂给（256k、1M = 1048576）：整除 1024 时按 1024 进位，和厂商写法一致。
  if (value % 1024 === 0) {
    const k = value / 1024;
    if (k >= 1024 && k % 1024 === 0) return `${k / 1024}M`;
    if (k < 1024) return `${k}k`;
  }
  if (value < 1_000_000)
    return `${trim((value / 1000).toFixed(value < 10_000 ? 1 : value < 100_000 ? 1 : 0))}k`;
  return `${trim((value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1))}M`;
}

/** 0–1 的占用比例对应的提示等级：≥70% 琥珀，≥90% 红。 */
export function contextLevel(ratio: number): "ok" | "warn" | "full" {
  if (ratio >= 0.9) return "full";
  if (ratio >= 0.7) return "warn";
  return "ok";
}
