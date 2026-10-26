import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { NotFoundRoute } from "@/components/not-found";

beforeAll(() => GlobalRegistrator.register());

afterEach(() => cleanup());

afterAll(() => GlobalRegistrator.unregister());

/**
 * 2026-10-20 审查：打错的地址（`/settings/models`）以前被 `Navigate` 回 `/`，而 `/` 按「上次停在哪」
 * 跳到别的页签——人只会看到应用突然换了页面。现在给真正的 404，地址栏不动。
 */
test("认不出的地址画 404，并写清是哪个地址", async () => {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
    notFoundComponent: NotFoundRoute,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>{"聊天"}</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div>{"设置"}</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);

  expect(view.getByText("页面不存在")).toBeTruthy();
  expect(view.getByText("/settings/models")).toBeTruthy();
  expect(view.getByRole("link", { name: "回到聊天" }).getAttribute("href")).toBe("/");
  expect(view.getByRole("link", { name: "打开设置" }).getAttribute("href")).toBe("/settings");
  // 没有被偷偷送去别处：地址还是那个打错的地址。
  expect(router.state.location.pathname).toBe("/settings/models");
});
