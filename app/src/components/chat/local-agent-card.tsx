import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconDeviceDesktop,
  IconGitMerge,
  IconHelpCircle,
  IconLoader2,
  IconPlayerStopFilled,
  IconSend,
  IconServer,
  IconShieldCheck,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  type FormEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  ContentEnter,
  SmoothCollapse,
} from "@/components/ui/motion-primitives";
import { useTimeout } from "@/hooks";
import { useConversationScope } from "@/lib/chat/conversation-scope";
import { formatElapsed } from "@/lib/conversations/workers";
import {
  decideDeviceApproval,
  localTaskQueryOptions,
  parseLocalAgentResult,
  useAnswerLocalTask,
  useContinueLocalTask,
  useLocalTaskAction,
  useThreadLocalTasks,
} from "@/lib/local-agents";
import { smoothScrollIntoView } from "@/lib/motion";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import {
  ACTIVE_LOCAL_TASK,
  LOCAL_AGENT_INFO,
  LOCAL_TASK_STATUS_ZH,
  type LocalAgentLine,
  type LocalAgentPendingInput,
  type LocalAgentQuestion,
  type LocalAgentTaskView,
  profileLine,
} from "../../../../shared/local-agents";

/**
 * 本地 agent 任务卡片（docs/local-agents.md，DESIGN.md「本地 agent」）：机器人用 device_agent_run 把一件事交给
 * 用户电脑上的 Claude Code / Codex / 内置 agent 时，在那条回复里出现。复用后台任务卡片（§38.3）的玻璃卡和动效：
 * 标题 · 状态 · 用时；下面一行「电脑 · agent · 档位」；当前步骤；可折叠的实时输出（等宽、固定最高、自动滚到底）；
 * 需要批准时卡片里直接「允许 / 拒绝」；结束后列出改动文件，改动在一次性副本里时给「应用改动 / 放弃」。
 */
export function LocalAgentCard({
  taskId,
  pendingTitle,
}: {
  taskId?: string;
  pendingTitle?: string;
}) {
  const chat = useConversationScope();
  const threadId = chat?.threadId;
  const tasks = useThreadLocalTasks(threadId);
  const task = taskId
    ? tasks.data?.find((item) => item.id === taskId)
    : undefined;
  useTimeout(
    () => {
      void tasks.refetch();
    },
    taskId && tasks.data && !task ? 400 : null,
    `${taskId ?? ""}:${tasks.dataUpdatedAt}:${tasks.errorUpdatedAt}:${tasks.fetchStatus}`,
  );
  if (!task) {
    return (
      <div
        className="worker-card la-card is-pending"
        data-status="pending"
        data-testid="local-agent-card"
      >
        <div className="worker-head">
          <span className="worker-icon is-running">
            <IconLoader2 className="size-4" />
          </span>
          <span className="worker-title">{pendingTitle || "子代理任务"}</span>
          <span className="worker-chip">{"正在交给子代理…"}</span>
        </div>
      </div>
    );
  }
  return <LocalAgentCardBody task={task} threadId={threadId ?? null} />;
}

function OutputLines({ lines }: { lines: LocalAgentLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current && lines.length > 0) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      className="la-output"
      data-testid="local-agent-output"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      ref={box}
    >
      {lines.length ? (
        lines.map((line, index) => (
          <div
            className={cn("la-line", `is-${line.kind}`)}
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表：只追加、不重排、没有稳定 id
            key={`${line.at}-${index}`}
          >
            {line.kind === "tool" ? (
              <span className="la-line-mark">{"›"}</span>
            ) : null}
            {line.text}
          </div>
        ))
      ) : (
        <div className="la-line is-status">{"还没有输出"}</div>
      )}
    </div>
  );
}

type PatchLineKind = "meta" | "hunk" | "add" | "del" | "ctx";

function classifyPatchLine(line: string): PatchLineKind {
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function PatchViewer({ patch }: { patch: string }) {
  const lines = useMemo(() => {
    const raw = patch.split("\n");
    const counts = new Map<string, number>();
    return raw.map((text) => {
      const seen = (counts.get(text) ?? 0) + 1;
      counts.set(text, seen);
      return {
        id: `${seen}:${text}`,
        text,
        kind: classifyPatchLine(text),
      };
    });
  }, [patch]);

  return (
    <section
      aria-label={"代码改动补丁"}
      className="la-patch"
      data-testid="local-agent-patch"
    >
      {lines.map((line) => (
        <div
          className={cn("la-patch-line", `is-${line.kind}`)}
          data-kind={line.kind}
          key={line.id}
        >
          {line.text || " "}
        </div>
      ))}
    </section>
  );
}

function DiffBlock({
  task,
  threadId,
}: {
  task: LocalAgentTaskView;
  threadId: string | null;
}) {
  const act = useLocalTaskAction(threadId);
  const apply = useAsyncAction(() => act(task.id, "apply"), {
    errorToast: (error) => `应用失败：${error.message}`,
  });
  const discard = useAsyncAction(() => act(task.id, "discard"), {
    errorToast: (error) => `操作失败：${error.message}`,
  });
  const [all, setAll] = useState(false);
  const [patchOpen, setPatchOpen] = useState(false);
  const diff = task.diff;
  if (!diff || (!diff.files.length && !diff.patch)) return null;
  const patch = diff.patch?.trim() ? diff.patch : null;
  return (
    <div className="la-diff" data-testid="local-agent-diff">
      <div className="la-diff-head">
        <span>{`改动 ${diff.files.length} 个文件`}</span>
        <span className="la-plus">{`+${diff.added}`}</span>
        <span className="la-minus">{`−${diff.removed}`}</span>
        <span className="la-diff-state">
          {diff.applied
            ? "已应用到原文件夹"
            : diff.discarded
              ? "已放弃"
              : diff.pending
                ? "在一次性副本里，还没应用"
                : "已直接写入文件夹"}
        </span>
      </div>
      {diff.files.length ? (
        <ul className="la-files">
          {diff.files.slice(0, 6).map((file) => (
            <li className="la-file" key={file.path}>
              <span className={cn("la-file-status", `is-${file.status}`)}>
                {file.status === "added"
                  ? "新"
                  : file.status === "deleted"
                    ? "删"
                    : "改"}
              </span>
              <span className="la-file-path">{file.path}</span>
              <span className="la-plus">{`+${file.added}`}</span>
              <span className="la-minus">{`−${file.removed}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {diff.files.length > 6 ? (
        <>
          <SmoothCollapse open={all} unmountOnExit>
            <ul className="la-files">
              {diff.files.slice(6).map((file) => (
                <li className="la-file" key={file.path}>
                  <span className={cn("la-file-status", `is-${file.status}`)}>
                    {file.status === "added"
                      ? "新"
                      : file.status === "deleted"
                        ? "删"
                        : "改"}
                  </span>
                  <span className="la-file-path">{file.path}</span>
                  <span className="la-plus">{`+${file.added}`}</span>
                  <span className="la-minus">{`−${file.removed}`}</span>
                </li>
              ))}
            </ul>
          </SmoothCollapse>
          <button
            className="worker-plan-toggle"
            onClick={() => setAll((value) => !value)}
            type="button"
          >
            {all ? "收起" : `还有 ${diff.files.length - 6} 个文件`}
          </button>
        </>
      ) : null}
      {patch ? (
        <div className="la-patch-wrap">
          <button
            aria-expanded={patchOpen}
            className="worker-plan-toggle"
            data-testid="local-agent-patch-toggle"
            onClick={() => setPatchOpen((value) => !value)}
            type="button"
          >
            <IconChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !patchOpen && "-rotate-90",
              )}
            />
            {patchOpen ? "收起代码改动" : "查看代码改动"}
          </button>
          {patchOpen ? <PatchViewer patch={patch} /> : null}
        </div>
      ) : null}
      {diff.pending ? (
        <div className="la-actions">
          <Button
            data-testid="local-agent-apply"
            feedback={{
              pending: "应用中…",
              success: "已应用",
              error: "应用失败",
            }}
            onClick={() => void apply.run()}
            size="sm"
            state={apply.state}
          >
            <IconGitMerge />
            {"应用改动"}
          </Button>
          <Button
            feedback={{
              pending: "放弃中…",
              success: "已放弃",
              error: "操作失败",
            }}
            onClick={() => void discard.run()}
            size="sm"
            state={discard.state}
            variant="outline"
          >
            <IconTrash />
            {"放弃"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function collectQuestionAnswer(
  question: LocalAgentQuestion,
  selected: readonly string[],
  text: string,
): string[] {
  const trimmed = text.trim();
  if (!question.options?.length) {
    return trimmed ? [trimmed] : [];
  }
  const values = [...selected];
  if (trimmed && !values.includes(trimmed)) {
    values.push(trimmed);
  }
  return values;
}

function PendingInputForm({
  taskId,
  pendingInput,
  threadId,
}: {
  taskId: string;
  pendingInput: LocalAgentPendingInput;
  threadId: string | null;
}) {
  const answerTask = useAnswerLocalTask(threadId);
  const [selectedMap, setSelectedMap] = useState<Record<string, string[]>>({});
  const [textMap, setTextMap] = useState<Record<string, string>>({});

  const submit = useAsyncAction(
    async (answers: Record<string, string[]>) => answerTask(taskId, answers),
    { errorToast: (error) => `提交回答失败：${error.message}` },
  );

  const toggleOption = (question: LocalAgentQuestion, label: string) => {
    setSelectedMap((prev) => {
      const current = prev[question.id] ?? [];
      if (question.allowMultiple) {
        const next = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label];
        return { ...prev, [question.id]: next };
      }
      const next = current.includes(label) ? [] : [label];
      return { ...prev, [question.id]: next };
    });
  };

  const canSubmit = pendingInput.questions.every((question) => {
    if (question.required === false) return true;
    const values = collectQuestionAnswer(
      question,
      selectedMap[question.id] ?? [],
      textMap[question.id] ?? "",
    );
    return values.length > 0;
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submit.state === "pending") return;
    const answers: Record<string, string[]> = {};
    for (const question of pendingInput.questions) {
      answers[question.id] = collectQuestionAnswer(
        question,
        selectedMap[question.id] ?? [],
        textMap[question.id] ?? "",
      );
    }
    void submit.run(answers);
  };

  return (
    <form
      className="la-input-form"
      data-testid="local-agent-input-form"
      onSubmit={handleSubmit}
    >
      <div className="la-input-head">
        <IconHelpCircle className="size-4 flex-none" />
        <span>{"子代理需要你补充信息后继续"}</span>
      </div>
      {pendingInput.questions.map((question) => {
        const selected = selectedMap[question.id] ?? [];
        const text = textMap[question.id] ?? "";
        const hasOptions = Boolean(question.options?.length);
        return (
          <div className="la-input-q" key={question.id}>
            {question.header ? (
              <div className="la-input-q-header">{question.header}</div>
            ) : null}
            <div className="la-input-q-text">{question.question}</div>
            {hasOptions ? (
              <div className="la-input-opts">
                {question.options?.map((option) => {
                  const active = selected.includes(option.label);
                  return (
                    <button
                      aria-pressed={active}
                      className={cn("la-input-opt", active && "is-selected")}
                      key={option.label}
                      onClick={() => toggleOption(question, option.label)}
                      type="button"
                    >
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className="la-input-opt-desc">
                          {option.description}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              aria-label={question.header || question.question}
              className="la-input-text"
              data-testid={`local-agent-input-field-${question.id}`}
              disabled={submit.state === "pending"}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setTextMap((prev) => ({ ...prev, [question.id]: value }));
              }}
              placeholder={
                hasOptions ? "或输入自定义补充说明…" : "请输入你的回答…"
              }
              type="text"
              value={text}
            />
          </div>
        );
      })}
      <div className="la-input-actions">
        <Button
          data-testid="local-agent-input-submit"
          disabled={!canSubmit || submit.state === "pending"}
          feedback={{
            pending: "提交中…",
            success: "已提交",
            error: "提交失败",
          }}
          size="sm"
          state={submit.state}
          type="submit"
        >
          {"提交回答"}
        </Button>
      </div>
    </form>
  );
}

function PendingInputBar({
  task,
  threadId,
}: {
  task: LocalAgentTaskView;
  threadId: string | null;
}) {
  if (task.status !== "needs_input" || !task.pendingInput?.questions.length) {
    return null;
  }
  return (
    <PendingInputForm
      key={task.pendingInput.reqId}
      pendingInput={task.pendingInput}
      taskId={task.id}
      threadId={threadId}
    />
  );
}

function ContinueBar({
  task,
  threadId,
}: {
  task: LocalAgentTaskView;
  threadId: string | null;
}) {
  const continueTask = useContinueLocalTask(threadId);
  const [prompt, setPrompt] = useState("");
  const submit = useAsyncAction(
    async (text: string) =>
      continueTask(task.id, { prompt: text, mode: "async" }),
    { errorToast: (error) => `继续执行失败：${error.message}` },
  );

  const active = ACTIVE_LOCAL_TASK.includes(task.status);
  if (active || task.continuable === false || !task.sessionId) {
    return null;
  }

  const trimmed = prompt.trim();
  const triggerSubmit = () => {
    if (!trimmed || submit.state === "pending") return;
    void submit.run(trimmed).then((outcome) => {
      if (outcome) setPrompt("");
    });
  };

  return (
    <form
      className="la-continue"
      data-testid="local-agent-continue-form"
      onSubmit={(event) => {
        event.preventDefault();
        triggerSubmit();
      }}
    >
      <textarea
        aria-label={"继续追问指令"}
        className="la-continue-input"
        data-testid="local-agent-continue-input"
        disabled={submit.state === "pending"}
        onChange={(event) => setPrompt(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            triggerSubmit();
          }
        }}
        placeholder={"补充后续指令，在原上下文继续执行…"}
        rows={1}
        value={prompt}
      />
      <Button
        data-testid="local-agent-continue-submit"
        disabled={!trimmed || submit.state === "pending"}
        feedback={{
          pending: "继续中…",
          success: "已继续",
          error: "续接失败",
        }}
        size="sm"
        state={submit.state}
        type="submit"
      >
        <IconSend className="size-3.5" />
        {"继续执行"}
      </Button>
    </form>
  );
}

function ApprovalBar({ task }: { task: LocalAgentTaskView }) {
  const approvalId = task.approvalId ?? "";
  const allow = useAsyncAction(
    () => decideDeviceApproval(approvalId, "approve"),
    { errorToast: (error) => error.message },
  );
  const deny = useAsyncAction(() => decideDeviceApproval(approvalId, "deny"), {
    errorToast: (error) => error.message,
  });
  if (!approvalId) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
    <div
      className="la-approval"
      data-testid="local-agent-approval"
      role="group"
    >
      <IconShieldCheck className="size-4 flex-none" />
      <span className="la-approval-text">
        {task.approvalSummary || "需要你批准"}
      </span>
      <div className="la-approval-actions">
        <Button
          data-testid="local-agent-allow"
          feedback={{ pending: "处理中…", success: "已允许", error: "失败" }}
          onClick={() => void allow.run()}
          size="sm"
          state={allow.state}
        >
          {"允许"}
        </Button>
        <Button
          feedback={{ pending: "处理中…", success: "已拒绝", error: "失败" }}
          onClick={() => void deny.run()}
          size="sm"
          state={deny.state}
          variant="outline"
        >
          {"拒绝"}
        </Button>
      </div>
    </div>
  );
}

function LocalAgentCardBody({
  task,
  threadId,
}: {
  task: LocalAgentTaskView;
  threadId: string | null;
}) {
  const active = ACTIVE_LOCAL_TASK.includes(task.status);
  const now = useNow(active);
  const [outputOpen, setOutputOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [fullLog, setFullLog] = useState(false);
  const act = useLocalTaskAction(threadId);
  const stop = useAsyncAction(() => act(task.id, "stop"), {
    errorToast: (error) => `停止失败：${error.message}`,
  });
  const full = useQuery({
    ...localTaskQueryOptions(task.id),
    enabled: fullLog,
  });

  const started = task.startedAt
    ? Date.parse(task.startedAt)
    : Date.parse(task.createdAt);
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : now;
  const elapsed = formatElapsed(ended - started);
  const agentLabel =
    task.instanceName || LOCAL_AGENT_INFO[task.agent]?.label || task.agent;
  const ok = task.status === "done";
  const pendingDiff = Boolean(task.diff?.pending);
  const HostIcon = task.deviceId === "server" ? IconServer : IconDeviceDesktop;
  const meta = (
    <div className="la-meta" data-testid="local-agent-meta">
      <HostIcon className="size-3.5 flex-none" />
      <span>{task.deviceName}</span>
      <span className="la-dot">{"·"}</span>
      <IconTerminal2 className="size-3.5 flex-none" />
      <span>{agentLabel}</span>
      <span className="la-profile" data-testid="local-agent-profile">
        {profileLine(task)}
      </span>
    </div>
  );

  const openResult = () => {
    const id = task.resultMessageId;
    const target = id
      ? document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
      : null;
    if (target) {
      smoothScrollIntoView(target, { block: "center" });
      target.classList.add("is-flash");
      setTimeout(() => target.classList.remove("is-flash"), 1200);
    } else setExpanded(true);
  };

  // 结束了、没有待处理的改动：收成一行（点 ⌄ 看过程）。
  if (!active && !expanded && !pendingDiff) {
    return (
      <div
        className={cn("worker-card la-card is-collapsed", `is-${task.status}`)}
        data-status={task.status}
        data-testid="local-agent-card"
      >
        <button
          className="worker-line"
          onClick={openResult}
          title={task.resultMessageId ? "跳到结果" : "展开"}
          type="button"
        >
          <span
            className={cn(
              "worker-icon",
              ok
                ? "is-done"
                : task.status === "cancelled"
                  ? "is-stopped"
                  : "is-failed",
            )}
          >
            {ok ? (
              <IconCheck className="size-3.5" stroke={2.5} />
            ) : task.status === "cancelled" ? (
              <IconPlayerStopFilled className="size-3" />
            ) : (
              <IconAlertTriangle className="size-3.5" />
            )}
          </span>
          <span className="worker-title">{task.title}</span>
          <span className="worker-line-text">
            {ok
              ? `${agentLabel} · ${task.diff?.files.length ? `${task.diff.files.length} 个文件 +${task.diff.added} −${task.diff.removed}${task.diff.applied ? " · 已应用" : ""}` : task.summary || "已完成"}`
              : task.error || LOCAL_TASK_STATUS_ZH[task.status]}
          </span>
          <span className="worker-time">{elapsed}</span>
        </button>
        <button
          aria-label={"展开详情"}
          className="worker-more"
          onClick={() => setExpanded(true)}
          title={"详情"}
          type="button"
        >
          <IconChevronDown className="size-3.5" />
        </button>
      </div>
    );
  }

  const lines = fullLog && full.data ? full.data.transcript : task.lines;
  return (
    <ContentEnter
      className={cn(
        "worker-card la-card",
        `is-${task.status === "pending_approval" ? "waiting" : task.status}`,
      )}
      data-status={task.status}
      data-testid="local-agent-card"
    >
      <div className="worker-head">
        <span
          className={cn(
            "worker-icon",
            task.status === "needs_input"
              ? "is-waiting"
              : active
                ? "is-running"
                : ok
                  ? "is-done"
                  : "is-failed",
          )}
        >
          {task.status === "needs_input" ? (
            <IconHelpCircle className="size-4" />
          ) : active ? (
            <IconLoader2 className="size-4" />
          ) : ok ? (
            <IconCheck className="size-3.5" stroke={2.5} />
          ) : (
            <IconAlertTriangle className="size-3.5" />
          )}
        </span>
        <span className="worker-title">{task.title}</span>
        <span
          className={cn(
            "worker-chip",
            task.status === "pending_approval"
              ? "is-waiting"
              : task.status === "starting"
                ? "is-running"
                : `is-${task.status}`,
          )}
          data-testid="local-agent-status"
        >
          {LOCAL_TASK_STATUS_ZH[task.status]}
        </span>
        <span className="worker-time">{elapsed}</span>
        {!active ? (
          <button
            aria-expanded
            aria-label={"收起"}
            className="worker-more"
            onClick={() => setExpanded(false)}
            title={"收起"}
            type="button"
          >
            <IconChevronDown className="size-3.5 rotate-180" />
          </button>
        ) : null}
      </div>
      {meta}
      <div
        className="worker-step"
        data-testid="local-agent-step"
        key={task.step ?? task.status}
      >
        {active
          ? task.step || "正在工作"
          : ok
            ? (task.summary?.split("\n")[0] ?? "已完成")
            : task.error || LOCAL_TASK_STATUS_ZH[task.status]}
      </div>
      <ApprovalBar task={task} />
      <PendingInputBar task={task} threadId={threadId} />
      <div className="worker-plan-wrap">
        <button
          aria-expanded={outputOpen}
          className="worker-plan-toggle"
          onClick={() => setOutputOpen((value) => !value)}
          type="button"
        >
          <IconChevronDown
            className={cn(
              "size-3.5 transition-transform",
              !outputOpen && "-rotate-90",
            )}
          />
          {`输出 ${task.lineCount} 行`}
        </button>
        {outputOpen && task.lineCount > task.lines.length ? (
          <button
            className="worker-plan-toggle la-full-toggle"
            onClick={() => setFullLog((value) => !value)}
            type="button"
          >
            {fullLog ? "只看最近" : "查看全部"}
          </button>
        ) : null}
        <div
          className="worker-plan-collapse"
          data-open={outputOpen || undefined}
        >
          <div>
            <OutputLines lines={lines} />
          </div>
        </div>
      </div>
      {!active && task.summary && ok ? (
        <div className="la-summary">{task.summary}</div>
      ) : null}
      <DiffBlock task={task} threadId={threadId} />
      <ContinueBar task={task} threadId={threadId} />
      {active ? (
        <div className="worker-actions">
          <Button
            data-testid="local-agent-stop"
            feedback="stop"
            onClick={() => void stop.run()}
            size="sm"
            state={stop.state}
            variant="outline"
          >
            <IconPlayerStopFilled />
            {"停止"}
          </Button>
        </div>
      ) : null}
    </ContentEnter>
  );
}

/** 交回来的结果消息：一行「本地 agent「Claude Code」在「我的电脑」上已完成：…」，点开看全文。 */
export function LocalAgentResultRow({
  messageId,
  text,
}: {
  messageId: string;
  text: string;
}) {
  const parsed = parseLocalAgentResult(text);
  const [open, setOpen] = useState(false);
  if (!parsed) return null;
  const ok = parsed.status === "done";
  const stopped = parsed.status === "cancelled";
  return (
    <div
      className={cn(
        "worker-result",
        ok ? "is-done" : stopped ? "is-stopped" : "is-failed",
      )}
      data-message-id={messageId}
      data-testid="local-agent-result"
    >
      <button
        aria-expanded={open}
        className="worker-result-line"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span
          className={cn(
            "worker-icon",
            ok ? "is-done" : stopped ? "is-stopped" : "is-failed",
          )}
        >
          {ok ? (
            <IconCheck className="size-3.5" stroke={2.5} />
          ) : stopped ? (
            <IconPlayerStopFilled className="size-3" />
          ) : (
            <IconAlertTriangle className="size-3.5" />
          )}
        </span>
        <span className="worker-result-head">
          {parsed.headline.replace(/。$/, "")}
        </span>
        <span className="worker-result-hint">{open ? "收起" : "查看结果"}</span>
        <IconChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      <div className="worker-plan-collapse" data-open={open || undefined}>
        <div className="worker-result-body">{parsed.body}</div>
      </div>
    </div>
  );
}
