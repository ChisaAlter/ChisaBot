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
  createRouter,
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
import { useRef } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { setSidebarSearch } from "@/lib/sidebar-search";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";

/**
 * The conversation list's pagination, on the left column, as it is drawn today.
 *
 * THE LEFT COLUMN SHOWS BOTS, AND THE CONVERSATION LIST ONLY EXISTS WHILE SEARCHING. That is the
 * shape `app-sidebar.tsx` has now — the search box filters a list of conversations, and the two are
 * one card (DESIGN-v4) — so a test of the list has to open it the way a person does: by typing in
 * the search field or writing to the same store the field writes to. Rendering the sidebar and
 * expecting rows on a blank search describes a page that no longer exists, which is what every case
 * below used to do.
 *
 * AND THE LIST IS EXPANDED BY A PRESS, NOT BY SCROLLING, WHILE IT IS A FILTER. `ChannelPagination`
 * receives `searching` and deliberately does not observe the sentinel in that state — "let people
 * explicitly expand their search instead of downloading their entire history" — so the three list
 * cases drive the button, and the sentinel's own contract is pinned directly against the component
 * at the bottom of this file. That is also where the finding behind it is written down: the
 * scroll branch has no caller left in the product, because the only screen that draws this list
 * draws it while searching.
 */

// Keep the sidebar's live-update socket offline; these tests exercise HTTP pagination.
class OfflineWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 0;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  close() {}
  send() {}
}

class ScrollObserver implements IntersectionObserver {
  static active = new Set<ScrollObserver>();
  readonly root;
  readonly rootMargin;
  readonly thresholds = [0];
  private targets = new Set<Element>();
  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    ScrollObserver.active.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ScrollObserver.active.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(isIntersecting = true) {
    this.callback(
      [...this.targets].map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })),
      this,
    );
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
/**
 * What the next request is answered with, by URL.
 *
 * By URL rather than as one canned response because the list under test is not the only thing the
 * sidebar reads: a search also asks `/api/channels/search` for message-body hits, and a stub that
 * answered the same body to both would be answering a question nobody asked.
 */
let respond: (url: string) => Promise<Response>;
const requests: string[] = [];
const clients: QueryClient[] = [];

/** The search box's own read, which is not the conversation list's pagination. */
function answerSearch(url: string): Promise<Response> | null {
  return url.startsWith("/api/channels/search")
    ? Promise.resolve(Response.json({ hits: [] }))
    : null;
}

/** Everything asked of the channel LIST, in order — the cursor each page was requested at. */
function listRequests(): string[] {
  return requests.filter((url) => url.startsWith("/api/channels?cursor="));
}

/** The filters' own store: what the search box writes as somebody types. */
function searchFor(text: string) {
  act(() => setSidebarSearch(text));
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.IntersectionObserver = ScrollObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return respond(url);
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  requests.length = 0;
  respond = async (url) => {
    const searched = answerSearch(url);
    if (searched) return searched;
    throw new Error(`Unexpected request: ${url}`);
  };
});
afterEach(() => {
  cleanup();
  // Module state, like the query cache: left behind, it would open the next test's sidebar already
  // filtered.
  setSidebarSearch("");
  for (const client of clients) client.clear();
  clients.length = 0;
  expect(ScrollObserver.active.size).toBe(0);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function channel(id: string): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: id,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-09-15T00:00:00Z",
    pinned: false,
    lastReadAt: null,
  };
}

function preferences(emphasis: "agent" | "thread") {
  return {
    messageListEmphasis: emphasis,
    selfHostBannerDismissed: false,
    mainBotId: null,
    brandAccent: "Chisa",
    brandRest: "Bot",
  };
}

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(
    userPreferencesQueryOptions("user").queryKey,
    preferences("thread"),
  );
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  // The sidebar's attention list polls on its own schedule; this test counts channel requests only.
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      { channels: [channel("Recent conversation")], nextCursor: "older/page" },
    ],
    pageParams: [""],
  });
  const routeTree = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ThemeProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function activeObserver() {
  const observer = [...ScrollObserver.active][0];
  if (!observer) throw new Error("No active pagination observer");
  return observer;
}

test("message emphasis restyles the mounted rows from the account preferences cache", async () => {
  const view = renderSidebar();
  // The list is a filter now, so this is how a person opens it.
  searchFor("conversation");

  // The row's name, which is the line this preference decides the weight of.
  const name = await waitFor(() => view.getByTitle("Recent conversation"));
  expect(name.className).toContain("text-muted-foreground");
  expect(name.className).not.toContain("text-[0.9rem]");

  act(() =>
    clients[0]?.setQueryData(
      userPreferencesQueryOptions("user").queryKey,
      preferences("agent"),
    ),
  );

  /*
   * THE SAME NODE, RESTYLED — which is the property, not merely that a bolder name appeared. The row
   * is already mounted and `name` is that node, so a class that changed on it is the preference
   * reaching the row rather than a new row drawn over the old one.
   */
  await waitFor(() => expect(name.className).toContain("text-[0.9rem]"));
  expect(name.className).not.toContain("text-muted-foreground");
  expect(name.isConnected).toBe(true);
});

test("opening the history asks for the next cursor once and stops at the final page", async () => {
  /*
   * THE NEXT PAGE IS HELD, AND NOTHING ELSE IS. A resolver per request rather than one held
   * response for the whole stub: `Response` bodies are single-read, so a held one handed to every
   * caller in flight answers exactly one of them and fails the rest with "body already used" —
   * which, on a screen with a banner and an account card beside the list, is every other read.
   */
  const pending = Promise.withResolvers<Response>();
  respond = (url) => {
    const searched = answerSearch(url);
    if (searched) return searched;
    if (url.startsWith("/api/channels?cursor=")) return pending.promise;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  const view = renderSidebar();
  searchFor("conversation");
  expect(await view.findByText("Recent conversation")).toBeTruthy();

  const load = await view.findByRole("button", { name: "加载更早的会话" });
  /*
   * AND NOTHING SCROLLS A PAGE IN. While the list is a filter the sentinel is deliberately not
   * observing anything — a person narrowing their history is never handed the whole of it — so the
   * list grows on this press and on no other event.
   */
  await waitFor(() => expect(ScrollObserver.active.size).toBe(0));

  // Two presses before the first answer lands are one request: a page already in flight is not
  // asked for a second time. This is the property the sentinel was pinned for, on the press that
  // has replaced it.
  fireEvent.click(load);
  fireEvent.click(load);

  await view.findByRole("button", { name: "正在加载更早的会话…" });
  expect(listRequests()).toEqual(["/api/channels?cursor=older%2Fpage"]);

  pending.resolve(
    Response.json({
      channels: [channel("Older conversation")],
      nextCursor: null,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await view.findByText("Older conversation")).toBeTruthy();
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "加载更早的会话" }),
  ).toBeNull();
});

test("a failed page preserves the rows and waits for an explicit retry", async () => {
  respond = async (url) =>
    answerSearch(url) ??
    Response.json({ error: "Unavailable" }, { status: 503 });

  const view = renderSidebar();
  searchFor("conversation");
  await view.findByText("Recent conversation");

  fireEvent.click(view.getByRole("button", { name: "加载更早的会话" }));

  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "无法加载较旧的对话。",
  );
  // The page that did load is still there: a refusal on the next page is not a reason to lose this
  // one, and the row the person was reading survives it.
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(ScrollObserver.active.size).toBe(0);
  expect(listRequests()).toHaveLength(1);

  respond = async (url) =>
    answerSearch(url) ??
    Response.json({
      channels: [channel("Recovered conversation")],
      nextCursor: "last-page",
    });
  fireEvent.click(
    view.getByRole("button", { name: "重试加载更早对话" }),
  );
  expect(await view.findByText("Recovered conversation")).toBeTruthy();
  expect(listRequests()).toEqual([
    "/api/channels?cursor=older%2Fpage",
    "/api/channels?cursor=older%2Fpage",
  ]);

  // And the cursor moves on: the page after this one is asked for at the cursor this answer named.
  respond = async (url) =>
    answerSearch(url) ??
    Response.json({
      channels: [channel("Oldest conversation")],
      nextCursor: null,
    });
  fireEvent.click(view.getByRole("button", { name: "加载更早的会话" }));
  expect(await view.findByText("Oldest conversation")).toBeTruthy();
  expect(listRequests().at(-1)).toBe("/api/channels?cursor=last-page");
});

test("a search filters what is loaded and the history is opened by hand", async () => {
  const view = renderSidebar();
  // Nothing has been asked of the list yet: the first page is the one already in the cache.
  expect(listRequests()).toEqual([]);

  const user = userEvent.setup({ document: view.container.ownerDocument });
  const search = await view.findByRole("textbox", { name: "搜索会话" });
  await user.type(search, "Archived");

  expect(
    await view.findByText("没有会话匹配您的搜索"),
  ).toBeTruthy();
  // The filter says what it can see; it does not go looking through the history on its own.
  expect(listRequests()).toEqual([]);
  expect(ScrollObserver.active.size).toBe(0);

  respond = async (url) =>
    answerSearch(url) ??
    Response.json({
      channels: [channel("Archived conversation")],
      nextCursor: null,
    });
  fireEvent.click(view.getByRole("button", { name: "加载更早的会话" }));

  expect(await view.findByText("Archived conversation")).toBeTruthy();
  expect(view.queryByText("没有会话匹配您的搜索")).toBeNull();
  expect(listRequests()).toEqual(["/api/channels?cursor=older%2Fpage"]);

  /*
   * AND CLEARING THE BOX LEAVES THE FILTER — the rows go with it, because the left column goes back
   * to the Bot roster. The loaded page is still loaded, which the request count below proves; what
   * ends is the view that was showing it.
   */
  fireEvent.click(view.getByRole("button", { name: "清除搜索" }));
  await waitFor(() =>
    expect(view.queryByText("Archived conversation")).toBeNull(),
  );
  expect(listRequests()).toEqual(["/api/channels?cursor=older%2Fpage"]);
});

/**
 * The sentinel's own contract, driven directly.
 *
 * DRIVEN DIRECTLY BECAUSE NO SCREEN REACHES IT. `ChannelPagination` is drawn by the sidebar's
 * conversation list, and that list is only drawn while `searching` is true — the one state in which
 * this component deliberately creates no observer. So the branch below is currently unreachable from
 * the product; it is pinned here so that whoever gives it a calling screen again gets it with its
 * wiring intact, and so that the wiring is not quietly deleted as dead code.
 */
function PaginationProbe({
  fetchNextPage,
  hasNextPage,
  isFetching = false,
  isFetchNextPageError = false,
  searching = false,
}: {
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>;
  hasNextPage: boolean;
  isFetching?: boolean;
  isFetchNextPageError?: boolean;
  searching?: boolean;
}) {
  const scrollRoot = useRef<HTMLDivElement>(null);
  // 探针只关心「有没有人调了翻页」，不关心无限查询的返回类型；在边界上收窄一次，别把整条链路的类型都放开。
  const nextPage = fetchNextPage as unknown as React.ComponentProps<
    typeof ChannelPagination
  >["query"]["fetchNextPage"];
  return (
    <div ref={scrollRoot}>
      <ChannelPagination
        query={{
          fetchNextPage: nextPage,
          hasNextPage,
          isFetching,
          isFetchingNextPage: false,
          isFetchNextPageError,
        }}
        scrollRoot={scrollRoot}
        searching={searching}
      />
    </div>
  );
}

test("the sentinel asks for the next page on the list's own scroller", async () => {
  const asked: unknown[] = [];
  const fetchNextPage = (options?: { cancelRefetch?: boolean }) => {
    asked.push(options);
    return Promise.resolve();
  };

  const view = render(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage />,
  );

  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  /*
   * THE SCROLLER, HANDED DOWN RATHER THAN GUESSED. A sentinel watching `null` watches the viewport,
   * which in a sidebar is the wrong box entirely: the list scrolls inside its own card, and a row
   * two screens down in a document that never scrolls would never intersect.
   */
  expect(activeObserver().root).toBe(view.container.firstElementChild);

  await act(async () => {
    activeObserver().intersect();
  });
  expect(asked).toEqual([{ cancelRefetch: false }]);

  // A page already in flight is not asked for again by scrolling: the sentinel goes away while the
  // query is fetching, and comes back when it settles.
  view.rerender(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage isFetching />,
  );
  await waitFor(() => expect(ScrollObserver.active.size).toBe(0));
  expect(asked).toHaveLength(1);

  // The final page has nothing left to ask for, so it carries no press either.
  view.rerender(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage={false} />,
  );
  expect(view.queryByRole("button")).toBeNull();

  // And a filtered list observes nothing at all, which is why the sidebar's list never scrolls.
  view.rerender(<PaginationProbe fetchNextPage={fetchNextPage} hasNextPage searching />);
  expect(ScrollObserver.active.size).toBe(0);
  expect(asked).toHaveLength(1);
});
