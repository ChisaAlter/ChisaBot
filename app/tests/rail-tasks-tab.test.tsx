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
import { workflowKeys } from "@/lib/workflows";
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
  });
});
