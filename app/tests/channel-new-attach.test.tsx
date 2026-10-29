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
  useParams,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  isDraftChannel,
  resetDraftChannelsForTest,
} from "@/lib/channels/draft-channel";
import { channelKeys } from "@/lib/channels/queries";
import { resetUiMemory, setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

/**
 * 新话题页带图（A1）：在 `/channel/new` 上选文件 → 先建一段草稿对话（`draft: true`）→ 字和文件交给它 →
 * 替换地址跳到 `/channel/<id>`，那边的输入框第一帧就有字、文件自己重新上传到这段对话。
 *
 * `/channel/$channelId` 这里只挂真正的 Composer（频道 id 作草稿键，和 channel-chat.tsx 一样）：整页聊天要
 * CopilotKit 运行时，和这里要证明的「字和附件跟过去了」无关。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let requests: { method: string; path: string; body?: unknown }[];

const DRAFT = {
  id: "channel_draft",
  name: "General Assistant",
  agentIds: ["general-assistant"],
  threadId: "thread_draft",
  active: true,
  lastMessageAt: null,
};

/** 设了就让建草稿的 POST 等着它（测「请求还没回来」那一段）。 */
let holdCreate: Promise<void> | null;

beforeEach(() => {
  resetUiMemory();
  resetDraftChannelsForTest();
  requests = [];
  holdCreate = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof FormData)
      body = (init.body.get("file") as File | null)?.name;
    requests.push({ method, path, body });
    if (method === "POST" && path === "/api/channels") {
      if (holdCreate) await holdCreate;
      return Response.json({ channel: DRAFT }, { status: 201 });
    }
    if (method === "POST" && path === `/api/channels/${DRAFT.id}/attachments`)
      return Response.json(
        {
          id: "att-1",
          name: body,
          mimeType: "image/png",
          width: 640,
          height: 480,
        },
        { status: 201 },
      );
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

function DraftChannelPage() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  return (
    <div data-testid="channel-page">
      <Composer
        channelId={channelId}
        compact
        draftKey={channelId}
        onSubmit={async () => {}}
      />
    </div>
  );
}

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
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: DraftChannelPage,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

test("新话题页选了图：建草稿对话、跳过去，字和图片都跟着", async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    agent({ id: "general-assistant", name: "General Assistant" }),
  ]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  setThreadUi("new:general-assistant", {
    draft: [{ type: "text", text: "看这张图" }],
  });

  const history = createMemoryHistory({
    initialEntries: ["/channel/new?agent=general-assistant&topic=new"],
  });
  const router = createRouter({ routeTree, history });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  const input = (await view.findByLabelText("选择文件")) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(["png"], "shot.png", { type: "image/png" })] },
    });
  });

  // 到了草稿对话的页面：地址是替换的（后退不会回到一个已经交出去的新话题页）。
  await view.findByTestId("channel-page");
  expect(router.state.location.pathname).toBe(`/channel/${DRAFT.id}`);
  expect(history.length).toBe(1);

  // 建的是草稿对话。
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/channels",
    ),
  ).toEqual([
    {
      method: "POST",
      path: "/api/channels",
      body: { agentIds: ["general-assistant"], draft: true },
    },
  ]);
  expect(isDraftChannel(DRAFT.id)).toBe(true);

  // 字在第一帧就在新输入框里，新话题页那份清掉了。
  const editor = view.container.querySelector("[contenteditable]");
  expect(editor?.textContent).toContain("看这张图");
  expect(threadUi("new:general-assistant")?.draft).toBeUndefined();

  // 图片重新上传到这段对话，放在输入框上。
  await waitFor(() => {
    expect(view.queryByLabelText("移除 shot.png")).not.toBeNull();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/channels/${DRAFT.id}/attachments` &&
          request.body === "shot.png",
      ),
    ).toBe(true);
  });
  await waitFor(() =>
    expect(
      (view.getByLabelText("发送消息") as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  // 对话列表没有因为它刷新（它本来也不会出现）。
  expect(
    requests.some(
      (request) =>
        request.method === "GET" && request.path.startsWith("/api/channels?"),
    ),
  ).toBe(false);
});

function mountNewPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    agent({ id: "general-assistant", name: "General Assistant" }),
  ]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const history = createMemoryHistory({
    initialEntries: ["/channel/new?agent=general-assistant&topic=new"],
  });
  const router = createRouter({ routeTree, history });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

function channelCreates() {
  return requests.filter(
    (request) => request.method === "POST" && request.path === "/api/channels",
  );
}

async function pick(input: HTMLInputElement, ...files: File[]) {
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("建草稿的请求没回来时不能发送：回车不会另建一段对话", async () => {
  const gate = deferred();
  holdCreate = gate.promise;
  setThreadUi("new:general-assistant", {
    draft: [{ type: "text", text: "先写的字" }],
  });
  const { router, view } = mountNewPage();
  const input = (await view.findByLabelText("选择文件")) as HTMLInputElement;
  await pick(input, new File(["png"], "a.png", { type: "image/png" }));

  // 草稿还在建：发送键不可用，回车也不发。
  const send = view.getByLabelText("发送消息") as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(true));
  const editor = view.container.querySelector("[contenteditable]");
  if (!editor) throw new Error("editor missing");
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    fireEvent.click(send);
  });
  expect(channelCreates()).toHaveLength(1);

  await act(async () => gate.resolve());
  await view.findByTestId("channel-page");
  expect(router.state.location.pathname).toBe(`/channel/${DRAFT.id}`);
  // 只有那一段草稿，没有另一段带着字的普通对话。
  expect(channelCreates()).toEqual([
    {
      method: "POST",
      path: "/api/channels",
      body: { agentIds: ["general-assistant"], draft: true },
    },
  ]);
});

test("建草稿期间又加的文件不丢：跳过去后和第一批一起放上", async () => {
  const gate = deferred();
  holdCreate = gate.promise;
  const { view } = mountNewPage();
  const input = (await view.findByLabelText("选择文件")) as HTMLInputElement;
  await pick(input, new File(["png"], "first.png", { type: "image/png" }));
  await pick(input, new File(["png"], "second.png", { type: "image/png" }));
  // 第二批没有再建一段。
  expect(channelCreates()).toHaveLength(1);

  await act(async () => gate.resolve());
  await view.findByTestId("channel-page");
  await waitFor(() => {
    expect(view.queryByLabelText("移除 first.png")).not.toBeNull();
    expect(view.queryByLabelText("移除 second.png")).not.toBeNull();
  });
  const uploaded = requests
    .filter(
      (request) =>
        request.method === "POST" &&
        request.path === `/api/channels/${DRAFT.id}/attachments`,
    )
    .map((request) => request.body)
    .sort();
  expect(uploaded).toEqual(["first.png", "second.png"]);
  expect(channelCreates()).toHaveLength(1);
});

test("文件全被拒：不建草稿对话，留在新话题页说明原因", async () => {
  const { router, view } = mountNewPage();
  const input = (await view.findByLabelText("选择文件")) as HTMLInputElement;
  await pick(
    input,
    new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
  );
  await settleReactWork();

  expect(channelCreates()).toEqual([]);
  expect(isDraftChannel(DRAFT.id)).toBe(false);
  expect(router.state.location.pathname).toBe("/channel/new");
  expect(view.container.textContent).toContain("logo.svg");
});
