import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCalendarTime,
  IconCheck,
  IconChecklist,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleOff,
  IconCircleX,
  IconCode,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconGitBranch,
  IconMessages,
  IconPinned,
  IconPinnedOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconScale,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  ACTIVE_STATUSES,
  CATEGORY_LABELS,
  RISK_LABELS,
  STATUS_LABELS,
  safeTaskUrl,
  taskDate,
} from "@/components/task-center/labels";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { friendlyError } from "@/lib/chat/friendly-error";
import { ClientError } from "@/lib/client";
import { copyText } from "@/lib/conversations/json-render/rich-context";
import {
  type TaskControl,
  taskCenterApi,
  taskCenterDetailOptions,
  taskCenterKeys,
  taskTraceOptions,
} from "@/lib/task-center-api";
import {
  type RailOrderSection,
  toggleRailItemPin,
  useTaskRailOrder,
} from "@/lib/task-rail-order";
import {
  durationText,
  tokensText,
  WorkflowSaveError,
  workflowKeys,
  workflowRunQueryOptions,
  workflowsApi,
} from "@/lib/workflows";
import {
  TASK_LEVEL_LABELS,
  type TaskArtifact,
  type TaskCategory,
  type TaskCenterDecision,
  type TaskCenterSnapshot,
  type TaskCenterTask,
  type TaskTraceEvent,
} from "../../../../shared/task-center";
import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS_LABEL,
  STEP_STATUS_LABEL,
  type WorkflowRunView,
  type WorkflowStepStatus,
} from "../../../../shared/workflows";

export const CATEGORY_ICONS: Record<TaskCategory, typeof IconChecklist> = {
  research: IconSearch,
  development: IconCode,
  documents: IconFileText,
  project: IconChecklist,
  schedule: IconCalendarTime,
  communication: IconMessages,
  decision: IconScale,
  other: IconSparkles,
};

export type RailDetailTarget =
  | {
      kind: "task";
      taskId: string;
      initialTask?: TaskCenterTask;
      decision?: TaskCenterDecision;
      section?: RailOrderSection;
      orderItemId?: string;
    }
  | {
      kind: "workflow";
      runId: string;
      initialRun?: WorkflowRunView;
      section?: RailOrderSection;
      orderItemId?: string;
    };

/** 判断一段错误文本是否是底层结构体 / JSON / 纯英文机器报错，需要做人话转译。 */
export function isMachineErrorDump(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (
    /\bSome\s*\(|\berror_code\s*:|\berror_message\s*:|^\s*[{[]|"error"\s*:|\bTraceback\b|\bat\s+[\w.$]+\s*\(/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return !/[\u4e00-\u9fff]/.test(trimmed);
}

function extractEmbeddedMessage(raw: string): string | null {
  const rustMatch =
    raw.match(/error_message\s*:\s*Some\(\s*"([^"]+)"\s*\)/i) ??
    raw.match(/message\s*:\s*Some\(\s*"([^"]+)"\s*\)/i);
  if (rustMatch?.[1]) return rustMatch[1];
  const jsonMatch =
    raw.match(/"error_message"\s*:\s*"([^"]+)"/i) ??
    raw.match(/"message"\s*:\s*"([^"]+)"/i);
  if (jsonMatch?.[1]) return jsonMatch[1];
  return null;
}

/**
 * 右栏卡片上的简明错误文案：
 * - 已经是自然中文提示（如「前序资料收集失败，需要先修复依赖任务」）时原样保留；
 * - 底层 Rust / JSON / OAuth 原始报错（如 `{ error_code: Some("refresh_token_invalidated"), ... }`）转成清晰中文说明。
 */
export function formatRailErrorSummary(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !isMachineErrorDump(trimmed)) return trimmed;
  const friendly = friendlyError(trimmed);
  if (friendly.title !== "这一轮没有收到回答") {
    return friendly.hint
      ? `${friendly.title}：${friendly.hint}`
      : friendly.title;
  }
  const extracted = extractEmbeddedMessage(trimmed);
  if (extracted) {
    const inner = friendlyError(extracted);
    if (inner.title !== "这一轮没有收到回答") {
      return inner.hint ? `${inner.title}：${inner.hint}` : inner.title;
    }
    return extracted;
  }
  return friendly.hint ? `${friendly.title}：${friendly.hint}` : friendly.title;
}

function isStaleErr(err: unknown): boolean {
  const status =
    err instanceof ClientError || err instanceof WorkflowSaveError
      ? err.status
      : undefined;
  return status === 409 || status === 404;
}

function targetKey(target: RailDetailTarget | null): string {
  if (!target) return "closed";
  return target.kind === "task"
    ? `task:${target.taskId}:${target.decision?.id ?? ""}`
    : `workflow:${target.runId}`;
}

export function TaskRailDetailDialog({
  target,
  onClose,
  allTasks,
  allDecisions,
  sortedSectionIds,
}: {
  target: RailDetailTarget | null;
  onClose: () => void;
  allTasks: TaskCenterTask[];
  allDecisions: TaskCenterDecision[];
  sortedSectionIds: Record<RailOrderSection, string[]>;
}) {
  const open = target !== null;
  const lastTargetRef = useRef<RailDetailTarget | null>(null);
  if (target !== null) {
    lastTargetRef.current = target;
  }
  const baseTarget = target ?? lastTargetRef.current;

  const [navStack, setNavStack] = useState<RailDetailTarget[]>([]);
  const outerKey = targetKey(target);
  useEffect(() => {
    setNavStack([]);
  }, [outerKey]);

  const activeTarget =
    navStack.length > 0 ? (navStack.at(-1) ?? baseTarget) : baseTarget;

  const pushTaskTarget = (nextTaskId: string) => {
    if (!activeTarget) return;
    if (activeTarget.kind === "task" && activeTarget.taskId === nextTaskId) {
      return;
    }
    const found = allTasks.find((item) => item.id === nextTaskId);
    setNavStack((prev) => [
      ...prev,
      {
        kind: "task",
        taskId: nextTaskId,
        initialTask: found,
      },
    ]);
  };

  const popTarget = () => {
    setNavStack((prev) => prev.slice(0, -1));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {activeTarget ? (
        activeTarget.kind === "task" ? (
          <TaskDetailModalContent
            allDecisions={allDecisions}
            allTasks={allTasks}
            canGoBack={navStack.length > 0}
            onBack={popTarget}
            onClose={onClose}
            onSelectTask={pushTaskTarget}
            sortedSectionIds={sortedSectionIds}
            target={activeTarget}
          />
        ) : (
          <WorkflowRunModalContent
            canGoBack={navStack.length > 0}
            onBack={popTarget}
            onClose={onClose}
            sortedSectionIds={sortedSectionIds}
            target={activeTarget}
          />
        )
      ) : null}
    </Dialog>
  );
}

function modalToneForTask(task: TaskCenterTask | undefined): string {
  if (!task) return "info";
  if (task.status === "failed") return "danger";
  if (task.status === "succeeded") return "success";
  if (task.status === "cancelled" || task.status === "paused") return "neutral";
  if (
    task.status === "waiting_approval" ||
    task.status === "waiting_dependencies" ||
    task.error
  ) {
    return "warning";
  }
  return "info";
}

function TaskDetailModalContent({
  target,
  allTasks,
  allDecisions,
  sortedSectionIds,
  canGoBack,
  onBack,
  onSelectTask,
  onClose,
}: {
  target: Extract<RailDetailTarget, { kind: "task" }>;
  allTasks: TaskCenterTask[];
  allDecisions: TaskCenterDecision[];
  sortedSectionIds: Record<RailOrderSection, string[]>;
  canGoBack: boolean;
  onBack: () => void;
  onSelectTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const orderMap = useTaskRailOrder();
  const [tab, setTab] = useState<"overview" | "events" | "trace">("overview");
  useEffect(() => {
    setTab("overview");
  }, [target.taskId]);

  const detailQuery = useQuery(taskCenterDetailOptions(target.taskId));
  const snapshotTask =
    allTasks.find((item) => item.id === target.taskId) ?? target.initialTask;
  const task = detailQuery.data?.task ?? snapshotTask;
  const events = detailQuery.data?.events ?? [];
  const children = detailQuery.data?.children ?? [];

  const pendingDecision =
    allDecisions.find(
      (item) => item.taskId === target.taskId && item.status === "pending",
    ) ?? (target.decision?.status === "pending" ? target.decision : undefined);

  const isPinned =
    target.section && target.orderItemId
      ? orderMap[target.section].pinned.includes(target.orderItemId)
      : false;

  const refreshTasks = () => {
    void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
  };

  const control = useMutation({
    mutationFn: (action: TaskControl) =>
      taskCenterApi.controlTask(target.taskId, action),
    onSuccess: (_, action) => {
      refreshTasks();
      const labels: Record<TaskControl, string> = {
        start: "任务已开始",
        pause: "任务已暂停",
        resume: "任务已继续推进",
        retry: "已重新发起任务",
        cancel: "任务已取消",
      };
      toast.success(labels[action]);
    },
    onError: (err) => {
      if (isStaleErr(err)) {
        refreshTasks();
        toast.info(err instanceof Error ? err.message : "任务状态已经更新。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
  });

  const decide = useMutation({
    mutationFn: (approved: boolean) => {
      if (!pendingDecision) throw new Error("没有待处理的确认项");
      return taskCenterApi.decide(pendingDecision.id, approved);
    },
    onSuccess: (_, approved) => {
      refreshTasks();
      toast.success(approved ? "已批准执行" : "已拒绝该操作");
    },
    onError: (err) => {
      if (isStaleErr(err) && pendingDecision) {
        queryClient.setQueryData<TaskCenterSnapshot>(
          taskCenterKeys.snapshot,
          (prev) =>
            prev
              ? {
                  ...prev,
                  outbox: prev.outbox.filter(
                    (item) => item.id !== pendingDecision.id,
                  ),
                }
              : prev,
        );
        refreshTasks();
        toast.info(
          err instanceof Error ? err.message : "这条确认请求已经处理。",
        );
        return;
      }
      toast.error(err instanceof Error ? err.message : "确认操作失败");
    },
  });

  const actions: Array<{
    action: TaskControl;
    label: string;
    destructive?: boolean;
  }> = task
    ? task.status === "inbox"
      ? [
          { action: "start", label: "开始任务" },
          { action: "cancel", label: "取消任务", destructive: true },
        ]
      : task.status === "paused"
        ? [
            { action: "resume", label: "继续任务" },
            { action: "cancel", label: "取消任务", destructive: true },
          ]
        : task.status === "failed"
          ? [{ action: "retry", label: "重试任务" }]
          : ACTIVE_STATUSES.includes(task.status)
            ? [
                { action: "pause", label: "暂停任务" },
                { action: "cancel", label: "取消任务", destructive: true },
              ]
            : task.status === "waiting_approval"
              ? [{ action: "cancel", label: "取消任务", destructive: true }]
              : []
    : [];

  const CategoryIcon = task ? CATEGORY_ICONS[task.category] : IconChecklist;
  const tone = modalToneForTask(task);
  const parsedError = task?.error ? friendlyError(task.error) : null;
  const trimmedRawError = task?.error?.trim();
  const showRawError = Boolean(
    trimmedRawError &&
      parsedError &&
      trimmedRawError !== parsedError.title &&
      trimmedRawError !== parsedError.hint,
  );

  return (
    <DialogContent
      className="task-rail-detail-dialog"
      data-testid="task-rail-detail-dialog"
      data-tone={tone}
      overlayClassName="task-rail-detail-overlay"
    >
      <DialogHeader className="task-rail-modal-header">
        <div className="task-rail-modal-badges">
          {canGoBack ? (
            <button
              className="task-rail-modal-back"
              onClick={onBack}
              type="button"
            >
              <IconArrowLeft aria-hidden className="size-3.5" />
              {"返回上一任务"}
            </button>
          ) : null}
          {task ? (
            <>
              <span className="task-rail-kind-pill">
                <CategoryIcon aria-hidden className="size-3.5" />
                {CATEGORY_LABELS[task.category]}
              </span>
              <span className="task-rail-modal-status" data-tone={tone}>
                {STATUS_LABELS[task.status]}
              </span>
              {isPinned ? (
                <span className="task-rail-pin-badge">
                  <IconPinned aria-hidden className="size-3" />
                  {"已置顶"}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <DialogTitle className="task-rail-modal-title">
          {task?.title ??
            pendingDecision?.proposedAction.title ??
            "正在加载任务详情…"}
        </DialogTitle>
        <DialogDescription className="task-rail-modal-subtitle">
          {task
            ? `${CATEGORY_LABELS[task.category]} · ${task.executor} · 更新于 ${taskDate(task.updatedAt)}`
            : "正在同步最新状态与执行记录"}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="task-rail-modal-body">
        {pendingDecision ? (
          <section aria-label="待确认操作" className="task-rail-modal-decision">
            <div className="task-rail-modal-decision-head">
              <span className="task-rail-modal-decision-tag">
                <IconShieldCheck aria-hidden className="size-4" />
                {`需要确认 · ${RISK_LABELS[pendingDecision.proposedAction.risk]}`}
              </span>
              <time dateTime={pendingDecision.createdAt}>
                {taskDate(pendingDecision.createdAt)}
              </time>
            </div>
            <p className="task-rail-modal-decision-summary">
              {pendingDecision.summary}
            </p>
            <div className="task-rail-modal-decision-actions">
              <Button
                disabled={decide.isPending}
                mutation={decide}
                mutationWhen={decide.variables === true}
                onClick={() => decide.mutate(true)}
                size="sm"
              >
                <IconCheck aria-hidden className="size-3.5" />
                {"批准执行"}
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
          </section>
        ) : null}

        {actions.length > 0 || (target.section && target.orderItemId) ? (
          <div className="task-rail-modal-toolbar">
            {actions.map(({ action, label, destructive }) => (
              <Button
                disabled={control.isPending}
                key={action}
                mutation={control}
                mutationWhen={control.variables === action}
                onClick={() => control.mutate(action)}
                size="sm"
                variant={
                  destructive
                    ? "destructive"
                    : action === "retry" ||
                        action === "start" ||
                        action === "resume"
                      ? "default"
                      : "outline"
                }
              >
                {action === "pause" ? (
                  <IconPlayerPause aria-hidden className="size-3.5" />
                ) : action === "retry" ? (
                  <IconRefresh aria-hidden className="size-3.5" />
                ) : action === "cancel" ? (
                  <IconX aria-hidden className="size-3.5" />
                ) : (
                  <IconPlayerPlay aria-hidden className="size-3.5" />
                )}
                {label}
              </Button>
            ))}
            {target.section && target.orderItemId ? (
              <Button
                onClick={() => {
                  const { section, orderItemId } = target;
                  if (!section || !orderItemId) return;
                  const pinned = toggleRailItemPin(
                    section,
                    sortedSectionIds[section],
                    orderItemId,
                  );
                  toast.info(pinned ? "已置顶到列表顶部" : "已取消置顶");
                }}
                size="sm"
                variant="ghost"
              >
                {isPinned ? (
                  <IconPinnedOff aria-hidden className="size-3.5" />
                ) : (
                  <IconPinned aria-hidden className="size-3.5" />
                )}
                {isPinned ? "取消置顶" : "置顶卡片"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {!task && detailQuery.isPending ? (
          <div
            aria-label="正在加载任务内容"
            className="task-rail-loading"
            role="status"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!task && detailQuery.error ? (
          <div className="task-rail-modal-error-card" role="alert">
            <div className="task-rail-modal-error-head">
              <strong>{"任务详情暂时无法读取"}</strong>
              <Button
                onClick={() => void detailQuery.refetch()}
                size="sm"
                variant="outline"
              >
                {"重新加载"}
              </Button>
            </div>
            <p>{detailQuery.error.message}</p>
          </div>
        ) : null}

        {task ? (
          <>
            {task.error && parsedError ? (
              <div className="task-rail-modal-error-card" role="status">
                <div className="task-rail-modal-error-head">
                  <span className="task-rail-modal-error-title">
                    <IconAlertTriangle aria-hidden className="size-4" />
                    <strong>{parsedError.title}</strong>
                  </span>
                  <Button
                    onClick={() => {
                      void copyText(task.error ?? "");
                      toast.info("已复制错误信息");
                    }}
                    size="xs"
                    variant="ghost"
                  >
                    <IconCopy aria-hidden className="size-3.5" />
                    {"复制"}
                  </Button>
                </div>
                {parsedError.hint ? (
                  <p className="task-rail-modal-error-hint">
                    {parsedError.hint}
                  </p>
                ) : null}
                {task.status === "queued" ? (
                  <p className="task-rail-modal-meta-note">
                    {`下次尝试时间：${taskDate(task.nextAttemptAt)}`}
                  </p>
                ) : null}
                {showRawError ? (
                  <details className="task-rail-modal-raw-details">
                    <summary>{"查看原始错误详情"}</summary>
                    <pre>{task.error}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div
              aria-label="任务详情分区"
              className="task-rail-modal-tabs"
              role="tablist"
            >
              <button
                aria-selected={tab === "overview"}
                className="task-rail-modal-tab"
                data-active={tab === "overview" || undefined}
                onClick={() => setTab("overview")}
                role="tab"
                type="button"
              >
                {"概览与成果"}
              </button>
              <button
                aria-selected={tab === "events"}
                className="task-rail-modal-tab"
                data-active={tab === "events" || undefined}
                onClick={() => setTab("events")}
                role="tab"
                type="button"
              >
                {`执行日志${events.length > 0 ? ` (${events.length})` : ""}`}
              </button>
              <button
                aria-selected={tab === "trace"}
                className="task-rail-modal-tab"
                data-active={tab === "trace" || undefined}
                onClick={() => setTab("trace")}
                role="tab"
                type="button"
              >
                {"执行轨迹"}
              </button>
            </div>

            {tab === "overview" ? (
              <div className="task-rail-modal-sections">
                {task.summary ? (
                  <section className="task-rail-modal-card task-rail-modal-deliverable">
                    <div className="task-rail-modal-card-head">
                      <h4>{"交付结果"}</h4>
                      <Button
                        onClick={() => {
                          void copyText(task.summary ?? "");
                          toast.info("已复制交付结果");
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        <IconCopy aria-hidden className="size-3.5" />
                        {"复制"}
                      </Button>
                    </div>
                    <p className="task-rail-modal-prose">{task.summary}</p>
                  </section>
                ) : null}

                {task.artifacts.length > 0 ? (
                  <section className="task-rail-modal-card">
                    <h4>{`交付附件 (${task.artifacts.length})`}</h4>
                    <div className="task-rail-modal-artifacts">
                      {task.artifacts.map((artifact, index) => (
                        <ModalArtifact
                          artifact={artifact}
                          key={`${artifact.name}-${index}`}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {task.dependencies.length > 0 ? (
                  <section className="task-rail-modal-card">
                    <h4>{"前序依赖任务"}</h4>
                    <ul className="task-rail-modal-rel-list">
                      {task.dependencies.map((depId) => {
                        const dep = allTasks.find((item) => item.id === depId);
                        return (
                          <li key={depId}>
                            <button
                              className="task-rail-modal-rel-btn"
                              onClick={() => onSelectTask(depId)}
                              type="button"
                            >
                              <span className="task-rail-modal-rel-title">
                                {dep?.title ?? `任务 ${depId}`}
                              </span>
                              <span
                                className="task-rail-modal-rel-status"
                                data-tone={modalToneForTask(dep)}
                              >
                                {dep
                                  ? STATUS_LABELS[dep.status]
                                  : "查看任务详情"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}

                {children.length > 0 ? (
                  <section className="task-rail-modal-card">
                    <h4>{`子任务与执行计划 (${children.length})`}</h4>
                    <ol className="task-rail-modal-rel-list">
                      {children.map((child, index) => (
                        <li key={child.id}>
                          <button
                            className="task-rail-modal-rel-btn"
                            onClick={() => onSelectTask(child.id)}
                            type="button"
                          >
                            <span className="task-rail-modal-step-num">
                              {index + 1}
                            </span>
                            <span className="task-rail-modal-rel-title">
                              {child.title}
                            </span>
                            <span
                              className="task-rail-modal-rel-status"
                              data-tone={modalToneForTask(child)}
                            >
                              {STATUS_LABELS[child.status]}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}

                <section className="task-rail-modal-card">
                  <div className="task-rail-modal-card-head">
                    <h4>{"任务目标与要求"}</h4>
                    {task.parentId ? (
                      <Button
                        onClick={() => {
                          if (task.parentId) onSelectTask(task.parentId);
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        <IconArrowLeft aria-hidden className="size-3.5" />
                        {"上级任务"}
                      </Button>
                    ) : null}
                  </div>
                  <p className="task-rail-modal-prose">
                    {task.description || "未填写详细描述"}
                  </p>
                  {safeTaskUrl(task.sourceUrl) ? (
                    <a
                      className="task-rail-modal-ext-link"
                      href={safeTaskUrl(task.sourceUrl)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {"打开原始来源"}
                      <IconExternalLink aria-hidden className="size-3.5" />
                    </a>
                  ) : null}
                </section>

                {task.completion ? (
                  <section className="task-rail-modal-card">
                    <h4>{"完成标准"}</h4>
                    <p className="task-rail-modal-prose">
                      {task.completion.criteria}
                    </p>
                  </section>
                ) : null}

                <details className="task-rail-modal-details">
                  <summary>
                    {`执行配置与用量（L${task.level} · ${RISK_LABELS[task.risk]} · 优先级 ${task.priority}）`}
                  </summary>
                  {task.assessment ? (
                    <p className="task-rail-modal-prose">{task.assessment}</p>
                  ) : null}
                  <dl className="task-rail-modal-dl">
                    <dt>{"自主等级"}</dt>
                    <dd>{`L${task.level} · ${TASK_LEVEL_LABELS[task.level]}`}</dd>
                    <dt>{"操作范围"}</dt>
                    <dd>{RISK_LABELS[task.risk]}</dd>
                    <dt>{"开始时间"}</dt>
                    <dd>{taskDate(task.startedAt)}</dd>
                    <dt>{"结束时间"}</dt>
                    <dd>
                      {task.finishedAt ? taskDate(task.finishedAt) : "尚未结束"}
                    </dd>
                    <dt>{"尝试次数"}</dt>
                    <dd>{`${task.attempts} / ${task.maxAttempts}`}</dd>
                    <dt>{"单次时限"}</dt>
                    <dd>{`${Math.round(task.timeoutSeconds / 60)} 分钟`}</dd>
                    <dt>{"Token 用量"}</dt>
                    <dd>
                      {`输入 ${task.usage.inputTokens ?? "—"} / 输出 ${task.usage.outputTokens ?? "—"}`}
                    </dd>
                    <dt>{"任务 ID"}</dt>
                    <dd className="task-rail-modal-mono">{task.id}</dd>
                  </dl>
                </details>
              </div>
            ) : tab === "events" ? (
              <div aria-live="polite" className="task-rail-modal-events">
                {detailQuery.isPending && events.length === 0 ? (
                  <p className="task-rail-modal-empty">{"正在读取执行日志…"}</p>
                ) : events.length === 0 ? (
                  <p className="task-rail-modal-empty">
                    {"任务启动后，这里会实时记录规划、工具执行和状态变更。"}
                  </p>
                ) : (
                  events.map((event) => (
                    <article className="task-rail-modal-event" key={event.id}>
                      <div className="task-rail-modal-event-meta">
                        <time dateTime={event.createdAt}>
                          {taskDate(event.createdAt)}
                        </time>
                        <span>{event.type}</span>
                      </div>
                      <p>{event.message}</p>
                      {Object.keys(event.data).length > 0 ? (
                        <details className="task-rail-modal-raw-details">
                          <summary>{"查看附加上下文"}</summary>
                          <pre>{JSON.stringify(event.data, null, 2)}</pre>
                        </details>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            ) : (
              <ModalTaskTracePanel task={task} />
            )}
          </>
        ) : null}
      </DialogBody>

      <DialogFooter className="task-rail-modal-footer">
        <Button onClick={onClose} size="sm" variant="outline">
          {"完成"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ModalArtifact({ artifact }: { artifact: TaskArtifact }) {
  const url = safeTaskUrl(artifact.uri);
  const download = () => {
    const objectUrl = URL.createObjectURL(
      new Blob([artifact.content ?? ""], {
        type: artifact.mediaType ?? "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = artifact.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  };
  return (
    <article className="task-rail-modal-artifact">
      <div className="task-rail-modal-artifact-head">
        <strong>{artifact.name}</strong>
        <div className="task-rail-modal-artifact-btns">
          {url ? (
            <a
              className="task-rail-modal-ext-link"
              href={url}
              rel="noreferrer"
              target="_blank"
            >
              {"打开"}
              <IconExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : null}
          {artifact.content !== undefined ? (
            <Button onClick={download} size="xs" variant="ghost">
              <IconDownload aria-hidden className="size-3.5" />
              {"下载"}
            </Button>
          ) : null}
        </div>
      </div>
      {artifact.uri && !url ? (
        <p className="task-rail-modal-mono">{artifact.uri}</p>
      ) : null}
      {artifact.content ? (
        <details className="task-rail-modal-raw-details">
          <summary>{"预览内容"}</summary>
          <pre>{artifact.content}</pre>
        </details>
      ) : null}
    </article>
  );
}

const TRACE_KIND_LABELS: Record<string, string> = {
  RUN_STARTED: "回合开始",
  TOOL_CALL_START: "工具调用",
  TOOL_CALL_END: "调用完成",
  TOOL_CALL_RESULT: "工具结果",
  TEXT_MESSAGE: "回复",
  RUN_FINISHED: "回合完成",
  RUN_ERROR: "出错",
};

function traceThreadTitle(thread: string): string {
  const parts = thread.split(":");
  const tag = parts[2];
  const attempt = parts.at(-1);
  const name = tag === "plan" ? "规划" : tag === "run" ? "执行" : tag || "回合";
  return attempt ? `${name} · 第 ${attempt} 次` : name;
}

function traceUsageLine(usage: TaskTraceEvent["usage"]): string {
  if (!usage) return "";
  return `模型调用 ${usage.modelCalls ?? "—"} · 输入 ${usage.inputTokens ?? "—"} · 输出 ${usage.outputTokens ?? "—"}`;
}

function ModalTaskTracePanel({ task }: { task: TaskCenterTask }) {
  const running = ACTIVE_STATUSES.includes(task.status);
  const trace = useQuery({
    ...taskTraceOptions(task.id),
    refetchInterval: running ? 30_000 : false,
  });
  const threads = trace.data?.threads ?? [];

  return (
    <div aria-live="polite" className="task-rail-modal-events">
      <div className="task-rail-modal-trace-head">
        <Button
          disabled={trace.isFetching}
          onClick={() => void trace.refetch()}
          size="xs"
          variant="ghost"
        >
          <IconRefresh aria-hidden className="size-3.5" />
          {"刷新轨迹"}
        </Button>
        {running ? (
          <span className="task-rail-modal-meta-note">
            {"执行中每 30 秒自动刷新"}
          </span>
        ) : null}
      </div>
      {trace.isPending ? (
        <p className="task-rail-modal-empty">{"正在加载执行轨迹…"}</p>
      ) : trace.error ? (
        <p className="task-rail-modal-empty">{trace.error.message}</p>
      ) : threads.length === 0 ? (
        <p className="task-rail-modal-empty">
          {running
            ? "执行线程尚未产生轨迹事件，请稍后刷新。"
            : "该任务未记录本地会话轨迹。"}
        </p>
      ) : (
        threads.map((thread) => (
          <section className="task-rail-modal-card" key={thread.thread}>
            <h4>{traceThreadTitle(thread.thread)}</h4>
            <div className="task-rail-modal-events">
              {thread.events.map((event) => (
                <article className="task-rail-modal-event" key={event.sequence}>
                  <div className="task-rail-modal-event-meta">
                    <time dateTime={event.at}>{taskDate(event.at)}</time>
                    <span>{TRACE_KIND_LABELS[event.type] ?? event.type}</span>
                  </div>
                  <p>{event.summary}</p>
                  {event.usage ? (
                    <span className="task-rail-modal-meta-note">
                      {traceUsageLine(event.usage)}
                    </span>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function stepTone(status: WorkflowStepStatus): string {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting_approval") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

function StepStatusIcon({ status }: { status: WorkflowStepStatus }) {
  if (status === "succeeded")
    return <IconCircleCheck aria-hidden className="size-4" />;
  if (status === "failed")
    return <IconCircleX aria-hidden className="size-4" />;
  if (status === "waiting_approval")
    return <IconAlertTriangle aria-hidden className="size-4" />;
  if (status === "cancelled" || status === "skipped")
    return <IconCircleOff aria-hidden className="size-4" />;
  return <IconCircleDashed aria-hidden className="size-4" />;
}

function WorkflowRunModalContent({
  target,
  sortedSectionIds,
  canGoBack,
  onBack,
  onClose,
}: {
  target: Extract<RailDetailTarget, { kind: "workflow" }>;
  sortedSectionIds: Record<RailOrderSection, string[]>;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const orderMap = useTaskRailOrder();
  const [tab, setTab] = useState<"steps" | "events">("steps");
  const [comment, setComment] = useState("");
  useEffect(() => {
    setTab("steps");
    setComment("");
  }, [target.runId]);

  const runQuery = useQuery(workflowRunQueryOptions(target.runId));
  const run = runQuery.data ?? target.initialRun;

  const isPinned =
    target.section && target.orderItemId
      ? orderMap[target.section].pinned.includes(target.orderItemId)
      : false;

  const refreshWorkflows = () => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.all });
  };

  const approve = useMutation({
    mutationFn: ({
      stepId,
      decision,
    }: {
      stepId: string;
      decision: "approve" | "reject";
    }) =>
      workflowsApi.approve(
        target.runId,
        stepId,
        decision,
        comment.trim() || undefined,
      ),
    onSuccess: (_, vars) => {
      setComment("");
      refreshWorkflows();
      toast.success(
        vars.decision === "approve" ? "已批准该步骤" : "已打回/拒绝该步骤",
      );
    },
    onError: (err) => {
      if (isStaleErr(err)) {
        refreshWorkflows();
        toast.info(err instanceof Error ? err.message : "这一步已经处理过了。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "审批操作失败");
    },
  });

  const cancelRun = useMutation({
    mutationFn: () => workflowsApi.cancel(target.runId),
    onSuccess: () => {
      refreshWorkflows();
      toast.success("工作流已停止");
    },
    onError: (err) => {
      if (isStaleErr(err)) {
        refreshWorkflows();
        toast.info("该工作流运行已结束。");
        return;
      }
      toast.error(err instanceof Error ? err.message : "停止失败");
    },
  });

  const retryRun = useMutation({
    mutationFn: (mode: "targeted_fix" | "full_redo") =>
      workflowsApi.retry(target.runId, { mode }),
    onSuccess: () => {
      refreshWorkflows();
      toast.success("工作流已重新启动");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "重试失败");
    },
  });

  const totalSteps = run?.steps.length ?? 0;
  const doneSteps =
    run?.steps.filter((s) => s.status === "succeeded" || s.status === "skipped")
      .length ?? 0;
  const waitingStep = run?.steps.find((s) => s.status === "waiting_approval");
  const isActive = run ? ACTIVE_RUN_STATUSES.includes(run.status) : false;
  const canRetry = run?.status === "failed" || run?.status === "cancelled";

  const tone =
    run?.status === "failed"
      ? "danger"
      : run?.status === "succeeded"
        ? "success"
        : run?.status === "waiting_approval"
          ? "warning"
          : run?.status === "cancelled"
            ? "neutral"
            : "info";

  const downloadOutput = () => {
    if (!run?.output) return;
    const ext =
      run.outputFormat === "json"
        ? "json"
        : run.outputFormat === "markdown"
          ? "md"
          : "txt";
    const objectUrl = URL.createObjectURL(
      new Blob([run.output], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${run.workflowName || "workflow-output"}.${ext}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  };

  return (
    <DialogContent
      className="task-rail-detail-dialog"
      data-testid="task-rail-detail-dialog"
      data-tone={tone}
      overlayClassName="task-rail-detail-overlay"
    >
      <DialogHeader className="task-rail-modal-header">
        <div className="task-rail-modal-badges">
          {canGoBack ? (
            <button
              className="task-rail-modal-back"
              onClick={onBack}
              type="button"
            >
              <IconArrowLeft aria-hidden className="size-3.5" />
              {"返回"}
            </button>
          ) : null}
          <span className="task-rail-kind-pill">
            <IconGitBranch aria-hidden className="size-3.5" />
            {"工作流"}
          </span>
          {run ? (
            <span className="task-rail-modal-status" data-tone={tone}>
              {RUN_STATUS_LABEL[run.status]}
            </span>
          ) : null}
          {isPinned ? (
            <span className="task-rail-pin-badge">
              <IconPinned aria-hidden className="size-3" />
              {"已置顶"}
            </span>
          ) : null}
        </div>
        <DialogTitle className="task-rail-modal-title">
          {run
            ? `${run.icon ? `${run.icon} ` : ""}${run.workflowName}`
            : "正在加载工作流详情…"}
        </DialogTitle>
        <DialogDescription className="task-rail-modal-subtitle">
          {run
            ? `已完成 ${doneSteps}/${totalSteps} 步 · 启动于 ${taskDate(run.startedAt ?? run.createdAt)}`
            : "正在同步工作流步骤状态"}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="task-rail-modal-body">
        {run?.status === "waiting_approval" && waitingStep ? (
          <section aria-label="步骤审批" className="task-rail-modal-decision">
            <div className="task-rail-modal-decision-head">
              <span className="task-rail-modal-decision-tag">
                <IconShieldCheck aria-hidden className="size-4" />
                {`等待审批 · ${waitingStep.name}`}
              </span>
            </div>
            {waitingStep.approval?.note ? (
              <p className="task-rail-modal-decision-summary">
                {waitingStep.approval.note}
              </p>
            ) : null}
            <Input
              onChange={(e) => setComment(e.target.value)}
              placeholder="可选：填写审批备注或打回修改意见"
              value={comment}
            />
            <div className="task-rail-modal-decision-actions">
              <Button
                disabled={approve.isPending}
                mutation={approve}
                mutationWhen={approve.variables?.decision === "approve"}
                onClick={() =>
                  approve.mutate({
                    stepId: waitingStep.id,
                    decision: "approve",
                  })
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
                  approve.mutate({
                    stepId: waitingStep.id,
                    decision: "reject",
                  })
                }
                size="sm"
                variant="outline"
              >
                <IconX aria-hidden className="size-3.5" />
                {"打回/拒绝"}
              </Button>
            </div>
          </section>
        ) : null}

        {isActive || canRetry || (target.section && target.orderItemId) ? (
          <div className="task-rail-modal-toolbar">
            {isActive ? (
              <Button
                disabled={cancelRun.isPending}
                mutation={cancelRun}
                onClick={() => cancelRun.mutate()}
                size="sm"
                variant="destructive"
              >
                <IconPlayerStop aria-hidden className="size-3.5" />
                {"停止运行"}
              </Button>
            ) : null}
            {canRetry ? (
              <>
                <Button
                  disabled={retryRun.isPending}
                  mutation={retryRun}
                  mutationWhen={retryRun.variables === "targeted_fix"}
                  onClick={() => retryRun.mutate("targeted_fix")}
                  size="sm"
                >
                  <IconRefresh aria-hidden className="size-3.5" />
                  {"断点续跑"}
                </Button>
                <Button
                  disabled={retryRun.isPending}
                  mutation={retryRun}
                  mutationWhen={retryRun.variables === "full_redo"}
                  onClick={() => retryRun.mutate("full_redo")}
                  size="sm"
                  variant="outline"
                >
                  <IconPlayerPlay aria-hidden className="size-3.5" />
                  {"全新重跑"}
                </Button>
              </>
            ) : null}
            {target.section && target.orderItemId ? (
              <Button
                onClick={() => {
                  const { section, orderItemId } = target;
                  if (!section || !orderItemId) return;
                  const pinned = toggleRailItemPin(
                    section,
                    sortedSectionIds[section],
                    orderItemId,
                  );
                  toast.info(pinned ? "已置顶到列表顶部" : "已取消置顶");
                }}
                size="sm"
                variant="ghost"
              >
                {isPinned ? (
                  <IconPinnedOff aria-hidden className="size-3.5" />
                ) : (
                  <IconPinned aria-hidden className="size-3.5" />
                )}
                {isPinned ? "取消置顶" : "置顶卡片"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {run ? (
          <>
            {run.error ? (
              <div className="task-rail-modal-error-card" role="status">
                <div className="task-rail-modal-error-head">
                  <span className="task-rail-modal-error-title">
                    <IconAlertTriangle aria-hidden className="size-4" />
                    <strong>{formatRailErrorSummary(run.error)}</strong>
                  </span>
                </div>
                {isMachineErrorDump(run.error) ? (
                  <details className="task-rail-modal-raw-details">
                    <summary>{"查看原始错误详情"}</summary>
                    <pre>{run.error}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="task-rail-modal-meters">
              <div className="task-rail-modal-meter">
                <span>{"步骤进度"}</span>
                <strong>{`${doneSteps} / ${totalSteps}`}</strong>
              </div>
              <div className="task-rail-modal-meter">
                <span>{"Token 用量"}</span>
                <strong>{`${tokensText(run.usage.tokens)} / ${tokensText(run.limits.maxTokens)}`}</strong>
              </div>
              <div className="task-rail-modal-meter">
                <span>{"累计耗时"}</span>
                <strong>{durationText(run.usage.elapsedMs)}</strong>
              </div>
            </div>

            <div
              aria-label="工作流详情分区"
              className="task-rail-modal-tabs"
              role="tablist"
            >
              <button
                aria-selected={tab === "steps"}
                className="task-rail-modal-tab"
                data-active={tab === "steps" || undefined}
                onClick={() => setTab("steps")}
                role="tab"
                type="button"
              >
                {`步骤与产出 (${totalSteps})`}
              </button>
              <button
                aria-selected={tab === "events"}
                className="task-rail-modal-tab"
                data-active={tab === "events" || undefined}
                onClick={() => setTab("events")}
                role="tab"
                type="button"
              >
                {`运行记录${run.events?.length ? ` (${run.events.length})` : ""}`}
              </button>
            </div>

            {tab === "steps" ? (
              <div className="task-rail-modal-sections">
                {run.output ? (
                  <section className="task-rail-modal-card task-rail-modal-deliverable">
                    <div className="task-rail-modal-card-head">
                      <h4>{"最终产出"}</h4>
                      <div className="task-rail-modal-artifact-btns">
                        <Button
                          onClick={() => {
                            void copyText(run.output ?? "");
                            toast.info("已复制最终产出");
                          }}
                          size="xs"
                          variant="ghost"
                        >
                          <IconCopy aria-hidden className="size-3.5" />
                          {"复制"}
                        </Button>
                        <Button
                          onClick={downloadOutput}
                          size="xs"
                          variant="ghost"
                        >
                          <IconDownload aria-hidden className="size-3.5" />
                          {"下载"}
                        </Button>
                      </div>
                    </div>
                    <pre className="task-rail-modal-output-pre">
                      {run.output}
                    </pre>
                  </section>
                ) : null}

                <section className="task-rail-modal-card">
                  <h4>{"执行步骤"}</h4>
                  <ol className="task-rail-modal-step-list">
                    {run.steps.map((step, idx) => (
                      <li
                        className="task-rail-modal-step-item"
                        data-tone={stepTone(step.status)}
                        key={step.id}
                      >
                        <div className="task-rail-modal-step-head">
                          <span className="task-rail-modal-step-title">
                            <StepStatusIcon status={step.status} />
                            <strong>{`${idx + 1}. ${step.name}`}</strong>
                          </span>
                          <span
                            className="task-rail-modal-rel-status"
                            data-tone={stepTone(step.status)}
                          >
                            {STEP_STATUS_LABEL[step.status]}
                          </span>
                        </div>
                        <p className="task-rail-modal-meta-note">
                          {`${step.roleName}${step.botName ? `（${step.botName}）` : ""}${step.group ? ` · 并行组 ${step.group}` : ""}${step.tokens > 0 ? ` · ${tokensText(step.tokens)} tokens` : ""}`}
                        </p>
                        {step.error ? (
                          <p className="task-rail-modal-step-error">
                            {formatRailErrorSummary(step.error)}
                          </p>
                        ) : null}
                        {step.output ? (
                          <details className="task-rail-modal-raw-details">
                            <summary>{"查看步骤输出"}</summary>
                            <pre>{step.output}</pre>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>

                {Object.keys(run.inputs).length > 0 ? (
                  <details className="task-rail-modal-details">
                    <summary>{"查看运行输入参数"}</summary>
                    <dl className="task-rail-modal-dl">
                      {Object.entries(run.inputs).map(([k, v]) => (
                        <div className="task-rail-modal-dl-row" key={k}>
                          <dt>{k}</dt>
                          <dd>{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ) : null}
              </div>
            ) : (
              <div aria-live="polite" className="task-rail-modal-events">
                {!run.events?.length ? (
                  <p className="task-rail-modal-empty">
                    {"暂无运行事件记录。"}
                  </p>
                ) : (
                  run.events.map((ev) => (
                    <article className="task-rail-modal-event" key={ev.id}>
                      <div className="task-rail-modal-event-meta">
                        <time dateTime={ev.at}>{taskDate(ev.at)}</time>
                        <span>{ev.kind}</span>
                      </div>
                      <p>{ev.message}</p>
                    </article>
                  ))
                )}
              </div>
            )}
          </>
        ) : null}
      </DialogBody>

      <DialogFooter className="task-rail-modal-footer">
        <Button onClick={onClose} size="sm" variant="outline">
          {"完成"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
