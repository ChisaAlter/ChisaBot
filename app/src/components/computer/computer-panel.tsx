import { useCallback, useEffect, useRef, useState } from "react";
import { markComputerEngaged } from "@/lib/computers/auto-watch";
import { useComputerStatus } from "@/lib/computers/use-status";
import { lastComputerStatusFor } from "@/lib/copilot/computer-activity";
import { JUMP_TO_ACTIVITY, pendingActivityJump } from "./activity-jump";
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
  /*
   * CB-101：窄屏（< 768px）「画面 | 活动」分段切换。只是组件里的状态，不碰路由和 history（#315 那类返回栈问题）。
   * 默认「画面」；停在「画面」时来了新活动，「活动」上亮未读点，切过去清掉。宽屏两块都显示，标签由 CSS 藏起来。
   */
  const [tab, setTab] = useState<"screen" | "activity">(() =>
    pendingActivityJump() ? "activity" : "screen",
  );
  const [unread, setUnread] = useState(false);
  const seen = useRef<string | undefined>(undefined);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const onNewest = useCallback((id: string | undefined) => {
    if (!id) return;
    if (seen.current === undefined || tabRef.current === "activity") {
      seen.current = id;
      return;
    }
    if (id !== seen.current) setUnread(true);
  }, []);
  const showTab = useCallback((next: "screen" | "activity") => {
    setTab(next);
    if (next === "activity") setUnread(false);
  }, []);
  useEffect(() => {
    if (tab === "activity") setUnread(false);
  }, [tab]);
  // 聊天里点「在活动里看」：窄屏先切到「活动」。
  useEffect(() => {
    const onJump = () => showTab("activity");
    window.addEventListener(JUMP_TO_ACTIVITY, onJump);
    return () => window.removeEventListener(JUMP_TO_ACTIVITY, onJump);
  }, [showTab]);
  return (
    <section
      aria-label={"计算机"}
      className={
        variant === "rail" ? "computer-rail flex flex-col gap-3 pb-1" : "p-4"
      }
      data-mobile-tab={tab}
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
            <span className="computer-status-text">
              {"画面正在大屏直播，这里暂停预览；活动记录照常更新"}
            </span>
          </>
        ) : status ? (
          <>
            <span aria-hidden className="computer-status-dot" />
            <span className="computer-status-text">
              {status.pending
                ? `${status.label}…`
                : status.label.replace(/^正在/, "刚刚")}
            </span>
          </>
        ) : (
          <span className="computer-status-text is-idle">
            {"机器人用浏览器时，这里会实时显示画面和它在做什么"}
          </span>
        )}
      </div>
      <div
        aria-label={"画面或活动"}
        className="computer-mobile-tabs"
        role="tablist"
      >
        <button
          aria-selected={tab === "screen"}
          className="computer-mobile-tab"
          data-tab="screen"
          onClick={() => showTab("screen")}
          role="tab"
          type="button"
        >
          {"画面"}
        </button>
        <button
          aria-selected={tab === "activity"}
          className="computer-mobile-tab"
          data-tab="activity"
          data-unread={unread || undefined}
          onClick={() => showTab("activity")}
          role="tab"
          type="button"
        >
          {"活动"}
          {unread ? (
            <>
              <span aria-hidden className="computer-mobile-unread" />
              <span className="sr-only">{"（有新活动）"}</span>
            </>
          ) : null}
        </button>
      </div>
      <div className="computer-mobile-screen">
        <ComputerView
          active
          browserChrome
          computerId={agentId}
          name={name}
          minWidth={0}
          minHeight={0}
          onLiveCastChange={setCasting}
        />
      </div>
      <div
        className={`computer-mobile-activity ${variant === "rail" ? "computer-rail-activity" : "mt-8"}`}
      >
        <h3 className="activity-heading">{"活动"}</h3>
        <ActivityLog computerId={agentId} onNewest={onNewest} />
      </div>
    </section>
  );
}
