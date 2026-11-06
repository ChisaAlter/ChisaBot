import {
  IconCheck,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  taskCenterApi,
  taskCenterCapabilityOptions,
} from "@/lib/task-center-api";
import {
  SOURCE_KINDS,
  type TaskCenterSource,
  type TaskSourceInput,
  type TaskSourceKind,
} from "../../../../shared/task-center";

export const SOURCE_LABELS: Record<TaskSourceKind, string> = {
  calendar: "日历",
  email: "邮件",
  github: "GitHub",
  repository: "本地仓库",
  documents: "文档",
  messages: "消息",
  tasks: "项目任务",
  webhook: "入站 Webhook",
};
const SOURCE_HELP: Record<TaskSourceKind, string> = {
  calendar: "读取已连接日历中的近期安排，发现需要准备的事项。",
  email: "读取已连接邮箱的邮件摘要，整理待处理事项。",
  github: "读取指定仓库的开放 Issue 和 Pull Request。",
  repository: "从仓库里的 Markdown / TXT 文件提取未完成事项。",
  documents: "读取 ChisaBot 页面，或已允许目录中的 Markdown / TXT 文档。",
  messages: "从你的近期 ChisaBot 对话中整理尚未闭环的事情。",
  tasks: "汇总定时任务异常和记忆中的待办线索。",
  webhook: "整理已经接收到的 Webhook 消息。连接地址在已连接账号中管理。",
};

const selectClass =
  "h-11 w-full min-w-0 rounded-[14px] border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&>option]:bg-background";
const formatTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未巡检";
const stringValue = (value: unknown) =>
  typeof value === "string" ? value : "";
const numberValue = (value: unknown, fallback: number) =>
  typeof value === "number" ? value : fallback;
const linesValue = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string").join("\n")
    : "";
const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

type SourceDraft = {
  kind: TaskSourceKind;
  label: string;
  enabled: boolean;
  intervalMinutes: number;
  autoStart: boolean;
  agentId: string;
  executor: string;
  config: Record<string, unknown>;
};
function draftOf(source?: TaskCenterSource): SourceDraft {
  return source
    ? {
        kind: source.kind,
        label: source.label,
        enabled: source.enabled,
        intervalMinutes: source.intervalMinutes,
        autoStart: source.autoStart,
        agentId: source.agentId ?? "",
        executor: source.executor,
        config:
          source.kind === "documents"
            ? {
                ...source.config,
                mode:
                  source.config.mode ??
                  (source.config.path ? "files" : "pages"),
              }
            : { ...source.config },
      }
    : {
        kind: "repository",
        label: "",
        enabled: true,
        intervalMinutes: 60,
        autoStart: false,
        agentId: "",
        executor: "bot",
        config: {},
      };
}

export function SourceSettings({
  sources,
  onChanged,
}: {
  sources: TaskCenterSource[];
  onChanged: () => void;
}) {
  const [editor, setEditor] = useState<TaskCenterSource | "new" | null>(null);
  return (
    <section className="space-y-5" aria-label="信息来源">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-lg font-semibold">发现值得推进的事情</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            按来源巡检，发现的事项统一进入 Inbox。邮件、日历与 GitHub
            使用你的已连接账号。
          </p>
          <Link
            className="inline-block text-sm text-primary underline-offset-4 hover:underline focus-visible:underline"
            to="/settings/connected-accounts"
          >
            管理已连接账号
          </Link>
        </div>
        <Button
          disabled={editor !== null}
          onClick={() => setEditor("new")}
          variant="outline"
        >
          <IconPlus aria-hidden />
          添加来源
        </Button>
      </div>
      {editor ? (
        <SourceEditor
          key={editor === "new" ? "new" : editor.id}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged();
          }}
          source={editor === "new" ? undefined : editor}
        />
      ) : null}
      {!sources.length && !editor ? (
        <div className="rounded-2xl border border-border px-5 py-9">
          <p className="font-medium">还没有巡检来源</p>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            先添加一个仓库、文档或已连接的账号。你可以先让事项进入
            Inbox，再决定是否开启自动推进。
          </p>
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            onChanged={onChanged}
            onEdit={() => setEditor(source)}
            editing={editor !== null}
          />
        ))}
      </div>
    </section>
  );
}

function SourceRow({
  source,
  onChanged,
  onEdit,
  editing,
}: {
  source: TaskCenterSource;
  onChanged: () => void;
  onEdit: () => void;
  editing: boolean;
}) {
  const scan = useMutation({
    mutationFn: () => taskCenterApi.scanSource(source.id),
    onSettled: onChanged,
  });
  const toggle = useMutation({
    mutationFn: () =>
      taskCenterApi.updateSource(source.id, { enabled: !source.enabled }),
    onSuccess: onChanged,
  });
  const failed = source.lastStatus === "failed";
  return (
    <article className="space-y-3 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-base font-medium">
              {source.label}
            </h3>
            <span className="rounded-full bg-muted px-2 py-1 text-xs">
              {SOURCE_LABELS[source.kind]}
            </span>
            {!source.enabled ? (
              <span className="text-sm text-muted-foreground">已暂停</span>
            ) : source.lastStatus === "running" ? (
              <span className="text-sm text-primary" role="status">
                正在巡检
              </span>
            ) : failed ? (
              <span className="text-sm text-destructive">巡检失败</span>
            ) : source.lastStatus === "succeeded" ? (
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <IconCheck className="size-4" aria-hidden />
                最近巡检完成
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            每 {source.intervalMinutes} 分钟 ·{" "}
            {source.autoStart ? "自动推进可执行事项" : "新事项进入 Inbox"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            上次：{formatTime(source.lastRunAt)}
            {source.enabled ? ` · 下次：${formatTime(source.nextRunAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-10"
            disabled={source.lastStatus === "running"}
            feedback={{
              pending: "巡检中…",
              success: "巡检完成",
              error: "巡检失败",
            }}
            mutation={scan}
            onClick={() => scan.mutate()}
            variant="outline"
          >
            <IconRefresh aria-hidden />
            立即巡检
          </Button>
          <Button
            aria-label={`${source.enabled ? "暂停" : "启用"}${source.label}`}
            className="min-h-10"
            feedback={{
              pending: "更新中…",
              success: "已更新",
              error: "更新失败",
            }}
            mutation={toggle}
            onClick={() => toggle.mutate()}
            variant="ghost"
          >
            {source.enabled ? (
              <IconPlayerPause aria-hidden />
            ) : (
              <IconPlayerPlay aria-hidden />
            )}
            {source.enabled ? "暂停" : "启用"}
          </Button>
          <Button
            aria-label={`编辑${source.label}`}
            className="min-h-10"
            disabled={editing}
            onClick={onEdit}
            variant="ghost"
          >
            <IconPencil aria-hidden />
            编辑
          </Button>
        </div>
      </div>
      {source.lastError || scan.error || toggle.error ? (
        <p className="break-words text-sm text-destructive" role="alert">
          {scan.error?.message ?? toggle.error?.message ?? source.lastError}
        </p>
      ) : null}
    </article>
  );
}

function SourceEditor({
  source,
  onSaved,
  onCancel,
}: {
  source?: TaskCenterSource;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(source));
  const [fileNames, setFileNames] = useState(() =>
    linesValue(source?.config.files),
  );
  const [threadIds, setThreadIds] = useState(() =>
    linesValue(source?.config.threadIds),
  );
  const agents = useQuery(agentListQueryOptions());
  const capabilities = useQuery(taskCenterCapabilityOptions());
  const executors =
    capabilities.data?.capabilities.filter(
      (item) => item.kind === "executor",
    ) ?? [];
  const save = useMutation({
    mutationFn: (input: TaskSourceInput) =>
      source
        ? taskCenterApi.updateSource(source.id, input)
        : taskCenterApi.createSource(input),
    onSuccess: onSaved,
  });
  const config = (key: string, value: unknown) =>
    setDraft((previous) => ({
      ...previous,
      config: { ...previous.config, [key]: value },
    }));
  const fileMode =
    draft.kind === "repository" ||
    (draft.kind === "documents" && draft.config.mode !== "pages");
  const sourceCapabilityId = fileMode
    ? "source:repository"
    : `source:${draft.kind}`;
  const sourceCapability = capabilities.data?.capabilities.find(
    (item) => item.id === sourceCapabilityId,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleaned = { ...draft.config };
    if (fileMode) {
      if (lines(fileNames).length) cleaned.files = lines(fileNames);
      else delete cleaned.files;
    }
    if (draft.kind === "messages") {
      if (lines(threadIds).length) cleaned.threadIds = lines(threadIds);
      else delete cleaned.threadIds;
    }
    save.mutate({ ...draft, agentId: draft.agentId || null, config: cleaned });
  };
  return (
    <form
      className="space-y-5 rounded-2xl border border-border bg-[var(--glass-1)] p-5"
      onSubmit={submit}
      aria-label={source ? "编辑巡检来源" : "添加巡检来源"}
    >
      <h3 className="text-base font-semibold">
        {source ? `编辑：${source.label}` : "添加巡检来源"}
      </h3>
      <fieldset className="space-y-5" disabled={save.isPending}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-kind`} label="来源类型">
            <select
              className={selectClass}
              id={`${id}-kind`}
              value={draft.kind}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  kind: event.target.value as TaskSourceKind,
                  config: {},
                });
                setFileNames("");
                setThreadIds("");
              }}
            >
              {SOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {SOURCE_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${id}-label`} label="名称">
            <Input
              autoComplete="off"
              id={`${id}-label`}
              maxLength={120}
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
              placeholder="便于识别的名称"
              required
              value={draft.label}
            />
          </Field>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {SOURCE_HELP[draft.kind]}
        </p>
        {sourceCapability && !sourceCapability.available ? (
          <p className="text-sm text-destructive" role="status">
            {sourceCapability.detail}
          </p>
        ) : null}
        {draft.kind === "github" ? (
          <Field id={`${id}-repo`} label="GitHub 仓库">
            <Input
              autoComplete="off"
              id={`${id}-repo`}
              onChange={(event) => config("repo", event.target.value.trim())}
              placeholder="owner/repository"
              required
              value={stringValue(draft.config.repo)}
            />
          </Field>
        ) : null}
        {draft.kind === "documents" ? (
          <Field id={`${id}-mode`} label="文档位置">
            <select
              className={selectClass}
              id={`${id}-mode`}
              onChange={(event) =>
                setDraft({ ...draft, config: { mode: event.target.value } })
              }
              value={draft.config.mode === "pages" ? "pages" : "files"}
            >
              <option value="files">服务器本地文件</option>
              <option value="pages">ChisaBot 页面</option>
            </select>
          </Field>
        ) : null}
        {fileMode ? (
          <div className="space-y-4">
            <Field
              id={`${id}-path`}
              label={
                draft.kind === "repository"
                  ? "仓库完整路径"
                  : "文件或目录完整路径"
              }
              hint="填写服务器上已获准读取的目录，或其中的单个文档。"
            >
              <Input
                autoComplete="off"
                id={`${id}-path`}
                maxLength={1000}
                onChange={(event) => config("path", event.target.value)}
                required
                value={stringValue(draft.config.path)}
              />
            </Field>
            <Field
              id={`${id}-files`}
              label="限定文件（可选）"
              hint="每行一个相对目录的文件名，例如 docs/BACKLOG.md。留空时扫描目录中的 Markdown / TXT。"
            >
              <Textarea
                id={`${id}-files`}
                onChange={(event) => setFileNames(event.target.value)}
                rows={3}
                value={fileNames}
              />
            </Field>
          </div>
        ) : null}
        {draft.kind === "calendar" || draft.kind === "messages" ? (
          <Field
            id={`${id}-days`}
            label={draft.kind === "calendar" ? "未来多少天" : "回看多少天"}
          >
            <Input
              id={`${id}-days`}
              max={draft.kind === "calendar" ? 30 : 90}
              min={1}
              onChange={(event) => config("days", Number(event.target.value))}
              required
              type="number"
              value={numberValue(draft.config.days, 7)}
            />
          </Field>
        ) : null}
        {draft.kind === "messages" ? (
          <Field
            id={`${id}-threads`}
            label="限定对话（可选）"
            hint="每行一个对话 ID；留空时检查你的近期对话。"
          >
            <Textarea
              id={`${id}-threads`}
              onChange={(event) => setThreadIds(event.target.value)}
              rows={2}
              value={threadIds}
            />
          </Field>
        ) : null}
        {draft.kind === "email" ? (
          <Toggle
            id={`${id}-unread`}
            label="只查看未读邮件"
            checked={draft.config.unreadOnly !== false}
            onChange={(checked) => config("unreadOnly", checked)}
          />
        ) : null}
        {draft.kind === "tasks" ? (
          <Toggle
            id={`${id}-memory`}
            label="包含记忆中的待办线索"
            checked={draft.config.includeMemory !== false}
            onChange={(checked) => config("includeMemory", checked)}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-interval`} label="巡检间隔（分钟）">
            <Input
              id={`${id}-interval`}
              max={10080}
              min={15}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  intervalMinutes: Number(event.target.value),
                })
              }
              required
              type="number"
              value={draft.intervalMinutes}
            />
          </Field>
          {draft.kind !== "webhook" ? (
            <Field id={`${id}-limit`} label="每次最多处理条数">
              <Input
                id={`${id}-limit`}
                max={draft.kind === "email" ? 20 : 50}
                min={1}
                onChange={(event) =>
                  config("limit", Number(event.target.value))
                }
                required
                type="number"
                value={numberValue(draft.config.limit, 20)}
              />
            </Field>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-executor`} label="执行方式">
            <select
              className={selectClass}
              id={`${id}-executor`}
              onChange={(event) =>
                setDraft({ ...draft, executor: event.target.value })
              }
              value={draft.executor}
            >
              <option value="bot">ChisaBot 机器人</option>
              {executors
                .filter((item) => item.id !== "bot")
                .map((item) => (
                  <option
                    disabled={!item.available}
                    key={item.id}
                    value={item.id}
                  >
                    {item.name}
                    {item.available ? "" : "（未就绪）"}
                  </option>
                ))}
              {draft.executor !== "bot" &&
              !executors.some((item) => item.id === draft.executor) ? (
                <option value={draft.executor}>
                  {draft.executor}（当前未发现）
                </option>
              ) : null}
            </select>
          </Field>
          <Field id={`${id}-agent`} label="负责的机器人">
            <select
              className={selectClass}
              id={`${id}-agent`}
              onChange={(event) =>
                setDraft({ ...draft, agentId: event.target.value })
              }
              value={draft.agentId}
            >
              <option value="">尚未指定</option>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
              {draft.agentId &&
              !agents.data?.some((agent) => agent.id === draft.agentId) ? (
                <option value={draft.agentId}>{draft.agentId}</option>
              ) : null}
            </select>
          </Field>
        </div>
        {agents.error || capabilities.error ? (
          <p className="text-sm text-destructive" role="alert">
            {agents.error?.message ?? capabilities.error?.message}
          </p>
        ) : null}
        <Toggle
          id={`${id}-auto`}
          label="自动推进可执行事项"
          hint="开启后，可执行的读取与内部工作会自动排队；对外沟通、发布和敏感操作进入 Outbox 等待确认。"
          checked={draft.autoStart}
          onChange={(checked) => setDraft({ ...draft, autoStart: checked })}
        />
        <Toggle
          id={`${id}-enabled`}
          label="启用定时巡检"
          checked={draft.enabled}
          onChange={(checked) => setDraft({ ...draft, enabled: checked })}
        />
      </fieldset>
      {save.error ? (
        <p className="text-sm text-destructive" role="alert">
          {save.error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          disabled={save.isPending}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          取消
        </Button>
        <Button feedback="save" mutation={save} type="submit">
          保存来源
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0 space-y-1">
        <label className="block text-sm font-medium" htmlFor={id}>
          {label}
        </label>
        {hint ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      <Switch checked={checked} id={id} onCheckedChange={onChange} />
    </div>
  );
}
