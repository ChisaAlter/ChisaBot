import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { summarizeDoneWork, summarizeWork, type WorkCall, workStepLines } from "@/lib/chat/work-steps";

/**
 * 干活卡（DESIGN.md §70 / §74，Hark 的「实时工作卡片」）。
 *
 * 一轮里机器人开始干真正的活（搜索、读网页、操作设备…，不算看技能 / 画卡片）后，这张卡画在这一轮**第一个干活的工具
 * 那一行**里（不是末尾的「思考中」那个槽）：中间夹的过程话、后面的工具都排在它下面，卡片一直在原地，不会一会儿出现
 * 一会儿消失（§74.1）。干活时是「● 正在搜索「…」 · 第 3 步 · 12 秒 ⌄」；这一轮结束，同一个按钮原地换成
 * 「✓ 搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」，高度不变，所以结束那一刻画面不跳。点开（用户自己点才长高）是每一步。
 *
 * 用时从这一轮第一次看到干活卡算起（按 `turnKey` 记在模块里，卡片重挂也不归零）。
 */
const startedAt = new Map<string, number>();
const finishedAt = new Map<string, number>();

function remember(map: Map<string, number>, key: string, value: number) {
  if (map.has(key)) return;
  map.set(key, value);
  if (map.size > 50) map.delete(map.keys().next().value as string);
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

export function WorkRow({ calls, turnKey, live }: { calls: readonly WorkCall[]; turnKey: string; live: boolean }) {
  if (live) remember(startedAt, turnKey, Date.now());
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  // 结束时记下用时（只记一次）；之后重画都用同一个数。
  const [doneSeconds, setDoneSeconds] = useState<number | null>(() => (live ? null : workSeconds(turnKey)));
  useEffect(() => {
    if (!live) setDoneSeconds(workSeconds(turnKey));
  }, [live, turnKey]);
  const reduce = useReducedMotion();
  const summary = live ? summarizeWork(calls) : null;
  const done = live ? null : summarizeDoneWork(calls);
  if (live ? !summary : !done) return null;
  const since = startedAt.get(turnKey) ?? now;
  const seconds = live ? Math.max(0, Math.round((now - since) / 1000)) : doneSeconds;
  const steps = open ? workStepLines(calls) : [];
  const text = live ? summary!.current : done!.label;
  return (
    <div className="chat-work" data-state={live ? "live" : "done"}>
      <button
        aria-expanded={open}
        aria-label={open ? "收起步骤" : "展开步骤"}
        className={live ? "chat-thinking chat-work-card" : "chat-thinking chat-work-card chat-work-done"}
        data-state={live ? "live" : "done"}
        data-testid={live ? "chat-work-card" : "chat-work-done"}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {live ? (
          <span aria-hidden="true" className="chat-thinking-dots">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span aria-hidden="true" className="chat-work-check">
            <IconCheck className="size-3.5" stroke={2.5} />
          </span>
        )}
        <span className="chat-work-step" role={live ? "status" : undefined}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              animate={{ opacity: 1 }}
              className={live ? "tool-line-running chat-work-step-text" : "chat-work-step-text"}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key={text}
              transition={{ duration: reduce ? 0 : 0.18 }}
            >
              {text}
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="chat-work-meta">
          {live ? (summary!.count > 0 ? `第 ${summary!.count} 步` : "") : ""}
          {live && summary!.count > 0 && seconds !== null && seconds >= 2 ? " · " : ""}
          {seconds !== null && seconds >= 2 ? `${seconds} 秒` : ""}
        </span>
        <IconChevronDown aria-hidden="true" className="chat-work-chevron size-3.5" data-open={open || undefined} />
      </button>
      {open ? (
        <ol className="chat-work-steps" data-testid="chat-work-steps">
          {steps.length === 0 ? <li>{"正在准备"}</li> : null}
          {steps.map((step, index) => (
            <li className={live && index === steps.length - 1 ? "is-current" : undefined} key={`${index}:${step}`}>
              {step}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
