import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { scheduleRunsQueryOptions } from "@/lib/schedules";
import { cn } from "@/lib/utils";
import {
  formatWhen,
  RUN_STATUS_ZH,
  type ScheduleRunStatus,
  type ScheduleView,
} from "../../../../shared/schedules";

/**
 * 「去对话创建定时任务」填进输入框的起手句（审查模块 13 S4）：中性，不替用户决定做什么，
 * 尤其不预设对外推送（notify_push）或整理记忆（memory_dream）。只填不发，用户补完自己按发送。
 */
export const SCHEDULE_STARTER = "帮我设一个定时任务：";

/** 空状态的起手句：都是提醒类，留空让用户补内容；只填进输入框，不发送。 */
export const SCHEDULE_PRESETS = [
  { id: "tomorrow", label: "明早 9 点提醒我…", prompt: "明天早上 9 点提醒我：" },
  { id: "workday", label: "每个工作日提醒我…", prompt: "每个工作日 18:00 提醒我：" },
  { id: "weekly", label: "每周提醒我…", prompt: "每周日晚上 9 点提醒我：" },
] as const;

/** 详情里的运行记录一次多看几条（S7）。服务端每个任务最多留 50 条（service.ts 修剪到 50）。 */
export const RUNS_PAGE = 20;
export const RUNS_KEPT = 50;

export function statusTone(status: ScheduleRunStatus | null) {
  return status === "ok" || status === "queued"
    ? "is-ok"
    : status === "failed"
      ? "is-bad"
      : status === "waiting"
        ? "is-wait"
        : status === "running"
          ? "is-run"
          : "is-muted";
}

/**
 * 详情里的运行记录（审查模块 13 S7）：列表接口每个任务只带最近 5 条；打开详情后拉 20 条，
 * 「显示更多」每次再加 20 条，到服务端保留的 50 条为止。加载时旧的几条留在原处，不闪；
 * 按钮加载中不禁用（禁用会把键盘焦点丢到 body），没有更多时焦点移到列表上。
 */
export function ScheduleRuns({ schedule: s }: { schedule: ScheduleView }) {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const detail = useQuery({
    ...scheduleRunsQueryOptions(s.id, limit),
    placeholderData: keepPreviousData,
  });
  const runs = detail.data?.recentRuns ?? s.recentRuns ?? [];
  const loading = detail.isFetching && detail.isPlaceholderData;
  // 拿回来的条数够了要的条数，就可能还有更早的；到服务端保留上限就不再给「更多」。
  const more = Boolean(detail.data) && runs.length >= limit && limit < RUNS_KEPT;
  const showButton = more || loading;
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const buttonHadFocus = useRef(false);
  useEffect(() => {
    if (!showButton && buttonHadFocus.current) {
      buttonHadFocus.current = false;
      listRef.current?.focus();
    }
  }, [showButton]);
  return (
    <div className="sch-detail">
      <div className="sch-detail-l">{`最近运行${runs.length ? ` · ${runs.length}` : ""}`}</div>
      {runs.length ? (
        <ul
          aria-busy={loading || undefined}
          aria-label="运行记录"
          className="sch-runs"
          data-testid="schedule-runs"
          id={listId}
          ref={listRef}
          tabIndex={-1}
        >
          {runs.map((r) => (
            <li className="sch-run-item" key={r.id}>
              <span className={cn("sch-last", statusTone(r.status))}>
                {RUN_STATUS_ZH[r.status]}
              </span>
              <span className="sch-run-at">{`${formatWhen(r.startedAt, s.timezone)}${r.manual ? " · 手动" : ""}`}</span>
              {r.result ? (
                <span className="sch-run-result">{r.result}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="sch-detail-v is-muted">{"还没运行过。"}</div>
      )}
      {showButton ? (
        <div className="mt-2">
          <Button
            aria-controls={listId}
            aria-disabled={loading || undefined}
            data-testid="schedule-runs-more"
            onBlur={() => {
              buttonHadFocus.current = false;
            }}
            onClick={() => {
              if (loading) return;
              setLimit((n) => Math.min(RUNS_KEPT, n + RUNS_PAGE));
            }}
            onFocus={() => {
              buttonHadFocus.current = true;
            }}
            size="sm"
            variant="ghost"
          >
            {loading ? "加载中…" : "显示更多"}
          </Button>
        </div>
      ) : runs.length >= RUNS_KEPT ? (
        <div className="sch-detail-v is-muted mt-2">{`只保留最近 ${RUNS_KEPT} 次运行。`}</div>
      ) : null}
      <span aria-live="polite" className="sr-only" data-testid="schedule-runs-status">
        {limit > RUNS_PAGE && !loading ? `已显示 ${runs.length} 次运行` : ""}
      </span>
    </div>
  );
}
