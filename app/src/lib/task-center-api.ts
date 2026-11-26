import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { type ClientOptions, client, tryClient } from "@/lib/client";
import type {
  BoardCardCreateInput,
  BoardCardUpdateInput,
  BoardCheckboxInput,
  BoardDispatchInput,
  BoardDocWriteInput,
  BoardMoveInput,
  MarkdownBoardDocPayload,
  MarkdownBoardSnapshot,
  MarkdownBoardSummary,
  TaskScheduleInput,
} from "../../../shared/task-board";
import type {
  DecisionListPage,
  TaskCapability,
  TaskCenterDecision,
  TaskCenterEvent,
  TaskCenterSnapshot,
  TaskCenterSource,
  TaskCenterTask,
  TaskContext,
  TaskInput,
  TaskListFilter,
  TaskListPage,
  TaskSourceInput,
  TaskTrace,
} from "../../../shared/task-center";

export const taskCenterKeys = {
  all: ["task-center"] as const,
  snapshot: ["task-center", "snapshot"] as const,
  detail: (id: string) => ["task-center", "task", id] as const,
  trace: (id: string) => ["task-center", "trace", id] as const,
  roots: ["task-center", "roots"] as const,
  context: ["task-center", "context"] as const,
  capabilities: ["task-center", "capabilities"] as const,
  tasks: (filter: TaskListFilter) => ["task-center", "tasks", filter] as const,
  decisions: (status: "pending" | "resolved") =>
    ["task-center", "decisions", status] as const,
  boards: ["task-center", "boards"] as const,
  boardView: (boardId: string) =>
    ["task-center", "board-view", boardId] as const,
  boardDoc: (boardId: string, relFile: string) =>
    ["task-center", "board-doc", boardId, relFile] as const,
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
  tasks: (filter: TaskListFilter, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter))
      if (value !== undefined && value !== "") params.set(key, String(value));
    return request<TaskListPage>(`/tasks?${params}`, { signal });
  },
  decisions: (
    status: "pending" | "resolved",
    offset: number,
    signal?: AbortSignal,
  ) =>
    request<DecisionListPage>(
      `/outbox?status=${status}&offset=${offset}&limit=50`,
      { signal },
    ),
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
  /**
   * 同步任务调度优先级（置顶 / 上下移时调用）。
   * 走 tryClient 静默容错，避免离线或仅测前端视图时阻断本地卡片排序。
   */
  syncTaskPriority: async (id: string, priority: number): Promise<void> => {
    try {
      await tryClient(`${endpoint}/tasks/${encodeURIComponent(id)}/priority`, {
        method: "POST",
        body: { priority: Math.max(0, Math.min(100, Math.round(priority))) },
      });
    } catch {
      // 忽略网络或测试桩未挂 priority 路由的情况；前端视图顺序仍立即生效。
    }
  },
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
  scanSource: async (id: string) => {
    const result = await request<{ source: TaskCenterSource }>(
      `/sources/${encodeURIComponent(id)}/scan`,
      {
        method: "POST",
        timeoutMs: 120_000,
      },
    );
    if (result.source.lastStatus !== "succeeded")
      throw new Error(
        result.source.lastError ||
          (result.source.lastStatus === "running"
            ? "巡检仍在执行，请查看来源状态。"
            : "巡检尚未完成，请稍后查看来源状态。"),
      );
    return result;
  },
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
  taskTrace: (id: string, signal?: AbortSignal) =>
    request<TaskTrace>(`/tasks/${encodeURIComponent(id)}/trace`, { signal }),
  listRoots: (signal?: AbortSignal) =>
    request<{ roots: string[] }>("/roots", { signal }),
  addRoot: (path: string) =>
    request<{ roots: string[] }>("/roots", {
      method: "PUT",
      body: { path },
    }),
  removeRoot: (path: string) =>
    request<{ roots: string[] }>("/roots", {
      method: "DELETE",
      body: { path },
    }),
  scheduleTask: (id: string, body: TaskScheduleInput) =>
    request<{ task: TaskCenterTask }>(
      `/tasks/${encodeURIComponent(id)}/schedule`,
      { method: "POST", body },
    ),
  listBoards: (signal?: AbortSignal) =>
    request<{
      boards: MarkdownBoardSummary[];
      availableRoots: Array<{ path: string; label: string; hasBoard: boolean }>;
    }>("/boards", { signal }),
  initBoard: (rootPath: string) =>
    request<{ board: MarkdownBoardSummary }>("/boards/init", {
      method: "POST",
      body: { rootPath },
    }),
  boardView: (boardId: string, signal?: AbortSignal) =>
    request<{ board: MarkdownBoardSnapshot }>(
      `/boards/view?boardId=${encodeURIComponent(boardId)}`,
      { signal },
    ),
  moveBoardCard: (body: BoardMoveInput) =>
    request<{ board: MarkdownBoardSnapshot }>("/boards/move", {
      method: "POST",
      body,
    }),
  updateBoardCard: (body: BoardCardUpdateInput) =>
    request<{ board: MarkdownBoardSnapshot }>("/boards/card", {
      method: "POST",
      body,
    }),
  createBoardCard: (body: BoardCardCreateInput) =>
    request<{ board: MarkdownBoardSnapshot; cardId: string }>("/boards/new", {
      method: "POST",
      body,
    }),
  toggleBoardCheckbox: (body: BoardCheckboxInput) =>
    request<{ board: MarkdownBoardSnapshot }>("/boards/checkbox", {
      method: "POST",
      body,
    }),
  readBoardDoc: (boardId: string, relFile: string, signal?: AbortSignal) =>
    request<{ doc: MarkdownBoardDocPayload }>(
      `/boards/doc?boardId=${encodeURIComponent(boardId)}&relFile=${encodeURIComponent(relFile)}`,
      { signal },
    ),
  writeBoardDoc: (body: BoardDocWriteInput) =>
    request<{ doc: MarkdownBoardDocPayload }>("/boards/doc", {
      method: "POST",
      body,
    }),
  dispatchBoardCard: (body: BoardDispatchInput) =>
    request<{ task: TaskCenterTask; board: MarkdownBoardSnapshot }>(
      "/boards/dispatch",
      {
        method: "POST",
        body,
      },
    ),
};

export function taskListOptions(filter: TaskListFilter, enabled = true) {
  return infiniteQueryOptions({
    queryKey: taskCenterKeys.tasks(filter),
    queryFn: ({ signal, pageParam }) =>
      taskCenterApi.tasks({ ...filter, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}
export function decisionListOptions(
  status: "pending" | "resolved",
  enabled = true,
) {
  return infiniteQueryOptions({
    queryKey: taskCenterKeys.decisions(status),
    queryFn: ({ signal, pageParam }) =>
      taskCenterApi.decisions(status, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export const TASK_CENTER_ACTIVE_POLL_MS = 5_000;
export const TASK_CENTER_IDLE_POLL_MS = 60_000;

const ACTIVE_SNAPSHOT_STATUSES = [
  "queued",
  "planning",
  "running",
  "waiting_dependencies",
  "waiting_approval",
  "paused",
] as const;

export function hasActiveTaskCenterWork(
  snapshot: TaskCenterSnapshot | undefined,
): boolean {
  if (!snapshot) return false;
  if ((snapshot.decisionCounts?.pending ?? 0) > 0) return true;
  if (
    Array.isArray(snapshot.outbox) &&
    snapshot.outbox.some((decision) => decision.status === "pending")
  ) {
    return true;
  }
  if (snapshot.counts) {
    for (const status of ACTIVE_SNAPSHOT_STATUSES) {
      if ((snapshot.counts[status] ?? 0) > 0) return true;
    }
  }
  if (
    Array.isArray(snapshot.tasks) &&
    snapshot.tasks.some((task) =>
      (ACTIVE_SNAPSHOT_STATUSES as readonly string[]).includes(task.status),
    )
  ) {
    return true;
  }
  return false;
}

export function taskCenterSnapshotOptions(options?: { poll?: boolean }) {
  const poll = options?.poll ?? true;
  return queryOptions({
    queryKey: taskCenterKeys.snapshot,
    queryFn: ({ signal }) => taskCenterApi.snapshot(signal),
    refetchInterval: poll
      ? (query) =>
          hasActiveTaskCenterWork(query.state.data)
            ? TASK_CENTER_ACTIVE_POLL_MS
            : TASK_CENTER_IDLE_POLL_MS
      : false,
    refetchIntervalInBackground: false,
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
    refetchIntervalInBackground: false,
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
export function taskTraceOptions(id: string) {
  return queryOptions({
    queryKey: taskCenterKeys.trace(id),
    queryFn: ({ signal }) => taskCenterApi.taskTrace(id, signal),
    enabled: Boolean(id),
  });
}
export function taskCenterRootsOptions() {
  return queryOptions({
    queryKey: taskCenterKeys.roots,
    queryFn: ({ signal }) => taskCenterApi.listRoots(signal),
  });
}

export function taskCenterBoardsOptions() {
  return queryOptions({
    queryKey: taskCenterKeys.boards,
    queryFn: ({ signal }) => taskCenterApi.listBoards(signal),
  });
}

export function taskCenterBoardViewOptions(boardId: string) {
  return queryOptions({
    queryKey: taskCenterKeys.boardView(boardId),
    queryFn: ({ signal }) => taskCenterApi.boardView(boardId, signal),
    enabled: Boolean(boardId),
    refetchInterval: 4_000,
    refetchIntervalInBackground: false,
  });
}

export function taskCenterBoardDocOptions(boardId: string, relFile: string) {
  return queryOptions({
    queryKey: taskCenterKeys.boardDoc(boardId, relFile),
    queryFn: ({ signal }) =>
      taskCenterApi.readBoardDoc(boardId, relFile, signal),
    enabled: Boolean(boardId && relFile),
    refetchInterval: 6_000,
    refetchIntervalInBackground: false,
  });
}
