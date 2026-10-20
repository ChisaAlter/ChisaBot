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
import { cleanup, render, waitFor } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * What the two person-facing entry screens say when the roster cannot be read.
 *
 * REWRITTEN, NOT TRANSLATED. This file used to drive the `/agents` roster (two columns: your agents
 * and the ones shared with you, plus Pinned and Hidden sections) and the old `/` home page. Commit
 * 5ade3780 (「导航收敛」) deleted both screens: `/agents` is now a redirect to `/bots`
 * (`routes/_authed/_app/agents/index.tsx`), `/` is `LandingRedirect`
 * (`routes/_authed/_app/index.tsx`) and the roster, pin and hide UI it asserted no longer exists.
 * No assertion could be translated into a passing one, so the coverage target moved to the screens
 * that replaced them: the Bot list at `/bots`, and the landing redirect that puts somebody straight
 * into a conversation. The invariant the old file existed for is unchanged and is what every test
 * below pins: a request that never came back must never be rendered as "you have nothing".
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and queries off `render()`'s own return, matching the other dialog tests for the
 * reason recorded there: bun walks every file into one process, and a document another file tore
 * down mid-run fails invisibly.
 *
 * Each test builds its own `QueryClient` with `retry: false` — the app's own client (see
 * `query-client.ts`) retries once, which is correct for production and would just slow this test
 * down for no assertion it needs. Both screens are exercised through their real, exported `Route`,
 * not a stand-in; see `renderBots` below for what that costs on `/bots`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // `readStoredPanelBot()` and the "last left mode" both read this; a key left by another test
  // would silently decide where `/` lands.
  localStorage.clear();
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends, and is
  // exactly what `client()`'s fallback message path exists for.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * Serves the URLs one of these screens reads; anything else is the 500 above.
 *
 * A handler rather than a map so a test can hold one response open forever (the pending case) or
 * answer differently per URL (`/api/me` succeeding while the roster fails is one real state).
 */
function installFetch(
  handler: (url: string) => Response | Promise<Response> | undefined,
): void {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return (await handler(url)) ?? new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  ) as unknown as typeof fetch;
}

const ME = { user: { id: "me", email: "me@example.test", role: "user" } };

/** `/bots` reads the roster and nothing else this test cares about; the rest of its reads may fail. */
function servingBots(agents: () => Response | Promise<Response>): void {
  installFetch((url) => (url.startsWith("/api/agents") ? agents() : undefined));
}

/**
 * `/` needs more than the roster to leave its loading state: the current user (whose preferences
 * `useMainBot` waits for) and the channel list. Only the roster is varied, because only it decides
 * between the error card and the empty state.
 */
function servingLanding(agents: () => Response | Promise<Response>): void {
  installFetch((url) => {
    if (url === "/api/me") return Response.json(ME);
    if (url.startsWith("/api/settings/preferences"))
      return Response.json({ preferences: { mainBotId: null } });
    if (url.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    if (url.startsWith("/api/agents")) return agents();
    return undefined;
  });
}

/** A client the failing query settles on in one attempt, so the test does not wait on a retry. */
function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * A client that already holds a successful `agents` list under the exact key
 * `agentListQueryOptions()` reads (`agentKeys.list(false)`, the default `hidden` param both screens
 * call it with), built on `failingQueryClient()` so the one refetch it triggers on mount settles
 * without a retry.
 *
 * Combined with the always-failing `global.fetch` this file's `beforeEach` installs, mounting a
 * screen against this client reproduces a failed BACKGROUND refetch: TanStack Query's default
 * `refetchOnMount` fires a fetch immediately because `staleTime` is unset (0), that fetch hits the
 * mocked 500, and `isError` becomes true while `data` — per query-core's error action, which
 * spreads `...state` and never touches `data` — stays exactly this seeded roster. No fake timers or
 * queryFn stand-in are needed: seeding the cache and letting the real, already-mocked fetch fail is
 * the whole scaffold.
 */
function staleQueryClient(agents: AgentProfile[]) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

/** A minimal but complete `AgentProfile`, overridable per test. */
function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
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
    ...overrides,
  };
}

/** Waits for the seeded query to have actually failed its background refetch, rather than trusting
 *  that the seeded data alone (which would render identically before any fetch ran) proves it. */
async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    );
  });
}

/**
 * `/bots`'s component makes no `useParams()` / `useSearch()` call of its own — only `useNavigate()`
 * and `Link`s to `"/bots/$agentId"` — so mounting its real `Route` under two decoy pathless parents
 * that reproduce the `/_authed/_app` join is enough; the real ancestors (a session check and the
 * shell) are not what this file is about. The detail route is registered because `Link` needs it
 * in the tree to build an href, and is never navigated to.
 *
 * The exported `Route` singleton is `.update()`d in place and its *entire own state* captured and
 * restored around each render, because `router.js`'s `buildRouteTree()` derives `_id`/`parentRoute`
 * off it and `.update()` merges rather than replaces. See `bot-app-grants-screen.test.tsx` and the
 * long note this scheme came from: a restore that merely replayed `options` through `.update()`
 * cannot delete the decoy keys a render adds.
 */
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

/** Captured once, at module scope, the instant this line runs — before any test body in this file.
 *  That timing, not a claim that the route is untouched, is what makes it the right fixed point:
 *  `routeTree.gen.ts` may already have initialised `BotsRoute` in this process, and what has to be
 *  handed back is whatever state this file found. `captureRouteState` is called again on the
 *  constant everywhere it is used, because `restoreRouteState` aliases `route.options` to the
 *  snapshot's clone and `.update()` mutates it in place. */
const pristineBotsRouteState = captureRouteState(BotsRoute);

let botsRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  botsRouteSnapshot = captureRouteState(pristineBotsRouteState);
});

afterEach(() => {
  restoreRouteState(BotsRoute, botsRouteSnapshot);
});

function renderBots(queryClient: QueryClient) {
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
  const detailRoute = createRoute({
    path: "/bots/$agentId",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const wired = (
    BotsRoute as unknown as {
      update: (options: unknown) => typeof BotsRoute;
    }
  ).update({
    id: "/bots/",
    path: "/bots",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([wired, detailRoute])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** `/`'s component calls no `Route.use*` hook, so mounting the real exported component as a memory
 *  router's root is enough. The two channel routes are registered so a landing target has somewhere
 *  to resolve to; the assertion reads the router's location rather than drawing either one. */
function renderLanding(queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: HomeRoute.options.component,
  });
  const channelNew = createRoute({
    path: "/channel/new",
    getParentRoute: () => rootRoute,
    component: () => null,
  });
  const channel = createRoute({
    path: "/channel/$channelId",
    getParentRoute: () => rootRoute,
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([channelNew, channel]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("a failed roster on /bots reports the failure, not an empty roster", async () => {
  servingBots(() => new Response(null, { status: 500 }));
  const view = renderBots(failingQueryClient());

  expect(await view.findByText("机器人列表暂时无法加载。")).toBeTruthy();

  // The whole point: a person with Bots must never be told they have none because the request that
  // would have proven otherwise never came back.
  expect(view.queryByText("你还没有机器人。")).toBeNull();
  expect(view.container.querySelectorAll('[data-slot="item"]')).toHaveLength(0);
});

test("a failed roster on / reports the failure and offers a way back", async () => {
  servingLanding(() => new Response(null, { status: 500 }));
  const { view } = renderLanding(failingQueryClient());

  expect(await view.findByText("机器人列表加载失败")).toBeTruthy();
  expect(view.getByText("请检查网络后重试。")).toBeTruthy();
  expect(view.getByRole("button", { name: "重试" })).toBeTruthy();

  // Not the empty state, which would claim the account owns no Bot at all.
  expect(view.queryByText("还没有可用的机器人")).toBeNull();
});

test("a pending roster on /bots holds a skeleton, not an empty state", async () => {
  // A fetch that never settles is `isPending` forever — the state the screen's loading arm renders.
  servingBots(() => new Promise<Response>(() => {}));

  const view = renderBots(failingQueryClient());

  const skeleton = await waitFor(() => {
    const found = view.getByRole("status", { name: "正在加载" });
    expect(found.querySelectorAll(".page-skeleton-row")).toHaveLength(3);
    return found;
  });
  expect(skeleton.getAttribute("aria-busy")).toBe("true");

  // A skeleton beside a premature empty or error sentence would be no fix at all: the point is
  // that loading reserves the section instead of claiming an answer it does not have yet.
  expect(view.queryByText("你还没有机器人。")).toBeNull();
  expect(view.queryByText("机器人列表暂时无法加载。")).toBeNull();
});

test("a failed REFETCH on /bots keeps the roster it already had, not the error", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  servingBots(() => new Response(null, { status: 500 }));
  const queryClient = staleQueryClient([mine, shared]);

  const view = renderBots(queryClient);
  await waitForFailedRefetch(queryClient);

  // A failed background refetch is an ordinary state, not an empty answer: the roster it already
  // had is still the truth, and replacing it with an error card would throw away a working list.
  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(await view.findByText("Shared Agent")).toBeTruthy();
  expect(view.queryByText("机器人列表暂时无法加载。")).toBeNull();
  expect(view.queryByText("你还没有机器人。")).toBeNull();
  expect(view.container.querySelectorAll('[data-slot="item"]')).toHaveLength(2);
});

test("an empty roster on /bots says you have none", async () => {
  servingBots(() => Response.json({ agents: [] }));
  const view = renderBots(failingQueryClient());

  expect(await view.findByText("你还没有机器人。")).toBeTruthy();
  expect(view.queryByText("机器人列表暂时无法加载。")).toBeNull();
});

test("an empty roster on / offers to create the first Bot, not an error", async () => {
  servingLanding(() => Response.json({ agents: [] }));
  const { view, router } = renderLanding(failingQueryClient());

  expect(await view.findByText("还没有可用的机器人")).toBeTruthy();
  expect(view.getByText("新建一个机器人，就可以开始聊天。")).toBeTruthy();
  expect(view.getByRole("button", { name: "新建机器人" })).toBeTruthy();
  expect(view.queryByText("机器人列表加载失败")).toBeNull();
  expect(router.state.location.pathname).toBe("/");
});

test("each Bot on /bots links to its profile and to its chat", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent" });
  servingBots(() => Response.json({ agents: [mine] }));
  const view = renderBots(failingQueryClient());

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(view.getByRole("heading", { level: 1, name: "机器人" })).toBeTruthy();

  // The two ways into a Bot, both carrying its name rather than a bare arrow.
  expect(
    view.getByLabelText("「Mine Agent」的资料").getAttribute("href"),
  ).toBe("/bots/mine-1");
  expect(
    view.getByRole("button", { name: "和「Mine Agent」聊天" }),
  ).toBeTruthy();
});

test("a roster of only hidden Bots gives / nothing to open, not an error", async () => {
  const tucked = agent({ id: "hidden-1", hidden: true });
  servingLanding(() => Response.json({ agents: [tucked] }));
  const { view, router } = renderLanding(failingQueryClient());

  // Hidden Bots are the person's own preference and are not where the app opens; that is an empty
  // landing, not a failed read, and must not be drawn as one.
  expect(await view.findByText("还没有可用的机器人")).toBeTruthy();
  expect(view.queryByText("机器人列表加载失败")).toBeNull();
  expect(router.state.location.pathname).toBe("/");
});

test("a loaded roster on / lands in that Bot's conversation", async () => {
  const mine = agent({ id: "bot-1", name: "Mine Agent" });
  servingLanding(() => Response.json({ agents: [mine] }));
  const { router } = renderLanding(failingQueryClient());

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/new"),
  );
  expect(
    (router.state.location.search as { agent?: string }).agent,
  ).toBe("bot-1");
});

test("a failed REFETCH on / still lands in the Bot it already had, not the error card", async () => {
  const mine = agent({ id: "bot-1", name: "Mine Agent" });
  servingLanding(() => new Response(null, { status: 500 }));
  const queryClient = staleQueryClient([mine]);

  const { view, router } = renderLanding(queryClient);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/new"),
  );
  await waitForFailedRefetch(queryClient);

  // The retained roster still supplies a target — the direct evidence that the landing screen is
  // not the "nothing to open" state its error card would describe.
  expect(
    (router.state.location.search as { agent?: string }).agent,
  ).toBe("bot-1");
  expect(view.queryByText("机器人列表加载失败")).toBeNull();
  expect(view.queryByText("还没有可用的机器人")).toBeNull();
});

test("while the roster is pending / claims neither an error nor an empty roster", async () => {
  servingLanding(() => new Promise<Response>(() => {}));
  const queryClient = failingQueryClient();
  const { view } = renderLanding(queryClient);

  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(false))).toBeDefined(),
  );
  expect(
    queryClient.getQueryState(agentKeys.list(false))?.status,
  ).toBe("pending");
  // Nothing is drawn while the roster loads: the chat appears in place, no flash of a page that is
  // about to leave, and no sentence asserting an answer that has not arrived.
  expect(view.container.innerHTML).toBe("");
});

/**
 * Proves the restore itself, rather than trusting the doc comment above it: it drives
 * `captureRouteState`/`restoreRouteState` directly, sandwiched around a corruption that reproduces
 * both halves of what `renderBots` does to the singleton — the `.update()` merge that plants
 * `id`/`path`/`getParentRoute`, and the `route.init()` call `createRouter()` makes for every route in
 * a tree it builds, which is what actually derives `_id`/`_fullPath`/`_to`/`parentRoute` from those
 * options.
 */
test("restoring after a decoy render leaves no trace on the exported Route singleton", () => {
  const before = captureRouteState(pristineBotsRouteState);

  const decoyParentRoute = { id: "/_app", fullPath: "/" };
  const route = BotsRoute as unknown as {
    update: (options: unknown) => unknown;
    init: (opts: { originalIndex: number }) => void;
  };
  route.update({
    id: "/bots/",
    path: "/bots",
    getParentRoute: () => decoyParentRoute,
  });
  route.init({ originalIndex: 0 });

  // Sanity check: the corruption actually took, so the restore below proves something.
  expect((BotsRoute as { parentRoute: unknown }).parentRoute).toBe(
    decoyParentRoute,
  );

  restoreRouteState(BotsRoute, before);

  expect(captureRouteState(BotsRoute)).toEqual(before);
});

/**
 * The test above compares one `captureRouteState` snapshot against another. That is only as
 * trustworthy as `captureRouteState`'s own `options` clone and `beforeEach`'s own re-clone off
 * `pristineBotsRouteState`. This anchors to two things the corruption cannot drag along: an
 * object-identity check against `pristineBotsRouteState.options` itself, and a second identity
 * check against a closure created fresh in this test — neither is derived from the "pristine"
 * constant, so neither can be corrupted in lockstep with it.
 */
test("the pristine snapshot's options is never the live route's, and a restore leaves no decoy behind — checked by identity, not against another snapshot", () => {
  const decoyParentRoute = { id: "/_app", fullPath: "/" };
  const decoyGetParentRoute = () => decoyParentRoute;
  const route = BotsRoute as unknown as {
    update: (options: unknown) => unknown;
    init: (opts: { originalIndex: number }) => void;
  };
  route.update({
    id: "/bots/",
    path: "/bots",
    getParentRoute: decoyGetParentRoute,
  });
  route.init({ originalIndex: 0 });

  restoreRouteState(BotsRoute, botsRouteSnapshot);

  const liveOptions = (
    BotsRoute as unknown as {
      options: { getParentRoute?: unknown };
    }
  ).options;

  // Anchor 1 — identity, not a snapshot.
  expect(pristineBotsRouteState.options).not.toBe(liveOptions);

  // Anchor 2 — identity against a value created fresh in this test.
  expect(liveOptions.getParentRoute).not.toBe(decoyGetParentRoute);
});
