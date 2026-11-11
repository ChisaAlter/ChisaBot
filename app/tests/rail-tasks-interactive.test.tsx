import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { formatRailErrorSummary } from "@/components/panels/task-rail-detail-dialog";
import { TasksRailCard } from "@/components/panels/tasks-rail-card";
import { taskCenterKeys } from "@/lib/task-center-api";
import { TASK_RAIL_ORDER_KEY } from "@/lib/task-rail-order";
import { workflowKeys } from "@/lib/workflows";
import type {
  TaskCenterDecision,
  TaskCenterSnapshot,
  TaskCenterTask,
} from "../../shared/task-center";
import type { WorkflowRunView } from "../../shared/workflows";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = realFetch;
  await settleReactWork();
});

function makeTask(
  id: string,
  overrides: Partial<TaskCenterTask> = {},
): TaskCenterTask {
  return {
    id,
    ownerUserId: "u1",
    agentId: null,
    title: `任务 ${id}`,
    description: `任务 ${id} 的详细目标说明`,
    category: "documents",
    level: 3,
    assessment: "自动规划并执行",
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
    priority: 50,
    attempts: 1,
    maxAttempts: 3,
    timeoutSeconds: 600,
    summary: null,
    artifacts: [],
    usage: { inputTokens: 120, outputTokens: 240, modelCalls: 2 },
    error: null,
    createdAt: "2026-11-06T12:00:00.000Z",
    updatedAt: "2026-11-06T12:01:00.000Z",
    startedAt: "2026-11-06T12:00:10.000Z",
    finishedAt: null,
    nextAttemptAt: "2026-11-06T12:01:00.000Z",
    leaseExpiresAt: null,
    version: 1,
    ...overrides,
  };
}

function makeSnapshot(
  over: Partial<TaskCenterSnapshot> = {},
): TaskCenterSnapshot {
  return {
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
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    tasks: [],
    outbox: [],
    sources: [],
    ...over,
  };
}

function makeRun(
  id: string,
  over: Partial<WorkflowRunView> = {},
): WorkflowRunView {
  return {
    id,
    workflowId: "wf-1",
    workflowName: "发布验收工作流",
    icon: "🚀",
    status: "running",
    source: "chat",
    inputs: { branch: "main" },
    steps: [
      {
        id: "s1",
        name: "静态检查",
        roleKey: "qa",
        roleName: "质检",
        botId: "b1",
        botName: "Chisa",
        status: "succeeded",
        output: "检查通过",
        tokens: 320,
        skills: [],
      },
      {
        id: "s2",
        name: "回归测试",
        roleKey: "qa",
        roleName: "质检",
        botId: "b1",
        botName: "Chisa",
        status: "running",
        output: "",
        tokens: 180,
        skills: [],
      },
    ],
    usage: { tokens: 500, steps: 1, elapsedMs: 14_000 },
    limits: {
      maxTokens: 60_000,
      maxSteps: 10,
      timeLimitMinutes: 20,
      stepTimeoutMinutes: 5,
    },
    outputFormat: "markdown",
    output: null,
    error: null,
    createdAt: "2026-11-06T12:00:00.000Z",
    startedAt: "2026-11-06T12:00:05.000Z",
    finishedAt: null,
    tools: {},
    ...over,
  };
}

async function mountRail(queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TasksRailCard />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/tasks",
        component: () => <div data-testid="tasks-page">任务中心页面</div>,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/workflows/runs/$runId",
        component: () => <div data-testid="workflow-page">工作流运行页</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
  });
  await settleReactWork();
  return { view, router };
}

function createStaticClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

describe("任务卡片高可读错误摘要", () => {
  test("底层 Rust / OAuth 原始报错会转成清晰中文，自然中文句子原样保留", () => {
    const rawDump =
      '{ error_code: Some("refresh_token_invalidated"), error_message: Some("Your session has ended. Please sign in again.") }';
    const summary = formatRailErrorSummary(rawDump);
    expect(summary).toContain("模型登录已失效");
    expect(summary).not.toContain('Some("refresh_token_invalidated")');

    const chineseMsg = "依赖任务失败或已取消，请处理依赖后继续。";
    expect(formatRailErrorSummary(chineseMsg)).toBe(chineseMsg);
  });
});

describe("点击卡片丝滑弹窗查看详情与原位操作（不跳页面）", () => {
  test("点击任务卡片打开弹窗而不跳转路由，并可在弹窗内穿透查看依赖任务与返回", async () => {
    const upstream = makeTask("dep-1", {
      title: "上游资料抓取",
      status: "failed",
      error:
        '{ error_code: Some("refresh_token_invalidated"), error_message: Some("Your session has ended.") }',
      finishedAt: "2026-11-06T12:05:00.000Z",
    });
    const blocked = makeTask("task-blocked", {
      title: "验证：梳理工作区顶层结构",
      status: "waiting_dependencies",
      dependencies: ["dep-1"],
      error: "依赖任务失败或已取消，请处理依赖后继续。",
    });

    const posts: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        posts.push(url.pathname);
        return Response.json({ task: { ...upstream, status: "queued" } });
      }
      if (url.pathname === "/api/task-center/tasks/task-blocked") {
        return Response.json({
          task: blocked,
          events: [
            {
              id: "ev-1",
              ownerUserId: "u1",
              taskId: "task-blocked",
              type: "waiting",
              message: "等待前序依赖完成。",
              data: {},
              createdAt: "2026-11-06T12:01:00.000Z",
            },
          ],
          children: [],
        });
      }
      if (url.pathname === "/api/task-center/tasks/dep-1") {
        return Response.json({
          task: upstream,
          events: [],
          children: [],
        });
      }
      return Response.json(
        makeSnapshot({
          tasks: [blocked, upstream],
          counts: {
            ...makeSnapshot().counts,
            waiting_dependencies: 1,
            failed: 1,
          },
        }),
      );
    }) as typeof fetch;

    const queryClient = createStaticClient();
    queryClient.setQueryData(
      taskCenterKeys.snapshot,
      makeSnapshot({
        tasks: [blocked, upstream],
        counts: {
          ...makeSnapshot().counts,
          waiting_dependencies: 1,
          failed: 1,
        },
      }),
    );
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const { view, router } = await mountRail(queryClient);

    // 卡片上已将底层结构体报错转成易读中文
    const failedCard = view.getByText("上游资料抓取").closest("article")!;
    expect(failedCard.textContent).toContain("模型登录已失效");
    expect(failedCard.textContent).not.toContain(
      'Some("refresh_token_invalidated")',
    );

    // 点击被阻塞的任务卡片，在当前页弹出详情弹窗，路由保持 "/"
    const cardButton = view
      .getByText("验证：梳理工作区顶层结构")
      .closest("button.task-rail-item-link")!;
    await act(async () => {
      fireEvent.click(cardButton);
    });

    const dialog = await waitFor(() =>
      view.getByTestId("task-rail-detail-dialog"),
    );
    expect(router.state.location.pathname).toBe("/");
    expect(dialog.textContent).toContain("验证：梳理工作区顶层结构");
    expect(dialog.textContent).toContain("前序依赖任务");
    expect(dialog.textContent).toContain("上游资料抓取");

    // 在弹窗内直接穿透到失败的前序依赖任务
    const depBtn = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("上游资料抓取"),
    )!;
    await act(async () => {
      fireEvent.click(depBtn);
    });

    await waitFor(() => {
      expect(dialog.textContent).toContain("返回上一任务");
      expect(dialog.textContent).toContain("查看原始错误详情");
    });

    // 在弹窗内直接点击「重试任务」
    const retryBtn = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("重试任务"),
    )!;
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() =>
      expect(posts).toContain("/api/task-center/tasks/dep-1/retry"),
    );

    // 点击返回上一任务，平滑退回原卡片详情
    const backBtn = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("返回上一任务"),
    )!;
    await act(async () => {
      fireEvent.click(backBtn);
    });
    await waitFor(() =>
      expect(dialog.textContent).toContain("验证：梳理工作区顶层结构"),
    );
    expect(router.state.location.pathname).toBe("/");
  });

  test("点击工作流卡片弹出步骤详情弹窗，并可在弹窗内直接停止工作流", async () => {
    const wfRun = makeRun("run-99");
    const posts: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        posts.push(url.pathname);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/workflows/runs/run-99") {
        return Response.json({ run: wfRun });
      }
      return Response.json({ presets: [], mine: [], runs: [wfRun] });
    }) as typeof fetch;

    const queryClient = createStaticClient();
    queryClient.setQueryData(taskCenterKeys.snapshot, makeSnapshot());
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [wfRun],
    });

    const { view, router } = await mountRail(queryClient);
    const wfCardBtn = view
      .getByText(/发布验收工作流/)
      .closest("button.task-rail-item-link")!;
    await act(async () => {
      fireEvent.click(wfCardBtn);
    });

    const dialog = await waitFor(() =>
      view.getByTestId("task-rail-detail-dialog"),
    );
    expect(router.state.location.pathname).toBe("/");
    expect(dialog.textContent).toContain("静态检查");
    expect(dialog.textContent).toContain("回归测试");

    const stopBtn = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("停止运行"),
    )!;
    await act(async () => {
      fireEvent.click(stopBtn);
    });
    await waitFor(() =>
      expect(posts).toContain("/api/workflows/runs/run-99/cancel"),
    );
  });
});

describe("三点菜单（⋯）原位操作：置顶、上移、下移、取消任务", () => {
  test("三点菜单支持置顶/取消置顶、上移下移持久化排序，以及直接取消任务", async () => {
    const user = userEvent.setup({ document: globalThis.document });
    const taskA = makeTask("t-a", {
      title: "甲：梳理接口契约",
      status: "queued",
      error: "依赖任务失败或已取消，请处理依赖后继续。",
    });
    const taskB = makeTask("t-b", {
      title: "乙：生成验收报告",
      status: "running",
    });
    const taskC = makeTask("t-c", {
      title: "丙：归档测试产物",
      status: "paused",
    });

    const requests: Array<{ path: string; body?: unknown }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        requests.push({
          path: url.pathname,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ task: { ...taskA, status: "cancelled" } });
      }
      return Response.json(
        makeSnapshot({
          tasks: [taskA, taskB, taskC],
          counts: {
            ...makeSnapshot().counts,
            queued: 1,
            running: 1,
            paused: 1,
          },
        }),
      );
    }) as typeof fetch;

    const queryClient = createStaticClient();
    queryClient.setQueryData(
      taskCenterKeys.snapshot,
      makeSnapshot({
        tasks: [taskA, taskB, taskC],
        counts: { ...makeSnapshot().counts, queued: 1, running: 1, paused: 1 },
      }),
    );
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const { view, router } = await mountRail(queryClient);
    const activeTitles = () =>
      [
        ...view.container.querySelectorAll(
          'section[aria-label="任务与工作流"] .task-rail-title',
        ),
      ].map((el) => el.textContent);

    expect(activeTitles()).toEqual([
      "甲：梳理接口契约",
      "乙：生成验收报告",
      "丙：归档测试产物",
    ]);

    // 1. 打开「丙：归档测试产物」的三点菜单并点击「置顶」→ 丙立即浮到最顶部并持久化
    await user.click(
      view.getByRole("button", { name: "「丙：归档测试产物」的更多操作" }),
    );
    const pinItem = await waitFor(
      () =>
        [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find(
          (el) => el.textContent?.trim() === "置顶",
        )!,
    );
    await user.click(pinItem);

    await waitFor(() => {
      expect(activeTitles()).toEqual([
        "丙：归档测试产物",
        "甲：梳理接口契约",
        "乙：生成验收报告",
      ]);
    });
    const cardC = view.getByText("丙：归档测试产物").closest("article")!;
    expect(cardC.getAttribute("data-pinned")).toBe("true");
    expect(cardC.textContent).toContain("置顶");
    expect(localStorage.getItem(TASK_RAIL_ORDER_KEY)).toContain("task:t-c");
    expect(
      requests.some((r) => r.path === "/api/task-center/tasks/t-c/priority"),
    ).toBe(true);

    // 2. 打开「甲：梳理接口契约」（未置顶组第 1 项）的三点菜单，验证「上移」禁用，点击「下移」与乙互换顺序
    await user.click(
      view.getByRole("button", { name: "「甲：梳理接口契约」的更多操作" }),
    );
    const moveUpItem = await waitFor(
      () =>
        [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find(
          (el) => el.textContent?.trim() === "上移",
        )!,
    );
    expect(moveUpItem.hasAttribute("data-disabled")).toBe(true);

    const moveDownItem = [
      ...document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    ].find((el) => el.textContent?.trim() === "下移")!;
    await user.click(moveDownItem);

    await waitFor(() => {
      expect(activeTitles()).toEqual([
        "丙：归档测试产物",
        "乙：生成验收报告",
        "甲：梳理接口契约",
      ]);
    });

    // 3. 打开「甲：梳理接口契约」的三点菜单，点击「取消任务」原位取消，不跳页面
    await user.click(
      view.getByRole("button", { name: "「甲：梳理接口契约」的更多操作" }),
    );
    const cancelItem = await waitFor(
      () =>
        [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find(
          (el) => el.textContent?.trim() === "取消任务",
        )!,
    );
    await user.click(cancelItem);

    await waitFor(() =>
      expect(
        requests.some((r) => r.path === "/api/task-center/tasks/t-a/cancel"),
      ).toBe(true),
    );
    expect(router.state.location.pathname).toBe("/");
  });

  test("待确认审批卡片点击打开详情弹窗并可在弹窗内直接批准", async () => {
    const pendingTask = makeTask("t-outbox", {
      title: "对外发送版本公告",
      status: "waiting_approval",
      risk: "external",
    });
    const decision: TaskCenterDecision = {
      id: "dec-outbox",
      taskId: "t-outbox",
      ownerUserId: "u1",
      taskVersion: 1,
      summary: "将向全员公告群发送 v2.4 发布说明",
      proposedAction: {
        title: "对外发送版本公告",
        description: "发送公告",
        executor: "bot",
        risk: "external",
      },
      status: "pending",
      createdAt: "2026-11-06T12:00:00.000Z",
      decidedAt: null,
      notificationError: null,
    };

    const posts: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        posts.push(url.pathname);
        return Response.json({
          decision: { ...decision, status: "approved" },
        });
      }
      if (url.pathname === "/api/task-center/tasks/t-outbox") {
        return Response.json({
          task: pendingTask,
          events: [],
          children: [],
        });
      }
      return Response.json(
        makeSnapshot({
          tasks: [pendingTask],
          outbox: [decision],
          decisionCounts: {
            pending: 1,
            approved: 0,
            rejected: 0,
            superseded: 0,
          },
        }),
      );
    }) as typeof fetch;

    const queryClient = createStaticClient();
    queryClient.setQueryData(
      taskCenterKeys.snapshot,
      makeSnapshot({
        tasks: [pendingTask],
        outbox: [decision],
        decisionCounts: {
          pending: 1,
          approved: 0,
          rejected: 0,
          superseded: 0,
        },
      }),
    );
    queryClient.setQueryData(workflowKeys.library, {
      presets: [],
      mine: [],
      runs: [],
    });

    const { view, router } = await mountRail(queryClient);
    const cardBtn = view.container.querySelector<HTMLButtonElement>(
      'article[data-kind="decision"] button.task-rail-item-link',
    )!;
    await act(async () => {
      fireEvent.click(cardBtn);
    });

    const dialog = await waitFor(() =>
      view.getByTestId("task-rail-detail-dialog"),
    );
    expect(router.state.location.pathname).toBe("/");
    expect(dialog.textContent).toContain("将向全员公告群发送 v2.4 发布说明");

    const approveBtn = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("批准执行"),
    )!;
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() =>
      expect(posts).toContain("/api/task-center/outbox/dec-outbox/decide"),
    );
  });
});
