import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useNow } from "@/lib/use-now";
import "./status-capsule.css";

/**
 * 等待时的一行状态胶囊（回复显示①，2026-10-29，参考 Hark）：转圈 + 当前动作 + 已用秒数。
 *
 * 一轮里同一时刻只画一个：还没开始干活时画在对话末尾（「思考中」），开始干活后由干活卡自己画（同一套 rs- 类）。
 * 以前末尾的「思考中」是一个带三个跳点的气泡、一句话之后又是一排不带字的小点，两种占位长得不一样；现在都是这一个胶囊。
 *
 * - 不用 backdrop-filter：底色是设计系统的 `--glass-strong`，减少透明度 / 性能模式下换不透明底色。
 * - 动画只有 transform（转圈、进场上移）和 opacity（进场淡入）；减少动态效果时都不动。
 * - 读屏：胶囊自己不带 role=status——对话末尾有一个一直挂着的 role=status（chat-transcript.tsx 的
 *   `transcript-live-status`），「思考中」换成干活卡时同一个节点里换字。秒数 aria-hidden，不会每秒播一次。
 */
export function CapsuleSpinner() {
  return (
    <span aria-hidden="true" className="rs-spinner" data-testid="rs-spinner" />
  );
}

/** 秒数：不到 1 秒不写（刚出现那一下不闪「0 秒」）。 */
export function capsuleSeconds(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds >= 1 ? `${seconds} 秒` : "";
}

export function StatusCapsule({
  label,
  since,
  testId = "status-capsule",
  variant,
}: {
  label: string;
  /** 从什么时候算起（这一轮开始的时刻）。 */
  since: number;
  testId?: string;
  /** `pause`：说了一句之后的停顿。和以前停顿时的占位一样高（22px），来新字时它让位，下面不多跳。 */
  variant?: "pause";
}) {
  const now = useNow(true);
  const time = capsuleSeconds(since, Math.max(now, since));
  return (
    <div
      className="rs-capsule"
      data-state="live"
      data-testid={testId}
      data-variant={variant}
    >
      <CapsuleSpinner />
      <span className="rs-capsule-label">{label}</span>
      <span aria-hidden="true" className="rs-capsule-time">
        {time}
      </span>
    </div>
  );
}

/**
 * 机器人说了一句、还没有下文（DESIGN.md §78.2）：停 0.9 秒才出胶囊——回答写完到这一轮真正结束通常不到 0.9 秒，
 * 不会在答案后面闪一下；有新字或工具一来就收起（`watch` 变了重新计时）。
 */
export function PausedCapsule({
  watch,
  since,
}: {
  watch: string;
  since: number;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const timer = window.setTimeout(() => setShown(true), 900);
    return () => window.clearTimeout(timer);
  }, [watch]);
  if (!shown) return null;
  return (
    <StatusCapsule
      label="思考中"
      since={since}
      testId="transcript-pause-capsule"
      variant="pause"
    />
  );
}

/**
 * 一轮结束了、却没有一个看得见的回答（回复显示①，2026-10-29）：工具失败后模型没再写字，或者只回了「---」。
 * 以前这一轮整段收起，画面上是一片空白；现在干活那一行留着（「N 步失败」），下面是这一句和重试。
 * 重试走现有的「重发没有回答的那一条」（`onRetryUnanswered`，和重新生成同一条路）；只有最后一轮带。
 */
export function NoAnswerRow({
  onRetry,
}: {
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="rs-noanswer" data-testid="turn-no-answer">
      <span className="rs-noanswer-text">{"这一轮没有回答"}</span>
      {onRetry ? (
        <button className="chat-error-retry" onClick={onRetry} type="button">
          <IconRefresh aria-hidden="true" className="size-3.5" />
          {"重试"}
        </button>
      ) : null}
    </div>
  );
}
