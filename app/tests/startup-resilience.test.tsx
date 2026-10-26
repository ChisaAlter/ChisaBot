import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createLazyRoute,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { useSidebar } from "@/components/ui/sidebar";
import { router as appRouter } from "@/router";
import type { RouterContext } from "@/router-context";
import { Route as RootRoute } from "@/routes/__root";
import { Route as AuthedRoute } from "@/routes/_authed";
import { settleReactWork } from "./settle-react-work";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://app.example.test/" }),
);
const originalFetch = globalThis.fetch;
let storageDescriptor: PropertyDescriptor | undefined;
beforeAll(() => {
  storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
});
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (storageDescriptor)
    Object.defineProperty(window, "localStorage", storageDescriptor);
  await settleReactWork();
});
afterAll(() => GlobalRegistrator.unregister());

function protectedPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRouteWithContext<RouterContext>()({
    component: RootRoute.options.component,
  });
  const authed = createRoute({
    getParentRoute: () => root,
    id: "_authed",
    beforeLoad: AuthedRoute.options.beforeLoad,
    component: Outlet,
  });
  const page = createRoute({
    getParentRoute: () => authed,
    path: "/admin/models",
    component: () => <p>模型设置已打开</p>,
  });
  const router = createRouter({
    defaultPendingMs: appRouter.options.defaultPendingMs,
    defaultPendingComponent: appRouter.options.defaultPendingComponent,
    defaultErrorComponent: appRouter.options.defaultErrorComponent,
    routeTree: root.addChildren([authed.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: ["/admin/models"] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function fakeFetch(read: () => Promise<Response>) {
  globalThis.fetch = Object.assign(read, {
    preconnect: originalFetch.preconnect,
  });
}

test("a protected page shows loading while the actual authentication guard waits", async () => {
  let resolveUser!: (response: Response) => void;
  fakeFetch(
    () =>
      new Promise((resolve) => {
        resolveUser = resolve;
      }),
  );
  const view = protectedPage();
  try {
    // 「正在加载」现在挂在 role=status 的 aria-label 上（里面画的是骨架，没有可见文字）。
    expect(
      (await view.findByRole("status", {}, { timeout: 1600 })).getAttribute(
        "aria-label",
      ),
    ).toContain("正在加载");
  } finally {
    await act(async () =>
      resolveUser(
        Response.json({
          user: {
            id: "admin",
            email: "admin@example.test",
            role: "admin",
            onboarding: null,
          },
        }),
      ),
    );
  }
  await view.findByText("模型设置已打开");
});

test("a failed authentication request gives a visible retry without exposing the exception", async () => {
  fakeFetch(async () =>
    Response.json({ error: "upstream-private-detail" }, { status: 503 }),
  );
  const view = protectedPage();
  expect((await view.findByRole("alert")).textContent).toContain("没能加载出来");
  expect(view.getByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("503");
  expect(view.container.textContent).not.toContain("upstream-private-detail");
});

test("a failed route chunk gives a visible retry instead of an empty application", async () => {
  const root = createRootRouteWithContext<RouterContext>()({
    component: RootRoute.options.component,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/admin/models",
  }).lazy(async () => {
    throw new Error("private-chunk-url");
  });
  const router = createRouter({
    defaultPendingMs: appRouter.options.defaultPendingMs,
    defaultPendingComponent: appRouter.options.defaultPendingComponent,
    defaultErrorComponent: appRouter.options.defaultErrorComponent,
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/admin/models"] }),
    context: { queryClient: new QueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  expect((await view.findByRole("alert")).textContent).toContain("没能加载出来");
  expect(view.getByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("private-chunk-url");
});

test("a pending lazy route replaces the static startup shell before the chunk resolves", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRouteWithContext<RouterContext>()({
    component: RootRoute.options.component,
  });
  const authed = createRoute({
    getParentRoute: () => root,
    id: "_authed",
    beforeLoad: AuthedRoute.options.beforeLoad,
    component: Outlet,
  });
  const loadedRoute = createLazyRoute("/_authed/admin/models")({
    component: () => <p>模型设置已打开</p>,
  });
  let resolveChunk!: () => void;
  let chunkStarted = false;
  const page = createRoute({
    getParentRoute: () => authed,
    path: "/admin/models",
  }).lazy(() => {
    chunkStarted = true;
    return new Promise((resolve) => {
      resolveChunk = () => resolve(loadedRoute);
    });
  });
  const router = createRouter({
    defaultPendingMs: appRouter.options.defaultPendingMs,
    defaultPendingComponent: appRouter.options.defaultPendingComponent,
    defaultErrorComponent: appRouter.options.defaultErrorComponent,
    routeTree: root.addChildren([authed.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: ["/admin/models"] }),
    context: { queryClient },
  });
  fakeFetch(async () =>
    Response.json({
      user: {
        id: "admin",
        email: "admin@example.test",
        role: "admin",
        onboarding: null,
      },
    }),
  );
  const container = document.createElement("div");
  container.innerHTML = '<div id="chisabot-startup">静态启动提示</div>';
  document.body.append(container);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
    { container },
  );
  try {
    expect(
      (await view.findByRole("status", {}, { timeout: 1600 })).getAttribute(
        "aria-label",
      ),
    ).toContain("正在加载");
    expect(chunkStarted).toBe(true);
    expect(container.querySelector("#chisabot-startup")).toBeNull();
    expect(view.queryByText("模型设置已打开")).toBeNull();
  } finally {
    await act(async () => resolveChunk());
  }
  await view.findByText("模型设置已打开");
  queryClient.clear();
});

function Preferences() {
  const theme = useTheme();
  const sidebar = useSidebar();
  return (
    <>
      <p>页面内容</p>
      <button type="button" onClick={() => theme.setDark(!theme.dark)}>
        切换主题
      </button>
      <button type="button" onClick={() => sidebar.toggleSidebar()}>
        切换侧栏
      </button>
    </>
  );
}

test("denied localStorage cannot take down the theme or sidebar shell", async () => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access denied", "SecurityError");
    },
  });
  const view = render(
    <ThemeProvider>
      <SidebarShell width="300px">
        <Preferences />
      </SidebarShell>
    </ThemeProvider>,
  );
  expect(view.getByText("页面内容")).toBeTruthy();
  await act(async () => view.getByRole("button", { name: "切换主题" }).click());
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await act(async () => view.getByRole("button", { name: "切换侧栏" }).click());
  expect(view.getByText("页面内容")).toBeTruthy();
});

test("a quota error saving preferences leaves the current page usable", async () => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Storage full", "QuotaExceededError");
      },
    },
  });
  const view = render(
    <ThemeProvider>
      <SidebarShell width="300px">
        <Preferences />
      </SidebarShell>
    </ThemeProvider>,
  );
  await act(async () => view.getByRole("button", { name: "切换主题" }).click());
  expect(view.getByText("页面内容")).toBeTruthy();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
