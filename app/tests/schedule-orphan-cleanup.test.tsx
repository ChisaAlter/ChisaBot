import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { ConfirmHost } from "@/components/ui/confirm";
import { agentKeys } from "@/lib/agents/queries";
import { scheduleKeys } from "@/lib/schedules";
import { Route as SchedulesRoute } from "@/routes/_authed/settings/schedules";
import type { ScheduleView } from "../../shared/schedules";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const schedule: ScheduleView = {
  id: "schedule-live",
  agentId: "bot-live",
  threadId: "thread-live",
  source: "web",
  title: "晨报",
  instruction: "整理晨报",
  kind: "cron",
  cron: "0 9 * * *",
  runAt: null,
  timezone: "Asia/Shanghai",
  status: "active",
  nextRunAt: "2026-11-07T01:00:00Z",
  lastRunAt: null,
  lastStatus: null,
  lastResult: null,
  runCount: 0,
  createdAt: "2026-11-01T01:00:00Z",
  schedule: "每天 09:00",
  running: false,
};

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(scheduleKeys.all, [schedule]);
  // 列表缓存尚未看到仍有效的机器人，界面暂时将任务列为孤儿。
  client.setQueryData(agentKeys.list(), []);
  client.setQueryData(agentKeys.list(true), []);
  const Schedules = SchedulesRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <>
          <Schedules />
          <ConfirmHost />
        </>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

for (const deleted of [0, 1]) {
  test(`清理 ${deleted} 条只采用服务端孤儿判定，并重新读取机器人列表`, async () => {
    const requests: { path: string; method: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        requests.push({ path, method });
        if (path === "/api/schedules/orphans" && method === "DELETE")
          return Response.json({ deleted });
        if (path === "/api/schedules")
          return Response.json({ schedules: deleted ? [] : [schedule] });
        if (path === "/api/agents")
          return Response.json({ agents: [{ id: "bot-live", name: "助手" }] });
        if (path === "/api/agents?hidden=true")
          return Response.json({ agents: [] });
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = draw();
    fireEvent.click(
      await view.findByRole("button", {
        name: /清理已删除机器人的任务（1\s*）/,
      }),
    );
    fireEvent.click(await view.findByRole("button", { name: "全部删除" }));
    await waitFor(() =>
      expect(requests.filter((r) => r.method === "GET")).toHaveLength(3),
    );
    await act(async () => {});
    expect(requests.filter((r) => r.method === "DELETE")).toEqual([
      { path: "/api/schedules/orphans", method: "DELETE" },
    ]);
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: /清理已删除机器人的任务/ }),
      ).toBeNull(),
    );
    if (deleted === 0)
      expect(
        view.getByRole("button", { name: "查看「晨报」的详情" }),
      ).toBeTruthy();
    else expect(view.queryByTestId("schedule-row")).toBeNull();
  });
}
