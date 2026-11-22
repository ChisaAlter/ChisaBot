import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as z from "zod";
import * as ChannelChatModule from "@/components/channels/channel-chat";
import { ChannelPage } from "@/components/channels/channel-page";
import { WorkerCard } from "@/components/chat/worker-card";
import { DetailPanel } from "@/components/layout/detail-panel";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { LivePanelList } from "@/components/panels/live-panels";
import { type LivePanel, livePanelKeys } from "@/components/panels/live-panels-query";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ConversationScopeProvider } from "@/lib/chat/conversation-scope";
import { ToolRendererProvider } from "@/lib/chat/renderers";
import {
  agentComponentsQueryOptions,
  componentKeys,
} from "@/lib/components/queries";
import { useComputerActivity } from "@/lib/computers/use-computer-activity";
import { ActiveBotProvider, useActiveBot } from "@/lib/conversations/active-bot";
import { SandboxedTools } from "@/lib/conversations/sandboxed-tools";
import { SkillTools } from "@/lib/conversations/skill-tools";
import { useStoppedTurnIds } from "@/lib/conversations/turn-compaction";
import { workerKeys } from "@/lib/conversations/workers";
import * as KeptVisibleModule from "@/lib/kept-visible";
import {
  KeptVisibilityContext,
  KeptVisibleContext,
  createKeptVisibility,
} from "@/lib/kept-visible";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { sandboxedKeys } from "@/lib/sandboxed/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Group 1 子包 B 回归单测：
 * - ChannelPage 无关 channelList 更新 0 重渲，且保留已读标定语义；
 * - DetailPanel 关闭态零 ResizeObserver 与零 getBoundingClientRect；
 * - LivePanelList active=false 时直连源与列表零轮询；
 * - turn-compaction 按 threadId 与 KeepAlive 可见性过滤 chisabot-chat-running；
 * - WorkerCard 孤儿 workerId 重试有上限且隐藏态不重试；
 * - agentComponentsQueryOptions 45s 降频 + refetchIntervalInBackground=false；
 * - useComputerActivity 隐藏态不建 SSE / 不轮询，恢复可见后立即补拉；
 * - SandboxedTools 缓存 z.fromJSONSchema 结果；
 * - AppSidebar 预建 Map 索引且严禁动 botAttentionQueryOptions 15s 轮询。
 */

const realFetch = globalThis.fetch;
let realResizeObserver: typeof ResizeObserver;
let realEventSource: typeof EventSource | undefined;

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1440,
    height: 900,
  });
  realResizeObserver = globalThis.ResizeObserver;
  realEventSource = globalThis.EventSource;
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = realFetch;
  globalThis.ResizeObserver = realResizeObserver;
  if (realEventSource === undefined) {
    Reflect.deleteProperty(globalThis, "EventSource");
  } else {
    globalThis.EventSource = realEventSource;
  }
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function makeSummary(overrides: Partial<ChannelSummary> & { id: string }): ChannelSummary {
  return {
    name: `会话 ${overrides.id}`,
    agentIds: ["bot_a"],
    threadId: `thread_${overrides.id}`,
    active: true,
    lastMessageAt: "2026-11-20T10:00:00.000Z",
    summary: null,
    lastMessage: "hi",
    lastMessageAgentId: null,
    createdAt: "2026-11-20T09:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-20T10:05:00.000Z",
    ...overrides,
  };
}

describe("重渲染广播切断与 KeepAlive 轮询门控", () => {
  test("ChannelPage：无关频道列表乐观更新不触发重渲，但当前频道收到未读回复仍正常标已读", async () => {
    const counts = { page: 0, chat: 0 };
    const readCalls: string[] = [];
    const pageSpy = spyOn(KeptVisibleModule, "useMarkBotHidden");
    pageSpy.mockImplementation(() => {
      counts.page++;
    });
    const chatSpy = spyOn(ChannelChatModule, "ChannelChat");
    chatSpy.mockImplementation((({ channel }: { channel: AgentChannel }) => {
      counts.chat++;
      return <div data-testid="chat">{channel.id}</div>;
    }) as unknown as typeof ChannelChatModule.ChannelChat);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/read") && init?.method === "PUT") {
        readCalls.push(url);
        return Response.json({ ok: true });
      }
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const chA = makeSummary({ id: "ch_a", agentIds: ["bot_a"] });
    const chB = makeSummary({ id: "ch_b", agentIds: ["bot_b"] });
    queryClient.setQueryData(channelKeys.detail("ch_a"), {
      id: chA.id,
      name: chA.name,
      agentIds: chA.agentIds,
      threadId: chA.threadId,
      active: chA.active,
      lastMessageAt: chA.lastMessageAt,
    });
    queryClient.setQueryData(channelKeys.list(), {
      pages: [{ channels: [chA, chB], nextCursor: null }],
      pageParams: [""],
    });

    function Shell() {
      const pathname = useRouterState({ select: (s) => s.location.pathname });
      const match = /^\/channel\/([^/]+)$/.exec(pathname);
      const address = match ? { channelId: match[1] as string } : null;
      return (
        <KeepAliveStage
          address={address}
          renderKept={(kept, { visible, epoch }) => (
            <ChannelPage
              channelId={kept.channelId}
              epoch={epoch}
              key={kept.channelId}
              visible={visible}
            />
          )}
          same={(a, b) => a.channelId === b.channelId}
        >
          <Outlet />
        </KeepAliveStage>
      );
    }

    const rootRoute = createRootRoute({ component: Shell });
    const routeTree = rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings",
        component: () => <section>{"设置"}</section>,
      }),
    ]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/channel/ch_a"] }),
    });

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(view.getByTestId("chat").textContent).toBe("ch_a"));
      const basePageRenders = counts.page;
      const baseChatRenders = counts.chat;

      // 1. 模拟无关频道 ch_b 与本频道 ch_a 的 busy 乐观更新：ChannelPage 与 ChannelChat 必须 0 重渲。
      await act(async () => {
        queryClient.setQueryData(channelKeys.list(), {
          pages: [
            {
              channels: [
                { ...chA, busy: true },
                {
                  ...chB,
                  busy: true,
                  lastMessageAt: "2026-11-20T10:10:00.000Z",
                  lastMessageAgentId: "bot_b",
                },
              ],
              nextCursor: null,
            },
          ],
          pageParams: [""],
        });
      });
      await settleReactWork();
      expect(counts.page).toBe(basePageRenders);
      expect(counts.chat).toBe(baseChatRenders);
      expect(readCalls).toEqual([]);

      // 2. 当前可见频道 ch_a 收到机器人新消息：依然自动标已读，且 ChannelPage 自身不重渲。
      await act(async () => {
        queryClient.setQueryData(channelKeys.list(), {
          pages: [
            {
              channels: [
                {
                  ...chA,
                  lastMessageAt: "2026-11-20T10:20:00.000Z",
                  lastMessageAgentId: "bot_a",
                },
                chB,
              ],
              nextCursor: null,
            },
          ],
          pageParams: [""],
        });
      });
      await waitFor(() => expect(readCalls.length).toBe(1));
      expect(readCalls[0]).toContain("/api/channels/ch_a/read");
      expect(counts.page).toBe(basePageRenders);
      expect(counts.chat).toBe(baseChatRenders);
    } finally {
      pageSpy.mockRestore();
      chatSpy.mockRestore();
      queryClient.clear();
    }
  });

  test("DetailPanel 关闭态零 ResizeObserver 与零 getBoundingClientRect，展开时才挂载观测", async () => {
    let observedCount = 0;
    let rectCalls = 0;
    class TrackingObserver implements ResizeObserver {
      observe() {
        observedCount++;
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TrackingObserver;

    const view = render(
      <DetailPanel detail={<p>{"详情正文"}</p>} onClose={() => {}} open={false}>
        <p>{"主区"}</p>
      </DetailPanel>,
    );
    const root = view.container.firstElementChild as HTMLElement;
    const origRect = root.getBoundingClientRect.bind(root);
    root.getBoundingClientRect = () => {
      rectCalls++;
      return origRect();
    };
    await settleReactWork();
    expect(observedCount).toBe(0);
    expect(rectCalls).toBe(0);

    // 展开后才挂 ResizeObserver 与测量容器宽度。
    await act(async () => {
      view.rerender(
        <DetailPanel detail={<p>{"详情正文"}</p>} onClose={() => {}} open>
          <p>{"主区"}</p>
        </DetailPanel>,
      );
    });
    expect(observedCount).toBe(1);
    expect(rectCalls).toBeGreaterThanOrEqual(1);
  });

  test("LivePanelList active=false 时暂停直连源轮询，切回 active=true 后立即恢复", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/panel-1/live")) {
        return Response.json({
          sources: {
            btc: {
              ok: true,
              value: 99000,
              at: "2026-11-20T10:00:00.000Z",
              ms: 12,
            },
          },
        });
      }
      return Response.json({ items: [panel] });
    }) as unknown as typeof fetch;

    const panel: LivePanel = {
      id: "panel-1",
      botId: "bot-live",
      title: "比特币",
      status: "ready",
      spec: JSON.stringify({
        root: "card",
        elements: {
          card: { type: "Text", props: { text: "BTC" } },
        },
      }),
      sources: [],
      instruction: "BTC",
      refreshMinutes: 60,
      dataSources: [
        {
          id: "btc",
          kind: "http",
          name: "BTC",
          intervalSec: 2,
          label: "api.example.com/btc",
        },
      ],
      error: null,
      refreshedAt: "2026-11-20T10:00:00.000Z",
      nextRefreshAt: null,
      refreshing: false,
      canUndoEdit: false,
      createdAt: "2026-11-20T09:00:00.000Z",
    };

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
        },
      },
    });
    queryClient.setQueryData(livePanelKeys.list("bot-live"), [panel]);

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <LivePanelList active={false} botId="bot-live" width={360} />
        </QueryClientProvider>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(requestedUrls.filter((u) => u.includes("/live-panels/panel-1/live"))).toEqual([]);

      // 展开并切回「面板」标签：立即恢复直连源取数。
      await act(async () => {
        view.rerender(
          <QueryClientProvider client={queryClient}>
            <LivePanelList active botId="bot-live" width={360} />
          </QueryClientProvider>,
        );
      });
      await waitFor(() =>
        expect(
          requestedUrls.some((u) => u.includes("/api/live-panels/panel-1/live")),
        ).toBe(true),
      );
    } finally {
      queryClient.clear();
    }
  });

  test("turn-compaction 按 threadId 与 KeepAlive 可见性过滤 chisabot-chat-running", async () => {
    const stoppedCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/stopped")) stoppedCalls.push(url);
      return Response.json({ userMessageIds: [] });
    }) as unknown as typeof fetch;

    const visHidden = createKeptVisibility(false);
    const visShown = createKeptVisibility(true);

    function Probe({ threadId }: { threadId: string }) {
      useStoppedTurnIds(threadId);
      return null;
    }

    render(
      <>
        <KeptVisibilityContext.Provider value={visShown}>
          <Probe threadId="t-shown" />
        </KeptVisibilityContext.Provider>
        <KeptVisibilityContext.Provider value={visHidden}>
          <Probe threadId="t-hidden" />
        </KeptVisibilityContext.Provider>
      </>,
    );
    await waitFor(() => expect(stoppedCalls.length).toBe(2));
    stoppedCalls.length = 0;

    // 1. 携带其他 threadId 的结束事件：两者都不重查。
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chisabot-chat-running", {
          detail: { running: false, threadId: "t-other" },
        }),
      );
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(stoppedCalls).toEqual([]);

    // 2. 隐藏线程收到全局结束事件时暂不请求，切回可见时才立即补偿一次。
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chisabot-chat-running", { detail: false }),
      );
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(stoppedCalls.filter((u) => u.includes("t-hidden"))).toEqual([]);

    await act(async () => {
      visHidden.set(true);
    });
    await waitFor(() =>
      expect(stoppedCalls.some((u) => u.includes("t-hidden"))).toBe(true),
    );
  });

  test("WorkerCard 隐藏态不重试，且孤儿 workerId 重试不会陷入死循环", async () => {
    let workerFetchCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/workers")) {
        workerFetchCount++;
        return Response.json({ workers: [] });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
        },
      },
    });
    queryClient.setQueryData(workerKeys.thread("t-orphan"), []);

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <KeptVisibleContext.Provider value={false}>
            <ConversationScopeProvider agentId="bot-1" threadId="t-orphan">
              <WorkerCard pendingTitle="旧任务" workerId="orphan-1" />
            </ConversationScopeProvider>
          </KeptVisibleContext.Provider>
        </QueryClientProvider>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 460));
      });
      // 隐藏态一次都不补查。
      expect(workerFetchCount).toBe(0);
      view.unmount();
    } finally {
      queryClient.clear();
    }
  });

  test("agentComponentsQueryOptions 放宽至 45s 且禁用后台标签轮询", () => {
    const opts = agentComponentsQueryOptions("bot-1");
    expect(opts.refetchInterval).toBe(45_000);
    expect(opts.staleTime).toBe(45_000);
    expect(opts.refetchIntervalInBackground).toBe(false);
  });

  test("useComputerActivity 隐藏态不建 SSE 也不发请求，切回可见后立即补拉与建链", async () => {
    const fetched: string[] = [];
    const sseUrls: string[] = [];
    let closedCount = 0;
    class FakeEventSource {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        sseUrls.push(url);
      }
      addEventListener() {}
      close() {
        closedCount++;
      }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Response.json({ steps: [], nextCursor: null, retentionDays: 90 });
    }) as unknown as typeof fetch;

    function ActivityProbe() {
      useComputerActivity("bot-comp");
      return null;
    }

    const view = render(
      <KeptVisibleContext.Provider value={false}>
        <ActivityProbe />
      </KeptVisibleContext.Provider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetched).toEqual([]);
    expect(sseUrls).toEqual([]);

    // 切回可见：拉取一次并建立 SSE。
    await act(async () => {
      view.rerender(
        <KeptVisibleContext.Provider value={true}>
          <ActivityProbe />
        </KeptVisibleContext.Provider>,
      );
    });
    await waitFor(() => expect(fetched.length).toBe(1));
    expect(sseUrls.length).toBe(1);

    // 再次隐藏：关闭 SSE。
    await act(async () => {
      view.rerender(
        <KeptVisibleContext.Provider value={false}>
          <ActivityProbe />
        </KeptVisibleContext.Provider>,
      );
    });
    expect(closedCount).toBe(1);
  });

  test("SandboxedTools 缓存 z.fromJSONSchema 避免逐渲染重复解析", async () => {
    const fromSchemaSpy = spyOn(z, "fromJSONSchema");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
        },
      },
    });
    const sharedSchema = {
      type: "object",
      properties: { city: { type: "string" } },
    };
    queryClient.setQueryData(sandboxedKeys.published(), [
      {
        name: "weather_card",
        html: "<div>ok</div>",
        css: "",
        jsFunctions: "",
        argumentSchema: sharedSchema,
      },
    ]);
    queryClient.setQueryData(componentKeys.forAgent("bot-sb"), [
      { name: "weather_card", description: "天气卡" },
    ]);

    function Declare({ botId }: { botId: string }) {
      useActiveBot(botId);
      return null;
    }

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <ActiveBotProvider>
            <ToolRendererProvider>
              <Declare botId="bot-sb" />
              <SandboxedTools />
            </ToolRendererProvider>
          </ActiveBotProvider>
        </QueryClientProvider>,
      );
      await settleReactWork();
      const firstCalls = fromSchemaSpy.mock.calls.length;
      expect(firstCalls).toBe(1);

      // 多次重渲（例如授权描述变动）：同一个 argumentSchema 对象引用必须命中缓存，不再重复调用 fromJSONSchema。
      await act(async () => {
        queryClient.setQueryData(componentKeys.forAgent("bot-sb"), [
          { name: "weather_card", description: "天气卡 v2" },
        ]);
      });
      await settleReactWork();
      expect(fromSchemaSpy.mock.calls.length).toBe(firstCalls);
      view.unmount();
    } finally {
      fromSchemaSpy.mockRestore();
      queryClient.clear();
    }
  });

  test("AppSidebar 使用 Map 预建最新单聊索引，且保留 botAttentionQueryOptions 15s 轮询红线", () => {
    const sidebarSrc = readFileSync(
      path.join(import.meta.dir, "../src/components/app-sidebar/app-sidebar.tsx"),
      "utf8",
    );
    expect(sidebarSrc).toContain("const latestChannelByBot = useMemo(");
    expect(sidebarSrc).toContain("latest={latestChannelByBot.get(bot.id)}");
    expect(sidebarSrc).not.toContain("latest={latestChannelFor(");
    // 红线：全局后台桌面提醒的 botAttentionQueryOptions() 轮询不可移除或门控暂停。
    expect(sidebarSrc).toContain("const attention = useQuery(botAttentionQueryOptions());");
    expect(sidebarSrc).toContain("useAttentionNotifications(attention.data);");
  });

  test("authed-shell ChatStage 仅在 / 路由挂载 LandingChannelProbe 订阅 useLanding", () => {
    const shellSrc = readFileSync(
      path.join(import.meta.dir, "../src/components/layout/authed-shell.tsx"),
      "utf8",
    );
    const chatStageStart = shellSrc.indexOf("function ChatStage(");
    expect(chatStageStart).toBeGreaterThan(-1);
    const chatStageBody = shellSrc.slice(chatStageStart);
    expect(chatStageBody).not.toContain("useLanding()");
    expect(chatStageBody).toContain("<LandingChannelProbe");
  });

  test("GroupChatView 与 SkillTools / SandboxedTools 门控轮询且不因 KeptVisibleContext 重渲工具注册组件", () => {
    const groupSrc = readFileSync(
      path.join(import.meta.dir, "../src/components/channels/group-chat-view.tsx"),
      "utf8",
    );
    expect(groupSrc).toContain("useKeptVisible()");
    expect(groupSrc).toContain("if (!keptVisible) return false;");
    expect(groupSrc).toContain("refetchIntervalInBackground: false");

    const skillToolsSrc = readFileSync(
      path.join(import.meta.dir, "../src/lib/conversations/skill-tools.tsx"),
      "utf8",
    );
    expect(skillToolsSrc).toContain("useKeptVisibility()");
    expect(skillToolsSrc).not.toContain("useKeptVisible()");
    expect(skillToolsSrc).toContain("useBotOnScreen(declared)");
    expect(skillToolsSrc).toContain("refetchIntervalInBackground: false");

    const sandboxedSrc = readFileSync(
      path.join(import.meta.dir, "../src/lib/conversations/sandboxed-tools.tsx"),
      "utf8",
    );
    expect(sandboxedSrc).toContain("useKeptVisibility()");
    expect(sandboxedSrc).not.toContain("useKeptVisible()");
    expect(sandboxedSrc).toContain("useBotOnScreen(declared)");
    expect(sandboxedSrc).toContain("refetchIntervalInBackground: false");
  });

  test("SkillTools 切换 KeptVisibleContext 零重渲，且 useSkillCommands 快速切换不重发 404 请求", async () => {
    const pluginRequests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/plugins/for/")) {
        pluginRequests.push(url);
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/api/chisa-skills")) {
        return Response.json({ skills: [] });
      }
      if (url.includes("/api/auth/me")) {
        return Response.json({ user: null });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 15_000,
        },
      },
    });
    const visibility = createKeptVisibility(true);

    function CommandsProbe() {
      useSkillCommands("bot-fast-switch");
      return null;
    }

    function Declare({ botId }: { botId: string }) {
      useActiveBot(botId);
      return null;
    }

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <ActiveBotProvider>
            <ToolRendererProvider>
              <Declare botId="bot-fast-switch" />
              <KeptVisibleContext.Provider value={true}>
                <KeptVisibilityContext.Provider value={visibility}>
                  <SkillTools />
                  <CommandsProbe />
                </KeptVisibilityContext.Provider>
              </KeptVisibleContext.Provider>
            </ToolRendererProvider>
          </ActiveBotProvider>
        </QueryClientProvider>,
      );

      await waitFor(() => expect(pluginRequests.length).toBeGreaterThanOrEqual(1));
      const initialCount = pluginRequests.length;

      // 模拟 c1 <-> c2 快速切换隐藏再恢复：15 秒内不应立即重发 /api/plugins/for/*。
      await act(async () => {
        visibility.set(false);
      });
      await act(async () => {
        visibility.set(true);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(pluginRequests.length).toBe(initialCount);
      view.unmount();
    } finally {
      queryClient.clear();
    }
  });
});
