import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  Outlet,
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
import { DeleteBotDialog } from "@/components/agents/delete-bot-dialog";
import { BotProfilePage } from "@/components/bot-profile/profile";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import { pickLandingBot } from "@/lib/agents/landing";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { resetBotsLocationMemory } from "@/lib/bots-location";
import {
  resetDraftChannelsForTest,
  switchNewChannelRecipient,
} from "@/lib/channels/draft-channel";
import { channelKeys } from "@/lib/channels/queries";
import { clearComposerInputs } from "@/lib/chat/quote-event";
import {
  resetUiMemory,
  setThreadUi,
  stashDraftFiles,
  takeDraftFiles,
  threadUi,
} from "@/lib/chat/ui-memory";
import {
  type PrimaryAgentResponse,
  primaryAgentKeys,
  settingsKeys,
} from "@/lib/settings/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { DEFAULT_USER_PREFERENCES } from "../../shared/user-preferences";
import { settleReactWork } from "./settle-react-work";

const BotsPage = BotsRoute.options.component;

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

const pristineChannelNew = captureRouteState(ChannelNewRoute);
let channelNewSnapshot: Record<string, unknown> = {};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

beforeEach(() => {
  localStorage.clear();
  resetUiMemory();
  resetDraftChannelsForTest();
  clearComposerInputs();
  resetBotsLocationMemory();
  resetToastsForTest();
  channelNewSnapshot = captureRouteState(pristineChannelNew);
});

afterEach(() => {
  cleanup();
  restoreRouteState(ChannelNewRoute, channelNewSnapshot);
  globalThis.fetch = originalFetch;
  localStorage.clear();
  resetUiMemory();
  resetDraftChannelsForTest();
  clearComposerInputs();
  resetBotsLocationMemory();
  resetToastsForTest();
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function installFetch(
  handler: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
): void {
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(rawUrl, "http://localhost");
      return (
        (await handler(url.pathname, init)) ??
        new NativeResponse(null, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

function makeAgent(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    title: `${overrides.name}助手`,
    roleDescription: "日常协助与对话调度",
    avatarSeed: overrides.id,
    visibility: "public",
    builtIn: true,
    mine: true,
    canManage: true,
    canDelete: true,
    systemOwned: false,
    hidden: false,
    pinned: false,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

function makeSeededClient(agents: AgentProfile[], mainBotId: string | null) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: {
        retry: false,
      },
    },
  });
  qc.setQueryData(authKeys.currentUser(), {
    id: "u1",
    email: "u1@chisabot.test",
    name: "测试用户",
  });
  qc.setQueryData(agentKeys.list(false), agents);
  qc.setQueryData(settingsKeys.preferences("u1"), {
    ...DEFAULT_USER_PREFERENCES,
    mainBotId,
  });
  const matched = mainBotId
    ? (agents.find((item) => item.id === mainBotId) ?? null)
    : null;
  qc.setQueryData<PrimaryAgentResponse>(primaryAgentKeys.current("u1"), {
    configuredAgentId: mainBotId,
    isPaused: false,
    primaryAgent: matched ?? agents[0] ?? null,
    resolution: matched
      ? { status: "configured", fallbackUsed: false }
      : {
          status: agents.length > 0 ? "fallback_roster" : "none",
          fallbackUsed: agents.length > 0,
          reason: "NOT_CONFIGURED",
        },
  });
  qc.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [undefined],
  });
  return qc;
}

function typeIntoComposer(view: ReturnType<typeof render>, text: string) {
  const editor = view.container.querySelector("[contenteditable]");
  if (!editor) throw new Error("composer editor not found");
  (editor as HTMLElement).focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (mime: string) => (mime === "text/plain" ? text : ""),
    },
  });
}

function draftTextInComposer(view: ReturnType<typeof render>): string {
  const editor = view.container.querySelector("[contenteditable]");
  return editor?.textContent ?? "";
}

test("[TC-U02 & TC-U03 & TC-U07] BotsPage 将主 Agent 置顶、渲染星标与金色徽章，并遵从 CB-091 禁用直接删除", async () => {
  const botB = makeAgent({ id: "bot-b", name: "文档助手" });
  const botA = makeAgent({ id: "bot-a", name: "千咲" });
  const botC = makeAgent({ id: "bot-c", name: "代码审查" });

  installFetch((path) => {
    if (path === "/api/me") {
      return NativeResponse.json({
        user: { id: "u1", email: "u1@chisabot.test", name: "测试用户" },
      });
    }
    if (path === "/api/agents") {
      return NativeResponse.json({ agents: [botB, botA, botC] });
    }
    if (path === "/api/bots/attention") {
      return NativeResponse.json({ bots: [] });
    }
    if (path === "/api/channels") {
      return NativeResponse.json({ channels: [], nextCursor: null });
    }
    if (path === "/api/settings/preferences") {
      return NativeResponse.json({
        preferences: { ...DEFAULT_USER_PREFERENCES, mainBotId: "bot-a" },
      });
    }
    if (path === "/api/settings/primary-agent") {
      return NativeResponse.json({
        configuredAgentId: "bot-a",
        isPaused: false,
        primaryAgent: botA,
        resolution: { status: "configured", fallbackUsed: false },
      });
    }
    return undefined;
  });

  // 名册原始顺序把 bot-b 排第一，主 Agent bot-a 在第二
  const qc = makeSeededClient([botB, botA, botC], "bot-a");
  const rootRoute = createRootRoute({ component: Outlet });
  const botsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots",
    component: BotsPage,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId",
    component: () => null,
  });
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([botsRoute, detailRoute, newRoute]),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });

  await act(async () => {
    await router.load();
  });

  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  // [TC-U02] 主 Agent bot-a 必须位于首个列表项
  const rows = await waitFor(() => {
    const items = [...view.container.querySelectorAll("[data-bot-id]")];
    expect(items.length).toBe(3);
    return items;
  });
  expect(rows.map((el) => el.getAttribute("data-bot-id"))).toEqual([
    "bot-a",
    "bot-b",
    "bot-c",
  ]);

  // [TC-U03] 主 Agent 渲染 .glass-bot-star 与「主 Agent」胶囊徽标；其他行无
  const primaryRow = view.getByTestId("bot-row-bot-a");
  const secondaryRow = view.getByTestId("bot-row-bot-b");
  expect(primaryRow.getAttribute("data-primary")).toBe("true");
  expect(
    primaryRow.querySelector('[data-testid="primary-agent-star"]')?.className,
  ).toContain("glass-bot-star");
  expect(
    primaryRow.querySelector('[data-testid="primary-agent-badge"]')
      ?.textContent,
  ).toContain("主 Agent");
  expect(
    secondaryRow.querySelector('[data-testid="primary-agent-star"]'),
  ).toBeNull();
  expect(
    secondaryRow.querySelector('[data-testid="primary-agent-badge"]'),
  ).toBeNull();

  // [TC-U07] CB-091 防误删红线：主 Agent 行内菜单禁止直接点击删除（置灰禁用且带提示）
  const user = userEvent.setup({ document });
  await user.click(view.getByTestId("bot-row-menu-bot-a"));
  const deleteMenuItem = await view.findByTestId("bot-row-delete-bot-a");
  expect(
    deleteMenuItem.getAttribute("aria-disabled") === "true" ||
      deleteMenuItem.hasAttribute("data-disabled"),
  ).toBe(true);
  expect(deleteMenuItem.textContent).toContain("需先取消或更换主 Agent");
});

test("[TC-U04] BotProfilePage 异步按钮严格遵循 pending -> success 状态机且成功无多余 Toast", async () => {
  const botA = makeAgent({ id: "bot-a", name: "千咲" });
  const botB = makeAgent({ id: "bot-b", name: "写作搭档" });

  let currentMain = "bot-a";
  let releasePut!: () => void;
  let rejectPut = false;

  installFetch(async (path, init) => {
    const method = init?.method ?? "GET";
    if (path.endsWith("/lifecycle")) {
      return NativeResponse.json({
        lifecycle: { paused: false, notify: "all" },
        paused: false,
        notify: "all",
      });
    }
    if (path.endsWith("/activity")) {
      return NativeResponse.json({
        activity: { inProgress: [], scheduled: [], completed: [] },
        inProgress: [],
        scheduled: [],
        completed: [],
      });
    }
    if (path.endsWith("/model")) {
      return NativeResponse.json({
        agentId: botB.id,
        model: "m-1",
        overrideModel: null,
        defaultModel: "m-1",
        available: true,
        canManage: true,
      });
    }
    if (path.includes("/models")) {
      return NativeResponse.json({
        models: [{ id: "m-1", label: "Claude", provider: "p" }],
      });
    }
    if (path.endsWith("/library")) {
      return NativeResponse.json({
        files: [],
        limit: 20,
        maxFileBytes: 20 * 1024 * 1024,
      });
    }
    if (path === "/api/settings/preferences") {
      return NativeResponse.json({
        preferences: { ...DEFAULT_USER_PREFERENCES, mainBotId: currentMain },
      });
    }
    if (path === "/api/settings/primary-agent" && method === "GET") {
      return NativeResponse.json({
        configuredAgentId: currentMain,
        isPaused: false,
        primaryAgent: currentMain === "bot-a" ? botA : botB,
        resolution: { status: "configured", fallbackUsed: false },
      });
    }
    if (path === "/api/settings/primary-agent" && method === "PUT") {
      await new Promise<void>((resolve) => {
        releasePut = resolve;
      });
      if (rejectPut) {
        return NativeResponse.json(
          { error: "目标已暂停运行", code: "AGENT_PAUSED" },
          { status: 409 },
        );
      }
      currentMain = "bot-b";
      return NativeResponse.json({
        configuredAgentId: "bot-b",
        isPaused: false,
        primaryAgent: botB,
        resolution: { status: "configured", fallbackUsed: false },
      });
    }
    return NativeResponse.json({});
  });

  const qc = makeSeededClient([botA, botB], "bot-a");
  qc.setQueryData(agentKeys.detail(botB.id), botB);

  const root = createRootRoute({ component: Outlet });
  const profileRoute = createRoute({
    getParentRoute: () => root,
    path: "/bots/$agentId",
    component: () => <BotProfilePage agent={botB} />,
  });
  const botsRoute = createRoute({
    getParentRoute: () => root,
    path: "/bots",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([profileRoute, botsRoute]),
    history: createMemoryHistory({ initialEntries: ["/bots/bot-b"] }),
  });

  await act(async () => {
    await router.load();
  });

  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
      <Toaster />
    </QueryClientProvider>,
  );

  const toggleBtn = await view.findByTestId("profile-primary-toggle");
  expect(toggleBtn.getAttribute("data-btn-state")).toBe("idle");
  expect(toggleBtn.textContent).toContain("设为主 Agent");

  const user = userEvent.setup({ document });
  await act(async () => {
    await user.click(toggleBtn);
  });

  // 1. Pending 态
  expect(toggleBtn.getAttribute("data-btn-state")).toBe("pending");
  expect(toggleBtn.textContent).toContain("设置中");

  // 2. 放行成功并等 MIN_PENDING_MS（300ms）后进入 success 态，同时零 Toast
  releasePut();
  await waitFor(
    () => {
      expect(toggleBtn.getAttribute("data-btn-state")).toBe("success");
      expect(toggleBtn.textContent).toContain("已设为主 Agent");
    },
    { timeout: 1500 },
  );
  expect(view.getByTestId("profile-primary-star")).toBeTruthy();
  expect(view.getByTestId("profile-primary-badge").textContent).toContain(
    "主 Agent",
  );
  expect(view.container.querySelectorAll(".glass-toast").length).toBe(0);

  // 3. 验证失败态弹出错误 Toast 并进入 error 状态
  cleanup();
  resetToastsForTest();
  currentMain = "bot-a";
  rejectPut = true;
  const qcFail = makeSeededClient([botA, botB], "bot-a");
  qcFail.setQueryData(agentKeys.detail(botB.id), botB);
  const routerFail = createRouter({
    routeTree: root.addChildren([profileRoute, botsRoute]),
    history: createMemoryHistory({ initialEntries: ["/bots/bot-b"] }),
  });
  await act(async () => {
    await routerFail.load();
  });
  const failView = render(
    <QueryClientProvider client={qcFail}>
      <RouterProvider router={routerFail as never} />
      <Toaster />
    </QueryClientProvider>,
  );
  const failBtn = await failView.findByTestId("profile-primary-toggle");
  await act(async () => {
    await user.click(failBtn);
  });
  releasePut();
  await waitFor(
    () => {
      expect(failBtn.getAttribute("data-btn-state")).toBe("error");
      expect(failView.getByRole("alert").textContent).toContain(
        "目标已暂停运行",
      );
    },
    { timeout: 1500 },
  );
});

test("[TC-U05] DeleteBotDialog 在删除主 Agent 时展示删除拦截守卫", async () => {
  const botA = makeAgent({ id: "bot-a", name: "千咲" });
  const botB = makeAgent({ id: "bot-b", name: "候补" });
  const deletes: string[] = [];

  installFetch((path, init) => {
    if (init?.method === "DELETE" && path.startsWith("/api/agents/")) {
      deletes.push(path);
    }
    return NativeResponse.json({});
  });

  const qc = makeSeededClient([botA, botB], "bot-a");
  const root = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <DeleteBotDialog
        bot={{ id: botA.id, name: botA.name }}
        onOpenChange={() => {}}
        open
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
  });

  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  expect(await view.findByTestId("main-bot-guard-unset")).toBeTruthy();
  expect(view.getByText(/主机器人不能直接删除/)).toBeTruthy();
  const replaceBtn = view.getByTestId("main-bot-guard-replace");
  expect(replaceBtn).toBeTruthy();
  const user = userEvent.setup({ document });
  await act(async () => {
    await user.click(replaceBtn);
  });
  expect(await view.findByTestId("main-bot-guard-choices")).toBeTruthy();
  expect(deletes).toEqual([]);
});

test("[TC-U06] pickLandingBot 在配置有效主 Agent 时优先返回主 Agent", () => {
  const roster = [{ id: "bot-first" }, { id: "bot-last" }, { id: "bot-main" }];
  expect(pickLandingBot(roster, "bot-last", "bot-main")).toBe("bot-main");
  expect(pickLandingBot(roster, "bot-last", "missing-main")).toBe("bot-last");
  expect(pickLandingBot(roster, null, null)).toBe("bot-first");
});

test("[TC-U08] /channel/new 遭遇主 Agent 暂停 409 与切换目标时完整迁移文本草稿与暂存附件", async () => {
  // Part A: 纯协议 switchNewChannelRecipient 无损迁移文本与暂存 File
  const file = new File(["important-attachment"], "spec.md", {
    type: "text/markdown",
  });
  setThreadUi("new:bot-a", {
    draft: [{ type: "text", text: "一段必须保留的长草稿" }],
  });
  stashDraftFiles("new:bot-a", [file]);

  switchNewChannelRecipient("bot-a", "bot-b");
  expect(threadUi("new:bot-b")?.draft).toEqual([
    { type: "text", text: "一段必须保留的长草稿" },
  ]);
  expect(threadUi("new:bot-a")?.draft).toBeUndefined();
  expect(takeDraftFiles("new:bot-b").map((f) => f.name)).toEqual(["spec.md"]);

  // 清理 Part A 写入的草稿状态后再执行 Part B 真实页面集成用例
  resetUiMemory();
  resetDraftChannelsForTest();
  clearComposerInputs();

  // Part B: 真实 /channel/new 组件在 POST 409 AGENT_PAUSED 后不锁死输入框，并一键迁移草稿切换到候补 Bot
  const botA = makeAgent({ id: "bot-a", name: "千咲" });
  const botB = makeAgent({ id: "bot-b", name: "候补B" });

  installFetch((path, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/channels" && method === "POST") {
      return NativeResponse.json(
        {
          error:
            "主 Agent「千咲」当前处于暂停状态，请先恢复运行或指定其他 Agent 发起会话。",
          code: "AGENT_PAUSED",
          agentId: "bot-a",
        },
        { status: 409 },
      );
    }
    if (path === "/api/channels") {
      return NativeResponse.json({ channels: [], nextCursor: null });
    }
    if (path === "/api/me") {
      return NativeResponse.json({
        user: { id: "u1", email: "u1@chisabot.test", name: "测试用户" },
      });
    }
    if (path === "/api/settings/preferences") {
      return NativeResponse.json({
        preferences: { ...DEFAULT_USER_PREFERENCES, mainBotId: "bot-a" },
      });
    }
    if (path === "/api/settings/primary-agent") {
      return NativeResponse.json({
        configuredAgentId: "bot-a",
        isPaused: false,
        primaryAgent: botA,
        resolution: { status: "configured", fallbackUsed: false },
      });
    }
    if (path === "/api/agents") {
      return NativeResponse.json({ agents: [botA, botB] });
    }
    if (path.endsWith("/model")) {
      return NativeResponse.json({
        agentId: "bot-a",
        model: "m-1",
        overrideModel: null,
        defaultModel: "m-1",
        available: true,
        canManage: true,
      });
    }
    if (path.includes("/models")) {
      return NativeResponse.json({
        models: [{ id: "m-1", label: "Claude", provider: "p" }],
      });
    }
    if (path.endsWith("/library")) {
      return NativeResponse.json({
        files: [],
        limit: 20,
        maxFileBytes: 20 * 1024 * 1024,
      });
    }
    return NativeResponse.json({});
  });

  const qc = makeSeededClient([botA, botB], "bot-a");
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const wired = (
    ChannelNewRoute as unknown as { update: (opts: unknown) => unknown }
  ).update({
    id: "/channel/new",
    path: "/channel/new",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([wired as never])]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/channel/new?agent=bot-a"],
    }),
  });

  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  // 欢迎区展示主 Agent 徽标与切换按钮
  expect(await view.findByTestId("new-channel-primary-badge")).toBeTruthy();
  expect(view.getByTestId("new-channel-switch-trigger")).toBeTruthy();

  const sendBtn = (await view.findByLabelText("发送消息")) as HTMLButtonElement;
  typeIntoComposer(view, "请保留这段提问草稿");
  await waitFor(() => expect(sendBtn.disabled).toBe(false));

  await act(async () => {
    fireEvent.click(sendBtn);
  });

  // 遇到 409 AGENT_PAUSED：显示可恢复/切换引导条，且输入框绝不锁死、草稿仍在
  const banner = await view.findByTestId("paused-agent-banner");
  expect(banner.textContent).toContain("当前处于暂停状态");
  expect(view.getByTestId("paused-agent-resume")).toBeTruthy();
  const switchBtn = view.getByTestId("paused-agent-switch");
  expect(switchBtn.textContent).toContain("候补B");
  const editor = view.container.querySelector("[contenteditable]");
  expect(editor?.getAttribute("aria-disabled")).not.toBe("true");
  await waitFor(() => {
    expect(draftTextInComposer(view)).toContain("请保留这段提问草稿");
  });

  // 点击切换到候补B -> 路由切到 ?agent=bot-b 且草稿无损保留在新输入框中
  await act(async () => {
    fireEvent.click(switchBtn);
  });
  await waitFor(() => {
    expect(view.getByText("候补B")).toBeTruthy();
    expect(draftTextInComposer(view)).toContain("请保留这段提问草稿");
  });
});
