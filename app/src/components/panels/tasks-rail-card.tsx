import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconGitBranch,
  IconPaperclip,
  IconPlayerPause,
  IconPlayerPlay,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  ACTIVE_STATUSES,
  CATEGORY_LABELS,
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
import "./tasks-rail-card.css";

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
  } = useRailTasksSummary();

  const data = snapshot.data;
  const recentTasks =
    data?.tasks
      .filter((task) =>
        ["succeeded", "failed", "cancelled"].includes(task.status),
      )
      .slice(0, 5) ?? [];

  return (
    <div className="task-rail" data-testid="tasks-rail-card">
      <header className="task-rail-header">
        <h2>{"任务进度"}</h2>
        <Link
          className="task-rail-center-link"
          search={{ view: approvalCount > 0 ? "outbox" : "active" }}
          to="/tasks"
        >
          {"任务中心"}
        </Link>
      </header>
      <TasksRailBody
        activeRuns={activeRuns}
        activeTasks={activeTasks}
        inboxCount={data?.counts.inbox ?? 0}
        snapshot={snapshot}
        workflows={workflows}
        pendingDecisions={pendingDecisions}
        recentTasks={recentTasks}
      />
    </div>
  );
}

function TasksRailBody({
  snapshot,
  workflows,
  pendingDecisions,
  activeTasks,
  activeRuns,
  recentTasks,
  inboxCount,
}: {
  snapshot: ReturnType<typeof useRailTasksSummary>["snapshot"];
  workflows: ReturnType<typeof useRailTasksSummary>["workflows"];
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

  const hasActiveOrPending =
    pendingDecisions.length > 0 ||
    activeTasks.length > 0 ||
    activeRuns.length > 0;

  return (
    <div className="task-rail-sections">
      {snapshot.isError || workflows.isError ? (
        <div className="task-rail-notice" role="alert">
          <p>
            {snapshot.isError && workflows.isError
              ? "任务和工作流暂时无法刷新。"
              : snapshot.isError
                ? "任务暂时无法刷新。"
                : "工作流暂时无法刷新。"}
          </p>
          <Button
            loading={snapshot.isFetching || workflows.isFetching}
            onClick={() => {
              if (snapshot.isError) void snapshot.refetch();
              if (workflows.isError) void workflows.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {"重试"}
          </Button>
        </div>
      ) : null}
      {snapshot.isPending || workflows.isPending ? (
        <div
          aria-label="正在加载任务进度"
          className="task-rail-loading"
          role="status"
        >
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {pendingDecisions.length > 0 ? (
        <RailSection
          title="需要你确认"
          count={`${pendingDecisions.length} 待确认`}
        >
          {pendingDecisions.map((decision) => (
            <RailDecisionItem
              decision={decision}
              key={decision.id}
              onChanged={refreshTasks}
            />
          ))}
        </RailSection>
      ) : null}
      {activeRuns.length > 0 || activeTasks.length > 0 ? (
        <RailSection
          title="任务与工作流"
          count={`${activeRuns.length + activeTasks.length} 项`}
        >
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
        </RailSection>
      ) : null}

      {!hasActiveOrPending &&
      !snapshot.isPending &&
      !workflows.isPending &&
      !snapshot.isError &&
      !workflows.isError ? (
        <div className="task-rail-empty">
          <IconCircleCheck aria-hidden className="size-5" />
          <div>
            <p>{"当前没有待跟进的任务"}</p>
            {inboxCount > 0 ? (
              <Link to="/tasks" search={{ view: "inbox" }}>
                {`查看 ${inboxCount} 项待安排事项`}
              </Link>
            ) : (
              <span>{"可以在对话中交办，或前往任务中心新建。"}</span>
            )}
          </div>
        </div>
      ) : null}

      {recentTasks.length > 0 ? (
        <RailSection title="最近交付" count={`${recentTasks.length} 项`}>
          {recentTasks.map((task) => (
            <RailTaskItem
              key={task.id}
              onChanged={refreshTasks}
              task={task}
              recent
            />
          ))}
        </RailSection>
      ) : null}
    </div>
  );
}

function RailSection({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: ReactNode;
}) {
  return (
    <section className="task-rail-section" aria-label={title}>
      <div className="task-rail-section-head">
        <h3>{title}</h3>
        <span>{count}</span>
      </div>
      <div className="task-rail-cards">{children}</div>
    </section>
  );
}

type CardTone = "info" | "warning" | "success" | "danger" | "neutral";

function CardStatus({
  tone,
  children,
}: {
  tone: CardTone;
  children: ReactNode;
}) {
  const Icon =
    tone === "warning"
      ? IconAlertTriangle
      : tone === "success"
        ? IconCircleCheck
        : tone === "danger"
          ? IconCircleX
          : tone === "neutral"
            ? IconPlayerPause
            : IconCircleDashed;
  return (
    <span className="task-rail-status" data-tone={tone}>
      <Icon aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}

function CardMeta({ at, children }: { at: string; children?: ReactNode }) {
  return (
    <div className="task-rail-meta">
      <time dateTime={at}>{taskDate(at)}</time>
      {children}
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
    <article
      className="task-rail-item"
      data-kind="decision"
      data-tone="warning"
    >
      <Link
        className="task-rail-item-link"
        search={{ view: "outbox", task: decision.taskId }}
        to="/tasks"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            <IconShieldCheck aria-hidden className="size-3.5" />
            {RISK_LABELS[decision.proposedAction.risk]}
          </span>
          <CardStatus tone="warning">{"待确认"}</CardStatus>
        </div>
        <h4 className="task-rail-title">{decision.proposedAction.title}</h4>
        <p className="task-rail-description">{decision.summary}</p>
        <CardMeta at={decision.createdAt} />
      </Link>
      <div className="task-rail-actions">
        <Button
          disabled={decide.isPending}
          mutation={decide}
          mutationWhen={decide.variables === true}
          onClick={() => decide.mutate(true)}
          size="sm"
        >
          <IconCheck aria-hidden className="size-3.5" />
          {"批准"}
        </Button>
        <Button
          disabled={decide.isPending}
          mutation={decide}
          mutationWhen={decide.variables === false}
          onClick={() => decide.mutate(false)}
          size="sm"
          variant="outline"
        >
          <IconX aria-hidden className="size-3.5" />
          {"拒绝"}
        </Button>
      </div>
    </article>
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
  const tone = run.status === "waiting_approval" ? "warning" : "info";

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
    <article className="task-rail-item" data-kind="workflow" data-tone={tone}>
      <Link
        className="task-rail-item-link"
        params={{ runId: run.id }}
        to="/workflows/runs/$runId"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            <IconGitBranch aria-hidden className="size-3.5" />
            {"工作流"}
          </span>
          <CardStatus tone={tone}>{RUN_STATUS_LABEL[run.status]}</CardStatus>
        </div>
        <h4 className="task-rail-title">{`${run.icon ? `${run.icon} ` : ""}${run.workflowName}`}</h4>
        <p className="task-rail-description">
          {activeStep
            ? `当前：${activeStep.name}`
            : run.status === "queued"
              ? "等待工作流开始"
              : "准备执行步骤…"}
        </p>
        <div className="task-rail-progress-label">
          <span>{"步骤进度"}</span>
          <span>{`${doneSteps}/${totalSteps} 步`}</span>
        </div>
        <progress
          className="task-rail-progress"
          aria-label={`${run.workflowName}步骤进度`}
          max={100}
          value={percent}
        />
        <CardMeta at={run.startedAt ?? run.createdAt} />
      </Link>
      {run.status === "waiting_approval" && activeStep ? (
        <div className="task-rail-actions">
          <Button
            disabled={approve.isPending}
            mutation={approve}
            mutationWhen={approve.variables?.decision === "approve"}
            onClick={() =>
              approve.mutate({ stepId: activeStep.id, decision: "approve" })
            }
            size="sm"
          >
            <IconCheck aria-hidden className="size-3.5" />
            {"批准步骤"}
          </Button>
          <Button
            disabled={approve.isPending}
            mutation={approve}
            mutationWhen={approve.variables?.decision === "reject"}
            onClick={() =>
              approve.mutate({ stepId: activeStep.id, decision: "reject" })
            }
            size="sm"
            variant="outline"
          >
            <IconX aria-hidden className="size-3.5" />
            {"打回/拒绝"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function RailTaskItem({
  task,
  onChanged,
  recent = false,
}: {
  task: TaskCenterTask;
  onChanged: () => void;
  recent?: boolean;
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
  const tone: CardTone =
    task.status === "failed"
      ? "danger"
      : task.status === "succeeded"
        ? "success"
        : task.status === "waiting_approval" ||
            task.status === "waiting_dependencies" ||
            (task.error && !recent)
          ? "warning"
          : isPaused || task.status === "cancelled"
            ? "neutral"
            : "info";
  const description = task.error || task.summary || task.description;

  return (
    <article
      className="task-rail-item"
      data-kind={recent ? "recent" : "task"}
      data-tone={tone}
    >
      <Link
        className="task-rail-item-link"
        search={{ view: recent ? "history" : "active", task: task.id }}
        to="/tasks"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            {CATEGORY_LABELS[task.category]}
          </span>
          <CardStatus tone={tone}>{STATUS_LABELS[task.status]}</CardStatus>
        </div>
        <h4 className="task-rail-title">{task.title}</h4>
        {description ? (
          <p
            className="task-rail-description"
            data-error={Boolean(task.error) || undefined}
          >
            {description}
          </p>
        ) : null}
        <CardMeta at={task.finishedAt ?? task.updatedAt}>
          {task.artifacts.length > 0 ? (
            <span className="task-rail-artifacts">
              <IconPaperclip aria-hidden className="size-3.5" />
              {`${task.artifacts.length} 个附件`}
            </span>
          ) : null}
        </CardMeta>
      </Link>
      {!recent && (isRunning || isPaused) ? (
        <div className="task-rail-actions">
          <Button
            disabled={control.isPending}
            mutation={control}
            onClick={() => control.mutate(isPaused ? "resume" : "pause")}
            size="sm"
            variant="outline"
          >
            {isPaused ? (
              <IconPlayerPlay aria-hidden className="size-3.5" />
            ) : (
              <IconPlayerPause aria-hidden className="size-3.5" />
            )}
            {isPaused ? "继续任务" : "暂停任务"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
