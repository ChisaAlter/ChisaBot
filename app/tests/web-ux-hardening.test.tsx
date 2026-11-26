import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { PendingInbox } from "@/components/approvals/inbox";
import { BotProfilePage } from "@/components/bot-profile/profile";
import { ProfileDialog } from "@/components/layout/profile-dialog";
import { PanelRail } from "@/components/panels/panel-rail";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import { setAgentPinnedMutationOptions } from "@/lib/agents/mutations";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  ConversationSession,
  isSyntheticConnectRunId,
} from "@/lib/chat/session-client";
import { useSharedReducedMotion } from "@/lib/motion";
import { setPanelRailOpen } from "@/lib/panels/rail-open";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "https://chisabot.test/" }));

beforeEach(() => {
  resetToastsForTest();
});

afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetToastsForTest();
  await settleReactWork();
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
) {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "https://chisabot.test");
      const res = await handler(url.pathname + url.search, init);
      if (res) return res;
      return NativeResponse.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
}

describe("M3 Web UX hardening regressions", () => {
  test("[P0-1] ConversationSession ignores connect:* synthetic runId and clears stale observedRunId on idle finalize", async () => {
    expect(isSyntheticConnectRunId("connect:t1:abc")).toBe(true);
    expect(isSyntheticConnectRunId("run-real-1")).toBe(false);
    expect(isSyntheticConnectRunId(undefined)).toBe(false);

    const stopBodies: Array<{ runId?: string }> = [];
    installFetch(async (path, init) => {
      if (path.includes("/stop/")) {
        stopBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return NativeResponse.json({ stopped: true });
      }
      return NativeResponse.json({});
    });

    const session = new ConversationSession("bot-1", "thread-empty", "channel:1");
    let send!: (event: BaseEvent) => void;
    let complete!: () => void;
    let onSubscribed!: () => void;
    let subscribed = new Promise<void>((resolve) => {
      onSubscribed = resolve;
    });
    const runSpy = spyOn(session, "run").mockImplementation(
      (_input: RunAgentInput) =>
        new Observable((observer) => {
          send = (event) => observer.next(event);
          complete = () => observer.complete();
          onSubscribed();
        }),
    );

    try {
      // 1. 先模拟一次真实 run 记录了 observedRunId
      let done = session.runAgent();
      await subscribed;
      send({
        type: "RUN_STARTED",
        threadId: "thread-empty",
        runId: "run-real-99",
      } as BaseEvent);
      send({
        type: "RUN_FINISHED",
        threadId: "thread-empty",
        runId: "run-real-99",
      } as BaseEvent);
      complete();
      await done;

      await session.stop();
      expect(stopBodies.at(-1)).toEqual({ runId: "run-real-99" });

      // 2. 再模拟一次 connect:* 空连接信封：不得覆盖为 connect:*，finalize 后清空残留 runId
      subscribed = new Promise<void>((resolve) => {
        onSubscribed = resolve;
      });
      done = session.runAgent();
      await subscribed;
      send({
        type: "RUN_STARTED",
        threadId: "thread-empty",
        runId: "connect:thread-empty:uuid-1",
      } as BaseEvent);
      await session.stop();
      expect(stopBodies.at(-1)).toEqual({ runId: "run-real-99" });

      send({
        type: "RUN_FINISHED",
        threadId: "thread-empty",
        runId: "connect:thread-empty:uuid-1",
      } as BaseEvent);
      complete();
      await done;

      await session.stop();
      expect(stopBodies.at(-1)).toEqual({});
    } finally {
      runSpy.mockRestore();
    }
  });

  test("[P1-1] PanelRail renders Chinese ErrorCard with retry when /api/live-panels fails and recovers on retry", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("1280"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    let attempts = 0;
    installFetch((path) => {
      if (path.startsWith("/api/live-panels")) {
        attempts += 1;
        if (attempts === 1) {
          return NativeResponse.json({ error: "后端面板服务暂时不可用" }, { status: 500 });
        }
        return NativeResponse.json({ items: [] });
      }
      if (path === "/api/agents") {
        return NativeResponse.json({
          agents: [
            {
              id: "bot-1",
              name: "千咲",
              title: "助手",
              roleDescription: "",
              avatarSeed: "bot-1",
              visibility: "private",
              endpoint: null,
              builtIn: true,
              hasAuth: false,
              hasCallbackToken: false,
              hidden: false,
              pinned: false,
              systemOwned: false,
              canManage: true,
              mine: true,
            },
          ],
        });
      }
      if (path === "/api/task-center") {
        return NativeResponse.json({
          running: false,
          concurrency: 1,
          counts: {},
          tasks: [],
          outbox: [],
          sources: [],
        });
      }
      return NativeResponse.json({});
    });

    setPanelRailOpen(true);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Outlet });
    const botRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => <PanelRail />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([botRoute]),
      history: createMemoryHistory({ initialEntries: ["/bots/bot-1"] }),
    });
    await act(async () => {
      await router.load();
    });

    try {
      const view = render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router as never} />
        </QueryClientProvider>,
      );

      const retryBtn = await view.findByTestId("rail-panels-retry");
      expect(view.getByText("面板暂时无法加载")).toBeTruthy();

      await act(async () => {
        fireEvent.click(retryBtn);
      });

      await waitFor(() => {
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(view.queryByTestId("rail-panels-retry") === null).toBe(true);
      });
    } finally {
      window.matchMedia = originalMatchMedia;
      qc.clear();
    }
  });

  test("[P1-2 & P1-3] AppSidebar shows skeleton while loading, error+retry on failure, and mutations toast Chinese errors", async () => {
    const origWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class StubWebSocket {
      static readonly OPEN = 1;
      readyState = 1;
      addEventListener() {}
      removeEventListener() {}
      close() {}
      send() {}
    } as unknown as typeof WebSocket;

    let releaseAgents!: (res: Response) => void;
    let agentsCalls = 0;
    installFetch((path) => {
      if (path === "/api/agents") {
        agentsCalls += 1;
        if (agentsCalls === 1) {
          return new Promise<Response>((resolve) => {
            releaseAgents = resolve;
          });
        }
        return NativeResponse.json({
          agents: [
            {
              id: "bot-1",
              name: "千咲",
              title: "助手",
              roleDescription: "",
              avatarSeed: "bot-1",
              visibility: "private",
              endpoint: null,
              builtIn: true,
              hasAuth: false,
              hasCallbackToken: false,
              hidden: false,
              pinned: false,
              systemOwned: false,
              canManage: true,
              mine: true,
            },
          ],
        });
      }
      if (path === "/api/channels") {
        return NativeResponse.json({ channels: [], nextCursor: null });
      }
      if (path === "/api/bots/attention") {
        return NativeResponse.json({ bots: [] });
      }
      if (path === "/api/me") {
        return NativeResponse.json({
          user: { id: "u1", email: "u@chisabot.test", name: "测试" },
        });
      }
      if (path === "/api/settings/preferences") {
        return NativeResponse.json({ preferences: {} });
      }
      if (path.endsWith("/pin") || path.endsWith("/pause") || path.endsWith("/notifications")) {
        return NativeResponse.json({ error: "" }, { status: 500 });
      }
      return NativeResponse.json({});
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={qc}>
          <ThemeProvider>
            <TaskCenterProvider>
              <SidebarProvider defaultOpen>
                <AppSidebar />
              </SidebarProvider>
              <Toaster />
            </TaskCenterProvider>
          </ThemeProvider>
        </QueryClientProvider>
      ),
    });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      await router.load();
    });

    try {
      const view = render(<RouterProvider router={router as never} />);

      // 加载中显示骨架
      expect(await view.findByTestId("sidebar-roster-skeleton")).toBeTruthy();

      // 首次返回 500 -> 显示错误提示与重试按钮
      await act(async () => {
        releaseAgents(NativeResponse.json({ error: "服务异常" }, { status: 500 }));
      });
      const retry = await view.findByTestId("sidebar-roster-retry");
      expect(view.getByTestId("sidebar-roster-error").textContent).toContain(
        "机器人列表暂时无法加载",
      );

      // 点击重试恢复渲染机器人行
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(await view.findByText("千咲")).toBeTruthy();

      // 验证 pin / pause / notify 失败弹出中文 toast.error
      const pinOpts = setAgentPinnedMutationOptions(qc);
      await expect(
        pinOpts.mutationFn?.({ agentId: "bot-1", pinned: true }, {} as never),
      ).rejects.toThrow();
      pinOpts.onError?.(
        new Error("固定失败测试"),
        { agentId: "bot-1", pinned: true },
        undefined,
        {} as never,
      );

      const pauseOpts = setBotPausedMutationOptions(qc);
      pauseOpts.onError?.(
        new Error(""),
        { agentId: "bot-1", paused: true },
        undefined,
        {} as never,
      );

      const notifyOpts = setBotNotifyMutationOptions(qc);
      notifyOpts.onError?.(
        new Error(""),
        { agentId: "bot-1", notify: "all" },
        undefined,
        {} as never,
      );

      await waitFor(() => {
        const text = view.container.textContent ?? "";
        expect(text).toContain("固定失败测试");
        expect(text).toContain("暂停机器人失败，请稍后重试。");
        expect(text).toContain("更新通知设置失败，请稍后重试。");
      });
    } finally {
      globalThis.WebSocket = origWebSocket;
      qc.clear();
    }
  });

  test("[P1-4] ProfileDialog revokes blob URL immediately when image load fails", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const origImage = globalThis.Image;

    URL.createObjectURL = (() => {
      const url = `blob:test-${created.length + 1}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    globalThis.Image = BrokenImage as unknown as typeof Image;

    installFetch((path) => {
      if (path === "/api/me") {
        return NativeResponse.json({
          user: { id: "u1", email: "u@chisabot.test", name: "千咲", image: null },
        });
      }
      return NativeResponse.json({});
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={qc}>
          <ProfileDialog onOpenChange={() => {}} open />
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      await router.load();
    });

    try {
      const view = render(<RouterProvider router={router as never} />);
      const input = view.baseElement.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      expect(input).toBeTruthy();

      const file = new File(["broken"], "bad.png", { type: "image/png" });
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(created).toEqual(["blob:test-1"]);
        expect(revoked).toEqual(["blob:test-1"]);
        expect(view.getByRole("alert").textContent).toContain("图片无法读取");
      });
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      globalThis.Image = origImage;
      qc.clear();
    }
  });

  test("[P1-5] HandOffCard prevents concurrent conflicting decisions across allow/always/deny buttons", async () => {
    const decisionCalls: string[] = [];
    let releaseDecision!: () => void;

    installFetch(async (path, init) => {
      if (path.startsWith("/api/approvals") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { decision?: string };
        decisionCalls.push(body.decision ?? "");
        await new Promise<void>((resolve) => {
          releaseDecision = resolve;
        });
        return NativeResponse.json({ ok: true });
      }
      if (path === "/api/approvals") {
        return NativeResponse.json({
          requests: [
            {
              id: "req-1",
              status: "pending",
              createdAt: new Date().toISOString(),
              action: {
                botId: "bot-1",
                toolRef: "host/run_shell",
                target: "echo hi",
                args: { cmd: "echo hi" },
                policy: { behaviour: "ask", reason: "需要确认" },
              },
            },
          ],
          questions: [],
        });
      }
      if (path.startsWith("/api/confirmations")) {
        return NativeResponse.json({ requests: [], nextCursor: null });
      }
      if (path === "/api/agents") {
        return NativeResponse.json({
          agents: [{ id: "bot-1", name: "千咲" }],
        });
      }
      return NativeResponse.json({});
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={qc}>
          <PendingInbox />
        </QueryClientProvider>
      ),
    });
    const settingsApprovals = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/approvals",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([settingsApprovals]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      await router.load();
    });

    const view = render(<RouterProvider router={router as never} />);
    const allowOnce = (await view.findByRole("button", {
      name: "允许一次",
    })) as HTMLButtonElement;
    const allowAlways = view.getByRole("button", {
      name: "以后都允许",
    }) as HTMLButtonElement;
    const deny = view.getByRole("button", {
      name: "不要执行",
    }) as HTMLButtonElement;

    // 同拍连续点击三个冲突按钮，只应发出第一条请求且其余按钮被禁用
    await act(async () => {
      fireEvent.click(allowOnce);
      fireEvent.click(allowAlways);
      fireEvent.click(deny);
    });

    expect(decisionCalls).toEqual(["allow_once"]);
    expect(allowAlways.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    await act(async () => {
      releaseDecision();
    });
    qc.clear();
  });

  test("[P2-2] BotProfilePage renders ErrorCard with retry for TasksSection and lifecycle failures", async () => {
    const agent: AgentProfile = {
      id: "bot-err",
      name: "测试机器人",
      title: "排障",
      roleDescription: "描述",
      avatarSeed: "bot-err",
      visibility: "private",
      endpoint: null,
      builtIn: true,
      hasAuth: false,
      hasCallbackToken: false,
      hidden: false,
      pinned: false,
      systemOwned: false,
      canManage: true,
      mine: true,
    };

    let activityCalls = 0;
    installFetch((path) => {
      if (path.endsWith("/lifecycle")) {
        return NativeResponse.json({ error: "生命周期接口超时" }, { status: 503 });
      }
      if (path.endsWith("/activity")) {
        activityCalls += 1;
        if (activityCalls === 1) {
          return NativeResponse.json({ error: "活动读取失败" }, { status: 500 });
        }
        return NativeResponse.json({
          activity: { inProgress: [], scheduled: [], completed: [] },
        });
      }
      if (path.endsWith("/model")) {
        return NativeResponse.json({
          agentId: agent.id,
          model: "m-1",
          overrideModel: null,
          defaultModel: "m-1",
          available: true,
          canManage: true,
        });
      }
      if (path.includes("/models")) {
        return NativeResponse.json({
          models: [{ id: "m-1", label: "M1", provider: "p" }],
        });
      }
      return NativeResponse.json({ files: [], limit: 20, maxFileBytes: 1024 });
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(agentKeys.detail(agent.id), agent);

    const rootRoute = createRootRoute({ component: Outlet });
    const profileRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => <BotProfilePage agent={agent} />,
    });
    const botsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([profileRoute, botsRoute]),
      history: createMemoryHistory({ initialEntries: ["/bots/bot-err"] }),
    });
    await act(async () => {
      await router.load();
    });

    const view = render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );

    expect(await view.findByText("任务列表暂时无法加载")).toBeTruthy();
    expect(view.getByText("无法加载运行状态。")).toBeTruthy();

    const retryButtons = view.getAllByRole("button", { name: "重试" });
    expect(retryButtons.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.click(retryButtons[1]!);
    });
    await waitFor(() => {
      expect(activityCalls).toBeGreaterThanOrEqual(2);
      expect(view.queryByText("任务列表暂时无法加载") === null).toBe(true);
    });
    qc.clear();
  });

  test("[P2-4] useSharedReducedMotion shares a single matchMedia subscription across consumers", async () => {
    const original = window.matchMedia;
    let matches = false;
    let addCalls = 0;
    let removeCalls = 0;
    const listeners = new Set<() => void>();

    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes("reduce") ? matches : false;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => {
        addCalls += 1;
        listeners.add(l);
      },
      removeEventListener: (_: string, l: () => void) => {
        removeCalls += 1;
        listeners.delete(l);
      },
    })) as unknown as typeof window.matchMedia;

    try {
      function Probe({ id }: { id: string }) {
        return (
          <span data-testid={id}>
            {useSharedReducedMotion() ? "reduce" : "full"}
          </span>
        );
      }
      const view = render(
        <>
          <Probe id="a" />
          <Probe id="b" />
        </>,
      );
      expect(addCalls).toBe(1);
      expect(view.getByTestId("a").textContent).toBe("full");
      expect(view.getByTestId("b").textContent).toBe("full");

      await act(async () => {
        matches = true;
        for (const listener of listeners) listener();
      });
      expect(view.getByTestId("a").textContent).toBe("reduce");
      expect(view.getByTestId("b").textContent).toBe("reduce");

      view.unmount();
      expect(removeCalls).toBe(1);
    } finally {
      window.matchMedia = original;
    }
  });
});
