import { afterEach, describe, expect, mock, test } from "bun:test";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";

let calls = 0;
mock.module("@/lib/client", () => ({
  client: async () => {
    calls += 1;
    return { id: "s1", recentRuns: [] };
  },
}));
const { scheduleRunsQueryOptions, SCHEDULE_RUNS_STALE_MS } = await import("@/lib/schedules");

const flush = () => new Promise((r) => setTimeout(r, 0));

/** CB-106 P3：详情缓存超过 60s 后，回到前台 / 重新挂载会重拉；60s 内不重拉。 */
describe("scheduleRunsQueryOptions", () => {
  afterEach(() => focusManager.setFocused(undefined));
  test("60s 内不重拉，过了 60s 聚焦/挂载就重拉", async () => {
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      calls = 0;
      const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } } });
      qc.mount();
      const obs = new QueryObserver(qc, scheduleRunsQueryOptions("s1", 20));
      const off = obs.subscribe(() => {});
      await flush();
      expect(calls).toBe(1);
      now += SCHEDULE_RUNS_STALE_MS - 1000;
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await flush();
      expect(calls).toBe(1);
      now += 2000;
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await flush();
      expect(calls).toBe(2);
      off();
      now += SCHEDULE_RUNS_STALE_MS + 1;
      const again = new QueryObserver(qc, scheduleRunsQueryOptions("s1", 20));
      const off2 = again.subscribe(() => {});
      await flush();
      expect(calls).toBe(3);
      off2();
      qc.unmount();
      qc.clear();
    } finally {
      Date.now = realNow;
    }
  });
});
