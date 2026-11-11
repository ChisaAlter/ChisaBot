import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleOff,
  IconCircleX,
  IconDots,
  IconEye,
  IconGitBranch,
  IconPaperclip,
  IconPinned,
  IconPinnedOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import {
  type QueryClient,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { CreateTask } from "@/components/task-center/create-task";
import {
  ACTIVE_STATUSES,
  CATEGORY_LABELS,
  RISK_LABELS,
  STATUS_LABELS,
  taskDate,
} from "@/components/task-center/labels";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { ClientError } from "@/lib/client";
import {
  type TaskControl,
  taskCenterApi,
  taskCenterKeys,
  taskCenterSnapshotOptions,
} from "@/lib/task-center-api";
import {
  getItemOrderMeta,
  type ItemOrderMeta,
  moveRailItem,
  type RailOrderSection,
  sortSectionItems,
  toggleRailItemPin,
  useTaskRailOrder,
} from "@/lib/task-rail-order";
import {
  WorkflowSaveError,
  workflowKeys,
  workflowLibraryQueryOptions,
  workflowsApi,
} from "@/lib/workflows";
import type {
  TaskCenterDecision,
  TaskCenterSnapshot,
  TaskCenterTask,
} from "../../../../shared/task-center";
import { activeTaskCount } from "../../../../shared/task-center";
import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS_LABEL,
  type WorkflowRunView,
  type WorkflowStepStatus,
} from "../../../../shared/workflows";
import {
  CATEGORY_ICONS,
  formatRailErrorSummary,
  type RailDetailTarget,
  TaskRailDetailDialog,
} from "./task-rail-detail-dialog";
import "../task-center/task-center.css";
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
    approvalCount:
      (data?.decisionCounts?.pending ?? pendingDecisions.length) +
      waitingApprovalRuns.length,
    activeCount: (data ? activeTaskCount(data.counts) : 0) + activeRuns.length,
  };
}

/**
 * 右栏「任务」选项卡内容：集中展示待确认审批、进行中的任务与工作流步骤进度、近期交付记录，
 * 支持原位操作（三点菜单：取消、置顶、上移、下移、暂停/继续/重试）与点击卡片丝滑弹窗查看详情。
 */
export function TasksRailCard() {
  const queryClient = useQueryClient();
  const {
    snapshot,
    workflows,
    pendingDecisions,
    activeTasks,
    activeRuns,
    approvalCount,
  } = useRailTasksSummary();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<RailDetailTarget | null>(
    null,
  );

  const data = snapshot.data;
  const finishedTasks =
    data?.tasks.filter((task) =>
      ["succeeded", "failed", "cancelled"].includes(task.status),
    ) ?? [];

  return (
    <div className="task-rail" data-testid="tasks-rail-card">
      <header className="task-rail-header">
        <h2>{"任务进度"}</h2>
        <div className="task-rail-header-actions">
          <button
            className="task-rail-new-btn"
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            <IconPlus aria-hidden className="size-3.5" />
            {"新建"}
          </button>
          <Link
            className="task-rail-center-link"
            search={{ view: approvalCount > 0 ? "outbox" : "active" }}
            to="/tasks"
          >
            {"任务中心"}
          </Link>
        </div>
      </header>
      <TasksRailBody
        activeRuns={activeRuns}
        activeTasks={activeTasks}
        detailTarget={detailTarget}
        finishedTasks={finishedTasks}
        inboxCount={data?.counts.inbox ?? 0}
        onOpenDetail={setDetailTarget}
        pendingCount={data?.decisionCounts?.pending ?? pendingDecisions.length}
        pendingDecisions={pendingDecisions}
        snapshot={snapshot}
        taskCount={data ? activeTaskCount(data.counts) : 0}
        workflows={workflows}
      />
      <CreateTask
        onCreated={(createdId) => {
          setCreateOpen(false);
          void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
          setDetailTarget({ kind: "task", taskId: createdId });
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </div>
  );
}

type ActiveRailEntry =
  | { kind: "run"; itemId: string; run: WorkflowRunView }
  | { kind: "task"; itemId: string; task: TaskCenterTask };

function TasksRailBody({
  snapshot,
  workflows,
  pendingDecisions,
  activeTasks,
  activeRuns,
  finishedTasks,
  pendingCount,
  taskCount,
  inboxCount,
  detailTarget,
  onOpenDetail,
}: {
  snapshot: ReturnType<typeof useRailTasksSummary>["snapshot"];
  workflows: ReturnType<typeof useRailTasksSummary>["workflows"];
  pendingDecisions: TaskCenterDecision[];
  activeTasks: TaskCenterTask[];
  activeRuns: WorkflowRunView[];
  finishedTasks: TaskCenterTask[];
  pendingCount: number;
  taskCount: number;
  inboxCount: number;
  detailTarget: RailDetailTarget | null;
  onOpenDetail: (target: RailDetailTarget | null) => void;
}) {
  const queryClient = useQueryClient();
  const orderMap = useTaskRailOrder();
  const [retrying, setRetrying] = useState(false);
  const snapshotFailed = railQueryFailed(snapshot);
  const workflowsFailed = railQueryFailed(workflows);
  const loading = railQueryLoading(snapshot) || railQueryLoading(workflows);

  const refreshTasks = () => {
    void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
  };
  const refreshWorkflows = () => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.all });
  };

  const sortedDecisions = useMemo(
    () =>
      sortSectionItems(
        pendingDecisions,
        (d) => `decision:${d.id}`,
        orderMap.decisions,
      ),
    [pendingDecisions, orderMap.decisions],
  );
  const sortedDecisionIds = useMemo(
    () => sortedDecisions.map((d) => `decision:${d.id}`),
    [sortedDecisions],
  );

  const sortedActiveEntries = useMemo(() => {
    const raw: ActiveRailEntry[] = [
      ...activeRuns.map(
        (run): ActiveRailEntry => ({
          kind: "run",
          itemId: `run:${run.id}`,
          run,
        }),
      ),
      ...activeTasks.map(
        (task): ActiveRailEntry => ({
          kind: "task",
          itemId: `task:${task.id}`,
          task,
        }),
      ),
    ];
    return sortSectionItems(raw, (entry) => entry.itemId, orderMap.active);
  }, [activeRuns, activeTasks, orderMap.active]);

  const sortedActiveIds = useMemo(
    () => sortedActiveEntries.map((entry) => entry.itemId),
    [sortedActiveEntries],
  );

  const recentTasks = useMemo(
    () =>
      sortSectionItems(
        finishedTasks,
        (task) => `task:${task.id}`,
        orderMap.recent,
      ).slice(0, 5),
    [finishedTasks, orderMap.recent],
  );
  const sortedRecentIds = useMemo(
    () => recentTasks.map((task) => `task:${task.id}`),
    [recentTasks],
  );

  const sortedSectionIds: Record<RailOrderSection, string[]> = {
    decisions: sortedDecisionIds,
    active: sortedActiveIds,
    recent: sortedRecentIds,
  };

  const hasActiveOrPending =
    sortedDecisions.length > 0 || sortedActiveEntries.length > 0;

  return (
    <>
      <div className="task-rail-sections">
        {snapshotFailed || workflowsFailed ? (
          <div className="task-rail-notice" role="alert">
            <p>
              {snapshotFailed && workflowsFailed
                ? "任务和工作流暂时无法刷新。"
                : snapshotFailed
                  ? "任务暂时无法刷新。"
                  : "工作流暂时无法刷新。"}
            </p>
            <Button
              // 只跟着用户点的这次重试转圈；后台 5 秒轮询不让按钮跟着闪。
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                void Promise.allSettled([
                  snapshotFailed ? snapshot.refetch() : null,
                  workflowsFailed ? workflows.refetch() : null,
                ]).finally(() => setRetrying(false));
              }}
              size="sm"
              variant="outline"
            >
              {"重试"}
            </Button>
          </div>
        ) : null}
        {loading ? (
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

        {sortedDecisions.length > 0 ? (
          <RailSection
            count={
              pendingCount > sortedDecisions.length
                ? `${sortedDecisions.length} / ${pendingCount} 待确认`
                : `${pendingCount} 待确认`
            }
            title="需要你确认"
          >
            {sortedDecisions.map((decision) => {
              const itemId = `decision:${decision.id}`;
              const matchedTask = snapshot.data?.tasks.find(
                (t) => t.id === decision.taskId,
              );
              return (
                <RailDecisionItem
                  decision={decision}
                  itemId={itemId}
                  key={decision.id}
                  onChanged={refreshTasks}
                  onOpenDetail={() =>
                    onOpenDetail({
                      kind: "task",
                      taskId: decision.taskId,
                      initialTask: matchedTask,
                      decision,
                      section: "decisions",
                      orderItemId: itemId,
                    })
                  }
                  onStale={() => dropStaleDecision(queryClient, decision.id)}
                  orderMeta={getItemOrderMeta(
                    orderMap.decisions,
                    sortedDecisionIds,
                    itemId,
                  )}
                  sectionIds={sortedDecisionIds}
                />
              );
            })}
            {pendingCount > sortedDecisions.length ? (
              <Link
                className="task-rail-center-link"
                search={{ view: "outbox" }}
                to="/tasks"
              >
                查看全部 {pendingCount} 项待确认
              </Link>
            ) : null}
          </RailSection>
        ) : null}

        {sortedActiveEntries.length > 0 ? (
          <RailSection
            count={
              taskCount > activeTasks.length
                ? `${activeRuns.length + activeTasks.length} / ${activeRuns.length + taskCount} 项`
                : `${activeRuns.length + activeTasks.length} 项`
            }
            title="任务与工作流"
          >
            {sortedActiveEntries.map((entry) =>
              entry.kind === "run" ? (
                <RailWorkflowRunItem
                  itemId={entry.itemId}
                  key={entry.itemId}
                  onChanged={refreshWorkflows}
                  onOpenDetail={() =>
                    onOpenDetail({
                      kind: "workflow",
                      runId: entry.run.id,
                      initialRun: entry.run,
                      section: "active",
                      orderItemId: entry.itemId,
                    })
                  }
                  orderMeta={getItemOrderMeta(
                    orderMap.active,
                    sortedActiveIds,
                    entry.itemId,
                  )}
                  run={entry.run}
                  sectionIds={sortedActiveIds}
                />
              ) : (
                <RailTaskItem
                  itemId={entry.itemId}
                  key={entry.itemId}
                  onChanged={refreshTasks}
                  onOpenDetail={() =>
                    onOpenDetail({
                      kind: "task",
                      taskId: entry.task.id,
                      initialTask: entry.task,
                      section: "active",
                      orderItemId: entry.itemId,
                    })
                  }
                  orderMeta={getItemOrderMeta(
                    orderMap.active,
                    sortedActiveIds,
                    entry.itemId,
                  )}
                  section="active"
                  sectionIds={sortedActiveIds}
                  task={entry.task}
                />
              ),
            )}
            {taskCount > activeTasks.length ? (
              <Link
                className="task-rail-center-link"
                search={{ view: "active" }}
                to="/tasks"
              >
                查看全部 {taskCount} 项任务
              </Link>
            ) : null}
          </RailSection>
        ) : null}

        {!hasActiveOrPending &&
        !loading &&
        !snapshotFailed &&
        !workflowsFailed ? (
          recentTasks.length > 0 ? (
            <p className="task-rail-idle-hint" role="status">
              {"现在没有进行中的任务"}
            </p>
          ) : (
            <div className="task-rail-empty">
              <IconCircleCheck aria-hidden className="size-5" />
              <div>
                <p>{"当前没有待跟进的任务"}</p>
                {inboxCount > 0 ? (
                  <Link search={{ view: "inbox" }} to="/tasks">
                    {`查看 ${inboxCount} 项待安排事项`}
                  </Link>
                ) : (
                  <span>
                    {"可以在对话中交办，或点右上角「新建」直接创建。"}
                  </span>
                )}
              </div>
            </div>
          )
        ) : null}

        {recentTasks.length > 0 ? (
          <RailSection count={`${recentTasks.length} 项`} title="最近交付">
            {recentTasks.map((task) => {
              const itemId = `task:${task.id}`;
              return (
                <RailTaskItem
                  itemId={itemId}
                  key={task.id}
                  onChanged={refreshTasks}
                  onOpenDetail={() =>
                    onOpenDetail({
                      kind: "task",
                      taskId: task.id,
                      initialTask: task,
                      section: "recent",
                      orderItemId: itemId,
                    })
                  }
                  orderMeta={getItemOrderMeta(
                    orderMap.recent,
                    sortedRecentIds,
                    itemId,
                  )}
                  recent
                  section="recent"
                  sectionIds={sortedRecentIds}
                  task={task}
                />
              );
            })}
          </RailSection>
        ) : null}
      </div>

      <TaskRailDetailDialog
        allDecisions={snapshot.data?.outbox ?? []}
        allTasks={snapshot.data?.tasks ?? []}
        onClose={() => onOpenDetail(null)}
        sortedSectionIds={sortedSectionIds}
        target={detailTarget}
      />
    </>
  );
}

/**
 * 这条查询现在算不算「失败」：本身报错，或者报错后后台轮询正在重拉、手上还没有任何数据。
 *
 * TanStack Query 在没有数据时重新拉取，会把 status 从 error 改回 pending、清掉 error；
 * 只看 isError / isPending 的话，每 5 秒轮询一次，提示就会被骨架屏顶掉约 1 秒。
 */
export function railQueryFailed(
  query: Pick<UseQueryResult, "isError" | "data" | "errorUpdateCount">,
): boolean {
  return (
    query.isError || (query.data === undefined && query.errorUpdateCount > 0)
  );
}

/** 骨架屏只给「第一次加载、还没失败过」——后台轮询时保留当前内容或错误提示。 */
export function railQueryLoading(
  query: Pick<
    UseQueryResult,
    "isError" | "isPending" | "data" | "errorUpdateCount"
  >,
): boolean {
  return query.isPending && !railQueryFailed(query);
}

/** 409（已在别处处理）/ 404（已不存在）：这张卡片已过期，要立刻刷新，不等 5 秒轮询。 */
export function isStaleActionError(err: unknown): boolean {
  const status =
    err instanceof ClientError || err instanceof WorkflowSaveError
      ? err.status
      : undefined;
  return status === 409 || status === 404;
}

/** 先从缓存里拿掉这条确认请求，让卡片马上消失；随后的刷新再以服务端为准。 */
function dropStaleDecision(queryClient: QueryClient, decisionId: string) {
  queryClient.setQueryData<TaskCenterSnapshot>(
    taskCenterKeys.snapshot,
    (prev) =>
      prev
        ? {
            ...prev,
            outbox: prev.outbox.filter((item) => item.id !== decisionId),
            ...(prev.decisionCounts &&
            prev.outbox.some(
              (item) => item.id === decisionId && item.status === "pending",
            )
              ? {
                  decisionCounts: {
                    ...prev.decisionCounts,
                    pending: Math.max(0, prev.decisionCounts.pending - 1),
                  },
                }
              : {}),
          }
        : prev,
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
    <section aria-label={title} className="task-rail-section">
      <div className="task-rail-section-head">
        <h3>{title}</h3>
        <span>{count}</span>
      </div>
      <div className="task-rail-cards">{children}</div>
    </section>
  );
}

type CardTone = "info" | "warning" | "success" | "danger" | "neutral";

/** 卡片状态语义：图标与色调成对，暂停与取消共用中性色但图标不同。 */
type StatusKind =
  | "active"
  | "attention"
  | "paused"
  | "success"
  | "danger"
  | "cancelled";

const STATUS_KIND_VISUAL: Record<
  StatusKind,
  { tone: CardTone; Icon: typeof IconCircleDashed }
> = {
  active: { tone: "info", Icon: IconCircleDashed },
  attention: { tone: "warning", Icon: IconAlertTriangle },
  paused: { tone: "neutral", Icon: IconPlayerPause },
  success: { tone: "success", Icon: IconCircleCheck },
  danger: { tone: "danger", Icon: IconCircleX },
  cancelled: { tone: "neutral", Icon: IconCircleOff },
};

function CardStatus({
  kind,
  children,
}: {
  kind: StatusKind;
  children: ReactNode;
}) {
  const { tone, Icon } = STATUS_KIND_VISUAL[kind];
  return (
    <span className="task-rail-status" data-kind={kind} data-tone={tone}>
      <Icon
        aria-hidden
        className="size-3.5"
        data-testid={`task-rail-status-icon-${kind}`}
      />
      {children}
    </span>
  );
}

function taskStatusKind(
  status: TaskCenterTask["status"],
  opts: { recent?: boolean; hasError?: boolean } = {},
): StatusKind {
  if (status === "failed") return "danger";
  if (status === "succeeded") return "success";
  if (status === "cancelled") return "cancelled";
  if (status === "paused") return "paused";
  if (
    status === "waiting_approval" ||
    status === "waiting_dependencies" ||
    (opts.hasError && !opts.recent)
  ) {
    return "attention";
  }
  return "active";
}

function CardMeta({ at, children }: { at: string; children?: ReactNode }) {
  return (
    <div className="task-rail-meta">
      <time dateTime={at}>{taskDate(at)}</time>
      {children}
    </div>
  );
}

type CardMenuAction = {
  key: string;
  label: string;
  Icon: typeof IconEye;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

function CardMoreMenu({
  title,
  section,
  sectionIds,
  itemId,
  orderMeta,
  onOpenDetail,
  primaryActions = [],
  destructiveAction,
}: {
  title: string;
  section: RailOrderSection;
  sectionIds: readonly string[];
  itemId: string;
  orderMeta: ItemOrderMeta;
  onOpenDetail: () => void;
  primaryActions?: CardMenuAction[];
  destructiveAction?: CardMenuAction;
}) {
  return (
    <div className="task-rail-more-slot">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              aria-label={`「${title}」的更多操作`}
              className="task-rail-more-btn"
              data-testid="task-rail-more-trigger"
              type="button"
            />
          }
        >
          <IconDots aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="glass-pop sg-menu w-[196px]"
          side="bottom"
          sideOffset={6}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem className="glass-mi" onClick={onOpenDetail}>
              <IconEye className="size-4" />
              <span className="min-w-0 flex-1">{"查看详情"}</span>
            </DropdownMenuItem>
            {primaryActions.map((actItem) => (
              <DropdownMenuItem
                className="glass-mi"
                disabled={actItem.disabled}
                key={actItem.key}
                onClick={actItem.onSelect}
              >
                <actItem.Icon className="size-4" />
                <span className="min-w-0 flex-1">{actItem.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>

          <DropdownMenuSeparator className="glass-sep" />

          <DropdownMenuGroup>
            <DropdownMenuItem
              className="glass-mi"
              onClick={() => {
                const pinned = toggleRailItemPin(section, sectionIds, itemId);
                toast.info(pinned ? "已置顶" : "已取消置顶");
              }}
            >
              {orderMeta.pinned ? (
                <IconPinnedOff className="size-4" />
              ) : (
                <IconPinned className="size-4" />
              )}
              <span className="min-w-0 flex-1">
                {orderMeta.pinned ? "取消置顶" : "置顶"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="glass-mi"
              disabled={!orderMeta.canMoveUp}
              onClick={() => {
                moveRailItem(section, sectionIds, itemId, -1);
              }}
            >
              <IconArrowUp className="size-4" />
              <span className="min-w-0 flex-1">{"上移"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="glass-mi"
              disabled={!orderMeta.canMoveDown}
              onClick={() => {
                moveRailItem(section, sectionIds, itemId, 1);
              }}
            >
              <IconArrowDown className="size-4" />
              <span className="min-w-0 flex-1">{"下移"}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          {destructiveAction ? (
            <>
              <DropdownMenuSeparator className="glass-sep" />
              <DropdownMenuItem
                className="glass-mi"
                disabled={destructiveAction.disabled}
                onClick={destructiveAction.onSelect}
                variant="destructive"
              >
                <destructiveAction.Icon className="size-4" />
                <span className="min-w-0 flex-1">
                  {destructiveAction.label}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RailDecisionItem({
  decision,
  itemId,
  sectionIds,
  orderMeta,
  onOpenDetail,
  onChanged,
  onStale,
}: {
  decision: TaskCenterDecision;
  itemId: string;
  sectionIds: readonly string[];
  orderMeta: ItemOrderMeta;
  onOpenDetail: () => void;
  onChanged: () => void;
  onStale: () => void;
}) {
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      taskCenterApi.decide(decision.id, approved),
    onSuccess: onChanged,
    onError: (err) => {
      if (isStaleActionError(err)) {
        // 别处已经处理过：卡片立刻拿掉并刷新，提示用中性语气，不当成失败。
        onStale();
        onChanged();
        toast.info(
          err instanceof Error ? err.message : "这条确认请求已经处理。",
        );
        return;
      }
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
  });

  const cancelTask = useMutation({
    mutationFn: () => taskCenterApi.controlTask(decision.taskId, "cancel"),
    onSuccess: () => {
      onChanged();
      toast.success("已取消该任务");
    },
    onError: (err) => {
      if (isStaleActionError(err)) {
        onStale();
        onChanged();
        toast.info("任务状态已更新。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "取消失败");
    },
  });

  return (
    <article
      className="task-rail-item"
      data-kind="decision"
      data-pinned={orderMeta.pinned || undefined}
      data-tone="warning"
    >
      <button
        className="task-rail-item-link"
        onClick={onOpenDetail}
        type="button"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            <span aria-hidden className="task-rail-kind-icon">
              <IconShieldCheck className="size-3.5" />
            </span>
            {RISK_LABELS[decision.proposedAction.risk]}
            {orderMeta.pinned ? (
              <span className="task-rail-pin-chip">
                <IconPinned aria-hidden className="size-3" />
                {"置顶"}
              </span>
            ) : null}
          </span>
          <CardStatus kind="attention">{"待确认"}</CardStatus>
        </div>
        <h4 className="task-rail-title">{decision.proposedAction.title}</h4>
        <p className="task-rail-description">{decision.summary}</p>
        <CardMeta at={decision.createdAt} />
      </button>
      <CardMoreMenu
        destructiveAction={{
          key: "cancel",
          label: "取消任务",
          Icon: IconCircleOff,
          disabled: cancelTask.isPending,
          onSelect: () => cancelTask.mutate(),
        }}
        itemId={itemId}
        onOpenDetail={onOpenDetail}
        orderMeta={orderMeta}
        primaryActions={[
          {
            key: "approve",
            label: "批准执行",
            Icon: IconCheck,
            disabled: decide.isPending,
            onSelect: () => decide.mutate(true),
          },
          {
            key: "reject",
            label: "拒绝操作",
            Icon: IconX,
            disabled: decide.isPending,
            onSelect: () => decide.mutate(false),
          },
        ]}
        section="decisions"
        sectionIds={sectionIds}
        title={decision.proposedAction.title}
      />
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
  itemId,
  sectionIds,
  orderMeta,
  onOpenDetail,
  onChanged,
}: {
  run: WorkflowRunView;
  itemId: string;
  sectionIds: readonly string[];
  orderMeta: ItemOrderMeta;
  onOpenDetail: () => void;
  onChanged: () => void;
}) {
  const totalSteps = run.steps.length;
  const doneSteps = run.steps.filter(
    (s) => s.status === "succeeded" || s.status === "skipped",
  ).length;
  const activeStep = run.steps.find(
    (s) => s.status === "running" || s.status === "waiting_approval",
  );
  const description = workflowRunDescription(run, doneSteps, activeStep);
  const percent =
    totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const kind: StatusKind =
    run.status === "waiting_approval" ? "attention" : "active";
  const tone = STATUS_KIND_VISUAL[kind].tone;

  const approve = useMutation({
    mutationFn: ({
      stepId,
      decision,
    }: {
      stepId: string;
      decision: "approve" | "reject";
    }) => workflowsApi.approve(run.id, stepId, decision),
    onSuccess: onChanged,
    onError: (err) => {
      if (isStaleActionError(err)) {
        // 别处已批准后运行常会继续：先重新拉取，完成后再一次替换缓存，
        // 不要先从缓存拿掉卡片（否则 3–8ms 后又加回来会闪一下）。
        onChanged();
        toast.info(err instanceof Error ? err.message : "这一步已经处理过了。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "审批操作失败");
    },
  });

  const cancelRun = useMutation({
    mutationFn: () => workflowsApi.cancel(run.id),
    onSuccess: () => {
      onChanged();
      toast.success("已停止工作流运行");
    },
    onError: (err) => {
      if (isStaleActionError(err)) {
        onChanged();
        toast.info("该工作流运行已经结束。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "停止失败");
    },
  });

  const displayTitle = `${run.icon ? `${run.icon} ` : ""}${run.workflowName}`;

  return (
    <article
      className="task-rail-item"
      data-kind="workflow"
      data-pinned={orderMeta.pinned || undefined}
      data-tone={tone}
    >
      <button
        className="task-rail-item-link"
        onClick={onOpenDetail}
        type="button"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            <span aria-hidden className="task-rail-kind-icon">
              <IconGitBranch className="size-3.5" />
            </span>
            {"工作流"}
            {orderMeta.pinned ? (
              <span className="task-rail-pin-chip">
                <IconPinned aria-hidden className="size-3" />
                {"置顶"}
              </span>
            ) : null}
          </span>
          <CardStatus kind={kind}>{RUN_STATUS_LABEL[run.status]}</CardStatus>
        </div>
        <h4 className="task-rail-title">{displayTitle}</h4>
        <p className="task-rail-description">{description}</p>
        {/* 按钮的可读名称只念一句「已完成 2/5 步」；可见的标签行和进度条是同一件事的图示，读屏跳过。 */}
        <span className="sr-only">{`已完成 ${doneSteps}/${totalSteps} 步`}</span>
        <div aria-hidden className="task-rail-progress-label">
          <span>{"步骤进度"}</span>
          <span>{`${doneSteps}/${totalSteps} 步`}</span>
        </div>
        <progress
          aria-hidden
          className="task-rail-progress"
          data-progress={`${doneSteps}/${totalSteps}`}
          max={100}
          value={percent}
        />
        <CardMeta at={run.startedAt ?? run.createdAt} />
      </button>
      <CardMoreMenu
        destructiveAction={
          ACTIVE_RUN_STATUSES.includes(run.status)
            ? {
                key: "stop",
                label: "停止工作流",
                Icon: IconPlayerStop,
                disabled: cancelRun.isPending,
                onSelect: () => cancelRun.mutate(),
              }
            : undefined
        }
        itemId={itemId}
        onOpenDetail={onOpenDetail}
        orderMeta={orderMeta}
        primaryActions={
          run.status === "waiting_approval" && activeStep
            ? [
                {
                  key: "approve-step",
                  label: "批准步骤",
                  Icon: IconCheck,
                  disabled: approve.isPending,
                  onSelect: () =>
                    approve.mutate({
                      stepId: activeStep.id,
                      decision: "approve",
                    }),
                },
                {
                  key: "reject-step",
                  label: "打回/拒绝",
                  Icon: IconX,
                  disabled: approve.isPending,
                  onSelect: () =>
                    approve.mutate({
                      stepId: activeStep.id,
                      decision: "reject",
                    }),
                },
              ]
            : []
        }
        section="active"
        sectionIds={sectionIds}
        title={run.workflowName}
      />
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

const FINISHED_STEP_STATUSES: readonly WorkflowStepStatus[] = [
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
];

/** 工作流卡片的一句话说明：正在做哪一步 / 还没开始 / 步骤都结束了在收尾 / 还没排出步骤。 */
export function workflowRunDescription(
  run: Pick<WorkflowRunView, "status" | "steps">,
  doneSteps: number,
  activeStep?: { name: string },
): string {
  if (activeStep) return `当前：${activeStep.name}`;
  if (run.status === "queued") return "等待工作流开始";
  const total = run.steps.length;
  if (total > 0 && doneSteps === total) return "步骤已全部完成，正在收尾…";
  if (
    total > 0 &&
    run.steps.every((step) => FINISHED_STEP_STATUSES.includes(step.status))
  ) {
    return "步骤已结束，正在收尾…";
  }
  return "准备执行步骤…";
}

function RailTaskItem({
  task,
  itemId,
  section,
  sectionIds,
  orderMeta,
  onOpenDetail,
  onChanged,
  recent = false,
}: {
  task: TaskCenterTask;
  itemId: string;
  section: RailOrderSection;
  sectionIds: readonly string[];
  orderMeta: ItemOrderMeta;
  onOpenDetail: () => void;
  onChanged: () => void;
  recent?: boolean;
}) {
  const control = useMutation({
    mutationFn: (action: TaskControl) =>
      taskCenterApi.controlTask(task.id, action),
    onSuccess: onChanged,
    onError: (err) => {
      if (isStaleActionError(err)) {
        onChanged();
        toast.info(err instanceof Error ? err.message : "任务状态已经变化。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
  });

  const isRunning = task.status === "running" || task.status === "planning";
  const isPaused = task.status === "paused";
  const isBlockedWithError =
    (task.status === "queued" || task.status === "waiting_dependencies") &&
    Boolean(task.error);
  const isTerminal =
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "cancelled";

  const kind = taskStatusKind(task.status, {
    recent,
    hasError: Boolean(task.error),
  });
  const tone = STATUS_KIND_VISUAL[kind].tone;
  const rawDescription = task.error || task.summary || task.description;
  const description = task.error
    ? formatRailErrorSummary(task.error)
    : rawDescription;
  const CategoryIcon = CATEGORY_ICONS[task.category];

  const primaryMenuActions: CardMenuAction[] = [];
  if (task.status === "inbox") {
    primaryMenuActions.push({
      key: "start",
      label: "开始任务",
      Icon: IconPlayerPlay,
      disabled: control.isPending,
      onSelect: () => control.mutate("start"),
    });
  } else if (ACTIVE_STATUSES.includes(task.status)) {
    primaryMenuActions.push({
      key: "pause",
      label: "暂停任务",
      Icon: IconPlayerPause,
      disabled: control.isPending,
      onSelect: () => control.mutate("pause"),
    });
  } else if (task.status === "paused") {
    primaryMenuActions.push({
      key: "resume",
      label: "继续任务",
      Icon: IconPlayerPlay,
      disabled: control.isPending,
      onSelect: () => control.mutate("resume"),
    });
  } else if (task.status === "failed") {
    primaryMenuActions.push({
      key: "retry",
      label: "重试任务",
      Icon: IconRefresh,
      disabled: control.isPending,
      onSelect: () => control.mutate("retry"),
    });
  }

  return (
    <article
      className="task-rail-item"
      data-kind={recent ? "recent" : "task"}
      data-pinned={orderMeta.pinned || undefined}
      data-tone={tone}
    >
      <button
        className="task-rail-item-link"
        onClick={onOpenDetail}
        type="button"
      >
        <div className="task-rail-item-head">
          <span className="task-rail-kind">
            <span aria-hidden className="task-rail-kind-icon">
              <CategoryIcon className="size-3.5" />
            </span>
            {CATEGORY_LABELS[task.category]}
            {orderMeta.pinned ? (
              <span className="task-rail-pin-chip">
                <IconPinned aria-hidden className="size-3" />
                {"置顶"}
              </span>
            ) : null}
          </span>
          <CardStatus kind={kind}>{STATUS_LABELS[task.status]}</CardStatus>
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
      </button>

      <CardMoreMenu
        destructiveAction={
          !isTerminal
            ? {
                key: "cancel",
                label: "取消任务",
                Icon: IconCircleOff,
                disabled: control.isPending,
                onSelect: () => control.mutate("cancel"),
              }
            : undefined
        }
        itemId={itemId}
        onOpenDetail={onOpenDetail}
        orderMeta={orderMeta}
        primaryActions={primaryMenuActions}
        section={section}
        sectionIds={sectionIds}
        title={task.title}
      />

      {!recent && (isRunning || isPaused || isBlockedWithError) ? (
        <div className="task-rail-actions">
          {isRunning || isPaused ? (
            <Button
              disabled={control.isPending}
              mutation={control}
              mutationWhen={
                control.variables === (isPaused ? "resume" : "pause")
              }
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
          ) : null}
          {isBlockedWithError ? (
            <Button
              disabled={control.isPending}
              mutation={control}
              mutationWhen={control.variables === "cancel"}
              onClick={() => control.mutate("cancel")}
              size="sm"
              variant="outline"
            >
              <IconX aria-hidden className="size-3.5" />
              {"取消任务"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
