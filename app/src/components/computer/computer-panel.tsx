import { useState } from "react";
import { markComputerEngaged } from "@/lib/computers/auto-watch";
import { useComputerStatus } from "@/lib/computers/use-status";
import { lastComputerStatusFor } from "@/lib/copilot/computer-activity";
import { ActivityLog } from "./activity-log";
import { ComputerView } from "./computer-view";

/**
 * The current live computer, separate from screenshots kept in historical tool results.
 *
 * `variant="rail"`：放在右栏「计算机」标签里（DESIGN.md §23），没有自己的外边距，标题交给标签。
 * 在这里点过、按过键，就算用户接手了：机器人停手后不再自动切回「面板」。
 */
export function ComputerViewPanel({
  agentId,
  name,
  variant = "pane",
}: {
  agentId: string;
  name?: string;
  variant?: "pane" | "rail";
}) {
  const engaged = () => markComputerEngaged(agentId);
  const liveStatus = useComputerStatus(agentId);
  const status = liveStatus ?? lastComputerStatusFor(agentId);
  // CB-101：预览给大屏直播让路时，状态行直接说明，免得以为电脑坏了。
  const [casting, setCasting] = useState(false);
  return (
    <section
      aria-label={"计算机"}
      className={variant === "rail" ? "computer-rail flex flex-col gap-3 pb-1" : "p-4"}
      onKeyDownCapture={engaged}
      onPointerDownCapture={engaged}
    >
      {/* 状态行：机器人此刻在做什么（像 Hark 的浏览器卡片），动作结束后停留几秒再淡出。 */}
      <div
        aria-live="polite"
        className="computer-status"
        data-pending={status?.pending || undefined}
        data-casting={casting || undefined}
        data-visible={status || casting ? true : undefined}
        role="status"
      >
        {casting && !status?.pending ? (
          <>
            <span aria-hidden className="computer-status-dot is-cast" />
            <span className="computer-status-text">{"画面正在大屏直播，这里暂停预览；活动记录照常更新"}</span>
          </>
        ) : status ? (
          <>
            <span aria-hidden className="computer-status-dot" />
            <span className="computer-status-text">{status.pending ? `${status.label}…` : status.label.replace(/^正在/, "刚刚")}</span>
          </>
        ) : (
          <span className="computer-status-text is-idle">{"机器人用浏览器时，这里会实时显示画面和它在做什么"}</span>
        )}
      </div>
      <ComputerView
        active
        browserChrome
        computerId={agentId}
        name={name}
        minWidth={0}
        minHeight={0}
        onLiveCastChange={setCasting}
      />
      <div className={variant === "rail" ? "computer-rail-activity" : "mt-8"}>
        <h3 className="activity-heading">{"活动"}</h3>
        <ActivityLog computerId={agentId} />
      </div>
    </section>
  );
}
