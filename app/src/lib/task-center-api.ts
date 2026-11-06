import { queryOptions } from "@tanstack/react-query";
import { type ClientOptions, client } from "@/lib/client";
import type {
  TaskCapability,
  TaskCenterDecision,
  TaskCenterEvent,
  TaskCenterSnapshot,
  TaskCenterSource,
  TaskCenterTask,
  TaskContext,
  TaskInput,
  TaskSourceInput,
} from "../../../shared/task-center";

export const taskCenterKeys = {
  all: ["task-center"] as const,
  snapshot: ["task-center", "snapshot"] as const,
  detail: (id: string) => ["task-center", "task", id] as const,
  context: ["task-center", "context"] as const,
  capabilities: ["task-center", "capabilities"] as const,
};

export type TaskDetail = {
  task: TaskCenterTask;
  events: TaskCenterEvent[];
  children: TaskCenterTask[];
};
export type TaskControl = "start" | "pause" | "resume" | "retry" | "cancel";
const endpoint = "/api/task-center";
async function request<T>(
  path: string,
  options: ClientOptions = {},
): Promise<T> {
  const response = await client(`${endpoint}${path}`, {
    fallback: "任务中心暂时无法连接，请重试。",
    ...options,
  });
  return response.json();
}

export const taskCenterApi = {
  snapshot: (signal?: AbortSignal) =>
    request<TaskCenterSnapshot>("", { signal }),
  detail: (id: string, signal?: AbortSignal) =>
    request<TaskDetail>(`/tasks/${encodeURIComponent(id)}`, { signal }),
  createTask: (input: TaskInput) =>
    request<{ task: TaskCenterTask }>("/tasks", {
      method: "POST",
      body: input,
    }),
  controlTask: (id: string, action: TaskControl) =>
    request<{ task: TaskCenterTask }>(
      `/tasks/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
    ),
  decide: (id: string, approved: boolean) =>
    request<{ decision: TaskCenterDecision }>(
      `/outbox/${encodeURIComponent(id)}/decide`,
      { method: "POST", body: { approved } },
    ),
  createSource: (input: TaskSourceInput) =>
    request<{ source: TaskCenterSource }>("/sources", {
      method: "POST",
      body: input,
    }),
  updateSource: (id: string, input: Partial<TaskSourceInput>) =>
    request<{ source: TaskCenterSource }>(
      `/sources/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input },
    ),
  scanSource: (id: string) =>
    request<unknown>(`/sources/${encodeURIComponent(id)}/scan`, {
      method: "POST",
      timeoutMs: 120_000,
    }),
  getContext: (signal?: AbortSignal) =>
    request<{ context: TaskContext }>("/context", { signal }),
  setContext: (
    input: Omit<TaskContext, "updatedAt" | "learned" | "learnedAt">,
  ) =>
    request<{ context: TaskContext }>("/context", {
      method: "PUT",
      body: input,
    }),
  capabilities: (signal?: AbortSignal) =>
    request<{ capabilities: TaskCapability[] }>("/capabilities", { signal }),
};

export function taskCenterSnapshotOptions() {
  return queryOptions({
    queryKey: taskCenterKeys.snapshot,
    queryFn: ({ signal }) => taskCenterApi.snapshot(signal),
    refetchInterval: 5_000,
  });
}
export function taskCenterDetailOptions(id: string) {
  return queryOptions({
    queryKey: taskCenterKeys.detail(id),
    queryFn: ({ signal }) => taskCenterApi.detail(id, signal),
    refetchInterval: (query) =>
      ["succeeded", "failed", "cancelled"].includes(
        query.state.data?.task.status ?? "",
      )
        ? false
        : 3_000,
    enabled: Boolean(id),
  });
}
export function taskCenterCapabilityOptions() {
  return queryOptions({
    queryKey: taskCenterKeys.capabilities,
    queryFn: ({ signal }) => taskCenterApi.capabilities(signal),
    staleTime: 30_000,
  });
}
