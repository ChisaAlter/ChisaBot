import { queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SystemUpdateAction, SystemUpdateOverview } from "../../../shared/system-update";
import { client } from "@/lib/client";

/** 管理后台 → 系统更新（docs/online-update.md）。 */
export const systemUpdateKeys = { overview: ["system-update", "overview"] as const };

export async function loadSystemUpdate(signal?: AbortSignal): Promise<SystemUpdateOverview> {
  const response = await client("/api/admin/system-update", {
    fallback: "无法读取系统更新状态，请重试。",
    signal,
  });
  return response.json();
}

export function systemUpdateQueryOptions() {
  return queryOptions({
    queryKey: systemUpdateKeys.overview,
    queryFn: ({ signal }) => loadSystemUpdate(signal),
    staleTime: 2_000,
    // 有任务在跑时每 2 秒看一次进度，平时每 30 秒。
    refetchInterval: (query) => {
      const data = query.state.data;
      const active =
        !!data &&
        (data.pending.length > 0 ||
          data.externalBusy ||
          data.job?.status === "running" ||
          data.job?.status === "queued");
      return active ? 2_000 : 30_000;
    },
    refetchOnWindowFocus: "always",
  });
}

export async function requestSystemUpdate(
  action: SystemUpdateAction,
  expectCommit?: string,
  options?: { full?: boolean },
): Promise<{ id: string; overview: SystemUpdateOverview }> {
  const response = await client(`/api/admin/system-update/${action}`, {
    method: "POST",
    body:
      action === "update"
        ? { ...(expectCommit ? { expectCommit } : {}), ...(options?.full ? { mode: "full" } : {}) }
        : {},
    fallback: action === "update" ? "无法开始更新。" : action === "rollback" ? "无法开始回滚。" : "无法检查更新。",
  });
  return response.json();
}

export function shortSha(sha?: string) {
  return sha ? sha.slice(0, 7) : "—";
}

export function timeText(at?: string) {
  if (!at) return "—";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 「3 分 12 秒」。 */
export function durationText(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/** 进行中的任务每秒走一次的「已用 x 分 y 秒」（系统更新页、Magpie 更新段共用）。 */
export function useElapsed(startedAt: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return running && Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : undefined;
}
