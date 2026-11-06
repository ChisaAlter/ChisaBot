import {
  IconArrowUpRight,
  IconCheck,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ACTIVE_STATUSES,
  RISK_LABELS,
  STATUS_LABELS,
  taskDate,
} from "@/components/task-center/labels";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  taskCenterApi,
  taskCenterKeys,
  taskCenterSnapshotOptions,
} from "@/lib/task-center-api";
import { cn } from "@/lib/utils";
import {
  workflowKeys,
  workflowLibraryQueryOptions,
  workflowsApi,
} from "@/lib/workflows";
import type {
  TaskCenterDecision,
  TaskCenterTask,
} from "../../../../shared/task-center";
import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS_LABEL,
  type WorkflowRunView,
} from "../../../../shared/workflows";

/**
 * 供右栏顶部「任务」选项卡读取角标状态（是否有待确认审批、是否有进行中任务/工作流）。
 */
export function useRailTasksSummary() {
  const snapshot = useQuery(taskCenterSnapshotOptions());
  const workflows = useQuery(workflowLibraryQueryOptions());
  const data = snapshot.data;

  const pendingDecisions =
    data?.outbox.filter((decision) => decision.status === "pending") ?? [];
  const activeTasks =
    data?.tasks.filter(
      (task) =>
        ACTIVE_STATUSES.includes(task.status) ||
        task.status === "paused" ||
        task.status === "waiting_approval",
    ) ?? [];
  const activeRuns =
    workflows.data?.runs.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status),
    ) ?? [];
  const waitingApprovalRuns = activeRuns.filter(
    (run) => run.status === "waiting_approval",
  );

  return {
    snapshot,
    workflows,
    pendingDecisions,
    activeTasks,
    activeRuns,
    approvalCount: pendingDecisions.length + waitingApprovalRuns.length,
    activeCount: activeTasks.length + activeRuns.length,
  };
}

/**
 * 右栏「任务」选项卡内容：集中展示待确认审批、进行中的任务与工作流步骤进度、近期交付记录。
 */
export function TasksRailCard() {
  const {
    snapshot,
    workflows,
    pendingDecisions,
    activeTasks,
    activeRuns,
    approvalCount,
    activeCount,
  } = useRailTasksSummary();

  const data = snapshot.data;
  const recentTasks =
    data?.tasks
      .filter((task) =>
        ["succeeded", "failed", "cancelled"].includes(task.status),
      )
      .slice(0, 5) ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="tasks-rail-card">
      <div className="glass-card live-panel flex flex-col gap-3">
        <header className="live-panel-head flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="live-panel-title font-medium text-[13px]">
              {"任务与工作流进度"}
            </span>
            {approvalCount > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {`${approvalCount} 待确认`}
              </span>
            ) : activeCount > 0 ? (
              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                {`${activeCount} 进行中`}
              </span>
            ) : null}
          </div>
          <Link
            className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            search={{ view: approvalCount > 0 ? "outbox" : "active" }}
            to="/tasks"
          >
            {"任务中心"}
            <IconArrowUpRight className="size-3" />
          </Link>
        </header>

        <TasksRailBody
          activeRuns={activeRuns}
          activeTasks={activeTasks}
          inboxCount={data?.counts.inbox ?? 0}
          isError={snapshot.isError}
          isPending={snapshot.isPending && workflows.isPending}
          pendingDecisions={pendingDecisions}
          recentTasks={recentTasks}
        />
      </div>
    </div>
  );
}

function TasksRailBody({
  isPending,
  isError,
  pendingDecisions,
  activeTasks,
  activeRuns,
  recentTasks,
  inboxCount,
}: {
  isPending: boolean;
  isError: boolean;
  pendingDecisions: TaskCenterDecision[];
  activeTasks: TaskCenterTask[];
  activeRuns: WorkflowRunView[];
  recentTasks: TaskCenterTask[];
  inboxCount: number;
}) {
  const queryClient = useQueryClient();
  const refreshTasks = () => {
    void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
  };
  const refreshWorkflows = () => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.all });
  };

  if (isPending) return null;
  if (isError && activeRuns.length === 0) {
    return (
      <p className="live-panel-error" role="alert">
        {"暂时无法加载任务进度。"}
      </p>
    );
  }

  const hasActiveOrPending =
    pendingDecisions.length > 0 ||
    activeTasks.length > 0 ||
    activeRuns.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      {!hasActiveOrPending ? (
        <p className="live-panel-note">
          {inboxCount > 0
            ? `当前没有运行中的任务，Inbox 有 ${inboxCount} 项待安排。`
            : "当前没有运行中的任务或工作流。"}
        </p>
      ) : (
        <>
          {pendingDecisions.map((decision) => (
            <RailDecisionItem
              decision={decision}
              key={decision.id}
              onChanged={refreshTasks}
            />
          ))}
          {activeRuns.map((run) => (
            <RailWorkflowRunItem
              key={run.id}
              onChanged={refreshWorkflows}
              run={run}
            />
          ))}
          {activeTasks.map((task) => (
            <RailTaskItem key={task.id} onChanged={refreshTasks} task={task} />
          ))}
        </>
      )}

      {recentTasks.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {"最近交付"}
          </span>
          <ul className="flex flex-col gap-1.5">
            {recentTasks.map((task) => (
              <li
                className="flex items-center justify-between gap-2 text-[12px]"
                key={task.id}
              >
                <Link
                  className="min-w-0 flex-1 truncate text-foreground/80 hover:text-foreground hover:underline"
                  search={{ view: "history", task: task.id }}
                  to="/tasks"
                >
                  {task.title}
                </Link>
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    task.status === "succeeded"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : task.status === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {STATUS_LABELS[task.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RailDecisionItem({
  decision,
  onChanged,
}: {
  decision: TaskCenterDecision;
  onChanged: () => void;
}) {
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      taskCenterApi.decide(decision.id, approved),
    onSuccess: onChanged,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "操作失败"),
  });

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {`待确认 · ${RISK_LABELS[decision.proposedAction.risk]}`}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {taskDate(decision.createdAt)}
        </span>
      </div>
      <Link
        className="text-[12.5px] font-medium text-foreground hover:underline"
        search={{ view: "outbox", task: decision.taskId }}
        to="/tasks"
      >
        {decision.proposedAction.title}
      </Link>
      <p className="line-clamp-2 text-[11.5px] text-muted-foreground">
        {decision.summary}
      </p>
      <div className="flex items-center gap-1.5 pt-0.5">
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate(true)}
          size="xs"
        >
          <IconCheck className="size-3.5" />
          {"批准"}
        </Button>
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate(false)}
          size="xs"
          variant="outline"
        >
          <IconX className="size-3.5" />
          {"拒绝"}
        </Button>
      </div>
    </div>
  );
}

function RailWorkflowRunItem({
  run,
  onChanged,
}: {
  run: WorkflowRunView;
  onChanged: () => void;
}) {
  const totalSteps = run.steps.length;
  const doneSteps = run.steps.filter(
    (s) => s.status === "succeeded" || s.status === "skipped",
  ).length;
  const activeStep = run.steps.find(
    (s) => s.status === "running" || s.status === "waiting_approval",
  );
  const percent =
    totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

  const approve = useMutation({
    mutationFn: ({
      stepId,
      decision,
    }: {
      stepId: string;
      decision: "approve" | "reject";
    }) => workflowsApi.approve(run.id, stepId, decision),
    onSuccess: onChanged,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "审批操作失败"),
  });

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <Link
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground hover:underline"
          params={{ runId: run.id }}
          to="/workflows/runs/$runId"
        >
          {`${run.icon ? `${run.icon} ` : ""}${run.workflowName}`}
        </Link>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
            run.status === "waiting_approval"
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
          )}
        >
          {RUN_STATUS_LABEL[run.status]}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span className="truncate">
          {activeStep ? `当前：${activeStep.name}` : "准备执行步骤…"}
        </span>
        <span className="shrink-0 tabular-nums">
          {`${doneSteps}/${totalSteps} 步`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            run.status === "waiting_approval" ? "bg-amber-500" : "bg-sky-500",
          )}
          style={{ width: `${Math.max(8, percent)}%` }}
        />
      </div>
      {run.status === "waiting_approval" && activeStep ? (
        <div className="flex items-center gap-1.5 pt-1">
          <Button
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate({ stepId: activeStep.id, decision: "approve" })
            }
            size="xs"
          >
            <IconCheck className="size-3.5" />
            {"批准步骤"}
          </Button>
          <Button
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate({ stepId: activeStep.id, decision: "reject" })
            }
            size="xs"
            variant="outline"
          >
            <IconX className="size-3.5" />
            {"打回/拒绝"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RailTaskItem({
  task,
  onChanged,
}: {
  task: TaskCenterTask;
  onChanged: () => void;
}) {
  const control = useMutation({
    mutationFn: (action: "pause" | "resume") =>
      taskCenterApi.controlTask(task.id, action),
    onSuccess: onChanged,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "操作失败"),
  });

  const isRunning = task.status === "running" || task.status === "planning";
  const isPaused = task.status === "paused";

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <Link
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground hover:underline"
          search={{ view: "active", task: task.id }}
          to="/tasks"
        >
          {task.title}
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[11px] font-medium",
              task.status === "waiting_approval"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : isPaused
                  ? "bg-muted text-muted-foreground"
                  : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
            )}
          >
            {STATUS_LABELS[task.status]}
          </span>
          {isRunning || isPaused ? (
            <button
              aria-label={isPaused ? "继续任务" : "暂停任务"}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              disabled={control.isPending}
              onClick={() => control.mutate(isPaused ? "resume" : "pause")}
              title={isPaused ? "继续任务" : "暂停任务"}
              type="button"
            >
              {isPaused ? (
                <IconPlayerPlay className="size-3.5" />
              ) : (
                <IconPlayerPause className="size-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </div>
      <p className="line-clamp-2 text-[11.5px] text-muted-foreground">
        {task.error ?? task.summary ?? task.description}
      </p>
    </div>
  );
}
