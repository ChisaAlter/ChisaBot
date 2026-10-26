import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Message } from "@ag-ui/core";
import type { ReactNode } from "react";
import { mock } from "bun:test";

const router = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...router,
  Link: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <span className={className}>{children}</span>,
}));

/**
 * CB-105：到点提醒按消息自己的时间显示（旧消息标题里存的「今天 HH:00」不再照抄）；
 * 同一任务连续的提醒折成一行可展开；暂停的任务不显示下次运行。
 */
const {
  collapseScheduleRuns,
  firedGroupSummary,
  firedHeadline,
  firedTimeLabel,
  scheduleGroupOf,
} = await import("@/lib/schedule-fired");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const NOW = new Date("2026-10-27T06:00:00Z"); // 北京 10-27 14:00
const OLD = "定时任务「和 Claude 聊电车」到点了（今天 07:00）。";
const reminder = (
  scheduleId: string,
  runId: string,
  headline = OLD,
): Message => ({
  id: `schedule-${runId}`,
  role: "user",
  content: `⟦chisabot:schedule:${scheduleId}:${runId}⟧\n${headline}\n\n任务：聊电车\n说明：聊聊电车`,
});

describe("time label", () => {
  test("today, not today, other year", () => {
    expect(firedTimeLabel("2026-10-27T01:00:00Z", NOW)).toBe("今天 09:00");
    expect(firedTimeLabel("2026-10-15T23:00:00Z", NOW)).toBe("10月16日 07:00");
    expect(firedTimeLabel("2025-12-31T01:00:00Z", NOW)).toBe(
      "2025年12月31日 09:00",
    );
  });
  test("old relative headline is not shown as-is", () => {
    expect(firedHeadline(OLD, "2026-10-15T23:00:00Z", NOW)).toBe(
      "定时任务「和 Claude 聊电车」到点了（10月16日 07:00）",
    );
    expect(firedHeadline(OLD, undefined, NOW)).toBe(
      "定时任务「和 Claude 聊电车」到点了",
    );
    expect(firedHeadline(OLD, undefined, NOW)).not.toContain("今天");
    expect(
      firedHeadline(
        "定时任务「周报」手动运行（10月16日 周五 07:00）。",
        "2026-10-27T01:00:00Z",
        NOW,
      ),
    ).toBe("定时任务「周报」手动运行（今天 09:00）");
  });
});

describe("collapse", () => {
  test("consecutive same-task reminders become one row; others untouched", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) =>
      reminder("sch_a", `r${i}`),
    );
    const other: Message = { id: "u1", role: "user", content: "你好" };
    const out = collapseScheduleRuns([
      ...sixteen,
      other,
      reminder("sch_a", "x1"),
      reminder("sch_b", "y1"),
      reminder("sch_b", "y2"),
    ]);
    expect(out.map((m) => m.id)).toEqual([
      "schedule-r0",
      "u1",
      "schedule-x1",
      "schedule-y1",
    ]);
    expect(scheduleGroupOf("schedule-r0")?.length).toBe(16);
    expect(scheduleGroupOf("schedule-x1")).toBeUndefined();
    expect(scheduleGroupOf("schedule-y1")?.length).toBe(2);
  });
  test("nothing to collapse returns the same array", () => {
    const list = [
      reminder("sch_a", "a"),
      { id: "u", role: "user", content: "hi" } as Message,
      reminder("sch_a", "b"),
    ];
    expect(collapseScheduleRuns(list)).toBe(list);
  });
  test("summary", () => {
    expect(
      firedGroupSummary("和 Claude 聊电车", 16, [
        "2026-10-18T04:00:00Z",
        "2026-10-15T23:00:00Z",
      ]),
    ).toBe("「和 Claude 聊电车」到点 16 次，10/16–10/18");
    expect(firedGroupSummary("x", 2, [])).toBe("「x」到点 2 次");
  });
});

function wrap(node: ReactNode, runs: { id: string; startedAt: string }[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const id of ["sch_a"])
    client.setQueryData(["schedules", id, "runs"], {
      recentRuns: runs.map((r) => ({ ...r, scheduledFor: null })),
    });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("ScheduleFiredRow", () => {
  test("group row expands to each run with its own date", async () => {
    const { ScheduleFiredRow } = await import("@/components/chat/schedule-row");
    const msgs = [reminder("sch_a", "r1"), reminder("sch_a", "r2")];
    collapseScheduleRuns(msgs);
    const view = wrap(
      <ScheduleFiredRow
        messageId="schedule-r1"
        text={msgs[0]!.content as string}
      />,
      [
        { id: "r1", startedAt: "2026-10-15T23:00:00Z" },
        { id: "r2", startedAt: "2026-10-18T04:00:00Z" },
      ],
    );
    expect(view.getByTestId("schedule-fired-group").textContent).toContain(
      "「和 Claude 聊电车」到点 2 次，10/16–10/18",
    );
    expect(view.container.textContent).not.toContain("今天 07:00");
    fireEvent.click(view.getByRole("button"));
    const list =
      view.getByTestId("schedule-fired-group-list").textContent ?? "";
    expect(list).toContain("10月16日 07:00");
    expect(list).toContain("10月18日 12:00");
  });
  test("single row without run record drops the stale 今天", async () => {
    const { ScheduleFiredRow } = await import("@/components/chat/schedule-row");
    const m = reminder("sch_a", "solo");
    collapseScheduleRuns([m]);
    const view = wrap(
      <ScheduleFiredRow messageId={m.id} text={m.content as string} />,
      [],
    );
    const text = view.getByTestId("schedule-fired").textContent ?? "";
    expect(text).toContain("定时任务「和 Claude 聊电车」到点了");
    expect(text).not.toContain("今天 07:00");
  });
});

describe("paused task shows no next run", () => {
  test("shownNextRun hides stale next_run_at", async () => {
    const { shownNextRun } = await import("@/lib/schedules");
    expect(
      shownNextRun({ status: "paused", nextRunAt: "2026-10-26T19:00:00Z" }),
    ).toBeNull();
    expect(
      shownNextRun({ status: "active", nextRunAt: "2026-10-26T19:00:00Z" }),
    ).toBe("2026-10-26T19:00:00Z");
  });
});
