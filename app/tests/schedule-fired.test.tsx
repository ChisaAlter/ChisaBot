import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { settleReactWork } from "./settle-react-work";

const router = await import("@tanstack/react-router");
// mock.module 会原地改写模块命名空间，先把真的 Link / useRouter 拿住。
const RealLink = router.Link as unknown as ComponentType<
  Record<string, unknown>
>;
const realUseRouter = router.useRouter;

/** 和真 Link 一样用 params 填 `to` 里的 `$xxx`；没给的参数原样留着，测试里一眼能看出来。 */
function fillParams(
  to: string | undefined,
  params: unknown,
): string | undefined {
  if (!to || !params || typeof params !== "object") return to;
  const values = params as Record<string, unknown>;
  return to.replace(/\$([A-Za-z0-9_]+)/g, (whole, key: string) =>
    key in values ? encodeURIComponent(String(values[key])) : whole,
  );
}

/*
 * mock.module 是进程级的，换不回来：共享进程里排在这份后面的文件拿到的也是这个 Link。
 * 所以有路由（RouterProvider）时直接交给真 Link，行为和没 mock 一样；只有像本文件这样不挂路由的
 * 渲染才走替身：所有 props（aria-label、className…）原样透传给 <a>，href 用 params 填好路径参数。
 */
mock.module("@tanstack/react-router", () => ({
  ...router,
  Link: (props: {
    children?: ReactNode;
    to?: string;
    href?: string;
    params?: unknown;
    search?: unknown;
    hash?: unknown;
    [key: string]: unknown;
  }) => {
    const inRouter = realUseRouter({ warn: false });
    if (inRouter) return <RealLink {...props} />;
    const {
      children,
      to,
      href,
      params,
      search: _search,
      hash: _hash,
      ...rest
    } = props;
    return (
      <a {...rest} href={href ?? fillParams(to, params)}>
        {children}
      </a>
    );
  },
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
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

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
  test("cross-year range carries the year (CB-105b)", () => {
    expect(
      firedGroupSummary("喝水", 25, [
        "2026-01-01T16:00:00Z",
        "2025-12-29T16:00:00Z",
      ]),
    ).toBe("「喝水」到点 25 次，2025/12/30–2026/01/02");
    // 同一年不带年份
    expect(
      firedGroupSummary("喝水", 2, [
        "2025-12-29T16:00:00Z",
        "2025-12-30T16:00:00Z",
      ]),
    ).toBe("「喝水」到点 2 次，12/30–12/31");
  });
});

function wrap(
  node: ReactNode,
  runs: { id: string; startedAt: string }[],
  limit = 20,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const id of ["sch_a"])
    client.setQueryData(["schedules", id, "runs", limit], {
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
    // r2：日期范围放在单独的、不省略的元素里（360 宽也完整可见）
    const tail = view.getByTestId("schedule-fired-group-tail");
    expect(tail.textContent).toBe("到点 2 次，10/16–10/18");
    expect(tail.className).toBe("schedule-fired-group-tail");
    expect(tail.previousElementSibling?.className).toBe(
      "schedule-fired-group-name",
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

describe("CB-105b", () => {
  test("single row: time in its own non-shrinking element, only the name ellipsizes", async () => {
    const { ScheduleFiredRow } = await import("@/components/chat/schedule-row");
    const m = reminder("sch_a", "solo2");
    collapseScheduleRuns([m]);
    const view = wrap(
      <ScheduleFiredRow messageId={m.id} text={m.content as string} />,
      [{ id: "solo2", startedAt: "2026-10-15T23:00:00Z" }],
    );
    const time = view.getByTestId("schedule-fired-time");
    expect(time.textContent).toBe("（10月16日 07:00）");
    expect(time.className).toBe("schedule-fired-group-tail");
    expect(time.previousElementSibling?.className).toBe(
      "schedule-fired-group-name",
    );
    expect(time.previousElementSibling?.textContent).toBe(
      "定时任务「和 Claude 聊电车」到点了",
    );
  });
  test("group of more than 20 asks for all runs and times every one", async () => {
    const { ScheduleFiredRow } = await import("@/components/chat/schedule-row");
    const start = Date.parse("2025-12-29T16:00:00Z");
    const runs = Array.from({ length: 25 }, (_, i) => ({
      id: `x${i}`,
      startedAt: new Date(start + i * 3 * 3600_000).toISOString(),
    }));
    const msgs = runs.map((r) => reminder("sch_a", r.id));
    collapseScheduleRuns(msgs);
    const view = wrap(
      <ScheduleFiredRow
        messageId={msgs[0]!.id}
        text={msgs[0]!.content as string}
      />,
      runs,
      25,
    );
    expect(view.getByTestId("schedule-fired-group-tail").textContent).toBe(
      "到点 25 次，2025/12/30–2026/01/02",
    );
    fireEvent.click(view.getByRole("button"));
    const items = view
      .getByTestId("schedule-fired-group-list")
      .querySelectorAll("li");
    expect(items.length).toBe(25);
    for (const li of items) expect(li.textContent).toMatch(/\d\d:\d\d）$/);
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
