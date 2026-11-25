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
import { type ReactNode, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ComposerDock } from "@/components/channels/composer/dock";
import { GlassTopBar } from "@/components/layout/glass-topbar";
import { PanelRail } from "@/components/panels/panel-rail";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { publishBotActivity } from "@/lib/agents/bot-activity";
import { agentKeys } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/keys";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { channelKeys, type ChannelPage } from "@/lib/channels/queries";
import { openForActivityJump } from "@/lib/computers/auto-watch";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import type { DesktopWindowBridge } from "@/lib/desktop-window";
import { KeptVisibleContext } from "@/lib/kept-visible";
import { openOverlayCount } from "@/lib/overlay-back";
import {
  openPanelSheet,
  setPanelRailOpen,
  setPanelSheetOpen,
  showPanels,
  togglePanelRail,
  usePanelRailOpen,
  usePanelSheetOpen,
} from "@/lib/panels/rail-open";
import { resetSimpleModeForTest, setSimpleMode } from "@/lib/simple-mode";
import { taskCenterKeys } from "@/lib/task-center-api";
import { workflowKeys } from "@/lib/workflows";
import { settleReactWork } from "./settle-react-work";

let wideMatches = false;
const mqlListeners = new Set<() => void>();
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
let realMatchMedia: typeof window.matchMedia | undefined;
const activeClients: QueryClient[] = [];

class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly readyState = StubWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

function setWideViewport(wide: boolean) {
  wideMatches = wide;
  for (const listener of mqlListeners) listener();
}

function installMockFetch() {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        user: { id: "u1", email: "test@example.com", name: "测试用户" },
        preferences: {},
        items: [],
        presets: [],
        mine: [],
        runs: [],
        channels: [],
        nextCursor: null,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      }),
    { preconnect() {} },
  ) as typeof fetch;
}

function createSeededClient() {
  const client = new QueryClient({
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
  activeClients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: "u1",
    email: "test@example.com",
    name: "测试用户",
    role: "admin",
  });
  client.setQueryData(agentKeys.list(), [
    {
      id: "bot-normal",
      name: "千纱",
      title: "前端工程专家",
      avatarSeed: "bot-normal",
      hidden: false,
      pinned: false,
      canManage: true,
    },
    {
      id: "bot-paused",
      name: "休眠助手",
      title: "后台巡检助手",
      avatarSeed: "bot-paused",
      hidden: false,
      pinned: false,
      canManage: true,
    },
  ]);
  const attention: BotAttention[] = [
    {
      agentId: "bot-normal",
      name: "千纱",
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
    },
    {
      agentId: "bot-paused",
      name: "休眠助手",
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: true,
      notify: "all",
    },
  ];
  client.setQueryData(botAttentionQueryOptions().queryKey, attention);
  client.setQueryData<{
    pages: ChannelPage[];
    pageParams: string[];
  }>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            id: "ch-1",
            name: "日常对话",
            agentIds: ["bot-normal"],
            threadId: "t-1",
            active: true,
            lastMessageAt: "2026-11-25T00:00:00Z",
            summary: "日常对话",
            lastMessage: "你好",
            lastMessageAgentId: "bot-normal",
            createdAt: "2026-11-25T00:00:00Z",
            pinned: false,
            lastReadAt: "2026-11-25T00:00:00Z",
            busy: true,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  client.setQueryData(["live-panels", "bot-normal"], []);
  client.setQueryData(approvalInboxOptions().queryKey, {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
  client.setQueryData(recentConfirmationsQueryOptions().queryKey, []);
  client.setQueryData(taskCenterKeys.snapshot, {
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
  });
  client.setQueryData(workflowKeys.library, {
    presets: [],
    mine: [],
    runs: [],
  });
  return client;
}

async function renderWithRouter(node: ReactNode, queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TaskCenterProvider>
            {node}
            <Outlet />
          </TaskCenterProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div />,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$channelId",
    component: () => <div />,
  });
  const newChannelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => <div />,
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId",
    component: () => <div />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      channelRoute,
      newChannelRoute,
      botRoute,
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
  });
  await settleReactWork();
  return view;
}

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1440,
    height: 900,
  });
  globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
  realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query.includes("1280px")) return wideMatches;
      return false;
    },
    media: query,
    onchange: null,
    addListener(cb: () => void) {
      mqlListeners.add(cb);
    },
    removeListener(cb: () => void) {
      mqlListeners.delete(cb);
    },
    addEventListener(_type: string, cb: EventListenerOrEventListenerObject) {
      if (typeof cb === "function") mqlListeners.add(cb as () => void);
    },
    removeEventListener(_type: string, cb: EventListenerOrEventListenerObject) {
      if (typeof cb === "function") mqlListeners.delete(cb as () => void);
    },
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
});

beforeEach(() => {
  installMockFetch();
  window.localStorage.clear();
  resetSimpleModeForTest();
  setPanelSheetOpen(false);
  setPanelRailOpen(false);
  wideMatches = false;
  delete window.chisabotWindow;
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
  for (const client of activeClients.splice(0)) client.clear();
  mqlListeners.clear();
  setPanelSheetOpen(false);
  setPanelRailOpen(true);
  resetSimpleModeForTest();
  window.localStorage.clear();
  document.body.removeAttribute("data-has-narrow-rail");
  delete window.chisabotWindow;
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  globalThis.WebSocket = realWebSocket;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

describe("精简模式布局、右栏封堵与交互回归", () => {
  test("rail-open 与 auto-watch：精简模式拦截 togglePanelRail / openPanelSheet / showPanels / openForActivityJump", () => {
    function RailProbe() {
      const open = usePanelRailOpen();
      const sheetOpen = usePanelSheetOpen();
      return (
        <output data-testid="rail-probe">{`${open ? 1 : 0}:${sheetOpen ? 1 : 0}`}</output>
      );
    }

    const view = render(<RailProbe />);
    expect(view.getByTestId("rail-probe").textContent).toBe("0:0");

    // 精简模式下所有公开入口均被拦截，且不触发 setWatching
    setSimpleMode(true);
    let watched = false;
    const setWatching = (next: boolean) => {
      watched = next;
    };

    act(() => {
      wideMatches = true;
      togglePanelRail();
      showPanels();
      openForActivityJump({ watching: false, setWatching });
      wideMatches = false;
      openPanelSheet("user");
      showPanels();
      openForActivityJump({ watching: false, setWatching });
    });

    expect(view.getByTestId("rail-probe").textContent).toBe("0:0");
    expect(watched).toBe(false);

    // 切回标准模式后恢复正常响应
    setSimpleMode(false);
    act(() => {
      wideMatches = true;
      togglePanelRail();
    });
    expect(view.getByTestId("rail-probe").textContent).toBe("1:0");

    act(() => {
      wideMatches = false;
      openPanelSheet("user");
    });
    expect(view.getByTestId("rail-probe").textContent).toBe("1:1");
  });

  test("PanelRail + KeptVisibleContext：窄窗开抽屉切精简模式清零抽屉与返回栈且不幽灵重弹，宽窗屏蔽 Ctrl+Alt+B", async () => {
    wideMatches = false;
    const queryClient = createSeededClient();

    function SheetStateProbe() {
      const sheetOpen = usePanelSheetOpen();
      const railOpen = usePanelRailOpen();
      return (
        <output data-testid="panel-state">{`${railOpen ? 1 : 0}:${sheetOpen ? 1 : 0}`}</output>
      );
    }

    let setVisible: (next: boolean) => void = () => {};
    function LiveHarness() {
      const [visible, setVis] = useState(true);
      setVisible = setVis;
      return (
        <KeptVisibleContext.Provider value={visible}>
          <SheetStateProbe />
          <PanelRail />
        </KeptVisibleContext.Provider>
      );
    }

    const view = await renderWithRouter(<LiveHarness />, queryClient);
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);

    // 1. 窄窗点击把手打开右抽屉
    const opener = view?.container.querySelector(".rail-tab.is-narrow");
    expect(opener).not.toBeNull();
    await act(async () => {
      if (opener) fireEvent.click(opener);
    });
    await settleReactWork();
    expect(view?.getByTestId("panel-state").textContent).toBe("0:1");
    expect(
      document.querySelector('[data-testid="panel-sheet-close"]'),
    ).not.toBeNull();
    expect(openOverlayCount()).toBe(1);

    // 2. 切入精简模式（onScreen=false）：sheetOpen 清零、body[data-has-narrow-rail] 移除、返回栈归零
    await act(async () => {
      setSimpleMode(true);
      setVisible(false);
    });
    await settleReactWork();
    expect(view?.getByTestId("panel-state").textContent).toBe("0:0");
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(false);
    expect(openOverlayCount()).toBe(0);
    expect(
      document.querySelector('[data-testid="panel-sheet-close"]'),
    ).toBeNull();

    // 3. 切回标准模式（onScreen=true）：旧抽屉不幽灵弹出，body[data-has-narrow-rail] 与把手恢复
    await act(async () => {
      setSimpleMode(false);
      setVisible(true);
    });
    await settleReactWork();
    expect(view?.getByTestId("panel-state").textContent).toBe("0:0");
    expect(document.body.hasAttribute("data-has-narrow-rail")).toBe(true);
    expect(openOverlayCount()).toBe(0);
    expect(
      document.querySelector('[data-testid="panel-sheet-close"]'),
    ).toBeNull();
    expect(view?.container.querySelector(".rail-tab.is-narrow")).not.toBeNull();

    // 4. 宽窗精简模式（onScreen=false）：Ctrl+Alt+B 不拉起右栏
    await act(async () => {
      setWideViewport(true);
      setPanelRailOpen(false);
      setSimpleMode(true);
      setVisible(false);
    });
    await settleReactWork();
    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "b",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settleReactWork();
    expect(view?.getByTestId("panel-state").textContent).toBe("0:0");
  });

  test("GlassTopBar：精简模式隐藏 WorkingCrewStrip，保留品牌字标与 PC 窗口控件", async () => {
    const queryClient = createSeededClient();
    const disposeActivity = publishBotActivity("bot-normal", "working");
    const desktopBridge: DesktopWindowBridge = {
      platform: "win32",
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      isMaximized: async () => false,
      onMaximizedChange: () => () => {},
      isCompact: async () => false,
      toggleCompact: () => {},
      onCompactChange: () => () => {},
    };
    window.chisabotWindow = desktopBridge;

    try {
      const view = await renderWithRouter(
        <SidebarProvider open>
          <GlassTopBar scope="app" />
        </SidebarProvider>,
        queryClient,
      );

      // 标准模式：品牌字标、PC 窗口按钮、WorkingCrewStrip 均可见
      expect(view?.container.querySelector(".glass-brand")).not.toBeNull();
      expect(view?.container.querySelector(".win-ctrls")).not.toBeNull();
      await waitFor(() => {
        expect(view?.queryByTestId("working-crew-strip")).not.toBeNull();
      });

      // 切换精简模式：隐藏 WorkingCrewStrip，完整保留品牌字标与 PC 窗口控件
      await act(async () => {
        setSimpleMode(true);
      });
      await settleReactWork();
      expect(view?.queryByTestId("working-crew-strip")).toBeNull();
      expect(view?.container.querySelector(".glass-brand")).not.toBeNull();
      expect(view?.container.querySelector(".win-ctrls")).not.toBeNull();
    } finally {
      disposeActivity();
    }
  });

  test("AppSidebar：精简模式隐藏正常机器人副标题与菜单「面板」「电脑操作…」，保留「已暂停」副标题与核心菜单项", async () => {
    const queryClient = createSeededClient();
    const view = await renderWithRouter(
      <SidebarProvider open>
        <AppSidebar />
      </SidebarProvider>,
      queryClient,
    );

    // 标准模式：正常机器人显示职责副标题，已暂停机器人显示「已暂停」
    expect(view?.getByText("千纱")).toBeTruthy();
    expect(view?.getByText("前端工程专家")).toBeTruthy();
    expect(view?.getByText("休眠助手")).toBeTruthy();
    expect(view?.getByText("已暂停")).toBeTruthy();

    // 标准模式打开机器人菜单：可见「面板」与「电脑操作…」
    const menuTrigger = view?.getByRole("button", { name: "千纱 机器人菜单" });
    expect(menuTrigger).toBeTruthy();
    await act(async () => {
      if (menuTrigger) fireEvent.click(menuTrigger);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("面板");
      expect(document.body.textContent).toContain("电脑操作…");
    });

    // 切入精简模式：隐藏正常机器人职责副标题，保留「已暂停」；菜单内隐藏「面板」和「电脑操作…」，保留核心菜单项
    await act(async () => {
      setSimpleMode(true);
    });
    await settleReactWork();

    expect(view?.queryByText("前端工程专家")).toBeNull();
    expect(view?.getByText("已暂停")).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("电脑操作…");
      expect(document.body.textContent).not.toContain("它做的仪表盘、列表和小工具");
      expect(document.body.textContent).toContain("机器人资料");
      expect(document.body.textContent).toContain("新话题");
    });
  });

  test("ComposerDock：有历史拖偏存储时，切精简模式清除 data-docked / inline 定位并隐藏把手，切回标准模式恢复", async () => {
    const saved = { x: 120, b: 80, w: 520, h: 160 };
    window.localStorage.setItem("chisabot.composer-dock", JSON.stringify(saved));

    const view = render(
      <div style={{ position: "relative", width: 1000, height: 800 }}>
        <div className="chat-scroll-pad" />
        <ComposerDock>
          <div className="composer-frame">
            <div>{"composer"}</div>
          </div>
        </ComposerDock>
      </div>,
    );
    await settleReactWork();

    const box = view.container.querySelector<HTMLElement>(".chat-composer-box");
    expect(box).not.toBeNull();
    expect(box?.dataset.docked).toBe("true");
    expect(box?.dataset.sized).toBe("true");
    expect(box?.style.left).toBe("120px");
    expect(box?.style.bottom).toBe("80px");
    expect(box?.style.width).toBe("520px");
    expect(view.container.querySelector(".chat-dock-handles")).not.toBeNull();

    // 切入精简模式：清除拖偏定位与把手，同时保留 localStorage 供切回标准模式还原
    await act(async () => {
      setSimpleMode(true);
    });
    await settleReactWork();

    expect(box?.dataset.docked).toBeUndefined();
    expect(box?.dataset.sized).toBeUndefined();
    expect(box?.style.left).toBe("");
    expect(box?.style.bottom).toBe("");
    expect(box?.style.width).toBe("");
    expect(box?.style.height).toBe("");
    expect(view.container.querySelector(".chat-dock-handles")).toBeNull();
    expect(window.localStorage.getItem("chisabot.composer-dock")).toBe(
      JSON.stringify(saved),
    );

    // 切回标准模式：完整恢复拖偏定位与把手
    await act(async () => {
      setSimpleMode(false);
    });
    await settleReactWork();

    expect(box?.dataset.docked).toBe("true");
    expect(box?.dataset.sized).toBe("true");
    expect(box?.style.left).toBe("120px");
    expect(box?.style.bottom).toBe("80px");
    expect(box?.style.width).toBe("520px");
    expect(view.container.querySelector(".chat-dock-handles")).not.toBeNull();
  });
});
