import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
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
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotProfilePage } from "@/components/bot-profile/profile";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * 机器人资料页（DESIGN.md §47）：页头三个主操作；资料 / 运行两张卡；没有任务就没有任务分区；
 * 「编辑」就地改、一次保存、一律私有；没有旧页面的空话和英文残留。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const AGENT: AgentProfile = {
  id: "bot-1",
  name: "写作助手",
  title: "帮我改稿",
  roleDescription: "你帮我修改文章，语气克制。",
  avatarSeed: "bot-1",
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
};

const originalFetch = global.fetch;
let writes: { request: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      if (path.endsWith("/lifecycle")) return Response.json({ lifecycle: { paused: false, notify: "all" }, paused: false, notify: "all" });
      if (path.endsWith("/activity")) return Response.json({ activity: { inProgress: [], scheduled: [], completed: [] }, inProgress: [], scheduled: [], completed: [] });
      if (path.endsWith("/model")) return Response.json({ agentId: AGENT.id, model: "m-1", overrideModel: null, defaultModel: "m-1", available: true, canManage: true });
      if (path.includes("/models")) return Response.json({ models: [{ id: "m-1", label: "模型一", provider: "p" }] });
      if (path === `/api/agents/${AGENT.id}` && method === "PATCH") return Response.json({ agent: { ...AGENT, ...body } });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function draw() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(agentKeys.detail(AGENT.id), AGENT);
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <BotProfilePage agent={AGENT} /> });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([page]),
  });
  await act(async () => {
    await router.load();
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("compact header with the three primary actions, two cards, no filler", async () => {
  const view = await draw();
  expect(await view.findByRole("heading", { name: AGENT.name })).toBeTruthy();
  expect(view.getByRole("button", { name: /开始聊天/ })).toBeTruthy();
  expect(view.getByRole("button", { name: /编辑/ })).toBeTruthy();
  expect(view.getByRole("button", { name: "删除机器人" })).toBeTruthy();
  expect(view.getByText("资料")).toBeTruthy();
  expect(view.getByText("运行")).toBeTruthy();
  const text = document.body.textContent ?? "";
  for (const gone of ["这个机器人为您做什么", "已暂停，轻点以恢复", "Nothing", "更新发到哪里", "更新去哪里", "暂无计划任务", "公开"]) {
    expect(text.includes(gone)).toBe(false);
  }
  // 没有任务 → 没有任务分区
  expect(view.queryByText("任务")).toBeNull();
});

test("编辑 edits in place and saves once, private", async () => {
  const view = await draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /编辑/ }));
  const name = view.getByDisplayValue(AGENT.name);
  await user.clear(name);
  await user.type(name, "改稿助手");
  await act(async () => {
    await user.click(view.getByRole("button", { name: /保存/ }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const patches = writes.filter((w) => w.request === `PATCH /api/agents/${AGENT.id}`);
  expect(patches.length).toBe(1);
  expect(patches[0]?.body).toMatchObject({
    name: "改稿助手",
    title: AGENT.title,
    roleDescription: AGENT.roleDescription,
    visibility: "private",
    endpoint: "",
  });
});
