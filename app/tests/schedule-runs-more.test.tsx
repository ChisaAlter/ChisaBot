import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ScheduleRunView, ScheduleView } from "../../shared/schedules";
import { settleReactWork } from "./settle-react-work";

/*
 * 审查模块 13：S4 起手句中性、只填不发；S7 运行记录「显示更多」到服务端保留的 50 条为止。
 * fetch 打桩，不用 mock.module（进程级、换不回来）。
 */
const { RUNS_KEPT, SCHEDULE_PRESETS, SCHEDULE_STARTER, ScheduleRuns } = await import(
  "@/components/schedules/schedule-runs"
);

const originalFetch = globalThis.fetch;
const asked: number[] = [];
function run(i: number): ScheduleRunView {
  return {
    id: `r${i}`,
    status: "ok",
    startedAt: new Date(Date.UTC(2026, 9, 28, 0, 0) - i * 3_600_000).toISOString(),
    manual: false,
    result: null,
  } as unknown as ScheduleRunView;
}
function serve(total: number) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://x");
      const n = Number(url.searchParams.get("runs") ?? 20);
      asked.push(n);
      const recentRuns = Array.from({ length: Math.min(n, total) }, (_, i) => run(i));
      return Response.json({ schedule: { id: "s1", recentRuns } });
    },
    { preconnect: originalFetch.preconnect },
  );
}

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  asked.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const base = {
  id: "s1",
  title: "提醒",
  timezone: "Asia/Shanghai",
  status: "active",
  recentRuns: [run(0), run(1), run(2), run(3), run(4)],
} as unknown as ScheduleView;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScheduleRuns schedule={base} />
    </QueryClientProvider>,
  );
}
const count = (c: HTMLElement) => c.querySelectorAll(".sch-run-item").length;

describe("S4 起手句", () => {
  test("不预设推送、整理记忆或 personal_* 工具", () => {
    const all = [SCHEDULE_STARTER, ...SCHEDULE_PRESETS.flatMap((p) => [p.label, p.prompt])].join("\n");
    expect(all).not.toMatch(/notify_push|memory_dream|personal_|推送|整理记忆/);
  });
});

describe("S7 显示更多", () => {
  test("先显示列表带的 5 条，拉回 20 条后可以一直加到 50 条", async () => {
    serve(60);
    const { container, findByTestId, queryByTestId } = mount();
    expect(count(container)).toBe(5);
    await waitFor(() => expect(count(container)).toBe(20));
    fireEvent.click(await findByTestId("schedule-runs-more"));
    await waitFor(() => expect(count(container)).toBe(40));
    expect(queryByTestId("schedule-runs-status")?.textContent).toBe("已显示 40 次运行");
    fireEvent.click(await findByTestId("schedule-runs-more"));
    await waitFor(() => expect(count(container)).toBe(RUNS_KEPT));
    expect(queryByTestId("schedule-runs-more")).toBeNull();
    expect(container.textContent).toContain(`只保留最近 ${RUNS_KEPT} 次运行`);
    expect(asked).toEqual([20, 40, 50]);
  });
  test("不足 20 条时不给「显示更多」", async () => {
    serve(7);
    const { container, queryByTestId } = mount();
    await waitFor(() => expect(count(container)).toBe(7));
    expect(queryByTestId("schedule-runs-more")).toBeNull();
  });
  test("键盘：按钮消失后焦点落到列表上，不丢到 body", async () => {
    serve(30);
    const { container, findByTestId } = mount();
    await waitFor(() => expect(count(container)).toBe(20));
    const more = await findByTestId("schedule-runs-more");
    act(() => more.focus());
    // 原生 <button> 上 Enter 触发 click；happy-dom 不模拟这一步，直接点。
    fireEvent.click(more);
    await waitFor(() => expect(count(container)).toBe(30));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe("schedule-runs"),
    );
  });
});
