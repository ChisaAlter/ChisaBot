import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { TasksRailCard } from "@/components/panels/tasks-rail-card";
import { taskCenterKeys } from "@/lib/task-center-api";
import { type WorkflowLibrary, workflowKeys } from "@/lib/workflows";
import type { TaskCenterSnapshot } from "../../shared/task-center";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

describe("右栏「面板 | 任务 | 计算机」三选项卡与任务进度拆分", () => {
  test("panel-rail.tsx 顶栏包含 panels、tasks、computer 三个分段选项卡，且面板标签内不再混入 AgentsRailCard 或 TasksRailCard", () => {
    const rail = readFileSync(
      join(import.meta.dir, "../src/components/panels/panel-rail.tsx"),
      "utf8",
    );
    expect(rail).toContain('type RailTab = "panels" | "tasks" | "computer"');
    expect(rail).toContain('item("panels", "面板"');
    expect(rail).toContain('"tasks",\n        "任务"');
    expect(rail).not.toContain("AgentsRailCard");

    const panelsPane = rail.slice(
      rail.indexOf('data-active={tab === "panels"}'),
      rail.indexOf('data-active={tab === "tasks"}'),
    );
    expect(panelsPane).toContain("LivePanelList");
    expect(panelsPane).not.toContain("TasksRailCard");

    const tasksPane = rail.slice(
      rail.indexOf('data-active={tab === "tasks"}'),
      rail.indexOf("RailComputerPane"),
    );
    expect(tasksPane).toContain("<TasksRailCard />");
  });

  test("AgentsRailCard 归入任务中心「工具与 Agent」(Capabilities) 视图", () => {
    const tc = readFileSync(
      join(import.meta.dir, "../src/components/task-center/task-center.tsx"),
      "utf8",
    );
    const capabilitiesSection = tc.slice(tc.indexOf("function Capabilities()"));
    expect(capabilitiesSection).toContain("<AgentsRailCard />");
  });

  test("styles.css 支持 .rail-tabs 的 tasks 与 computer 滑块位移及 3 标签宽度", () => {
    const css = readFileSync(
      join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    expect(css).toContain(
      '.rail-tabs[data-tab="tasks"] .rail-tabs-thumb { translate: 100% 0; }',
    );
    expect(css).toContain(
      '.rail-tabs[data-tab="computer"] .rail-tabs-thumb { translate: 200% 0; }',
    );
    expect(css).toContain('.rail-tabs[data-count="3"] .rail-tabs-item');
  });

  test("TasksRailCard 真实渲染待确认审批、工作流步骤进度与进行中任务", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    queryClient.setQueryData(taskCenterKeys.snapshot, {
      running: true,
      concurrency: 2,
      counts: {
        inbox: 1,
        queued: 0,
        planning: 0,
        running: 1,
        waiting_dependencies: 0,
        waiting_approval: 0,
        paused: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
      },
      tasks: [
        {
          id: "task-1",
          ownerUserId: "u1",
          agentId: null,
          title: "整理本周研发进展报告",
          description: "汇总各仓库 PR 与发布状态",
          category: "project",
          level: 3,
          assessment: "正在汇总",
          risk: "internal",
          status: "running",
          executor: "bot",
          workspace: null,
          sourceId: null,
          sourceRef: null,
          sourceUrl: null,
          parentId: null,
          dependencies: [],
          planPrepared: true,
          priority: 1,
          attempts: 1,
          maxAttempts: 3,
          timeoutSeconds: 300,
          summary: "正在抓取最近提交记录…",
          artifacts: [],
          usage: {},
          error: null,
          createdAt: "2026-11-06T16:00:00.000Z",
          updatedAt: "2026-11-06T16:05:00.000Z",
          startedAt: "2026-11-06T16:01:00.000Z",
          finishedAt: null,
          nextAttemptAt: "2026-11-06T16:00:00.000Z",
          leaseExpiresAt: null,
          version: 1,
        },
      ],
      outbox: [
        {
          id: "dec-1",
          taskId: "task-1",
          ownerUserId: "u1",
          taskVersion: 1,
          summary: "准备向团队群发送研发周报草稿",
          proposedAction: {
            title: "发送周报至研发频道",
            description: "发送整理好的周报 Markdown",
            executor: "bot",
            risk: "external",
          },
          status: "pending",
          createdAt: "2026-11-06T16:04:00.000Z",
          decidedAt: null,
          notificationError: null,
        },
      ],
      sources: [],
    });
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [
        {
          id: "run-1",
          workflowId: "wf-1",
          workflowName: "发布前验收流水线",
          icon: "🚀",
          status: "running",
          source: "chat",
          inputs: {},
          steps: [
            {
              id: "build",
              name: "构建检查",
              roleKey: "dev",
              roleName: "开发",
              botId: "b1",
              botName: "Chisa",
              status: "succeeded",
              output: "通过",
              tokens: 120,
              skills: [],
            },
            {
              id: "verify",
              name: "端到端回归",
              roleKey: "qa",
              roleName: "测试",
              botId: "b1",
              botName: "Chisa",
              status: "running",
              output: "",
              tokens: 50,
              skills: [],
            },
          ],
          usage: { tokens: 170, steps: 1, elapsedMs: 5000 },
          limits: {
            maxTokens: 60000,
            maxSteps: 10,
            timeLimitMinutes: 20,
            stepTimeoutMinutes: 5,
          },
          outputFormat: "markdown",
          output: null,
          error: null,
          createdAt: "2026-11-06T16:02:00.000Z",
          startedAt: "2026-11-06T16:02:01.000Z",
          finishedAt: null,
          tools: {},
        },
      ],
    });

    const snapshot = queryClient.getQueryData<TaskCenterSnapshot>(
      taskCenterKeys.snapshot,
    )!;
    const originalTask = snapshot.tasks[0]!;
    queryClient.setQueryData(taskCenterKeys.snapshot, {
      ...snapshot,
      tasks: [
        originalTask,
        {
          ...originalTask,
          id: "blocked",
          title: "等待上游交付后整理资料，包含必须完整显示的很长任务标题",
          status: "waiting_dependencies",
          error: "前序资料收集失败，需要先修复依赖任务",
        },
        {
          ...originalTask,
          id: "done",
          title: "已交付的项目资料",
          status: "succeeded",
          finishedAt: "2026-11-06T16:10:00.000Z",
          summary: "周报与附件已整理",
          artifacts: [{ name: "周报.md", uri: "/reports/week.md" }],
        },
      ],
    });
    const library = queryClient.getQueryData<WorkflowLibrary>(
      workflowKeys.library,
    )!;
    queryClient.setQueryData(workflowKeys.library, {
      ...library,
      runs: [
        ...library.runs,
        {
          ...library.runs[0],
          id: "queued-run",
          workflowName: "尚未开始的工作流",
          status: "queued",
          steps: library.runs[0]!.steps.map((step) => ({
            ...step,
            status: "pending",
          })),
        },
      ],
    });

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <TasksRailCard />
        </QueryClientProvider>
      ),
    });
    const tasksRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks",
      component: () => null,
    });
    const runRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/runs/$runId",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([tasksRoute, runRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<RouterProvider router={router} />);
    });
    await settleReactWork();

    const text = view.container.textContent ?? "";
    expect(text).toContain("1 待确认");
    expect(text).toContain("发送周报至研发频道");
    expect(text).toContain("发布前验收流水线");
    expect(text).toContain("当前：端到端回归");
    expect(text).toContain("1/2 步");
    expect(text).toContain("整理本周研发进展报告");
    const rail = view.getByTestId("tasks-rail-card");
    expect(rail.classList.contains("glass-card")).toBe(false);
    expect(rail.querySelectorAll("article.task-rail-item")).toHaveLength(6);
    expect(rail.querySelectorAll("a button")).toHaveLength(0);
    const blocked = view
      .getByText("等待上游交付后整理资料，包含必须完整显示的很长任务标题")
      .closest("article")!;
    expect(blocked.getAttribute("data-tone")).toBe("warning");
    expect(blocked.textContent).toContain(
      "前序资料收集失败，需要先修复依赖任务",
    );
    const recent = view.getByText("已交付的项目资料").closest("article")!;
    expect(recent.getAttribute("data-kind")).toBe("recent");
    expect(recent.getAttribute("data-tone")).toBe("success");
    expect(recent.textContent).toContain("1 个附件");
    expect(recent.querySelector("a")?.getAttribute("href")).toContain(
      "view=history",
    );
    expect(recent.querySelector("a")?.getAttribute("href")).toContain(
      "task=done",
    );
    expect(
      rail
        .querySelector('progress[aria-label="发布前验收流水线 · 步骤进度 1/2"]')
        ?.getAttribute("value"),
    ).toBe("50");
    expect(
      rail
        .querySelector('progress[aria-label="尚未开始的工作流 · 步骤进度 0/2"]')
        ?.getAttribute("value"),
    ).toBe("0");
  });

  test("有最近交付时只显示轻量提示，不显示完整空态", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    const baseTask = {
      id: "done",
      ownerUserId: "u1",
      agentId: null,
      title: "已交付的项目资料",
      description: "汇总",
      category: "project" as const,
      level: 3,
      assessment: "",
      risk: "internal" as const,
      status: "succeeded" as const,
      executor: "bot" as const,
      workspace: null,
      sourceId: null,
      sourceRef: null,
      sourceUrl: null,
      parentId: null,
      dependencies: [],
      planPrepared: true,
      priority: 1,
      attempts: 1,
      maxAttempts: 3,
      timeoutSeconds: 300,
      summary: "周报已整理",
      artifacts: [],
      usage: {},
      error: null,
      createdAt: "2026-11-06T16:00:00.000Z",
      updatedAt: "2026-11-06T16:10:00.000Z",
      startedAt: "2026-11-06T16:01:00.000Z",
      finishedAt: "2026-11-06T16:10:00.000Z",
      nextAttemptAt: "2026-11-06T16:00:00.000Z",
      leaseExpiresAt: null,
      version: 1,
    };
    queryClient.setQueryData(taskCenterKeys.snapshot, {
      running: true,
      concurrency: 2,
      counts: {
        inbox: 0,
        queued: 0,
        planning: 0,
        running: 0,
        waiting_dependencies: 0,
        waiting_approval: 0,
        paused: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
      },
      tasks: [baseTask],
      outbox: [],
      sources: [],
    });
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <TasksRailCard />
        </QueryClientProvider>
      ),
    });
    const tasksRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks",
      component: () => null,
    });
    const runRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/runs/$runId",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([tasksRoute, runRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<RouterProvider router={router} />);
    });
    await settleReactWork();

    const rail = view.getByTestId("tasks-rail-card");
    expect(rail.textContent).toContain("现在没有进行中的任务");
    expect(rail.textContent).toContain("已交付的项目资料");
    expect(rail.textContent).not.toContain("当前没有待跟进的任务");
    expect(rail.querySelector(".task-rail-empty")).toBeNull();
    expect(rail.querySelector(".task-rail-idle-hint")).not.toBeNull();
  });

  test("完全没有任何内容时显示完整空态", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    queryClient.setQueryData(taskCenterKeys.snapshot, {
      running: true,
      concurrency: 2,
      counts: {
        inbox: 2,
        queued: 0,
        planning: 0,
        running: 0,
        waiting_dependencies: 0,
        waiting_approval: 0,
        paused: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      },
      tasks: [],
      outbox: [],
      sources: [],
    });
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <TasksRailCard />
        </QueryClientProvider>
      ),
    });
    const tasksRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks",
      component: () => null,
    });
    const runRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/runs/$runId",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([tasksRoute, runRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<RouterProvider router={router} />);
    });
    await settleReactWork();

    const rail = view.getByTestId("tasks-rail-card");
    expect(rail.textContent).toContain("当前没有待跟进的任务");
    expect(rail.textContent).toContain("查看 2 项待安排事项");
    expect(rail.textContent).not.toContain("现在没有进行中的任务");
    expect(rail.querySelector(".task-rail-empty")).not.toBeNull();
    expect(rail.querySelector(".task-rail-idle-hint")).toBeNull();
  });

  test("已取消用斜杠圆图标且中性色，已暂停用暂停图标，失败用红色 × 圆", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    const baseTask = {
      id: "base",
      ownerUserId: "u1",
      agentId: null,
      title: "基础任务",
      description: "desc",
      category: "project" as const,
      level: 3,
      assessment: "",
      risk: "internal" as const,
      status: "running" as const,
      executor: "bot" as const,
      workspace: null,
      sourceId: null,
      sourceRef: null,
      sourceUrl: null,
      parentId: null,
      dependencies: [],
      planPrepared: true,
      priority: 1,
      attempts: 1,
      maxAttempts: 3,
      timeoutSeconds: 300,
      summary: null,
      artifacts: [],
      usage: {},
      error: null,
      createdAt: "2026-11-06T16:00:00.000Z",
      updatedAt: "2026-11-06T16:10:00.000Z",
      startedAt: "2026-11-06T16:01:00.000Z",
      finishedAt: "2026-11-06T16:10:00.000Z",
      nextAttemptAt: "2026-11-06T16:00:00.000Z",
      leaseExpiresAt: null,
      version: 1,
    };
    queryClient.setQueryData(taskCenterKeys.snapshot, {
      running: true,
      concurrency: 2,
      counts: {
        inbox: 0,
        queued: 0,
        planning: 0,
        running: 0,
        waiting_dependencies: 0,
        waiting_approval: 0,
        paused: 1,
        succeeded: 0,
        failed: 1,
        cancelled: 1,
      },
      tasks: [
        {
          ...baseTask,
          id: "paused",
          title: "已暂停的整理任务",
          status: "paused",
          finishedAt: null,
        },
        {
          ...baseTask,
          id: "failed",
          title: "失败的整理任务",
          status: "failed",
          error: "工具超时",
        },
        {
          ...baseTask,
          id: "cancelled",
          title: "已取消的整理任务",
          status: "cancelled",
        },
      ],
      outbox: [],
      sources: [],
    });
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <TasksRailCard />
        </QueryClientProvider>
      ),
    });
    const tasksRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks",
      component: () => null,
    });
    const runRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/runs/$runId",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([tasksRoute, runRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<RouterProvider router={router} />);
    });
    await settleReactWork();

    const paused = view.getByText("已暂停的整理任务").closest("article")!;
    expect(paused.getAttribute("data-tone")).toBe("neutral");
    expect(
      paused.querySelector('[data-testid="task-rail-status-icon-paused"]'),
    ).not.toBeNull();
    expect(
      paused.querySelector('[data-kind="paused"]')?.getAttribute("data-tone"),
    ).toBe("neutral");

    const failed = view.getByText("失败的整理任务").closest("article")!;
    expect(failed.getAttribute("data-tone")).toBe("danger");
    expect(
      failed.querySelector('[data-testid="task-rail-status-icon-danger"]'),
    ).not.toBeNull();

    const cancelled = view.getByText("已取消的整理任务").closest("article")!;
    expect(cancelled.getAttribute("data-tone")).toBe("neutral");
    expect(
      cancelled.querySelector(
        '[data-testid="task-rail-status-icon-cancelled"]',
      ),
    ).not.toBeNull();
    expect(
      cancelled
        .querySelector('[data-kind="cancelled"]')
        ?.getAttribute("data-tone"),
    ).toBe("neutral");
    // 取消与暂停同色不同图标
    expect(
      cancelled.querySelector('[data-testid="task-rail-status-icon-paused"]'),
    ).toBeNull();
  });
});
