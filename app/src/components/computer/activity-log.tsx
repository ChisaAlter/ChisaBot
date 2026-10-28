/**
 * 计算机活动（CB-101）：机器人和你在这台电脑上做过的每一步。
 *
 * 记录在服务端（刷新、换设备都在，保留 90 天）。按轮分组：一组的标题是你那句话，组里按先后列出
 * 每一步——做了什么、对什么、结果、用了多久。连续的只读探查命令合成一行「运行了 N 条命令」；被拒绝的
 * 一步用写给人看的状态（「已拒绝：电脑当前由你控制」），不显示给模型的原文。
 *
 * 新记录从顶上淡入并高亮；你往下翻着看旧记录时，新记录进来不会把内容顶走，而是在顶上提示「N 条新记录」。
 */
import {
  IconAlertTriangle,
  IconArrowUp,
  IconBan,
  IconChevronDown,
  IconClock,
  IconFile,
  IconFolder,
  IconHandFinger,
  IconKeyboard,
  IconLoader2,
  IconMessage,
  IconPhoto,
  IconTerminal2,
  IconUser,
  IconWorld,
} from "@tabler/icons-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tryClient } from "@/lib/client";
import {
  type ActivityItem,
  type ActivityTurn,
  groupActivity,
} from "@/lib/computers/activity-groups";
import {
  type ActivityStep,
  useComputerActivity,
} from "@/lib/computers/use-computer-activity";
import {
  formatBytes,
  formatDuration,
  formatTurnPrompt,
  statusText,
  stepObject,
  stepVerb,
} from "../../../../shared/computer-activity-labels";
import {
  clearActivityJump,
  JUMP_TO_ACTIVITY,
  JUMP_TO_TOOL_CALL,
  pendingActivityJump,
} from "./activity-jump";
import { CommandOutput } from "./command-output";
import { LegacyActivityLog } from "./legacy-activity-log";

const KIND_ICONS: Record<string, typeof IconTerminal2> = {
  navigate: IconWorld,
  read: IconWorld,
  snapshot: IconWorld,
  tabs: IconWorld,
  click: IconHandFinger,
  type: IconKeyboard,
  key: IconKeyboard,
  scroll: IconHandFinger,
  help: IconHandFinger,
  secret: IconKeyboard,
  screenshot: IconPhoto,
  run_command: IconTerminal2,
  read_file: IconFile,
  write_file: IconFile,
  download_file: IconFile,
  list_files: IconFolder,
};

function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function jumpToChat(step: Pick<ActivityStep, "toolCallId" | "threadId">) {
  if (!step.toolCallId) return;
  window.dispatchEvent(
    new CustomEvent(JUMP_TO_TOOL_CALL, {
      detail: { toolCallId: step.toolCallId, threadId: step.threadId },
    }),
  );
}

function StatusBadge({ step }: { step: ActivityStep }) {
  const text = statusText(step);
  if (step.status === "running") {
    return (
      <span className="activity-badge is-running">
        <IconLoader2 aria-hidden className="size-3 animate-spin" />
        {text}
      </span>
    );
  }
  if (!text) return null;
  const Icon =
    step.status === "refused"
      ? IconBan
      : step.status === "timeout"
        ? IconClock
        : IconAlertTriangle;
  return (
    <span className={`activity-badge is-${step.status}`}>
      <Icon aria-hidden className="size-3" />
      {text}
    </span>
  );
}

function FramePreview({
  computerId,
  step,
}: {
  computerId: string;
  step: ActivityStep;
}) {
  const [state, setState] = useState<"idle" | "loading" | "none" | string>(
    "idle",
  );
  const open = useCallback(() => {
    if (state !== "idle") return;
    setState("loading");
    tryClient(
      `/api/computers/${encodeURIComponent(computerId)}/activity/${encodeURIComponent(step.id)}/frame`,
      {},
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          frame?: { frame?: string } | null;
        } | null;
        setState(body?.frame?.frame ? body.frame.frame : "none");
      })
      .catch(() => setState("none"));
  }, [computerId, state, step.id]);
  if (state === "idle" || state === "loading") {
    return (
      <button
        className="activity-link"
        disabled={state === "loading"}
        onClick={open}
        type="button"
      >
        <IconPhoto aria-hidden className="size-3.5" />
        {state === "loading" ? "正在取画面…" : "看当时的画面"}
      </button>
    );
  }
  if (state === "none")
    return <span className="activity-muted">{"这一步没有留下画面。"}</span>;
  return (
    <img
      alt="这一步结束时的画面"
      className="activity-frame"
      src={`data:image/png;base64,${state}`}
    />
  );
}

function StepDetails({
  computerId,
  step,
}: {
  computerId: string;
  step: ActivityStep;
}) {
  const detail = step.detail ?? {};
  const rows: ReactNode[] = [];
  if (step.kind === "run_command" && step.status !== "refused") {
    rows.push(
      <div className="activity-output" key="out">
        <CommandOutput
          {...(typeof detail.exitCode === "number"
            ? { exitCode: detail.exitCode }
            : {})}
          output={step.output ?? ""}
          timedOut={step.status === "timeout"}
          truncated={step.outputTruncated}
        />
      </div>,
    );
  }
  if (typeof detail.bytes === "number" && step.kind !== "run_command") {
    rows.push(
      <span className="activity-muted" key="bytes">
        {formatBytes(detail.bytes)}
      </span>,
    );
  }
  if (typeof detail.title === "string" && detail.title) {
    rows.push(
      <span className="activity-muted" key="title">
        {detail.title}
      </span>,
    );
  }
  if (typeof detail.error === "string" && detail.error) {
    rows.push(
      <span className="activity-error" key="err">
        {detail.error}
      </span>,
    );
  }
  if (step.hasFrame || (step.kind === "navigate" && step.toolCallId)) {
    rows.push(<FramePreview computerId={computerId} key="frame" step={step} />);
  }
  if (step.toolCallId) {
    rows.push(
      <button
        className="activity-link"
        key="jump"
        onClick={() => jumpToChat(step)}
        type="button"
      >
        <IconMessage aria-hidden className="size-3.5" />
        {"在对话里看这一步"}
      </button>,
    );
  }
  if (!rows.length) return null;
  return <div className="activity-details">{rows}</div>;
}

function hasDetails(step: ActivityStep): boolean {
  return (
    (step.kind === "run_command" && step.status !== "refused") ||
    step.hasFrame ||
    Boolean(step.toolCallId) ||
    typeof step.detail?.error === "string"
  );
}

function StepRow({
  computerId,
  step,
  fresh,
}: {
  computerId: string;
  step: ActivityStep;
  fresh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICONS[step.kind] ?? IconTerminal2;
  const object = stepObject(step);
  const expandable = hasDetails(step);
  const code =
    step.kind === "run_command" ||
    step.kind.endsWith("_file") ||
    step.kind === "list_files";
  const duration =
    step.status !== "running" ? formatDuration(step.durationMs) : "";
  return (
    <li
      className={`activity-step${fresh ? " is-fresh" : ""}`}
      data-activity-step={step.id}
      data-kind={step.kind}
      data-status={step.status}
      data-tool-call={step.toolCallId ?? undefined}
    >
      <button
        aria-expanded={expandable ? open : undefined}
        className="activity-step-head"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon aria-hidden className="activity-step-icon" />
        <span className="activity-step-main">
          {step.actorKind === "human" ? (
            <span className="activity-you">{"你"}</span>
          ) : null}
          <span className="activity-verb">{stepVerb(step)}</span>
          {object ? (
            code ? (
              <code className="activity-object is-code" title={object}>
                {object}
              </code>
            ) : (
              <span className="activity-object" title={object}>
                {object}
              </span>
            )
          ) : null}
        </span>
        <span className="activity-step-meta">
          <StatusBadge step={step} />
          {duration ? (
            <span className="activity-duration">{duration}</span>
          ) : null}
          <time dateTime={step.startedAt}>{timeOf(step.startedAt)}</time>
          {expandable ? (
            <IconChevronDown
              aria-hidden
              className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          ) : null}
        </span>
      </button>
      {open ? <StepDetails computerId={computerId} step={step} /> : null}
    </li>
  );
}

function BatchRow({
  computerId,
  steps,
  fresh,
}: {
  computerId: string;
  steps: ActivityStep[];
  fresh: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const first = steps[0] as ActivityStep;
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  return (
    <li
      className={`activity-step is-batch${steps.some((step) => fresh.has(step.id)) ? " is-fresh" : ""}`}
      data-activity-batch={steps.length}
      data-status="ok"
      data-tool-calls={
        steps
          .map((step) => step.toolCallId ?? "")
          .join(" ")
          .trim() || undefined
      }
    >
      <button
        aria-expanded={open}
        className="activity-step-head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <IconTerminal2 aria-hidden className="activity-step-icon" />
        <span className="activity-step-main">
          <span className="activity-verb">{`运行了 ${steps.length} 条命令`}</span>
          <code className="activity-object is-code">
            {steps
              .map((step) => step.subject.split(/\s+/)[0])
              .slice(0, 4)
              .join("、")}
            {steps.length > 4 ? "…" : ""}
          </code>
        </span>
        <span className="activity-step-meta">
          {total ? (
            <span className="activity-duration">{formatDuration(total)}</span>
          ) : null}
          <time dateTime={first.startedAt}>{timeOf(first.startedAt)}</time>
          <IconChevronDown
            aria-hidden
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <ul className="activity-batch-list">
          {steps.map((step) => (
            <StepRow
              computerId={computerId}
              fresh={false}
              key={step.id}
              step={step}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const TURN_STATUS: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  succeeded: "已完成",
  failed: "出错了",
  cancelled: "已停止",
  stopped: "已停止",
  interrupted: "已中断",
};

function TurnGroup({
  computerId,
  turn,
  fresh,
}: {
  computerId: string;
  turn: ActivityTurn;
  fresh: ReadonlySet<string>;
}) {
  const human = turn.actorKind === "human";
  const cleanedPrompt = human ? null : formatTurnPrompt(turn.prompt);
  const title = human
    ? "你自己的操作"
    : cleanedPrompt
      ? cleanedPrompt.title
      : turn.runId
        ? "机器人的操作"
        : "未归属的操作";
  const status = turn.running
    ? "进行中"
    : turn.turnStatus
      ? TURN_STATUS[turn.turnStatus]
      : undefined;
  return (
    <section className="activity-turn" data-actor={turn.actorKind}>
      <header className="activity-turn-head">
        {human ? (
          <IconUser aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <IconMessage aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="activity-turn-title" title={title}>
          {human || !cleanedPrompt || cleanedPrompt.isSystem
            ? title
            : `「${title}」`}
        </span>
        {status ? <span className="activity-turn-status">{status}</span> : null}
      </header>
      <ul className="activity-steps">
        {turn.items.map((item: ActivityItem) =>
          item.type === "batch" ? (
            <BatchRow
              computerId={computerId}
              fresh={fresh}
              key={item.id}
              steps={item.steps}
            />
          ) : (
            <StepRow
              computerId={computerId}
              fresh={fresh.has(item.step.id)}
              key={item.step.id}
              step={item.step}
            />
          ),
        )}
      </ul>
    </section>
  );
}

export function ActivityLog({
  computerId,
  threadId,
  onNewest,
}: {
  computerId: string;
  threadId?: string;
  /** 最新一步的 id 变了（窄屏「活动」标签的未读点用）。 */
  onNewest?: (id: string | undefined) => void;
}) {
  const activity = useComputerActivity(
    computerId,
    threadId ? { threadId } : {},
  );
  const newestId = activity.steps[0]?.id;
  useEffect(() => {
    onNewest?.(newestId);
  }, [newestId, onNewest]);
  const turns = useMemo(() => groupActivity(activity.steps), [activity.steps]);
  const scroller = useRef<HTMLDivElement>(null);
  const before = useRef<{
    top: number;
    first: string | undefined;
    anchor?: { id: string; offset: number };
  }>({
    top: 0,
    first: undefined,
  });
  const [unseen, setUnseen] = useState(0);

  /** 眼前最上面那一行（id 和它离列表顶的距离），新记录进来后按它把滚动位置补回去。 */
  const readAnchor = useCallback((element: HTMLDivElement) => {
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll<HTMLElement>(
      "[data-activity-step]",
    )) {
      const offset = row.getBoundingClientRect().top - top;
      if (offset >= 0) return { id: row.dataset.activityStep ?? "", offset };
    }
    return undefined;
  }, []);

  /*
   * 新的一步加在最上面。你正在看下面的旧记录时（滚动位置不在顶部），让眼前那一行留在原处；
   * 在顶部时什么也不做，新记录自然出现在眼前。浏览器自带的滚动锚定已关掉（overflow-anchor: none），免得补两次。
   */
  useLayoutEffect(() => {
    const element = scroller.current;
    const first = activity.steps[0]?.id;
    if (!element) return;
    const previous = before.current;
    if (previous.top > 4 && previous.anchor) {
      const row = element.querySelector<HTMLElement>(
        `[data-activity-step="${CSS.escape(previous.anchor.id)}"]`,
      );
      if (row) {
        const offset =
          row.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.scrollTop += offset - previous.anchor.offset;
      }
    }
    if (previous.first && first !== previous.first && previous.top > 4) {
      const added = activity.steps.findIndex(
        (step) => step.id === previous.first,
      );
      if (added > 0) setUnseen((count) => count + added);
    }
    before.current = {
      top: element.scrollTop,
      first,
      anchor: readAnchor(element),
    };
  }, [activity.steps, readAnchor]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    before.current = {
      ...before.current,
      top: element.scrollTop,
      anchor: readAnchor(element),
    };
    if (element.scrollTop <= 4) setUnseen(0);
  }, [readAnchor]);

  /*
   * 对话 → 活动记录（和 JUMP_TO_TOOL_CALL 对称）：找到这次工具调用记下的步骤，滚到第一步、整组高亮。
   * 被合并的命令先展开那一组。记录还没到就等数据来了再找（请求 10 秒内有效）。
   */
  const [jumpTick, setJumpTick] = useState(0);
  useEffect(() => {
    const onJump = () => setJumpTick((tick) => tick + 1);
    window.addEventListener(JUMP_TO_ACTIVITY, onJump);
    return () => window.removeEventListener(JUMP_TO_ACTIVITY, onJump);
  }, []);
  useEffect(() => {
    void jumpTick;
    const toolCallId = pendingActivityJump();
    const element = scroller.current;
    if (!toolCallId || !element || !activity.steps.length) return;
    const selector = `[data-tool-call="${CSS.escape(toolCallId)}"]`;
    const rows = [...element.querySelectorAll<HTMLElement>(selector)];
    if (!rows.length) {
      const batch = element.querySelector<HTMLElement>(
        `[data-activity-batch][data-tool-calls~="${CSS.escape(toolCallId)}"] > button`,
      );
      if (batch && batch.getAttribute("aria-expanded") !== "true") {
        batch.click();
        setTimeout(() => setJumpTick((tick) => tick + 1), 0);
        return;
      }
      if (activity.hasMore && activity.steps.length < 500) activity.loadMore();
      return;
    }
    clearActivityJump(toolCallId);
    // 组内从旧到新：DOM 里第一个就是这次调用最早的那步。
    const target = rows[0];
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      element.scrollTop;
    element.scrollTo({ top: Math.max(0, top - 24) });
    before.current = {
      ...before.current,
      top: element.scrollTop,
      anchor: readAnchor(element),
    };
    target
      .closest(".computer-rail-activity, .activity-log")
      ?.scrollIntoView?.({ block: "nearest" });
    for (const row of rows) {
      row.classList.remove("is-activity-jump");
      void row.offsetWidth;
      row.classList.add("is-activity-jump");
      setTimeout(() => row.classList.remove("is-activity-jump"), 1800);
    }
  }, [
    jumpTick,
    activity.steps,
    activity.hasMore,
    activity.loadMore,
    readAnchor,
  ]);

  if (activity.legacy) return <LegacyActivityLog computerId={computerId} />;

  if (activity.loading && !activity.steps.length) {
    return <p className="activity-empty">{"正在读取活动记录…"}</p>;
  }
  if (!activity.steps.length) {
    return (
      <p className="activity-empty">
        {activity.error ??
          "暂无。机器人在这台电脑上打开网页、点击、输入、运行命令、读写文件，都会按顺序记在这里。"}
      </p>
    );
  }

  return (
    <div className="activity-log">
      {unseen > 0 ? (
        <button
          className="activity-unseen"
          onClick={() => {
            scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
            setUnseen(0);
          }}
          type="button"
        >
          <IconArrowUp aria-hidden className="size-3.5" />
          {`${unseen} 条新记录`}
        </button>
      ) : null}
      <div className="activity-scroll" onScroll={onScroll} ref={scroller}>
        {turns.map((turn) => (
          <TurnGroup
            computerId={computerId}
            fresh={activity.fresh}
            key={turn.key}
            turn={turn}
          />
        ))}
        {activity.hasMore ? (
          <button
            className="activity-more"
            onClick={activity.loadMore}
            type="button"
          >
            {"加载更早的记录"}
          </button>
        ) : (
          <p className="activity-retention">{`记录保留 ${activity.retentionDays} 天。`}</p>
        )}
      </div>
    </div>
  );
}
