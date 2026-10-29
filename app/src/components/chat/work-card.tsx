import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CapsuleSpinner } from "@/components/chat/status-capsule";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import { setWorkUi, workUi } from "@/lib/chat/ui-memory";
import { currentWorkStep, summarizeDoneWork, summarizeWork, type WorkCall, type WorkNote, workTimeline } from "@/lib/chat/work-steps";
import { useNow } from "@/lib/use-now";

/** 干活卡把当前这一步广播出去，右栏正在搭建的面板写「正在搜索「…」」（DESIGN.md §77.1）。 */
export const WORK_STEP_EVENT = "chisabot-work-step";
export type WorkStepDetail = { name: string; label: string } | null;
let lastStep: WorkStepDetail = null;
/** 最近广播的一步（卡片晚于广播挂上时先用它）。 */
export function lastWorkStep(): WorkStepDetail {
  return lastStep;
}
function announceStep(detail: WorkStepDetail) {
  lastStep = detail;
  window.dispatchEvent(new CustomEvent<WorkStepDetail>(WORK_STEP_EVENT, { detail }));
}

/**
 * 干活卡（DESIGN.md §70 / §75，Hark 的「实时工作卡片」）。
 *
 * 一轮里机器人开始干真正的活（搜索、读网页、操作设备…，不算看技能 / 画卡片）后，这张卡画在这一轮**第一个干活的工具
 * 那一行**里（不是末尾的「思考中」那个槽）：中间夹的过程话、后面的工具都排在它下面，卡片一直在原地，不会一会儿出现
 * 一会儿消失（§75.1）。干活时是「● 正在搜索「…」 · 第 3 步 · 12 秒 ⌄」；这一轮结束，同一个按钮原地换成
 * 「✓ 搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」，高度不变，所以结束那一刻画面不跳。点开（用户自己点才长高）是每一步。
 *
 * 用时从这一轮第一次看到干活卡算起（按 `turnKey` 记在模块里，卡片重挂也不归零）。
 */
const startedAt = new Map<string, number>();
const finishedAt = new Map<string, number>();
/** 这一页亲眼看着停下来的那几轮（`markTurnRunEnded`）：同一轮再开始跑时重新计时。 */
const endedRuns = new Set<string>();

function remember(map: Map<string, number>, key: string, value: number) {
  if (map.has(key)) return;
  map.set(key, value);
  if (map.size > 50) map.delete(map.keys().next().value as string);
}

/**
 * 这一轮从什么时候开始（第一次问的那一刻；按 `turnKey` 记在模块里）。对话末尾的「思考中」胶囊和干活卡都用它，
 * 换成干活卡、切到别的频道再回来、卡片重挂，秒数都接着算，不归零（回复显示①，2026-10-29）。
 */
export function turnStartedAt(turnKey: string, now = Date.now()): number {
  // 上一次跑已经停了，这是同一轮重新开始跑（重试、重新生成、确认后接着跑）：开始时间和用时都从头算，
  // 不然一出来就是「45 秒」（复审 #404）。
  if (endedRuns.has(turnKey)) restartTurnClock(turnKey);
  remember(startedAt, turnKey, now);
  return startedAt.get(turnKey) ?? now;
}

function restartTurnClock(turnKey: string) {
  endedRuns.delete(turnKey);
  startedAt.delete(turnKey);
  finishedAt.delete(turnKey);
  if (workUi(turnKey)?.seconds !== undefined)
    setWorkUi(turnKey, { seconds: undefined });
}

/**
 * 这一轮这一次跑停下来了（这一页亲眼看着从「跑着」变成「停了」）。只记一笔，下次 `turnStartedAt` 才重新计时；
 * 切频道回来重挂时还在跑，不会经过这里，所以秒数接着算。
 */
export function markTurnRunEnded(turnKey: string): void {
  if (!startedAt.has(turnKey)) return;
  endedRuns.add(turnKey);
  if (endedRuns.size > 50) endedRuns.delete(endedRuns.values().next().value as string);
}

/**
 * 键盘点开过步骤、这一轮结束时这一行被收起（外层变成 inert / aria-hidden）：焦点不能掉到 body 上。
 * 移到收起后接着看得见的那一行（通常是回答；没有就往上找），那一行不能聚焦时给它 tabIndex=-1。
 */
function moveFocusOffFolded(root: HTMLElement) {
  const folded = root.closest<HTMLElement>("[inert], [aria-hidden='true']");
  if (!folded) return;
  const row = folded.closest<HTMLElement>("[data-message-id]") ?? folded;
  const usable = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement &&
    el.hasAttribute("data-message-id") &&
    !el.hasAttribute("inert") &&
    el.getAttribute("aria-hidden") !== "true" &&
    // 只画了一个空壳的行（调试开关关着时的工具调用行）不算。
    (el.textContent ?? "").trim().length > 0;
  let target: Element | null = row.nextElementSibling;
  while (target && !usable(target)) target = target.nextElementSibling;
  if (!target) {
    target = row.previousElementSibling;
    while (target && !usable(target)) target = target.previousElementSibling;
  }
  if (!usable(target)) return;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/**
 * 这一轮干了多少秒：只有这台页面亲眼看着干活卡跑过才知道（开始时间记在上面）；
 * 第一次问的那一刻当结束时间。从历史打开的对话不知道，返回 null，那一行就不写用时。
 */
export function workSeconds(turnKey: string): number | null {
  const start = startedAt.get(turnKey);
  if (start === undefined) return null;
  remember(finishedAt, turnKey, Date.now());
  const seconds = Math.round(((finishedAt.get(turnKey) ?? Date.now()) - start) / 1000);
  return seconds >= 2 ? seconds : null;
}

/**
 * 这一轮用了几秒——知道才给（这一页看着它跑过，或这台浏览器记下过，§88）；不知道为 null。
 * 简单回合（§93）用它挡住「其实跑了很久」的那几轮。
 */
export function knownWorkSeconds(turnKey: string): number | null {
  return workSeconds(turnKey) ?? workUi(turnKey)?.seconds ?? null;
}

export function WorkRow({
  calls,
  turnKey,
  live,
  notes,
  since,
  unanswered = false,
}: {
  calls: readonly WorkCall[];
  turnKey: string;
  live: boolean;
  /**
   * 这一轮做完了却没有看得见的回答（回复显示①）：这一行留着写「N 步失败」。窄屏上做完的行不写用时 / 步数
   * （styles.css），这一行例外，用 `data-unanswered` 在 status-capsule.css 里重新显示。
   */
  unanswered?: boolean;
  /** 收进卡片的过程话（§90）。 */
  notes?: readonly WorkNote[];
  /** 这一轮开始的时刻（末尾「思考中」胶囊从这里算秒，换成干活卡后接着算，不归零）。 */
  since?: number;
}) {
  if (live) remember(startedAt, turnKey, since ?? Date.now());
  // 点开过的干活卡离开再回来 / 刷新后还开着（按这一轮记，DESIGN.md §88）。
  // 回复显示①：做完的一轮一律收起（工具过程做完就不再摊开），只有还在跑的一轮记得点开过。
  const [open, setOpenState] = useState(() => live && workUi(turnKey)?.open === true);
  const setOpen = (update: (value: boolean) => boolean) =>
    setOpenState((value) => {
      const next = update(value);
      setWorkUi(turnKey, { open: next });
      return next;
    });
  const now = useNow(live);
  // 跑着的时候点开过，做完那一刻自动收起（不用用户再点一下）。
  const wasLive = useRef(live);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (wasLive.current && !live) {
      // 这一页看着它停下：同一轮再跑时重新计时。
      markTurnRunEnded(turnKey);
      setOpenState(false);
      setWorkUi(turnKey, { open: false });
      // 焦点在这一行上、这一行跟着这一轮收起了：移到收起后的那一行（不掉到 body）。
      const root = rootRef.current;
      if (root && (hadFocus.current || root.contains(document.activeElement)))
        moveFocusOffFolded(root);
    }
    wasLive.current = live;
  }, [live, turnKey]);
  // 结束时记下用时（只记一次）；之后重画都用同一个数。
  // 用时只有亲眼看着它跑的那一页知道：记下来，刷新 / 切回来后「做了 2 步 · 10 秒」的秒数还在（§88）。
  const [doneSeconds, setDoneSeconds] = useState<number | null>(() =>
    live ? null : (workSeconds(turnKey) ?? workUi(turnKey)?.seconds ?? null),
  );
  useEffect(() => {
    if (live) return;
    const seconds = workSeconds(turnKey);
    if (seconds !== null) setWorkUi(turnKey, { seconds });
    setDoneSeconds(seconds ?? workUi(turnKey)?.seconds ?? null);
  }, [live, turnKey]);
  const step = live ? currentWorkStep(calls) : null;
  const stepKey = step ? `${step.name}\n${step.label}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: stepKey carries step.
  useEffect(() => {
    if (!live) return;
    announceStep(step);
  }, [live, stepKey]);
  useEffect(() => {
    if (!live) return;
    return () => announceStep(null);
  }, [live]);
  const reduce = useReducedMotion();
  const summary = live ? summarizeWork(calls) : null;
  const done = live ? null : summarizeDoneWork(calls);
  if (live ? !summary : !done) return null;
  const started = startedAt.get(turnKey) ?? now;
  const seconds = live ? Math.max(0, Math.floor((now - started) / 1000)) : doneSeconds;
  // 在跑时没返回的步骤是「进行中」（审查模块 7：以前标成「（失败）」）。
  const steps = open ? workTimeline(calls, notes, live) : [];
  const text = live ? summary!.current : done!.label;
  // 读屏：按钮名字里先说当前动作 / 做了什么（以前只有「展开步骤」，把动作盖掉了），再说点了会怎样。
  const failedText = !live && done?.failed ? `，${done.failed} 步失败` : "";
  const label = `${text}${failedText}，${open ? "收起步骤" : "展开步骤"}`;
  return (
    <div className="chat-work" data-state={live ? "live" : "done"} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label={label}
        onBlur={() => {
          hadFocus.current = false;
        }}
        onFocus={() => {
          hadFocus.current = true;
        }}
        className={live ? "rs-capsule chat-work-card" : "chat-thinking chat-work-card chat-work-done"}
        data-state={live ? "live" : "done"}
        data-testid={live ? "chat-work-card" : "chat-work-done"}
        data-unanswered={!live && unanswered ? "" : undefined}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {live ? (
          <CapsuleSpinner />
        ) : (
          <span aria-hidden="true" className="chat-work-check">
            <IconCheck className="size-3.5" stroke={2.5} />
          </span>
        )}
        {/* role=status 不在这里：对话末尾一直挂着的那个（transcript-live-status）读当前动作。 */}
        <span className="chat-work-step">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              animate={{ opacity: 1, y: 0 }}
              className="chat-work-step-text"
              // 换字：旧的往上淡出、新的从下面淡入（§78.3），两行不在同一处叠着，读起来不像两段字。
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              key={text}
              transition={{ duration: reduce ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}
            >
              {text}
            </motion.span>
          </AnimatePresence>
        </span>
        <span aria-hidden={live || undefined} className={live ? "chat-work-meta rs-capsule-time" : "chat-work-meta"}>
          {/*
           * 跑着的时候只报时间，不再报「第 N 步」；做完的那一行整行不画（用户：全部不显示步数，只留回答）。
           */}
          {!live && done?.failed ? `${done.failed} 步失败` : ""}
          {!live && done?.failed && seconds !== null && seconds >= 2 ? " · " : ""}
          {live
            ? seconds !== null && seconds >= 1
              ? `${seconds} 秒`
              : ""
            : seconds !== null && seconds >= 2
              ? `${seconds} 秒`
              : ""}
        </span>
        <IconChevronDown aria-hidden="true" className="chat-work-chevron size-3.5" data-open={open || undefined} />
      </button>
      {open ? (
        <ol className="chat-work-steps" data-testid="chat-work-steps">
          {steps.length === 0 ? <li>{"正在准备"}</li> : null}
          {steps.map((step, index) => (
            <li
              className={
                step.kind === "note" ? "chat-work-note" : step.state === "running" ? "is-current" : undefined
              }
              data-kind={step.kind}
              data-state={step.state}
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表：只追加、不重排、没有稳定 id
              key={`${index}:${step.text}`}
            >
              {step.text}
              <ActivityJumpButton
                name={step.call?.name}
                toolCallId={step.call?.id}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
