import { queryOptions, useQuery } from "@tanstack/react-query";
import { createContext, useMemo, useRef } from "react";
import { ACTIVE_STATUSES } from "@/components/task-center/labels";
import { client } from "@/lib/client";
import { taskCenterSnapshotOptions } from "@/lib/task-center-api";
import type { TaskStatus } from "../../../../shared/task-center";
import type {
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowSummary,
} from "../../../../shared/workflows";

/**
 * 控制右栏「任务」卡是否处于可见激活态：右栏折叠、切到别的页签或离开聊天页时为 false，
 * 暂停后台 3s/5s 轮询；独立挂载（单测或弹窗）默认 true，行为不变。
 */
export const RailTasksActiveContext = createContext(true);

const ACTIVE_TASK_COUNT_STATUSES: readonly TaskStatus[] = [
  "queued",
  "planning",
  "running",
  "waiting_dependencies",
  "waiting_approval",
  "paused",
];

const ACTIVE_WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "queued",
  "running",
  "waiting_approval",
];

type RailWorkflowLibrary = {
  presets: WorkflowSummary[];
  mine: WorkflowSummary[];
  runs: WorkflowRunView[];
};

function countActiveTasks(counts: Record<TaskStatus, number>): number {
  return ACTIVE_TASK_COUNT_STATUSES.reduce(
    (sum, status) => sum + (counts[status] ?? 0),
    0,
  );
}

/**
 * 与 `@/lib/workflows` 的 `workflowLibraryQueryOptions` 共享同一个 queryKey（`["workflows", "library"]`）与轮询节奏，
 * 但仅用 `import type` 引用 `shared/workflows`，避免右栏外壳把完整 Zod 运行时拉入 `shell` 块。
 */
function railWorkflowLibraryOptions(poll: boolean) {
  return queryOptions({
    queryKey: ["workflows", "library"] as const,
    queryFn: ({ signal }): Promise<RailWorkflowLibrary> =>
      client("/api/workflows", { fallback: "无法加载工作流", signal }).then(
        (r) => r.json(),
      ),
    refetchInterval: (query) => {
      if (!poll) return false;
      const failed =
        query.state.status === "error" ||
        (query.state.data === undefined && query.state.errorUpdateCount > 0);
      if (failed) return 5_000;
      return query.state.data?.runs.some((run) =>
        ACTIVE_WORKFLOW_RUN_STATUSES.includes(run.status),
      )
        ? 3_000
        : false;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * 供右栏顶部「任务」选项卡读取角标状态（是否有待确认审批、是否有进行中任务/工作流）。
 * 独立拆出轻量 hook，避免右栏外壳为了角标而静态拉入整份 `TasksRailCard`（含 43 KB 样式表）或 Zod 运行时。
 */
export function useRailTasksSummary(active = true) {
  const snapshot = useQuery(taskCenterSnapshotOptions({ poll: active }));
  const workflows = useQuery(railWorkflowLibraryOptions(active));
  const data = snapshot.data;
  const workflowData = workflows.data;

  const derived = useMemo(() => {
    const outbox = Array.isArray(data?.outbox) ? data.outbox : [];
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const runs = Array.isArray(workflowData?.runs) ? workflowData.runs : [];

    const pendingDecisions = outbox.filter(
      (decision) => decision.status === "pending",
    );
    const activeTasks = tasks.filter(
      (task) =>
        ACTIVE_STATUSES.includes(task.status) ||
        task.status === "paused" ||
        task.status === "waiting_approval",
    );
    const activeRuns = runs.filter((run) =>
      ACTIVE_WORKFLOW_RUN_STATUSES.includes(run.status),
    );
    const waitingApprovalRuns = activeRuns.filter(
      (run) => run.status === "waiting_approval",
    );

    return {
      pendingDecisions,
      activeTasks,
      activeRuns,
      approvalCount:
        (data?.decisionCounts?.pending ?? pendingDecisions.length) +
        waitingApprovalRuns.length,
      activeCount:
        (data?.counts ? countActiveTasks(data.counts) : 0) + activeRuns.length,
    };
  }, [data, workflowData]);

  const cacheRef = useRef<{
    key: string;
    derived: typeof derived;
    value: {
      snapshot: typeof snapshot;
      workflows: typeof workflows;
      pendingDecisions: typeof derived.pendingDecisions;
      activeTasks: typeof derived.activeTasks;
      activeRuns: typeof derived.activeRuns;
      approvalCount: number;
      activeCount: number;
    };
  } | null>(null);

  const key = `${snapshot.status}:${snapshot.fetchStatus}:${snapshot.dataUpdatedAt}:${snapshot.errorUpdatedAt}:${workflows.status}:${workflows.fetchStatus}:${workflows.dataUpdatedAt}:${workflows.errorUpdatedAt}`;
  if (
    !cacheRef.current ||
    cacheRef.current.key !== key ||
    cacheRef.current.derived !== derived
  ) {
    cacheRef.current = {
      key,
      derived,
      value: {
        snapshot,
        workflows,
        ...derived,
      },
    };
  }
  return cacheRef.current.value;
}
