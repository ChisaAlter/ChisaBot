import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * 后台任务（DESIGN.md §38.2；服务器 server/src/workers/service.ts）在界面上的数据：这个对话里委派过的
 * 任务、它们的状态 / 当前步骤 / 清单。有任务在跑时每 1.5 秒取一次，都结束了就停。
 */
export type WorkerStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type WorkerPlanStep = { text: string; status: "done" | "current" | "pending" | "blocked" };
export type WorkerView = {
  id: string;
  title: string;
  status: WorkerStatus;
  step: string | null;
  plan: WorkerPlanStep[];
  summary: string | null;
  error: string | null;
  resultMessageId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export const ACTIVE_WORKER: readonly WorkerStatus[] = ["queued", "running", "waiting"];
export const workerKeys = { thread: (threadId: string) => ["thread-workers", threadId] as const };

export function workersApi(threadId: string) {
  return `/api/conversations/threads/${encodeURIComponent(threadId)}/workers`;
}

export function useThreadWorkers(threadId: string | null | undefined) {
  return useQuery({
    queryKey: workerKeys.thread(threadId ?? ""),
    enabled: Boolean(threadId),
    queryFn: async (): Promise<WorkerView[]> => {
      const response = await fetch(workersApi(threadId!), { credentials: "include" });
      if (!response.ok) return [];
      return ((await response.json()) as { workers?: WorkerView[] }).workers ?? [];
    },
    refetchInterval: (query) => ((query.state.data ?? []).some((worker) => ACTIVE_WORKER.includes(worker.status)) ? 1500 : false),
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });
}

/** 停止 / 补充说明。完成后立刻刷新卡片。 */
export function useWorkerAction(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    async (workerId: string, action: "cancel" | "steer", text?: string) => {
      if (!threadId) throw new Error("no thread");
      const response = await fetch(workersApi(threadId), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId, action, ...(text ? { text } : {}) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "操作失败");
      }
      await queryClient.invalidateQueries({ queryKey: workerKeys.thread(threadId) });
    },
    [threadId, queryClient],
  );
}

export const WORKER_RESULT_MARKER = "⟦chisabot:worker-result:";

/** 「⟦chisabot:worker-result:<id>:<status>⟧\n后台任务「标题」已完成。\n\n结果…」拆开。 */
export function parseWorkerResult(text: string): { workerId: string; status: string; headline: string; body: string } | null {
  if (!text.startsWith(WORKER_RESULT_MARKER)) return null;
  const end = text.indexOf("⟧");
  if (end < 0) return null;
  const [workerId = "", status = ""] = text.slice(WORKER_RESULT_MARKER.length, end).split(":");
  const rest = text.slice(end + 1).replace(/^\n/, "");
  const [headline = "", ...lines] = rest.split("\n");
  // 旧结果里工人自己写进去的标记（服务器现在会剥掉）也不显示。
  const body = lines.join("\n").replace(/⟦chisabot:[^⟧\n]{0,200}⟧[ \t]*/gu, "").trim();
  return { workerId, status, headline: headline.trim(), body };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export const WORKER_STATUS_ZH: Record<WorkerStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待你",
  done: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
