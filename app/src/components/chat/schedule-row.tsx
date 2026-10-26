import { IconAlarm, IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ScheduleView } from "../../../../shared/schedules";
import { parseScheduleMessage } from "../../../../shared/schedules";
import { client } from "@/lib/client";
import {
  firedGroupParts,
  firedHeadline,
  firedHeadlineParts,
  scheduleGroupOf,
  splitFiredHeadline,
} from "@/lib/schedule-fired";
import { scheduleKeys } from "@/lib/schedules";
import { cn } from "@/lib/utils";

/** 运行记录默认只带最近 20 条；折叠了更多条时按条数要（CB-105b），服务端封顶 RUNS_MAX。 */
const RUNS_DEFAULT = 20;

/** 运行记录里每次到点的时间（runId → startedAt）。任务删了 / 记录滚掉了就是空的，行上就不写时间。 */
function useRunTimes(
  scheduleId: string,
  count = 1,
): ReadonlyMap<string, string> {
  const runs = Math.max(RUNS_DEFAULT, count);
  const { data } = useQuery({
    queryKey: [...scheduleKeys.all, scheduleId, "runs", runs],
    queryFn: ({ signal }): Promise<ScheduleView> =>
      client(
        `/api/schedules/${encodeURIComponent(scheduleId)}${runs > RUNS_DEFAULT ? `?runs=${runs}` : ""}`,
        "schedule",
        {
          fallback: "",
          signal,
        },
      ),
    enabled: Boolean(scheduleId),
    staleTime: 60_000,
    retry: false,
  });
  const times = new Map<string, string>();
  for (const run of data?.recentRuns ?? [])
    times.set(run.id, run.scheduledFor ?? run.startedAt);
  return times;
}

/**
 * 定时任务到点时放进对话的那条消息（DESIGN.md §55）：不是用户气泡，是一行「⏰ 定时任务「x」到点了（10月16日 07:00）」，
 * 点开看到点时要做的事；机器人的回复照常在下面。同一任务连着到点的几条折成一行（CB-105），可以展开。
 */
export function ScheduleFiredRow({ messageId, text }: { messageId: string; text: string }) {
  const parsed = parseScheduleMessage(text);
  const group = scheduleGroupOf(messageId);
  const times = useRunTimes(parsed?.scheduleId ?? "", group?.length ?? 1);
  const [open, setOpen] = useState(false);
  if (!parsed) return null;
  if (group && group.length > 1) {
    const runs = group
      .map((message) => parseScheduleMessage(typeof message.content === "string" ? message.content : ""))
      .filter((run): run is NonNullable<typeof run> => run !== null);
    const known = runs.map((run) => times.get(run.runId)).filter((at): at is string => Boolean(at));
    const { title } = splitFiredHeadline(parsed.headline);
    const summary = firedGroupParts(title, runs.length, known);
    return (
      <div className="worker-result schedule-fired" data-message-id={messageId} data-testid="schedule-fired-group">
        <button aria-expanded={open} className="worker-result-line" onClick={() => setOpen((value) => !value)} type="button">
          <span className="worker-icon schedule-fired-icon">
            <IconAlarm className="size-3.5" stroke={2.2} />
          </span>
          <span className="worker-result-head schedule-fired-group-head">
            <span className="schedule-fired-group-name">{summary.name}</span>
            <span className="schedule-fired-group-tail" data-testid="schedule-fired-group-tail">
              {/* CB-105b：「次数，」和日期范围各自不换行；整段放不下时在逗号后换行，而不是被裁 */}
              {summary.tail.split(/(?<=，)/).map((piece) => (
                <span key={piece}>{piece}</span>
              ))}
            </span>
          </span>
          <span className="worker-result-hint">{open ? "收起" : "展开"}</span>
          <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
        <div className="worker-plan-collapse" data-open={open || undefined}>
          <div className="worker-result-body">
            <ul className="schedule-fired-list" data-testid="schedule-fired-group-list">
              {runs.map((run) => (
                <li key={run.runId}>{firedHeadline(run.headline, times.get(run.runId))}</li>
              ))}
            </ul>
            {parsed.instruction}
            <Link className="schedule-fired-link" to="/settings/schedules">
              {"管理定时任务"}
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="worker-result schedule-fired" data-message-id={messageId} data-testid="schedule-fired">
      <button aria-expanded={open} className="worker-result-line" onClick={() => setOpen((value) => !value)} type="button">
        <span className="worker-icon schedule-fired-icon">
          <IconAlarm className="size-3.5" stroke={2.2} />
        </span>
        <SingleHead
          parts={firedHeadlineParts(parsed.headline, times.get(parsed.runId))}
        />
        <span className="worker-result-hint">{open ? "收起" : "详情"}</span>
        <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <div className="worker-plan-collapse" data-open={open || undefined}>
        <div className="worker-result-body">
          {parsed.instruction}
          <Link className="schedule-fired-link" to="/settings/schedules">
            {"管理定时任务"}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** CB-105b：单条行只省略名字，时间独立一段不缩不换行（同 schedule-fired-group-tail）。 */
function SingleHead({ parts }: { parts: { name: string; time: string } }) {
  return (
    <span className="worker-result-head schedule-fired-group-head">
      <span className="schedule-fired-group-name">{parts.name}</span>
      {parts.time ? (
        <span
          className="schedule-fired-group-tail"
          data-testid="schedule-fired-time"
        >
          {parts.time}
        </span>
      ) : null}
    </span>
  );
}
