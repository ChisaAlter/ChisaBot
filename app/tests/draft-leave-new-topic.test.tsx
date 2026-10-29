import "./channel-new-error-state.fixture";

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
  useRouterState,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { KEPT_TTL_MS, KeepAliveStage } from "@/components/layout/keep-alive";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  draftKeptTtl,
  holdDraftChannel,
  isDraftChannel,
  markDraftChannel,
  resetDraftChannelsForTest,
} from "@/lib/channels/draft-channel";
import { channelKeys } from "@/lib/channels/queries";
import { resetUiMemory, setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

/**
 * 回归（#399，真 Chrome 5/5）：草稿对话里写了一半的字，没发就去新话题页，字要在新话题页的输入框第一次画出来时
 * 就在——不是等草稿页卸载、回收以后才挪回草稿存储（那时输入框早已读过一次空值，要去设置再回来才出现）。
 *
 * 和外壳一样搭：`KeepAliveStage` 按当前地址留着草稿对话页（页上挂 `holdDraftChannel` + 真正的 Composer，草稿键是
 * 频道 id），路由那一层是真正的 `/channel/new` 页面；时长走 `draftKeptTtl`（去新话题页 → 0，随即卸载回收）。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let removed: string[];
beforeEach(() => {
  resetUiMemory();
  resetDraftChannelsForTest();
  removed = [];
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDraftChannelsForTest();
});

const DRAFT_ID = "channel_draft";
const TEXT = "写了一半的话";

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

/** 留着的草稿对话页：和 channel-page.tsx 一样挂着 `holdDraftChannel`，输入框按频道 id 记草稿。 */
function KeptDraftPage({ id }: { id: string }) {
  useEffect(
    () =>
      holdDraftChannel(id, async (channelId) => {
        removed.push(channelId);
      }),
    [id],
  );
  return (
    <div data-testid="draft-page">
      <Composer channelId={id} compact draftKey={id} onSubmit={async () => {}} />
    </div>
  );
}

/** 外壳的 `ChatStage`：地址是 `/channel/<id>` 时那页看得见，别的地址藏着、按 `draftKeptTtl` 定留多久。 */
function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const match = /^\/channel\/([^/]+)$/.exec(pathname);
  const id = match && match[1] !== "new" ? match[1] : undefined;
  return (
    <KeepAliveStage
      address={id ? { id } : null}
      renderKept={(kept) => <KeptDraftPage id={kept.id} />}
      same={(a, b) => a.id === b.id}
      ttlMs={(kept) => draftKeptTtl(kept.id, pathname, KEPT_TTL_MS)}
    >
      <Outlet />
    </KeepAliveStage>
  );
}

const rootRoute = createRootRoute({ component: Shell });
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
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
// 对话页这条路由自己什么都不画（外壳的留着那一层画），和真的一样。
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: () => null,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mountOnDraft() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    agent({ id: "general-assistant", name: "General Assistant" }),
    agent({ id: "other-bot", name: "Other Bot" }),
  ]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const history = createMemoryHistory({
    initialEntries: [`/channel/${DRAFT_ID}`],
  });
  const router = createRouter({ routeTree, history });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { history, view };
}

/** 路由那一层（新话题页）里的输入框。 */
function newTopicEditor(): HTMLElement | null {
  return document.querySelector(
    '[data-testid="route-layer"] [contenteditable]',
  );
}

test("离开草稿去新话题页：新话题页输入框第一次画出来就有字（不等回收）", async () => {
  markDraftChannel(DRAFT_ID, "new:general-assistant");
  setThreadUi(DRAFT_ID, { draft: [{ type: "text", text: TEXT }] });
  const { history, view } = mountOnDraft();
  await view.findByTestId("draft-page");
  expect(
    view.getByTestId("draft-page").querySelector("[contenteditable]")
      ?.textContent,
  ).toContain(TEXT);

  // 记下新话题页输入框第一次出现时的字，以及那一刻草稿对话回收了没有。
  let firstSeen: { text: string; released: boolean } | null = null;
  const observer = new MutationObserver(() => {
    const editor = newTopicEditor();
    if (!editor || firstSeen) return;
    firstSeen = {
      text: editor.textContent ?? "",
      released: removed.length > 0 || !isDraftChannel(DRAFT_ID),
    };
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  await act(async () => {
    history.push("/channel/new?agent=general-assistant&topic=new");
  });
  // 等藏着的草稿页卸载（0ms）+ 卸载收尾推迟的那一拍 + 带条件删除，远超过回收需要的时间。
  await act(async () => wait(50));
  await act(async () => wait(50));
  observer.disconnect();

  // 草稿对话照旧回收：页面卸载、删掉、不再记着。
  expect(view.queryByTestId("draft-page")).toBeNull();
  expect(removed).toEqual([DRAFT_ID]);
  expect(isDraftChannel(DRAFT_ID)).toBe(false);

  // 新话题页的输入框：第一次出现时就有字，那时草稿还没回收（字不是回收时才挪过来的）。
  expect(firstSeen).not.toBeNull();
  const seen = firstSeen as unknown as { text: string; released: boolean };
  expect(seen.text).toContain(TEXT);
  expect(seen.released).toBe(false);
  // 之后也还在，只有一份；两边的草稿存储：新话题页有，草稿对话那份清掉了。
  expect(newTopicEditor()?.textContent).toBe(TEXT);
  expect(threadUi("new:general-assistant")?.draft).toEqual([
    { type: "text", text: TEXT },
  ]);
  expect(threadUi(DRAFT_ID)?.draft).toBeUndefined();
});

test("去的是别的机器人的新话题页：字不挪到那边，回收时照旧回到原来的机器人", async () => {
  markDraftChannel(DRAFT_ID, "new:general-assistant");
  setThreadUi(DRAFT_ID, { draft: [{ type: "text", text: TEXT }] });
  const { history, view } = mountOnDraft();
  await view.findByTestId("draft-page");

  await act(async () => {
    history.push("/channel/new?agent=other-bot&topic=new");
  });
  await act(async () => wait(50));
  await act(async () => wait(50));

  expect(removed).toEqual([DRAFT_ID]);
  expect(newTopicEditor()?.textContent ?? "").not.toContain(TEXT);
  expect(threadUi("new:other-bot")?.draft).toBeUndefined();
  expect(threadUi("new:general-assistant")?.draft).toEqual([
    { type: "text", text: TEXT },
  ]);
});
