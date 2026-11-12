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
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LandingRedirect } from "@/components/agents/landing-redirect";
import { Composer } from "@/components/channels/composer/composer";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { resetBotsLocationMemory } from "@/lib/bots-location";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import {
  clearComposerInputs,
  dispatchComposerPrefill,
  dispatchComposerQuote,
} from "@/lib/chat/quote-event";
import { resetUiMemory } from "@/lib/chat/ui-memory";
import {
  createKeptVisibility,
  KeptVisibilityContext,
} from "@/lib/kept-visible";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "https://chat.test/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const close: (() => void)[] = [];
let channelsResponse: Promise<Response> | undefined;
let channelRequests = 0;
let holdDestination: Promise<void> | undefined;
let destinationEntered = false;

beforeEach(() => {
  resetUiMemory();
  resetBotsLocationMemory();
  clearComposerInputs();
  localStorage.clear();
  channelsResponse = undefined;
  channelRequests = 0;
  holdDestination = undefined;
  destinationEntered = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/channels") {
      channelRequests++;
      if (channelsResponse) return channelsResponse;
      return Response.json({ channels: [], nextCursor: null });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const dispose of close.splice(0)) dispose();
  globalThis.fetch = originalFetch;
  clearComposerInputs();
});

const bot: AgentProfile = {
  id: "bot-a",
  name: "Chisa",
  title: "",
  roleDescription: "",
  avatarSeed: "chisa",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: true,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const emptyChannel: ChannelSummary = {
  id: "empty-a",
  name: "Chisa",
  agentIds: [bot.id],
  threadId: "thread-a",
  active: true,
  lastMessageAt: null,
  lastMessage: null,
  lastMessageAgentId: null,
  summary: null,
  createdAt: "2026-11-11T00:00:00.000Z",
  pinned: false,
  lastReadAt: null,
};

function client(channels?: ChannelSummary[]) {
  const value = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  close.push(() => value.clear());
  value.setQueryData(agentKeys.list(), [bot]);
  value.setQueryData(authKeys.currentUser(), {
    id: "route-user",
    email: "route@example.test",
    role: "user",
    onboarding: null,
  });
  value.setQueryData(userPreferencesQueryOptions("route-user").queryKey, {
    mainBotId: bot.id,
    messageListEmphasis: "thread",
    brandAccent: "Chisa",
    brandRest: "Bot",
  });
  if (channels)
    value.setQueryData(channelKeys.list(), {
      pages: [{ channels, nextCursor: null }],
      pageParams: [""],
    });
  return value;
}

function ChannelComposer() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  return (
    <div data-testid="destination-composer">
      <Composer
        channelId={channelId}
        draftKey={channelId}
        onSubmit={() => {}}
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
type FileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const newRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as FileRouteWiring);
const landingRoute = createRoute({
  path: "/",
  getParentRoute: () => appRoute,
  component: LandingRedirect,
});
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: ChannelComposer,
  loader: async () => {
    destinationEntered = true;
    if (holdDestination) await holdDestination;
  },
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([landingRoute, newRoute, channelRoute]),
  ]),
]);

function mount(queryClient: QueryClient, retainedHidden = false) {
  // Production routing and input delivery both read window.location. Browser history keeps
  // those identities aligned; a memory router alone would leave the input on the old URL.
  const history = createBrowserHistory();
  close.push(() => history.destroy());
  const router = createRouter({ routeTree, history });
  const view = render(
    <QueryClientProvider client={queryClient}>
      {retainedHidden ? (
        <KeptVisibilityContext value={createKeptVisibility(false)}>
          <div data-testid="retained-hidden-composer" hidden>
            <Composer
              channelId="unrelated"
              draftKey="unrelated"
              onSubmit={() => {}}
            />
          </div>
        </KeptVisibilityContext>
      ) : null}
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

function queueAt(path: string) {
  window.history.replaceState({}, "", path);
  dispatchComposerPrefill("待交接的输入");
  dispatchComposerQuote({ text: "待交接的引用", source: "原会话" });
}

async function expectInput(view: ReturnType<typeof render>) {
  const editor = await view.findByRole("textbox", { name: "消息" });
  await waitFor(() => expect(editor.textContent).toBe("待交接的输入"));
  expect(view.getAllByText("待交接的引用")).toHaveLength(1);
}

test("首页的真实 LandingRedirect 把输入和引用交给选中的已有会话", async () => {
  queueAt("/");
  const { router, view } = mount(client([emptyChannel]), true);
  await expectInput(view);
  expect(router.state.location.pathname).toBe("/channel/empty-a");
  expect(window.location.pathname).toBe("/channel/empty-a");
  expect(view.getAllByRole("textbox", { name: "消息" })).toHaveLength(1);
  const hidden = view.getByTestId("retained-hidden-composer");
  expect(hidden.querySelector("[contenteditable]")?.textContent).toBe("");
  expect(
    hidden.querySelector('[data-testid="composer-reply-quote"]'),
  ).toBeNull();
});

test("没有指定机器人的新话题页经真实 LandingRedirect 交给新话题 Composer", async () => {
  queueAt("/channel/new");
  const { router, view } = mount(client([]));
  await expectInput(view);
  expect(router.state.location.pathname).toBe("/channel/new");
  expect(new URLSearchParams(window.location.search).get("agent")).toBe(bot.id);
  expect(view.queryByTestId("destination-composer")).toBeNull();
});

test("会话列表未返回及空会话重定向期间不挂旧 Composer，完成后只交接一次", async () => {
  let resolveChannels!: (response: Response) => void;
  channelsResponse = new Promise<Response>((resolve) => {
    resolveChannels = resolve;
  });
  let releaseDestination!: () => void;
  holdDestination = new Promise<void>((resolve) => {
    releaseDestination = resolve;
  });
  queueAt("/channel/new?agent=bot-a");
  const { router, view } = mount(client());
  try {
    await waitFor(() => expect(channelRequests).toBe(1));
    expect(view.queryByRole("textbox", { name: "消息" })).toBeNull();
    await act(async () => {
      resolveChannels(
        Response.json({ channels: [emptyChannel], nextCursor: null }),
      );
    });
    await waitFor(() => expect(destinationEntered).toBe(true));
    expect(view.queryByRole("textbox", { name: "消息" })).toBeNull();
    expect(view.queryByTestId("destination-composer")).toBeNull();
    await act(async () => releaseDestination());
    await expectInput(view);
    expect(router.state.location.pathname).toBe("/channel/empty-a");
    expect(view.getAllByRole("textbox", { name: "消息" })).toHaveLength(1);
  } finally {
    releaseDestination();
  }
});
