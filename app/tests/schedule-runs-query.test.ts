import { afterEach, describe, expect, test } from "bun:test";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";

import { SCHEDULE_RUNS_STALE_MS, scheduleRunsQueryOptions } from "@/lib/schedules";

/*
 * 用 fetch 打桩，而不是 mock.module("@/lib/client")。Bun 的 mock.module 是进程级的，而且换不回来：
 * 以前这里把 client 整个换成「永远返回这个日程」，test:app 共享进程里排在后面、走 client 的文件全都
 * 拿到它。例如 self-host-banner 点关闭后，偏好被这个返回值覆盖，横幅又冒出来。
 */
let calls = 0;
const originalFetch = globalThis.fetch;
function serveSchedule() {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input instanceof Request ? input.url : input).startsWith("/api/schedules/s1")) calls += 1;
      return Response.json({ schedule: { id: "s1", recentRuns: [] } });
    },
    { preconnect: originalFetch.preconnect },
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** CB-106 P3：详情缓存超过 60s 后，回到前台 / 重新挂载会重拉；60s 内不重拉。 */
describe("scheduleRunsQueryOptions", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    globalThis.fetch = originalFetch;
  });
  test("60s 内不重拉，过了 60s 聚焦/挂载就重拉", async () => {
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      calls = 0;
      serveSchedule();
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
