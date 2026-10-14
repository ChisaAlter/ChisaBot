import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import userEvent from "@testing-library/user-event";
import { BotDetailPane } from "@/components/bot-profile/detail-pane";

beforeAll(() => GlobalRegistrator.register({ url: "https://openbot.test/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;

const agent = {
  id: "bot-1",
  name: "千咲",
  title: "通用助手",
  roleDescription: "协助处理日常工作。",
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
  canDelete: true,
  mine: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch() {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/agents/bot-1") return Response.json({ agent });
      if (path === "/api/bots/bot-1/lifecycle") {
        return Response.json({
          lifecycle: {
            agentId: "bot-1",
            paused: false,
            pausedAt: null,
            notify: "all",
          },
        });
      }
      if (path === "/api/bots/bot-1/activity") {
        return Response.json({
          activity: { inProgress: [], scheduled: [], completed: [] },
        });
      }
      if (path === "/api/agents/bot-1/model") {
        return Response.json({
          agentId: "bot-1",
          model: "demo",
          overrideModel: null,
          defaultModel: "demo",
          available: true,
          canManage: true,
        });
      }
      if (path.startsWith("/api/models")) {
        return Response.json({ models: [], fetchedAt: 1 });
      }
      if (path === "/api/memory") return Response.json({ memories: [] });
      if (path === "/api/memory/sources") return Response.json({ sources: [] });
      if (path.startsWith("/api/devices"))
        return Response.json({ devices: [], approvals: [] });
      return Response.json({ error: `unexpected ${path}` }, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  installFetch();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <BotDetailPane agentId="bot-1" onOpenComputer={() => {}} />
    ),
  });
  const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/memory",
    component: () => null,
  });
  const devicesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/devices",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, memoryRoute, devicesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("bot details are a tabbed pane, with routines and runtime under 详情", async () => {
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await view.findByRole("heading", { name: "千咲" });
  expect(
    view.getByRole("tab", { name: "详情" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(view.getByRole("tab", { name: "资料库" })).toBeTruthy();
  expect(view.getByRole("tab", { name: "电脑" })).toBeTruthy();
  await view.findByRole("combobox", { name: "模型选择" });
  await view.findByRole("combobox", { name: "通知" });
  await view.findByText("请在聊天中设置例行任务。");
  await view.findByText("运行");
  expect(view.getByText("已暂停")).toBeTruthy();
  expect(view.getByText("重置")).toBeTruthy();
  expect(view.getByText("删除机器人")).toBeTruthy();

  await user.click(view.getByRole("tab", { name: "资料库" }));
  await view.findByText(
    "还没有这个机器人写下的资料。它形成的记忆会出现在这里。",
  );

  await user.click(view.getByRole("tab", { name: "电脑" }));
  await waitFor(() => {
    expect(view.getByText("还没有关联设备")).toBeTruthy();
  });
  expect(view.getByRole("button", { name: "查看计算机画面" })).toBeTruthy();
});
