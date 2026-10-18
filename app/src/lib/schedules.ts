import { queryOptions } from "@tanstack/react-query";
import type { ScheduleEvent, ScheduleView } from "../../../shared/schedules";
import { client } from "@/lib/client";

/** 定时任务 / 提醒（DESIGN.md §55，docs/schedules.md）。 */
export const scheduleKeys = { all: ["schedules"] as const };

export function schedulesQueryOptions() {
  return queryOptions({
    queryKey: scheduleKeys.all,
    queryFn: ({ signal }): Promise<ScheduleView[]> => client("/api/schedules", "schedules", { fallback: "无法加载定时任务", signal }),
    refetchOnWindowFocus: "always",
    // 有任务在跑时勤快一点，看得到「运行中 → 已完成」。
    refetchInterval: (query) => ((query.state.data ?? []).some((s) => s.running || s.lastStatus === "running") ? 3000 : 30_000),
  });
}

export function patchSchedule(id: string, body: { paused?: boolean; title?: string; instruction?: string }): Promise<ScheduleView> {
  return client(`/api/schedules/${encodeURIComponent(id)}`, "schedule", { method: "PATCH", body, fallback: "保存失败，请重试" });
}

export async function runScheduleNow(id: string) {
  await client(`/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST", fallback: "运行失败，请重试" });
}

export function skipScheduleNext(id: string): Promise<ScheduleView> {
  return client(`/api/schedules/${encodeURIComponent(id)}/skip`, "schedule", { method: "POST", fallback: "跳过失败，请重试" });
}

export async function deleteSchedule(id: string) {
  await client(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "删除失败，请重试" });
}

export async function scheduleEvents(after: string, signal?: AbortSignal): Promise<{ events: ScheduleEvent[]; now: string }> {
  const response = await client(`/api/schedules/events?after=${encodeURIComponent(after)}`, { fallback: "", ...(signal ? { signal } : {}) });
  return (await response.json()) as { events: ScheduleEvent[]; now: string };
}

/** 服务端一键清已删机器人下的全部定时（任意状态；从不 auto-resume）。 */
export async function purgeOrphanSchedules(): Promise<{ deleted: number }> {
  const deleted = await client<number>("/api/schedules/orphans", "deleted", {
    method: "DELETE",
    fallback: "清理失败，请重试",
  });
  return { deleted: typeof deleted === "number" ? deleted : 0 };
}
