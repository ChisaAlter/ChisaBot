import "./home-fallback-routing.fixture";

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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { pickLandingBot } from "@/lib/agents/landing";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";

/**
 * 第一条消息发给哪个机器人，以及发起失败时不替人做决定。
 *
 * REWRITTEN, NOT TRANSLATED. 这个文件原来驱动 `/` 上的输入框：那条路先 `POST /api/route` 让服务
 * 器挑机器人，503 时退回部署默认，409 时保留草稿并说明原因。「导航收敛」与 slimming P4b 之后
 * 首页和那次意图路由都不在了 —— `/` 只把人送进某个机器人的对话（`LandingRedirect` →
 * `pickLandingBot`），发给谁由地址里的 `?agent=` 决定，第一条消息发出时才建会话
 * （`POST /api/channels`）。原来守的那条不变量没变，也是下面每个用例守的东西：**消息必须发给
 * 选定的那个机器人；选不出来时说清楚，不偷偷换一个，也不吞掉草稿。**
 *
 * 覆盖点因此落在替代它的两处：选择顺序在 `pickLandingBot`（原来的「服务器默认优先于随便挑一个」），
 * 发送路径在 `/channel/new` 的第一条消息（原来的「决策成功优先于回退」「拒绝时保留草稿」）。
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`、`cleanup` 在
 * `afterEach`，查询从 `render()` 自己的返回值上做，和 `channel-new-error-state.test.tsx` 一样。
 * 那个文件把导出路由 `update` 之后不还原；这里捕获并在 `afterEach` 还原，因为 bun 把每个文件走
 * 进同一个进程，别的文件也有可能改这条路由的接线。
 */

beforeAll(() => GlobalRegistrator.register());

afterEach(() => cleanup());

afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: false,
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

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

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

beforeEach(() => {
  channelNewSnapshot = captureRouteState(pristineChannelNew);
});

afterEach(() => {
  restoreRouteState(ChannelNewRoute, channelNewSnapshot);
  global.fetch = originalFetch;
});

type Updatable = { update: (options: unknown) => unknown };

/** `/channel/new` 在测试自己的树里，挂在它自己那一层 `_authed` / `_app` 下面。 */
function renderChannelNew(queryClient: QueryClient, at: string) {
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
  const wired = (ChannelNewRoute as unknown as Updatable).update({
    id: "/channel/new",
    path: "/channel/new",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([wired as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** 输入框里现在写着什么：编辑区是 contenteditable，文字在它的内容里。 */
function draftOf(view: ReturnType<typeof render>): string {
  const editor = view.container.querySelector("[contenteditable]");
  return editor?.textContent ?? "";
}

/**
 * 往编辑区里写字，方式同 `composer-send-failure.test.tsx`：一次普通文本粘贴。
 *
 * PromptArea 在光标处插入、没有光标就放弃，所以先给一个落在末尾的 selection；没有文件的剪贴板
 * 会被 composer 的 paste 处理器当作文字（`shouldClaimPaste` 让文字赢）。
 */
function typeInto(view: ReturnType<typeof render>, words: string) {
  const editor = view.container.querySelector("[contenteditable]");
  if (!editor) throw new Error("composer editor is not on screen");
  (editor as HTMLElement).focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

const NAMED_BOT = agent({
  id: "own-public",
  mine: true,
  name: "Own Public",
  visibility: "public",
});

const OTHER_BOT = agent({
  id: "shared-public",
  mine: false,
  name: "Shared Public",
  visibility: "public",
});

test("with no Bot used yet the app opens the deployment's default Bot", () => {
  // 上一次用的是哪个（没有）→ 部署的「主机器人」→ 名册第一个。原来由服务器的路由接口回答，
  // 现在这个顺序就在这一处，所以在这一处断。
  expect(pickLandingBot([NAMED_BOT, OTHER_BOT].map((bot) => ({ id: bot.id })), null, "shared-public")).toBe("shared-public");
  // 部署连主机器人都没设：名册第一个，而不是空着不落地。
  expect(pickLandingBot([NAMED_BOT, OTHER_BOT].map((bot) => ({ id: bot.id })), null, null)).toBe("own-public");
});

test("the Bot used last keeps ahead of the deployment default", () => {
  const roster = [NAMED_BOT, OTHER_BOT].map((bot) => ({ id: bot.id }));
  // 一个真的选择优先于默认值。
  expect(pickLandingBot(roster, "own-public", "shared-public")).toBe("own-public");
  // 记着的那个已经不在名册里（删了 / 藏了）：退回默认，而不是拿着一个看不见的 id 去发消息。
  expect(pickLandingBot(roster, "gone-bot", "shared-public")).toBe("shared-public");
});

test("a refused start keeps the draft and never hands the message to a fallback Bot", async () => {
  const starts: string[][] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/channels") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { agentIds: string[] };
        starts.push(body.agentIds);
        return Response.json(
          { error: "这个名字匹配到不止一个同事。" },
          { status: 409 },
        );
      }
      // 会话列表要答，否则 `/channel/new` 一直停在 pending，输入框都不出现。
      if (url.startsWith("/api/channels"))
        return Response.json({ channels: [], nextCursor: null });
      // 其余读失败即可：清单来自缓存，这些都不参与本用例。
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );

  const view = renderChannelNew(
    queryClientWithAgents([NAMED_BOT, OTHER_BOT]),
    "/channel/new?agent=own-public",
  );

  const send = await waitFor(() => {
    const button = view.getByLabelText("发送消息") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    return button;
  });
  typeInto(view, "ask analyst");
  await waitFor(() => expect(send.disabled).toBe(false));

  await act(async () => {
    fireEvent.click(send);
  });

  // 服务器为什么拒绝，原话给到人，而不是换成一句「失败了」。
  expect((await view.findByRole("alert")).textContent).toContain(
    "这个名字匹配到不止一个同事。",
  );
  // 只发了那一次，收件人就是地址里那个 —— 没有被悄悄改发给别的机器人。
  expect(starts).toEqual([["own-public"]]);
  // 草稿还在输入框里，可以改完再发。
  await waitFor(() => expect(draftOf(view)).toContain("ask analyst"));
});
