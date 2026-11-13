import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
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
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TasksRailCard } from "@/components/panels/tasks-rail-card";
import {
  TaskCenter,
  type TaskCenterView,
} from "@/components/task-center/task-center";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { taskCenterApi } from "@/lib/task-center-api";
import {
  TASK_STATUSES,
  type TaskCenterDecision,
  type TaskCenterSnapshot,
  type TaskCenterTask,
} from "../../shared/task-center";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
const tasks: TaskCenterTask[] = Array.from({ length: 65 }, (_, n) => ({
  id: `task-${n}`,
  ownerUserId: "owner",
  agentId: null,
  title: `任务 ${n}`,
  description: "完成工作",
  category: "project",
  level: 2,
  assessment: "待处理",
  risk: "read",
  status: "paused",
  executor: "bot",
  workspace: null,
  sourceId: null,
  sourceRef: null,
  sourceUrl: null,
  parentId: null,
  dependencies: [],
  planPrepared: true,
  priority: 50,
  attempts: 1,
  maxAttempts: 3,
  timeoutSeconds: 900,
  summary: null,
  artifacts: [],
  usage: {},
  error: null,
  createdAt: "2026-11-11T00:00:00Z",
  updatedAt: "2026-11-11T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  nextAttemptAt: "2026-11-11T00:00:00Z",
  leaseExpiresAt: null,
  version: 1,
}));
const decisions: TaskCenterDecision[] = tasks.map((task, n) => ({
  id: `decision-${n}`,
  taskId: task.id,
  ownerUserId: "owner",
  taskVersion: 1,
  summary: "确认范围",
  proposedAction: {
    title: `审批 ${n}`,
    description: "具体操作",
    executor: "bot",
    risk: "external",
  },
  status: "pending",
  createdAt: task.createdAt,
  decidedAt: null,
  notificationError: null,
}));
const snapshot: TaskCenterSnapshot = {
  tasks: tasks.slice(0, 50),
  outbox: decisions.slice(0, 50),
  sources: [],
  running: true,
  concurrency: 2,
  counts: Object.fromEntries(
    TASK_STATUSES.map((status) => [status, status === "paused" ? 65 : 0]),
  ) as TaskCenterSnapshot["counts"],
  decisionCounts: { pending: 65, approved: 0, rejected: 0, superseded: 0 },
};
function mount(rail = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  function Surface() {
    const [view, setView] = useState<TaskCenterView>("active");
    return rail ? (
      <TaskCenterProvider>
        <TasksRailCard />
      </TaskCenterProvider>
    ) : (
      <TaskCenter view={view} onNavigate={setView} />
    );
  }
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Surface />
      </QueryClientProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/tasks" });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  });
  return { ...render(<RouterProvider router={router} />), router };
}
function serve() {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost");
      paths.push(url.pathname + url.search);
      if (url.pathname === "/api/task-center") return Response.json(snapshot);
      if (url.pathname === "/api/workflows")
        return Response.json({ workflows: [], runs: [], tools: [] });
      if (url.pathname === "/api/task-center/tasks") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const search = url.searchParams.get("search");
        const matching = search
          ? tasks.filter((task) => task.title.includes(search))
          : tasks;
        return Response.json({
          tasks: matching.slice(offset, offset + 50),
          total: matching.length,
          nextOffset: offset + 50 < matching.length ? offset + 50 : null,
        });
      }
      if (url.pathname === "/api/task-center/outbox") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const matching =
          url.searchParams.get("status") === "pending" ? decisions : [];
        return Response.json({
          outbox: matching.slice(offset, offset + 50),
          total: matching.length,
          nextOffset: offset + 50 < matching.length ? offset + 50 : null,
        });
      }
      throw Error(`Unexpected request ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return paths;
}
test("task and approval lists load beyond the snapshot; search is sent to the server", async () => {
  const paths = serve();
  const ui = mount();
  await waitFor(() => expect(ui.getByText("已显示 50 / 65 项")).toBeTruthy());
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: "加载更多" })),
  );
  await waitFor(() => expect(ui.getByText("任务 64")).toBeTruthy());
  expect(ui.getByText("已显示 65 / 65 项")).toBeTruthy();
  expect(ui.queryByRole("button", { name: "加载更多" })).toBeNull();
  const user = userEvent.setup({ document: ui.baseElement.ownerDocument });
  await act(async () =>
    user.type(ui.getByRole("textbox", { name: "搜索任务" }), "任务 64"),
  );
  await waitFor(() => expect(ui.getByText("已显示 1 / 1 项")).toBeTruthy());
  expect(ui.queryByText("任务 0")).toBeNull();
  expect(paths.some((path) => path.includes("search="))).toBe(true);
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: /Outbox/ })),
  );
  await waitFor(() => expect(ui.getByText("已显示 50 / 65 项")).toBeTruthy());
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: "加载更多" })),
  );
  await waitFor(() => expect(ui.getByText("审批 64")).toBeTruthy());
  expect(ui.getByText("已显示 65 / 65 项")).toBeTruthy();
});
test("rail totals open task center in place, switch tabs locally and close without navigating", async () => {
  serve();
  const ui = mount(true);
  await waitFor(() =>
    expect(
      ui.getByRole("button", { name: "查看全部 65 项待确认" }),
    ).toBeTruthy(),
  );
  expect(ui.getByText("50 / 65 待确认")).toBeTruthy();
  expect(ui.getByText("50 / 65 项")).toBeTruthy();
  expect(ui.queryByText("当前没有待跟进的任务")).toBeNull();
  const rail = ui.getByTestId("tasks-rail-card");
  const url = ui.router.state.location.href;
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: "查看全部 65 项待确认" })),
  );
  const dialog = await ui.findByRole("dialog", { name: "任务中心" });
  await waitFor(() => expect(dialog.textContent).toContain("需要你确认"));
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: /进行中/ })),
  );
  await waitFor(() => expect(dialog.textContent).toContain("正在推进"));
  expect(ui.router.state.location.href).toBe(url);
  expect(ui.getByTestId("tasks-rail-card")).toBe(rail);
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: /^关闭$/ })),
  );
  await waitFor(() =>
    expect(ui.queryByRole("dialog", { name: "任务中心" })).toBeNull(),
  );
  expect(ui.getByTestId("tasks-rail-card")).toBe(rail);
  await act(async () =>
    fireEvent.click(ui.getByRole("button", { name: "查看全部 65 项任务" })),
  );
  await waitFor(() =>
    expect(ui.getByRole("dialog", { name: "任务中心" }).textContent).toContain(
      "正在推进",
    ),
  );
}, 15000);
test("manual scan rejects persisted failures and in-progress responses, and accepts actual success", async () => {
  for (const status of ["failed", "running", "succeeded"]) {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          source: {
            lastStatus: status,
            lastError: status === "failed" ? "邮箱无权读取" : null,
          },
        }),
      { preconnect: originalFetch.preconnect },
    );
    let error: Error | null = null;
    try {
      await taskCenterApi.scanSource("source");
    } catch (caught) {
      error = caught as Error;
    }
    if (status === "succeeded") expect(error).toBeNull();
    else
      expect(error?.message).toContain(
        status === "failed" ? "邮箱无权读取" : "仍在执行",
      );
  }
});

test("list retry preserves its error panel, prevents duplicate slow requests, shows failure and recovers", async () => {
  serve();
  const base = globalThis.fetch;
  let calls = 0;
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        new URL(String(input), "http://localhost").pathname !==
        "/api/task-center/tasks"
      )
        return base(input, init);
      calls++;
      if (calls === 1)
        return Response.json({ error: "任务读取失败" }, { status: 503 });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const ui = mount();
  await waitFor(() => expect(ui.getByText("任务读取失败")).toBeTruthy());
  const retry = ui.getByRole("button", {
    name: /重新加载/,
  }) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(retry);
    fireEvent.click(retry);
  });
  await waitFor(() => expect(calls).toBe(2));
  expect(retry.disabled).toBe(true);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  expect(ui.getByText("任务读取失败")).toBeTruthy();
  expect(retry.isConnected).toBe(true);
  await act(async () =>
    finish!(Response.json({ error: "仍然不可用" }, { status: 503 })),
  );
  await waitFor(() =>
    expect(retry.getAttribute("data-btn-state")).toBe("error"),
  );
  expect(ui.getByText("仍然不可用")).toBeTruthy();
  await act(async () => fireEvent.click(retry));
  await waitFor(() => expect(calls).toBe(3));
  await act(async () =>
    finish!(
      Response.json({ tasks: tasks.slice(0, 1), total: 1, nextOffset: null }),
    ),
  );
  await waitFor(() => expect(ui.getByText("任务 0")).toBeTruthy());
  expect(ui.queryByText("仍然不可用")).toBeNull();
});
