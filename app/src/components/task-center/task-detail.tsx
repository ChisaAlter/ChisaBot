import {
  IconArrowLeft,
  IconDownload,
  IconExternalLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  type TaskControl,
  taskCenterApi,
  taskCenterDetailOptions,
  taskCenterKeys,
  taskTraceOptions,
} from "@/lib/task-center-api";
import {
  TASK_LEVEL_LABELS,
  type TaskArtifact,
  type TaskCenterTask,
  type TaskTraceEvent,
} from "../../../../shared/task-center";
import {
  ACTIVE_STATUSES,
  CATEGORY_LABELS,
  RISK_LABELS,
  STATUS_LABELS,
  safeTaskUrl,
  taskDate,
} from "./labels";

export function TaskStatusBadge({ task }: { task: TaskCenterTask }) {
  return (
    <span className="tc-status" data-status={task.status}>
      {STATUS_LABELS[task.status]}
    </span>
  );
}
export function TaskDetail({
  id,
  allTasks,
  onClose,
  onSelect,
}: {
  id: string;
  allTasks: TaskCenterTask[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const query = useQuery(taskCenterDetailOptions(id));
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"overview" | "events" | "trace">("overview");
  const heading = useRef<HTMLHeadingElement>(null);
  const control = useMutation({
    mutationFn: (action: TaskControl) => taskCenterApi.controlTask(id, action),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: taskCenterKeys.all }),
  });
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  const task = query.data?.task;
  const actions: Array<[TaskControl, string]> = task
    ? task.status === "inbox"
      ? [
          ["start", "开始任务"],
          ["cancel", "取消"],
        ]
      : task.status === "paused"
        ? [
            ["resume", "继续执行"],
            ["cancel", "取消任务"],
          ]
        : task.status === "failed"
          ? [
              ["retry", "重试"],
              ["cancel", "取消任务"],
            ]
          : ACTIVE_STATUSES.includes(task.status)
            ? [
                ["pause", "暂停"],
                ["cancel", "取消任务"],
              ]
            : task.status === "waiting_approval"
              ? [["cancel", "取消任务"]]
              : []
    : [];
  const events = query.data?.events ?? [];
  return (
    <section className="tc-detail" aria-labelledby="tc-detail-title">
      <div className="tc-detail-heading">
        <h2 id="tc-detail-title" ref={heading} tabIndex={-1}>
          任务详情
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭任务详情"
          onClick={onClose}
        >
          <IconX />
        </Button>
      </div>
      {query.isPending ? <PageSkeleton rows={3} /> : null}
      {query.error ? (
        <div className="tc-error" role="alert">
          {query.error.message}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            重新加载
          </Button>
        </div>
      ) : null}
      {task ? (
        <>
          <div className="tc-detail-title">
            <TaskStatusBadge task={task} />
            <h3>{task.title}</h3>
            <p className="tc-meta">
              {CATEGORY_LABELS[task.category]} · {task.executor} ·{" "}
              {taskDate(task.updatedAt)} 更新
            </p>
          </div>
          {actions.length ? (
            <div className="tc-actions">
              {actions.map(([action, label]) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === "cancel" ? "ghost" : "outline"}
                  state={
                    control.isPending && control.variables === action
                      ? "pending"
                      : "idle"
                  }
                  disabled={control.isPending}
                  onClick={() => control.mutate(action)}
                >
                  {action === "pause" ? (
                    <IconPlayerPause />
                  ) : action === "retry" ? (
                    <IconRefresh />
                  ) : action === "cancel" ? (
                    <IconX />
                  ) : (
                    <IconPlayerPlay />
                  )}
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
          {control.error ? (
            <p className="tc-error" role="alert">
              {control.error.message}
            </p>
          ) : null}
          {task.error ? (
            <div className="tc-error" role="status">
              <strong>需要处理</strong>
              <p>{task.error}</p>
              {task.status === "queued" ? (
                <p>下次尝试：{taskDate(task.nextAttemptAt)}</p>
              ) : null}
            </div>
          ) : null}
          <div
            className="tc-detail-tabs"
            role="toolbar"
            aria-label="任务详情内容"
          >
            <Button
              variant={tab === "overview" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === "overview"}
              onClick={() => setTab("overview")}
            >
              计划与成果
            </Button>
            <Button
              variant={tab === "events" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === "events"}
              onClick={() => setTab("events")}
            >
              执行日志 · {events.length}
            </Button>
            <Button
              variant={tab === "trace" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === "trace"}
              onClick={() => setTab("trace")}
            >
              执行轨迹
            </Button>
          </div>
          {tab === "trace" ? (
            <TaskTracePanel task={task} />
          ) : tab === "overview" ? (
            <div className="tc-detail-sections">
              <section>
                <h4>任务目标</h4>
                <p className="tc-prose">{task.description}</p>
                {safeTaskUrl(task.sourceUrl) ? (
                  <a
                    className="tc-link"
                    href={safeTaskUrl(task.sourceUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开原始来源
                    <IconExternalLink size={14} />
                  </a>
                ) : null}
              </section>
              <section>
                <h4>
                  L{task.level} · {TASK_LEVEL_LABELS[task.level]}
                </h4>
                <p className="tc-prose">{task.assessment}</p>
                <p className="tc-meta">
                  操作范围：{RISK_LABELS[task.risk]} · 优先级 {task.priority}
                </p>
              </section>
              {task.parentId ? (
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    if (task.parentId) onSelect(task.parentId);
                  }}
                >
                  <IconArrowLeft />
                  查看上级任务
                </Button>
              ) : null}
              {task.dependencies.length ? (
                <section>
                  <h4>前序任务</h4>
                  <ul className="tc-dependencies">
                    {task.dependencies.map((dependencyId) => {
                      const dependency = allTasks.find(
                        (item) => item.id === dependencyId,
                      );
                      return (
                        <li key={dependencyId}>
                          <button
                            type="button"
                            onClick={() => onSelect(dependencyId)}
                          >
                            {dependency?.title ?? dependencyId}
                            <span>
                              {dependency
                                ? STATUS_LABELS[dependency.status]
                                : "查看状态"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              {query.data?.children.length ? (
                <section>
                  <h4>执行计划</h4>
                  <ol className="tc-steps">
                    {query.data.children.map((child, index) => (
                      <li key={child.id}>
                        <span className="tc-step-number">{index + 1}</span>
                        <button
                          type="button"
                          onClick={() => onSelect(child.id)}
                        >
                          <strong>{child.title}</strong>
                          <span>
                            {STATUS_LABELS[child.status]} · {child.executor}
                            {child.dependencies.length
                              ? ` · ${child.dependencies.length} 项前序依赖`
                              : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {task.summary ? (
                <section>
                  <h4>交付结果</h4>
                  <p className="tc-prose">{task.summary}</p>
                </section>
              ) : null}
              {task.artifacts.length ? (
                <section>
                  <h4>交付物</h4>
                  <div className="tc-artifacts">
                    {task.artifacts.map((artifact, index) => (
                      <Artifact
                        key={`${artifact.name}-${index}`}
                        artifact={artifact}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <details className="tc-run-details">
                <summary>运行信息</summary>
                <dl>
                  <dt>开始时间</dt>
                  <dd>{taskDate(task.startedAt)}</dd>
                  <dt>结束时间</dt>
                  <dd>
                    {task.finishedAt ? taskDate(task.finishedAt) : "尚未结束"}
                  </dd>
                  <dt>执行次数</dt>
                  <dd>
                    {task.attempts} / {task.maxAttempts}
                  </dd>
                  <dt>单次时限</dt>
                  <dd>{Math.round(task.timeoutSeconds / 60)} 分钟</dd>
                  <dt>模型调用</dt>
                  <dd>{task.usage.modelCalls ?? "未报告"}</dd>
                  <dt>输入 / 输出 Token</dt>
                  <dd>
                    {task.usage.inputTokens ?? "—"} /{" "}
                    {task.usage.outputTokens ?? "—"}
                  </dd>
                  <dt>费用</dt>
                  <dd>
                    {task.usage.costUsd === undefined
                      ? "未报告"
                      : `$${task.usage.costUsd.toFixed(4)}`}
                  </dd>
                  <dt>任务 ID</dt>
                  <dd className="tc-identifier">{task.id}</dd>
                </dl>
              </details>
            </div>
          ) : (
            <div
              className="tc-event-list"
              aria-live="polite"
              aria-relevant="additions"
            >
              {!events.length ? (
                <p className="tc-muted">
                  任务开始后，这里会记录计划、工具调用、异常和交付过程。
                </p>
              ) : (
                events.map((event) => (
                  <article key={event.id} className="tc-event">
                    <div className="tc-event-meta">
                      <time dateTime={event.createdAt}>
                        {taskDate(event.createdAt)}
                      </time>
                      <span>{event.type}</span>
                    </div>
                    <p>{event.message}</p>
                    {Object.keys(event.data).length ? (
                      <details>
                        <summary>查看记录内容</summary>
                        <pre>{JSON.stringify(event.data, null, 2)}</pre>
                      </details>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
function Artifact({ artifact }: { artifact: TaskArtifact }) {
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
    <article className="tc-artifact">
      <div className="tc-artifact-head">
        <strong>{artifact.name}</strong>
        {url ? (
          <a className="tc-link" href={url} target="_blank" rel="noreferrer">
            打开
            <IconExternalLink size={14} />
          </a>
        ) : null}
        {artifact.content !== undefined ? (
          <Button variant="ghost" size="sm" onClick={download}>
            <IconDownload />
            下载
          </Button>
        ) : null}
      </div>
      {artifact.uri && !url ? (
        <p className="tc-identifier">{artifact.uri}</p>
      ) : null}
      {artifact.content ? (
        <details>
          <summary>预览内容</summary>
          <pre>{artifact.content}</pre>
        </details>
      ) : null}
    </article>
  );
}

const TRACE_KIND: Record<string, string> = {
  RUN_STARTED: "回合开始",
  TOOL_CALL_START: "工具调用",
  TOOL_CALL_END: "调用完成",
  TOOL_CALL_RESULT: "工具结果",
  TEXT_MESSAGE: "回复",
  RUN_FINISHED: "回合完成",
  RUN_ERROR: "出错",
};

/** `task-center:<taskId>:<tag>:<attempt>` → 「规划」/「执行 · 第 N 次」。 */
function traceThreadLabel(thread: string): string {
  const parts = thread.split(":");
  const tag = parts[2];
  const attempt = parts[3];
  const name = tag === "plan" ? "规划" : tag === "run" ? "执行" : tag || "回合";
  return attempt ? `${name} · 第 ${attempt} 次` : name;
}

function usageLine(usage: TaskTraceEvent["usage"]): string {
  if (!usage) return "";
  const parts = [
    `模型调用 ${usage.modelCalls ?? "—"}`,
    `输入 ${usage.inputTokens ?? "—"}`,
    `输出 ${usage.outputTokens ?? "—"}`,
  ];
  return parts.join(" · ");
}

/** 执行轨迹：机器人回合里的工具调用、结果与成段回复，按规划 / 各次尝试分组。 */
function TaskTracePanel({ task }: { task: TaskCenterTask }) {
  const running = ACTIVE_STATUSES.includes(task.status);
  const trace = useQuery({
    ...taskTraceOptions(task.id),
    refetchInterval: running ? 30_000 : false,
  });
  const threads = trace.data?.threads ?? [];
  return (
    <div className="tc-event-list" aria-live="polite" aria-relevant="additions">
      <div className="tc-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void trace.refetch()}
          state={trace.isFetching && !trace.isPending ? "pending" : "idle"}
        >
          <IconRefresh />
          刷新
        </Button>
        {running ? (
          <span className="tc-meta">任务进行中，每 30 秒自动刷新</span>
        ) : null}
      </div>
      {trace.isPending ? <PageSkeleton rows={3} /> : null}
      {trace.error ? (
        <div className="tc-error" role="alert">
          {trace.error.message}
          <Button variant="ghost" onClick={() => void trace.refetch()}>
            重新加载
          </Button>
        </div>
      ) : null}
      {trace.data && !threads.length ? (
        <p className="tc-muted">
          {running
            ? "执行线程还没有产生事件，稍后再看。"
            : "这个任务没有留下执行轨迹；只有本地会话模式的回合会记录。"}
        </p>
      ) : null}
      {threads.map((thread) => (
        <section className="tc-trace-thread" key={thread.thread}>
          <h4>{traceThreadLabel(thread.thread)}</h4>
          {thread.events.map((event) => (
            <article className="tc-event" key={event.sequence}>
              <div className="tc-event-meta">
                <time dateTime={event.at}>{taskDate(event.at)}</time>
                <span>{TRACE_KIND[event.type] ?? event.type}</span>
              </div>
              <p>{event.summary}</p>
              {event.usage ? (
                <p className="tc-meta">{usageLine(event.usage)}</p>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
