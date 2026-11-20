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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { TasksRailCard } from "@/components/panels/tasks-rail-card";
import {
  TaskCenter,
  type TaskCenterView,
} from "@/components/task-center/task-center";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import {
  clearComposerInputs,
  type ComposerInput,
  receiveComposerInputs,
} from "@/lib/chat/quote-event";
import {
  formatBoardSourceRef,
  type MarkdownBoardSnapshot,
  type MarkdownBoardSummary,
} from "../../shared/task-board";
import {
  TASK_STATUSES,
  type TaskCenterSnapshot,
  type TaskCenterTask,
} from "../../shared/task-center";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  clearComposerInputs();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const REV_1 = "a".repeat(64);
const REV_2 = "b".repeat(64);
const BOARD_ID = "1234567890abcdef";

function makeTask(overrides: Partial<TaskCenterTask> = {}): TaskCenterTask {
  return {
    id: "task-1",
    ownerUserId: "owner",
    agentId: null,
    title: "整理设计文档",
    description: "核对章节与实现一致性",
    category: "project",
    level: 3,
    assessment: "可执行",
    risk: "internal",
    status: "inbox",
    executor: "bot",
    workspace: null,
    sourceId: null,
    sourceRef: null,
    sourceUrl: null,
    parentId: null,
    dependencies: [],
    planPrepared: true,
    priority: 80,
    lane: "now",
    attempts: 0,
    maxAttempts: 3,
    timeoutSeconds: 900,
    summary: null,
    artifacts: [],
    usage: {},
    error: null,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: "2026-11-15T00:00:00Z",
    leaseExpiresAt: null,
    version: 1,
    ...overrides,
  };
}

function makeBoardSnapshot(revision = REV_1): MarkdownBoardSnapshot {
  return {
    boardId: BOARD_ID,
    rootPath: "c:/workspace/demo",
    label: "Demo 项目",
    dialect: "autobahn",
    backlogFile: "BACKLOG.md",
    revision,
    writable: true,
    lanes: {
      now: "现在",
      next: "接下来",
      later: "以后",
    },
    pinned: {
      title: "本周重点URGENT说明",
      body: "URGENT PRIORITY：先完成 API 闭环",
      line: 5,
    },
    cards: [
      {
        id: "AB-1",
        title: "URGENT 修复看板拖拽",
        lane: "now",
        filedIn: "now",
        done: false,
        blocked: false,
        movable: true,
        statusText: "open",
        size: "M",
        tags: ["ui"],
        body: [
          "- **Priority:** P1",
          "- [ ] 完成桌面端指针拖拽",
          "- [x] 补齐单元测试",
        ].join("\n"),
        line: 10,
        sourceFile: "BACKLOG.md",
        sourceRef: formatBoardSourceRef({
          rootKey: BOARD_ID,
          relFile: "BACKLOG.md",
          cardId: "AB-1",
        }),
        checkboxes: { checked: 1, total: 2 },
      },
      {
        id: "AB-2",
        title: "归档旧版本",
        lane: "shipped",
        filedIn: "next",
        done: true,
        blocked: false,
        movable: true,
        statusText: "done",
        size: "S",
        tags: [],
        body: "- **Status:** done\n已完成清理。",
        line: 20,
        sourceFile: "BACKLOG.md",
        sourceRef: formatBoardSourceRef({
          rootKey: BOARD_ID,
          relFile: "BACKLOG.md",
          cardId: "AB-2",
        }),
        checkboxes: { checked: 0, total: 0 },
      },
    ],
    docs: [
      { relFile: "BACKLOG.md", name: "BACKLOG.md", writable: true },
      { relFile: "README.md", name: "README.md", writable: true },
    ],
  };
}

function renderWithRouter(
  node: ReactNode,
  initialPath = "/tasks",
): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const catchAllRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, catchAllRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return render(<RouterProvider router={router} />);
}

function mountCenter(initialView: TaskCenterView = "board") {
  function Surface() {
    const [view, setView] = useState<TaskCenterView>(initialView);
    return <TaskCenter onNavigate={setView} view={view} />;
  }
  return renderWithRouter(<Surface />);
}

test("右栏任务卡片只保留单一任务中心入口、渲染已交付原属泳道标记，并支持发到当前对话", async () => {
  const received: ComposerInput[] = [];
  window.history.replaceState({}, "", "/channel/ch-1");
  const sub = receiveComposerInputs({
    targetPath: "/channel/ch-1",
    active: () => true,
    consume: (input) => received.push(input),
  });

  const activeTask = makeTask({
    id: "t-act",
    title: "联调后端接口",
    status: "running",
    lane: "now",
  });
  const shippedTask = makeTask({
    id: "t-done",
    title: "看板卡片已完成交付",
    status: "succeeded",
    lane: "next",
    summary: "全部验收通过",
    sourceRef: formatBoardSourceRef({
      rootKey: BOARD_ID,
      relFile: "BACKLOG.md",
      cardId: "AB-9",
    }),
    finishedAt: "2026-11-15T01:00:00Z",
  });

  const snap: TaskCenterSnapshot = {
    tasks: [activeTask, shippedTask],
    outbox: [],
    sources: [],
    running: true,
    concurrency: 2,
    counts: Object.fromEntries(
      TASK_STATUSES.map((s) => [s, s === "running" || s === "succeeded" ? 1 : 0]),
    ) as TaskCenterSnapshot["counts"],
    decisionCounts: { pending: 0, approved: 0, rejected: 0, superseded: 0 },
  };

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/task-center") return Response.json(snap);
      if (url.pathname === "/api/task-center/tasks")
        return Response.json({
          tasks: [activeTask],
          total: 1,
          nextOffset: null,
        });
      if (url.pathname === "/api/workflows")
        return Response.json({ workflows: [], runs: [], tools: [] });
      if (url.pathname === "/api/agents") return Response.json({ agents: [] });
      if (url.pathname === "/api/task-center/capabilities")
        return Response.json({ capabilities: [] });
      if (url.pathname === "/api/task-center/boards")
        return Response.json({ boards: [], availableRoots: [] });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    originalFetch,
  );

  const view = renderWithRouter(
    <TaskCenterProvider>
      <TasksRailCard />
    </TaskCenterProvider>,
    "/channel/ch-1",
  );

  await waitFor(() => {
    expect(view.getByRole("button", { name: "任务中心" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "看板" })).toBeNull();
    expect(view.getByText("原属：接下来")).toBeTruthy();
    expect(view.getByText("AB-9")).toBeTruthy();
  });

  const moreTriggers = view.getAllByTestId("task-rail-more-trigger");
  fireEvent.click(moreTriggers[0] as HTMLElement);
  const sendBtn = await view.findByText("发到当前对话");
  fireEvent.click(sendBtn);

  expect(received.length).toBe(1);
  expect(received[0]?.kind).toBe("prefill");
  if (received[0]?.kind === "prefill") {
    expect(received[0].text).toContain("联调后端接口");
  }

  fireEvent.click(view.getByRole("button", { name: "任务中心" }));
  const boardTab = await view.findByRole("button", { name: "看板" });
  fireEvent.click(boardTab);
  await waitFor(() => {
    expect(view.getByText("个人任务看板")).toBeTruthy();
  });

  sub.dispose();
});

test("右栏无进行中任务与待确认审批时，点击任务中心直达看板", async () => {
  const snap: TaskCenterSnapshot = {
    tasks: [
      makeTask({
        id: "t-idle-board",
        title: "整理待办事项",
        status: "inbox",
        lane: "now",
      }),
    ],
    outbox: [],
    sources: [],
    running: true,
    concurrency: 2,
    counts: Object.fromEntries(
      TASK_STATUSES.map((s) => [s, s === "inbox" ? 1 : 0]),
    ) as TaskCenterSnapshot["counts"],
    decisionCounts: { pending: 0, approved: 0, rejected: 0, superseded: 0 },
  };

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/task-center") return Response.json(snap);
      if (url.pathname === "/api/workflows")
        return Response.json({ workflows: [], runs: [], tools: [] });
      if (url.pathname === "/api/agents") return Response.json({ agents: [] });
      if (url.pathname === "/api/task-center/capabilities")
        return Response.json({ capabilities: [] });
      if (url.pathname === "/api/task-center/boards")
        return Response.json({ boards: [], availableRoots: [] });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    originalFetch,
  );

  const view = renderWithRouter(
    <TaskCenterProvider>
      <TasksRailCard />
    </TaskCenterProvider>,
    "/channel/ch-1",
  );

  await waitFor(() => {
    expect(view.getByRole("button", { name: "任务中心" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "看板" })).toBeNull();
  });

  fireEvent.click(view.getByRole("button", { name: "任务中心" }));
  await waitFor(() => {
    expect(view.getByText("个人任务看板")).toBeTruthy();
  });
});

test("个人任务看板四列投影、原属标记与菜单移动排期调用 schedule 接口", async () => {
  const scheduledCalls: Array<{ id: string; body: unknown }> = [];
  let tasksState: TaskCenterTask[] = [
    makeTask({
      id: "t-inbox-later",
      title: "补充性能基准",
      status: "inbox",
      lane: "later",
      priority: 20,
    }),
    makeTask({
      id: "t-shipped",
      title: "历史交付任务",
      status: "succeeded",
      lane: "now",
      priority: 80,
      summary: "已上线验证",
    }),
  ];

  const buildSnap = (): TaskCenterSnapshot => ({
    tasks: tasksState,
    outbox: [],
    sources: [],
    running: true,
    concurrency: 2,
    counts: Object.fromEntries(
      TASK_STATUSES.map((s) => [s, s === "inbox" || s === "succeeded" ? 1 : 0]),
    ) as TaskCenterSnapshot["counts"],
    decisionCounts: { pending: 0, approved: 0, rejected: 0, superseded: 0 },
  });

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/task-center") return Response.json(buildSnap());
      if (url.pathname === "/api/task-center/boards")
        return Response.json({ boards: [], availableRoots: [] });
      if (url.pathname === "/api/task-center/tasks/t-inbox-later/schedule") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        scheduledCalls.push({ id: "t-inbox-later", body });
        tasksState = tasksState.map((t) =>
          t.id === "t-inbox-later"
            ? { ...t, lane: body.lane, priority: body.priority }
            : t,
        );
        return Response.json({ task: tasksState[0] });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    originalFetch,
  );

  const view = mountCenter("board");
  await waitFor(() => {
    expect(view.getByText("补充性能基准")).toBeTruthy();
    expect(view.getByText("历史交付任务")).toBeTruthy();
    expect(view.getByText("原属：现在")).toBeTruthy();
  });

  const cardMoreBtns = view.getAllByRole("button", { name: "任务看板操作" });
  fireEvent.click(cardMoreBtns[0] as HTMLElement);
  const moveNowItem = await view.findByText("移到：现在");
  fireEvent.click(moveNowItem);

  await waitFor(() => {
    expect(scheduledCalls.length).toBe(1);
    expect(scheduledCalls[0]?.body).toEqual({ lane: "now", priority: 80 });
  });
});

test("本地 Markdown 看板支持 deshout、规格胶囊、复选框翻转、覆盖层 CAS 保存/409 及机器人派发", async () => {
  let currentBoard = makeBoardSnapshot(REV_1);
  let forceConflictNextSave = true;
  let viewRefetchedAfterConflict = false;

  const summary: MarkdownBoardSummary = {
    boardId: BOARD_ID,
    rootPath: currentBoard.rootPath,
    label: currentBoard.label,
    dialect: currentBoard.dialect,
    backlogFile: currentBoard.backlogFile,
    writable: true,
    cardCount: 2,
  };

  const snap: TaskCenterSnapshot = {
    tasks: [],
    outbox: [],
    sources: [],
    running: true,
    concurrency: 2,
    counts: Object.fromEntries(
      TASK_STATUSES.map((s) => [s, 0]),
    ) as TaskCenterSnapshot["counts"],
    decisionCounts: { pending: 0, approved: 0, rejected: 0, superseded: 0 },
  };

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/task-center") return Response.json(snap);
      if (url.pathname === "/api/agents") return Response.json({ agents: [] });
      if (url.pathname === "/api/task-center/capabilities")
        return Response.json({ capabilities: [] });
      if (url.pathname === "/api/task-center/boards")
        return Response.json({ boards: [summary], availableRoots: [] });
      if (url.pathname === "/api/task-center/boards/view") {
        if (!forceConflictNextSave) {
          viewRefetchedAfterConflict = true;
        }
        return Response.json({ board: currentBoard });
      }
      if (url.pathname === "/api/task-center/boards/checkbox") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.baseRevision).toBe(REV_1);
        expect(body.checkboxIndex).toBe(0);
        expect(body.checked).toBe(true);
        currentBoard = {
          ...currentBoard,
          revision: REV_2,
          cards: currentBoard.cards.map((c) =>
            c.id === "AB-1"
              ? {
                  ...c,
                  body: c.body.replace("- [ ] 完成桌面端指针拖拽", "- [x] 完成桌面端指针拖拽"),
                  checkboxes: { checked: 2, total: 2 },
                }
              : c,
          ),
        };
        return Response.json({ board: currentBoard });
      }
      if (url.pathname === "/api/task-center/boards/card") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (forceConflictNextSave) {
          forceConflictNextSave = false;
          viewRefetchedAfterConflict = false;
          currentBoard = { ...currentBoard, revision: "c".repeat(64) };
          return Response.json(
            { error: "看板文件已在外部更新，已刷新最新内容，请核对后重试。" },
            { status: 409 },
          );
        }
        expect(body.baseRevision).toBe("c".repeat(64));
        expect(body.body).toContain("- **Priority:** P0");
        currentBoard = {
          ...currentBoard,
          cards: currentBoard.cards.map((c) =>
            c.id === body.cardId
              ? { ...c, title: body.title, body: body.body }
              : c,
          ),
        };
        return Response.json({ board: currentBoard });
      }
      if (url.pathname === "/api/task-center/boards/dispatch") {
        const linkedTask = {
          id: "dispatched-1",
          title: "AB-1 · 修复拖拽",
          status: "running" as const,
          executor: "bot",
          summary: null,
          error: null,
          updatedAt: "2026-11-15T00:05:00Z",
          finishedAt: null,
        };
        currentBoard = {
          ...currentBoard,
          cards: currentBoard.cards.map((c) =>
            c.id === "AB-1" ? { ...c, linkedTask } : c,
          ),
        };
        return Response.json(
          { task: makeTask({ id: "dispatched-1", status: "running" }), board: currentBoard },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    originalFetch,
  );

  const view = mountCenter("board");
  const boardTab = await view.findByRole("tab", { name: /Demo 项目/ });
  fireEvent.click(boardTab);

  // 检验置顶说明与 deshout 柔化
  await waitFor(() => {
    expect(view.getByText(/Urgent priority/i)).toBeTruthy();
    expect(view.getByText("Urgent 修复看板拖拽")).toBeTruthy();
    expect(view.getByText("原属：接下来")).toBeTruthy();
  });

  // 打开 AB-1 卡片详情
  fireEvent.click(view.getByText("Urgent 修复看板拖拽"));
  await waitFor(() => {
    expect(view.getByText("Priority")).toBeTruthy();
    expect(view.getByText("P1")).toBeTruthy();
  });

  // 点击未完成复选框（index 0）
  const checkboxes = view.getAllByRole("checkbox");
  fireEvent.click(checkboxes[0] as HTMLInputElement);
  await waitFor(() => {
    expect((view.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(
      true,
    );
  });

  // 进入覆盖层源码编辑并测试 409 冲突 -> 重试保存
  fireEvent.click(view.getByRole("button", { name: "编辑源码" }));
  const editor = view.getByLabelText("编辑卡片 AB-1 的 Markdown 正文");
  const user = userEvent.setup({ document });
  await user.clear(editor);
  await user.type(editor, "- **Priority:** P0{Enter}已更新说明");
  fireEvent.click(view.getByRole("button", { name: "保存源码" }));

  // 第一次遇 409 自动触发看板刷新后再次点击保存成功
  await waitFor(() => {
    expect(forceConflictNextSave).toBe(false);
    expect(viewRefetchedAfterConflict).toBe(true);
    expect(
      (view.getByRole("button", { name: "保存源码" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  fireEvent.click(view.getByRole("button", { name: "保存源码" }));
  await waitFor(() => {
    expect(view.getByText("P0")).toBeTruthy();
  });

  // 交给机器人推进并在卡片上看到关联状态徽标
  fireEvent.click(view.getByRole("button", { name: "交给机器人推进" }));
  await waitFor(() => {
    expect(view.getByText(/关联任务：执行中/)).toBeTruthy();
  });
});

test("Companion .md 文档编辑在后台刷新后仍提交原始 baseRevision 触发 409，并支持显式覆盖外部版本", async () => {
  let currentDoc = {
    boardId: BOARD_ID,
    relFile: "README.md",
    name: "README.md",
    content: "# 文档初始版本\n\n第一段。",
    revision: REV_1,
    writable: true,
  };
  const postedRevisions: Array<{ baseRevision: string; content: string }> = [];

  const board = makeBoardSnapshot(REV_1);
  const summary: MarkdownBoardSummary = {
    boardId: BOARD_ID,
    rootPath: board.rootPath,
    label: board.label,
    dialect: board.dialect,
    backlogFile: board.backlogFile,
    writable: true,
    cardCount: 2,
  };
  const snap: TaskCenterSnapshot = {
    tasks: [],
    outbox: [],
    sources: [],
    running: true,
    concurrency: 2,
    counts: Object.fromEntries(
      TASK_STATUSES.map((s) => [s, 0]),
    ) as TaskCenterSnapshot["counts"],
    decisionCounts: { pending: 0, approved: 0, rejected: 0, superseded: 0 },
  };

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/task-center") return Response.json(snap);
      if (url.pathname === "/api/agents") return Response.json({ agents: [] });
      if (url.pathname === "/api/task-center/capabilities")
        return Response.json({ capabilities: [] });
      if (url.pathname === "/api/task-center/boards")
        return Response.json({ boards: [summary], availableRoots: [] });
      if (url.pathname === "/api/task-center/boards/view")
        return Response.json({ board });
      if (
        url.pathname === "/api/task-center/boards/doc" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json({ doc: currentDoc });
      }
      if (url.pathname === "/api/task-center/boards/doc" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          baseRevision: string;
          content: string;
        };
        postedRevisions.push({
          baseRevision: body.baseRevision,
          content: body.content,
        });
        if (body.baseRevision !== currentDoc.revision) {
          return Response.json(
            { error: "看板文件已在外部更新，已刷新最新内容，请核对后重试。" },
            { status: 409 },
          );
        }
        currentDoc = {
          ...currentDoc,
          content: body.content,
          revision: "c".repeat(64),
        };
        return Response.json({ doc: currentDoc });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    originalFetch,
  );

  const view = mountCenter("board");
  fireEvent.click(await view.findByRole("tab", { name: /Demo 项目/ }));
  fireEvent.click(await view.findByRole("tab", { name: /README\.md/ }));

  const docEditor = await view.findByLabelText("编辑看板文档 README.md");
  const user = userEvent.setup({ document });
  await user.type(docEditor, "\n本地修改内容");

  // 模拟后台轮询/手动刷新后服务端文档已变成 REV_2
  currentDoc = {
    ...currentDoc,
    content: "# 外部已保存的新版本\n",
    revision: REV_2,
  };
  fireEvent.click(view.getByRole("button", { name: "刷新看板" }));

  await waitFor(() => {
    expect(view.getByText("外部已更新 · 放弃本地草稿并重载")).toBeTruthy();
    expect(view.getByText("用当前草稿覆盖外部版本")).toBeTruthy();
  });

  // 点普通“保存文档”仍应携带 REV_1，从而被服务端 409 拦下而不静默覆盖 REV_2
  fireEvent.click(view.getByRole("button", { name: "保存文档" }));
  await waitFor(() => {
    expect(postedRevisions.length).toBe(1);
    expect(postedRevisions[0]?.baseRevision).toBe(REV_1);
  });

  // 点“用当前草稿覆盖外部版本”才提交 REV_2 并成功落盘
  fireEvent.click(view.getByRole("button", { name: "用当前草稿覆盖外部版本" }));
  await waitFor(() => {
    expect(postedRevisions.length).toBe(2);
    expect(postedRevisions[1]?.baseRevision).toBe(REV_2);
    expect(postedRevisions[1]?.content).toContain("本地修改内容");
    expect(view.getByText(`版本 ${"c".repeat(8)}`)).toBeTruthy();
  });
});
