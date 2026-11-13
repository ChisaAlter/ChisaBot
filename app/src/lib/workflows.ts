import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type {
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowRunView,
  WorkflowSummary,
} from "../../../shared/workflows";
import { ACTIVE_RUN_STATUSES } from "../../../shared/workflows";

/** 工作流（docs/workflows.md）。运行页在运行中每 1.5 秒刷新一次，跑完就停。 */

export const workflowKeys = {
  all: ["workflows"] as const,
  library: ["workflows", "library"] as const,
  detail: (id: string) => ["workflows", "detail", id] as const,
  run: (id: string) => ["workflows", "run", id] as const,
  runs: ["workflows", "runs"] as const,
};

export type WorkflowLibrary = {
  presets: WorkflowSummary[];
  mine: WorkflowSummary[];
  runs: WorkflowRunView[];
};

export function workflowLibraryQueryOptions() {
  return queryOptions({
    queryKey: workflowKeys.library,
    queryFn: ({ signal }): Promise<WorkflowLibrary> =>
      client("/api/workflows", { fallback: "无法加载工作流", signal }).then(
        (r) => r.json(),
      ),
    // 最近运行里有还在跑的，就跟着刷新。
    // 失败或还没有数据时也继续轮询：右栏同时拉任务和工作流，工作流失败后若停掉轮询，
    // 提示要等用户点「重试」才会消失。
    refetchInterval: (query) => {
      const failed =
        query.state.status === "error" ||
        (query.state.data === undefined && query.state.errorUpdateCount > 0);
      if (failed) return 5_000;
      return query.state.data?.runs.some((run) =>
        ACTIVE_RUN_STATUSES.includes(run.status),
      )
        ? 3_000
        : false;
    },
  });
}

export function workflowDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: workflowKeys.detail(id),
    queryFn: ({
      signal,
    }): Promise<{ workflow: WorkflowDetail; warnings: string[] }> =>
      client(`/api/workflows/${encodeURIComponent(id)}`, {
        fallback: "无法加载这个工作流",
        signal,
      }).then((r) => r.json()),
  });
}

export function workflowRunQueryOptions(id: string) {
  return queryOptions({
    queryKey: workflowKeys.run(id),
    queryFn: ({ signal }): Promise<WorkflowRunView> =>
      client(`/api/workflows/runs/${encodeURIComponent(id)}`, "run", {
        fallback: "无法加载这次运行",
        signal,
      }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return 3_000;
      return status === "running" || status === "queued"
        ? 1_500
        : status === "waiting_approval"
          ? 5_000
          : false;
    },
  });
}

/** 保存失败时服务器会给出一条条问题，带回来显示在编辑器里。 */
export class WorkflowSaveError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
    readonly status: number,
  ) {
    super(message);
  }
}

async function send<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await tryClient(path, { method, body });
  } catch {
    throw new WorkflowSaveError("无法连接到服务器，请重试。", [], 0);
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string; problems?: string[] })
    | null;
  if (!response.ok)
    throw new WorkflowSaveError(
      data?.error ?? "操作失败，请重试",
      data?.problems ?? [],
      response.status,
    );
  return data as T;
}

export const workflowsApi = {
  create: (definition: WorkflowDefinition) =>
    send<{ workflow: WorkflowDetail }>("/api/workflows", "POST", {
      definition,
    }),
  update: (id: string, definition: WorkflowDefinition) =>
    send<{ workflow: WorkflowDetail; warnings: string[] }>(
      `/api/workflows/${encodeURIComponent(id)}`,
      "PUT",
      { definition },
    ),
  remove: (id: string) =>
    send<{ ok: true }>(`/api/workflows/${encodeURIComponent(id)}`, "DELETE"),
  duplicate: (id: string) =>
    send<{ workflow: WorkflowDetail }>(
      `/api/workflows/${encodeURIComponent(id)}/duplicate`,
      "POST",
    ),
  import: (markdown: string) =>
    send<{ workflow: WorkflowDetail }>("/api/workflows/import", "POST", {
      markdown,
    }),
  validate: (input: { markdown: string } | { definition: unknown }) =>
    send<
      | {
          ok: true;
          definition: WorkflowDefinition;
          markdown: string;
          warnings: string[];
        }
      | { ok: false; error: string; problems?: string[] }
    >("/api/workflows/validate", "POST", input),
  run: (
    id: string,
    inputs: Record<string, unknown>,
    bindings: Record<string, string>,
  ) =>
    send<{ run: WorkflowRunView }>(
      `/api/workflows/${encodeURIComponent(id)}/runs`,
      "POST",
      { inputs, bindings },
    ),
  approve: (
    runId: string,
    stepId: string,
    decision: "approve" | "reject",
    comment?: string,
    options?: { rejectTo?: string; retryMode?: "targeted_fix" | "full_redo" },
  ) =>
    send<{ run: WorkflowRunView | null }>(
      `/api/workflows/runs/${encodeURIComponent(runId)}/approve`,
      "POST",
      {
        stepId,
        decision,
        ...(comment ? { comment } : {}),
        ...(options?.rejectTo ? { rejectTo: options.rejectTo } : {}),
        ...(options?.retryMode ? { retryMode: options.retryMode } : {}),
      },
    ),
  retry: (
    runId: string,
    options?: {
      stepId?: string;
      mode?: "targeted_fix" | "full_redo";
      comment?: string;
      bindings?: Record<string, string>;
    },
  ) =>
    send<{ run: WorkflowRunView | null }>(
      `/api/workflows/runs/${encodeURIComponent(runId)}/retry`,
      "POST",
      options ?? {},
    ),
  cancel: (runId: string) =>
    send<{ ok: true }>(
      `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`,
      "POST",
    ),
  removeRun: (runId: string) =>
    send<{ ok: true }>(
      `/api/workflows/runs/${encodeURIComponent(runId)}`,
      "DELETE",
    ),
};

/** 下载导出的 WORKFLOW.md（走浏览器下载，带登录 cookie）。 */
export async function downloadWorkflow(id: string, slug: string) {
  const response = await client(
    `/api/workflows/${encodeURIComponent(id)}/export`,
    { fallback: "导出失败" },
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.workflow.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

export function tokensText(n: number): string {
  return n >= 10_000
    ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
    : String(n);
}
