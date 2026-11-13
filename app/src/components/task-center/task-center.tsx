import {
  IconActivity,
  IconAdjustments,
  IconArrowUpRight,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconHistory,
  IconInbox,
  IconListDetails,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { AgentsRailCard } from "@/components/panels/agents-rail-card";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  decisionListOptions,
  taskCenterApi,
  taskCenterCapabilityOptions,
  taskCenterKeys,
  taskCenterSnapshotOptions,
  taskListOptions,
} from "@/lib/task-center-api";
import { cn } from "@/lib/utils";
import {
  activeTaskCount,
  TASK_CATEGORIES,
  type TaskCapability,
  type TaskCategory,
  type TaskCenterDecision,
  type TaskCenterTask,
  type TaskListView,
} from "../../../../shared/task-center";
import { ContextSettings } from "./context-settings";
import { CreateTask } from "./create-task";
import {
  CATEGORY_LABELS,
  formatExecutorLabel,
  RISK_LABELS,
  taskDate,
} from "./labels";
import { SourceSettings } from "./source-settings";
import { TaskDetail, TaskStatusBadge } from "./task-detail";
import "./task-center.css";

export type TaskCenterView =
  | "inbox"
  | "outbox"
  | "active"
  | "history"
  | "sources"
  | "context"
  | "capabilities";
const views = [
  { id: "inbox", label: "Inbox", icon: IconInbox },
  { id: "outbox", label: "Outbox", icon: IconSend },
  { id: "active", label: "进行中", icon: IconActivity },
  { id: "history", label: "历史", icon: IconHistory },
  { id: "sources", label: "信息源", icon: IconAdjustments },
  { id: "context", label: "我的上下文", icon: IconUser },
  { id: "capabilities", label: "工具与 Agent", icon: IconListDetails },
] as const;
const titles: Record<TaskCenterView, string> = {
  inbox: "等待安排的事项",
  outbox: "需要你确认",
  active: "正在推进",
  history: "历史与交付",
  sources: "巡检信息源",
  context: "我的工作上下文",
  capabilities: "工具与 Agent",
};
const descriptions: Partial<Record<TaskCenterView, string>> = {
  inbox: "主动发现的待办和你交付的目标，统一在这里安排。",
  outbox: "查看拟执行的具体内容，批准后继续，拒绝则停止这项操作。",
  active: "跟踪执行、等待和暂停的任务，随时查看进度或介入。",
  history: "查看已交付成果、失败原因和取消记录。",
};

export function TaskCenter({
  view,
  taskId,
  onNavigate,
}: {
  view: TaskCenterView;
  taskId?: string;
  onNavigate: (view: TaskCenterView, taskId?: string) => void;
}) {
  const snapshot = useQuery(taskCenterSnapshotOptions());
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const taskView = ["inbox", "active", "history"].includes(view);
  const tasks = useInfiniteQuery(
    taskListOptions(
      {
        view: taskView ? (view as TaskListView) : "inbox",
        ...(category ? { category: category as TaskCategory } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      },
      taskView,
    ),
  );
  const decisions = useInfiniteQuery(
    decisionListOptions("pending", view === "outbox"),
  );
  const resolved = useInfiniteQuery(
    decisionListOptions("resolved", view === "outbox"),
  );
  const navigation = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切视图是有意的触发——回到列表顶
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    nav.closest(".page-scroll")?.scrollTo({ top: 0 });
    // Deep links and desktop → phone resizing must keep the selected section visible.
    // Scroll only this strip, not the modal or the page underneath it.
    const revealSelection = () => {
      const selected = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!selected || nav.scrollWidth <= nav.clientWidth) return;
      const item = selected.getBoundingClientRect();
      const strip = nav.getBoundingClientRect();
      nav.scrollLeft +=
        item.left - strip.left - (nav.clientWidth - item.width) / 2;
    };
    revealSelection();
    const resize = new ResizeObserver(revealSelection);
    resize.observe(nav);
    return () => resize.disconnect();
  }, [view]);
  const data = snapshot.data;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
  };
  const pending = [
    ...new Map(
      decisions.data?.pages
        .flatMap((page) => page.outbox)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const handled = [
    ...new Map(
      resolved.data?.pages
        .flatMap((page) => page.outbox)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const activeCount = data ? activeTaskCount(data.counts) : 0;
  const displayed = [
    ...new Map(
      tasks.data?.pages
        .flatMap((page) => page.tasks)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const pendingCount =
    data?.decisionCounts?.pending ??
    data?.outbox.filter((item) => item.status === "pending").length ??
    0;
  const sourceErrors =
    data?.sources.filter((source) => source.lastStatus === "failed").length ??
    0;
  const tasksFailed =
    tasks.isError || (!tasks.data && tasks.errorUpdateCount > 0);
  const decisionsFailed =
    decisions.isError || (!decisions.data && decisions.errorUpdateCount > 0);
  const resolvedFailed =
    resolved.isError || (!resolved.data && resolved.errorUpdateCount > 0);
  return (
    <PageShell
      title="任务中心"
      width="wide"
      className="tc-page"
      description="把目标交给机器人，在这里掌握进展与关键决策。"
      action={
        <Button ref={createTrigger} onClick={() => setCreateOpen(true)}>
          <IconPlus />
          新建任务
        </Button>
      }
    >
      <div className="tc-service-bar">
        <details className="tc-service-help">
          <summary
            className="tc-service-state"
            data-running={data?.running ?? false}
          >
            <span aria-hidden />
            {data
              ? data.running
                ? "后台巡检运行中"
                : "后台巡检已停止"
              : "正在连接任务中心"}
          </summary>
          <p className="tc-service-note">
            {data?.running
              ? "后台正在按信息源设置检查待办，任务进展会显示在这里。"
              : "保存的任务会保留，服务恢复后继续检查。"}
          </p>
        </details>
        {data ? (
          <span className="tc-muted">
            每人最多并行 {data.concurrency} 个任务
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          state={snapshot.isFetching ? "pending" : "idle"}
          feedback={{
            pending: "刷新中…",
            success: "已刷新",
            error: "刷新失败",
          }}
        >
          <IconRefresh />
          刷新
        </Button>
      </div>
      <nav ref={navigation} className="tc-nav" aria-label="任务中心分区">
        {views.map(({ id, label, icon: Icon }) => {
          const count =
            id === "inbox"
              ? (data?.counts.inbox ?? 0)
              : id === "outbox"
                ? pendingCount
                : id === "active"
                  ? activeCount
                  : id === "sources"
                    ? sourceErrors
                    : 0;
          return (
            <button
              key={id}
              type="button"
              aria-current={view === id ? "page" : undefined}
              aria-label={count ? `${label}，${count} 项` : label}
              className={cn("tc-nav-item", view === id && "is-active")}
              onClick={() => onNavigate(id)}
            >
              <Icon size={17} aria-hidden />
              <span>{label}</span>
              {id === "inbox" ||
              id === "outbox" ||
              id === "active" ||
              id === "sources" ? (
                <span
                  className="tc-nav-count"
                  aria-hidden="true"
                  data-empty={!count}
                >
                  {count > 99 ? "99+" : count || "0"}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      {snapshot.error ? (
        <div className="tc-error" role="alert">
          <strong>任务中心暂时无法加载</strong>
          <p>{snapshot.error.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void snapshot.refetch()}
          >
            重新连接
          </Button>
        </div>
      ) : null}
      {snapshot.isPending ? <PageSkeleton rows={4} /> : null}
      {data ? (
        <div className={cn("tc-workspace", taskId && "has-detail")}>
          <div className="tc-main">
            {view !== "sources" && view !== "context" ? (
              <div className="tc-section-heading">
                <h2>{titles[view]}</h2>
                {descriptions[view] ? (
                  <p className="tc-muted">{descriptions[view]}</p>
                ) : null}
              </div>
            ) : null}
            {taskView ? (
              <>
                <div className="tc-filterbar">
                  <label className="tc-search">
                    <IconSearch size={17} aria-hidden />
                    <Input
                      aria-label="搜索任务"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索任务和交付结果"
                      maxLength={500}
                    />
                  </label>
                  <select
                    className="tc-select"
                    aria-label="按分类筛选任务"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="">全部分类</option>
                    {TASK_CATEGORIES.map((value) => (
                      <option key={value} value={value}>
                        {CATEGORY_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
                {tasksFailed ? (
                  <ListError
                    error={tasks.error}
                    retry={() => tasks.refetch({ throwOnError: true })}
                  />
                ) : null}
                {tasks.isPending && !tasksFailed ? (
                  <PageSkeleton rows={3} />
                ) : displayed.length ? (
                  <ul className="tc-task-list">
                    {displayed.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        selected={task.id === taskId}
                        onSelect={() => onNavigate(view, task.id)}
                      />
                    ))}
                  </ul>
                ) : !tasksFailed ? (
                  <div className="tc-empty">
                    <IconInbox size={30} aria-hidden />
                    <h3>
                      {search || category
                        ? "没有匹配的任务"
                        : view === "inbox"
                          ? "Inbox 暂时没有待办"
                          : view === "active"
                            ? "当前没有进行中的任务"
                            : "尚无历史记录"}
                    </h3>
                    <p>
                      {search || category
                        ? "换个关键词，或查看全部分类。"
                        : view === "inbox"
                          ? "添加信息源，让机器人定期发现值得推进的事项。也可以直接交付一个目标。"
                          : view === "active"
                            ? "从 Inbox 选一项开始，计划与进度会出现在这里。"
                            : "任务完成后，可以在这里重新打开成果与执行记录。"}
                    </p>
                    {view === "inbox" && !search && !category ? (
                      <Button
                        variant="outline"
                        onClick={() => onNavigate("sources")}
                      >
                        配置信息源
                        <IconArrowUpRight />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {tasks.data ? (
                  <ListMore
                    shown={displayed.length}
                    total={tasks.data.pages[0]?.total ?? 0}
                    hasMore={tasks.hasNextPage}
                    loading={tasks.isFetchingNextPage}
                    onMore={() => void tasks.fetchNextPage()}
                  />
                ) : null}
              </>
            ) : null}
            {view === "outbox" ? (
              <>
                {decisionsFailed ? (
                  <ListError
                    error={decisions.error}
                    retry={() => decisions.refetch({ throwOnError: true })}
                  />
                ) : null}
                {decisions.isPending && !decisionsFailed ? (
                  <PageSkeleton rows={2} />
                ) : null}
                <div className="tc-decisions">
                  {pending.map((decision) => (
                    <Decision
                      key={decision.id}
                      decision={decision}
                      onChanged={refresh}
                      onTask={() => onNavigate("outbox", decision.taskId)}
                    />
                  ))}
                </div>
                {!pending.length && decisions.isSuccess ? (
                  <div className="tc-empty">
                    <IconCircleCheck size={30} aria-hidden />
                    <h3>暂时没有待确认事项</h3>
                    <p>重要决策、对外沟通与敏感操作会集中到这里。</p>
                  </div>
                ) : null}
                {decisions.data ? (
                  <ListMore
                    shown={pending.length}
                    total={decisions.data.pages[0]?.total ?? 0}
                    hasMore={decisions.hasNextPage}
                    loading={decisions.isFetchingNextPage}
                    onMore={() => void decisions.fetchNextPage()}
                  />
                ) : null}
                {resolvedFailed ? (
                  <ListError
                    error={resolved.error}
                    retry={() => resolved.refetch({ throwOnError: true })}
                  />
                ) : null}
                {handled.length ? (
                  <details className="tc-decision-history">
                    <summary>已处理的决定</summary>
                    {handled.map((decision) => (
                      <button
                        key={decision.id}
                        type="button"
                        onClick={() => onNavigate("outbox", decision.taskId)}
                      >
                        <span>{decision.proposedAction.title}</span>
                        <span>
                          {decision.status === "approved"
                            ? "已批准"
                            : decision.status === "rejected"
                              ? "已拒绝"
                              : "已替代"}{" "}
                          · {taskDate(decision.decidedAt)}
                        </span>
                      </button>
                    ))}
                    <ListMore
                      shown={handled.length}
                      total={resolved.data?.pages[0]?.total ?? 0}
                      hasMore={resolved.hasNextPage}
                      loading={resolved.isFetchingNextPage}
                      onMore={() => void resolved.fetchNextPage()}
                    />
                  </details>
                ) : null}
              </>
            ) : null}
            {view === "sources" ? (
              <SourceSettings sources={data.sources} onChanged={refresh} />
            ) : null}
            {view === "context" ? <ContextSettings /> : null}
            {view === "capabilities" ? <Capabilities /> : null}
          </div>
          {taskId ? (
            <TaskDetail
              key={taskId}
              id={taskId}
              allTasks={[...data.tasks, ...displayed]}
              onClose={() => onNavigate(view)}
              onSelect={(id) => onNavigate(view, id)}
            />
          ) : null}
        </div>
      ) : null}
      <CreateTask
        finalFocus={createTrigger}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          setCreateOpen(false);
          refresh();
          onNavigate("active", id);
        }}
      />
    </PageShell>
  );
}

function ListError({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => Promise<unknown>;
}) {
  const lastError = useRef(error);
  if (error) lastError.current = error;
  const reload = useAsyncAction(retry, { errorToast: false });
  return (
    <div className="tc-error" role="alert">
      <p>{lastError.current?.message ?? "列表暂时无法加载。"}</p>
      <Button
        variant="ghost"
        state={reload.state}
        feedback="refresh"
        onClick={() => void reload.run()}
      >
        重新加载
      </Button>
    </div>
  );
}
function ListMore({
  shown,
  total,
  hasMore,
  loading,
  onMore,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!total) return null;
  return (
    <div className="tc-actions">
      <span className="tc-meta">
        已显示 {shown} / {total} 项
      </span>
      {hasMore ? (
        <Button variant="outline" size="sm" loading={loading} onClick={onMore}>
          加载更多
        </Button>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: TaskCenterTask;
  selected: boolean;
  onSelect: () => void;
}) {
  const queryClient = useQueryClient();
  const capabilities = queryClient.getQueryData<{
    capabilities: TaskCapability[];
  }>(taskCenterKeys.capabilities)?.capabilities;
  return (
    <li>
      <button
        type="button"
        className={cn("tc-task-row", selected && "is-selected")}
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="tc-task-level" title={`自主程度 L${task.level}`}>
          L{task.level}
        </span>
        <span className="tc-task-copy">
          <span className="tc-task-title">{task.title}</span>
          <span className="tc-task-summary">
            {task.error ?? task.summary ?? task.description}
          </span>
          <span className="tc-meta">
            {CATEGORY_LABELS[task.category]} ·{" "}
            {formatExecutorLabel(task.executor, capabilities)}
            {task.parentId ? " · 子任务" : ""}
            <span className="tc-task-date">{taskDate(task.updatedAt)}</span>
          </span>
        </span>
        <TaskStatusBadge task={task} />
      </button>
    </li>
  );
}
function Decision({
  decision,
  onChanged,
  onTask,
}: {
  decision: TaskCenterDecision;
  onChanged: () => void;
  onTask: () => void;
}) {
  const queryClient = useQueryClient();
  const capabilities = queryClient.getQueryData<{
    capabilities: TaskCapability[];
  }>(taskCenterKeys.capabilities)?.capabilities;
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      taskCenterApi.decide(decision.id, approved),
    onSuccess: onChanged,
  });
  return (
    <article className="tc-decision">
      <div className="tc-decision-title">
        <span className="tc-status" data-status="waiting_approval">
          {RISK_LABELS[decision.proposedAction.risk]}
        </span>
        <time className="tc-meta" dateTime={decision.createdAt}>
          {taskDate(decision.createdAt)}
        </time>
      </div>
      <h3>{decision.proposedAction.title}</h3>
      <p className="tc-prose">{decision.summary}</p>
      <details open>
        <summary>拟执行的内容</summary>
        <p className="tc-prose">{decision.proposedAction.description}</p>
        <p className="tc-meta">
          执行方式：
          {formatExecutorLabel(decision.proposedAction.executor, capabilities)}
        </p>
      </details>
      {decision.notificationError ? (
        <p className="tc-error">通知未送达：{decision.notificationError}</p>
      ) : null}
      {decide.error ? (
        <p className="tc-error" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      <div className="tc-actions">
        <Button
          onClick={() => decide.mutate(true)}
          disabled={decide.isPending}
          state={decide.isPending && decide.variables ? "pending" : "idle"}
        >
          <IconCheck />
          批准并继续
        </Button>
        <Button
          variant="outline"
          onClick={() => decide.mutate(false)}
          disabled={decide.isPending}
          state={decide.isPending && !decide.variables ? "pending" : "idle"}
        >
          <IconX />
          拒绝
        </Button>
        <Button variant="ghost" onClick={onTask}>
          任务详情
          <IconArrowUpRight />
        </Button>
      </div>
    </article>
  );
}
function Capabilities() {
  const query = useQuery(taskCenterCapabilityOptions());
  if (query.isPending) return <PageSkeleton rows={3} />;
  if (query.error)
    return (
      <div className="tc-error" role="alert">
        {query.error.message}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  const capabilities = query.data?.capabilities ?? [];
  return (
    <div className="tc-capabilities">
      <p className="tc-muted">
        执行器和工具的当前可用状态。任务会按实际能力与授权选择执行路径。
      </p>
      <AgentsRailCard />
      {(["executor", "source", "tool"] as const).map((kind) => {
        const entries = capabilities.filter((entry) => entry.kind === kind);
        return entries.length ? (
          <section className="tc-section" key={kind}>
            <h3>
              {kind === "executor"
                ? "执行 Agent"
                : kind === "source"
                  ? "信息源"
                  : "工具"}
            </h3>
            <ul>
              {entries.map((entry) => (
                <li key={entry.id}>
                  <span className="tc-capability-icon">
                    {entry.available ? (
                      <IconCheck size={18} />
                    ) : (
                      <IconClock size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{entry.name}</strong>
                    <p>{entry.detail}</p>
                  </div>
                  <span
                    className="tc-status"
                    data-status={entry.available ? "succeeded" : "paused"}
                  >
                    {entry.available ? "可用" : "待配置"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
      {!capabilities.length ? (
        <p className="tc-notice">尚未报告可用能力，请检查服务器执行器配置。</p>
      ) : null}
    </div>
  );
}
