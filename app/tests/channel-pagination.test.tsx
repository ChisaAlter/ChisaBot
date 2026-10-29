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
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import { SidebarSearchField } from "@/components/layout/sidebar-search-field";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { setSidebarSearch } from "@/lib/sidebar-search";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { settleReactWork } from "./settle-react-work";

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
afterAll(async () => {
  await settleReactWork();
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
          {/* Hark 顶栏（第 2 步）：电脑上搜索框在顶栏右上角，结果仍画在左栏卡片里，两边共用一份搜索状态。 */}
          <SidebarSearchField variant="topbar" />
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
  const search = await view.findByRole("combobox", { name: "搜索会话" });
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

  // CB-106 r2：结果是 combobox 控制的 listbox，每条是带 aria-selected 的 option；↓ 之后 activedescendant 指向它。
  const listbox = view.getByRole("listbox", { name: "搜索结果" });
  expect(search.getAttribute("aria-controls")).toBe(listbox.id);
  const options = within(listbox).getAllByRole("option");
  for (const o of options)
    expect(o.getAttribute("aria-selected")).toBe("false");
  const option = options[0] as HTMLElement;
  fireEvent.keyDown(search, { key: "ArrowDown" });
  await waitFor(() =>
    expect(search.getAttribute("aria-activedescendant")).toBe(option.id),
  );
  expect(option.getAttribute("aria-selected")).toBe("true");
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
 * 直接测组件本身：翻页只有按钮这一条路。
 *
 * 以前这里还钉着一条 IntersectionObserver 的契约（不处于搜索态时滚动自动翻页）。导航收敛之后左栏
 * 只列机器人，会话列表**只在搜索态**渲染，而搜索态正是那条分支主动退出的情况——它没有任何调用点。
 * 2026-10-21 实机审查把那条死分支删掉了，这里改成钉住现在的契约：一次点击发一次请求、取数中按钮禁用、
 * 最后一页没有按钮、全程不创建任何 observer。
 */
function PaginationProbe({
  fetchNextPage,
  hasNextPage,
  isFetching = false,
  isFetchNextPageError = false,
}: {
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>;
  hasNextPage: boolean;
  isFetching?: boolean;
  isFetchNextPageError?: boolean;
}) {
  // 探针只关心「有没有人调了翻页」，不关心无限查询的返回类型；在边界上收窄一次，别把整条链路的类型都放开。
  const nextPage = fetchNextPage as unknown as React.ComponentProps<
    typeof ChannelPagination
  >["query"]["fetchNextPage"];
  return (
    <ChannelPagination
      query={{
        fetchNextPage: nextPage,
        hasNextPage,
        isFetching,
        isFetchingNextPage: false,
        isFetchNextPageError,
      }}
    />
  );
}

test("the button asks for the next page, once per press, and disappears on the last page", async () => {
  const asked: unknown[] = [];
  const fetchNextPage = (options?: { cancelRefetch?: boolean }) => {
    asked.push(options);
    return Promise.resolve();
  };

  const view = render(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage />,
  );

  // 2026-10-21：滚动自动翻页那条分支删掉了（会话列表只在搜索态渲染，它没有调用点）。
  // 翻页只能来自一次明确的点击，而且一次点击只发一次请求。
  expect(ScrollObserver.active.size).toBe(0);
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
  });
  expect(asked).toEqual([{ cancelRefetch: false }]);

  // A page already in flight is not asked for again: the button is disabled while fetching.
  view.rerender(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage isFetching />,
  );
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(true);

  // The final page has nothing left to ask for, so it carries no press either.
  view.rerender(
    <PaginationProbe fetchNextPage={fetchNextPage} hasNextPage={false} />,
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(ScrollObserver.active.size).toBe(0);
});

test("Esc while composing (IME) stays in the field: the drawer never hears it (CB-106 r2)", async () => {
  const view = renderSidebar();
  const search = await view.findByRole("combobox", { name: "搜索会话" });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(search, "Arch");
  const heard: string[] = [];
  const onDoc = (event: KeyboardEvent) => heard.push(event.key);
  document.addEventListener("keydown", onDoc);
  try {
    search.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    );
    const e229 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(e229, "keyCode", { get: () => 229 });
    search.dispatchEvent(e229);
    expect(heard).toEqual([]);
    expect((search as HTMLInputElement).value).toBe("Arch");
    // 不在组字：Esc 照旧清空。
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
  } finally {
    document.removeEventListener("keydown", onDoc);
  }
});
