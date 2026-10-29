import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
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
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import * as ChannelChatModule from "@/components/channels/channel-chat";
import { ChannelPage } from "@/components/channels/channel-page";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { type AgentChannel, type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import * as KeptVisibleModule from "@/lib/kept-visible";
import { settleReactWork } from "./settle-react-work";

/**
 * #403 审查 b：真的把 `ChannelPage` 挂在外壳那套 `KeepAliveStage` + 路由下面，数它和它下面的聊天
 * （`ChannelBody` → `ChannelChat`）重画了几次，而不是比源码字符串。
 *
 * - `ChannelPage` 每画一次调一次 `useMarkBotHidden`（模块命名空间上 spyOn 计数）；
 * - `ChannelChat` 换成一个计数的替身（同样是命名空间 spyOn，用完还原，不用 mock.module 隔离进程）；
 * - 外壳（`Shell`）跟着 pathname 重画，和 `AuthedShell` / `ChatStage` 一样；React Profiler 记外壳的提交次数，
 *   证明 pathname 变化时外壳确实重画了、是 memo 把聊天页挡住的。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/", width: 1440, height: 900 }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const CHANNEL = "channel_a";
const AGENT = "bot_a";
const channel: AgentChannel = {
  id: CHANNEL,
  name: "测试对话",
  agentIds: [AGENT],
  threadId: "thread_a",
  active: true,
  lastMessageAt: null,
};
const summary: ChannelSummary = {
  ...channel,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  pinned: false,
  lastReadAt: null,
};

function setup() {
  const counts = { page: 0, chat: 0, shellCommits: 0 };
  const pageSpy = spyOn(KeptVisibleModule, "useMarkBotHidden");
  pageSpy.mockImplementation(() => {
    counts.page++;
  });
  const chatSpy = spyOn(ChannelChatModule, "ChannelChat");
  chatSpy.mockImplementation((({ channel: c }: { channel: AgentChannel }) => {
    counts.chat++;
    return <div data-testid="chat">{c.id}</div>;
  }) as unknown as typeof ChannelChatModule.ChannelChat);

  // 请求一律挂起：数据不会在中途到达、引起和本测试无关的重画。
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(channelKeys.detail(CHANNEL), channel);
  queryClient.setQueryData(channelKeys.list(), { pages: [{ channels: [summary], nextCursor: null }], pageParams: [""] });

  type Addr = { channelId: string };
  function Shell() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const match = /^\/channel\/([^/]+)$/.exec(pathname);
    const address: Addr | null = match ? { channelId: match[1] as string } : null;
    return (
      <Profiler id="shell" onRender={() => counts.shellCommits++}>
        <KeepAliveStage
          address={address}
          renderKept={(kept, { visible, epoch }) => (
            <ChannelPage channelId={kept.channelId} epoch={epoch} key={kept.channelId} visible={visible} />
          )}
          same={(a, b) => a.channelId === b.channelId}
        >
          <Outlet />
        </KeepAliveStage>
      </Profiler>
    );
  }
  const rootRoute = createRootRoute({ component: Shell });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/channel/$channelId", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/settings/$section", component: () => <section>{"设置"}</section> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/channel/${CHANNEL}`] }) });
  const go = async (to: string) => {
    await act(async () => {
      await router.history.push(to);
      await new Promise((r) => setTimeout(r, 30));
    });
  };
  const restore = () => {
    pageSpy.mockRestore();
    chatSpy.mockRestore();
    globalThis.fetch = realFetch;
    queryClient.clear();
  };
  return { counts, router, queryClient, go, restore };
}

test("聊天页真渲染：设置里切分类（pathname 变了）时外壳重画，聊天页和聊天都不重画", async () => {
  const { counts, router, queryClient, go, restore } = setup();
  try {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(view.getByTestId("chat").textContent).toBe(CHANNEL);
    expect(counts.chat).toBe(1);

    // 打开设置：聊天藏起来（visible 变了，聊天页本身要画一次；聊天不画）。
    await go("/settings/general");
    expect(counts.chat).toBe(1);
    const page = counts.page;
    const shell = counts.shellCommits;

    // 设置里切分类：只有 pathname 变了。
    await go("/settings/models");
    await go("/settings/devices");
    expect(counts.shellCommits).toBeGreaterThan(shell);
    expect(counts.page).toBe(page);
    expect(counts.chat).toBe(1);
  } finally {
    restore();
  }
});

test("聊天页真渲染：关设置回聊天时聊天页只因 visible 画一次，下面的聊天（ChannelBody / ChannelChat）不重画", async () => {
  const { counts, router, queryClient, go, restore } = setup();
  try {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(counts.chat).toBe(1);
    await go("/settings/general");
    const pageBeforeClose = counts.page;

    // 关设置。
    await go(`/channel/${CHANNEL}`);
    // ChannelPage 的 props（visible / epoch）变了：画一次（React 的 setState-in-render 可能让它在同一次提交里调两遍，都算这一次）。
    expect(counts.page - pageBeforeClose).toBeGreaterThanOrEqual(1);
    expect(counts.page - pageBeforeClose).toBeLessThanOrEqual(2);
    expect(counts.chat).toBe(1);
    const pageAfterClose = counts.page;

    // 再开再关一轮，仍然不碰聊天。
    await go("/settings/general");
    await go(`/channel/${CHANNEL}`);
    expect(counts.chat).toBe(1);
    expect(counts.page - pageAfterClose).toBeLessThanOrEqual(4);
  } finally {
    restore();
  }
});