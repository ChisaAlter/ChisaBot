import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentQueryOptions } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * 审查 10-1：编辑时同时改名和头像、头像保存失败——以前资料卡的 key 跟着名字变，PATCH 一回来表单就被换掉，
 * 头像错误落在已卸载的实例上，看起来像保存成功。现在 key 是机器人 id：错误留在表单上，草稿还在，能「重试保存头像」。
 * 页面从查询缓存里读 agent（和真路由一样），PATCH 之后的失效会真的把新名字送进来。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const { BotProfilePage } = await import("@/components/bot-profile/profile");

const BASE: AgentProfile = {
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
let server: AgentProfile;
let avatarPutStatus = 500;
let writes: string[] = [];

beforeEach(() => {
  server = { ...BASE };
  avatarPutStatus = 500;
  writes = [];
  global.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push(`${method} ${path}`);
      if (path.endsWith("/lifecycle"))
        return Response.json({
          lifecycle: { paused: false, notify: "all" },
          paused: false,
          notify: "all",
        });
      if (path.endsWith("/activity"))
        return Response.json({
          activity: { inProgress: [], scheduled: [], completed: [] },
          inProgress: [],
          scheduled: [],
          completed: [],
        });
      if (path.endsWith("/model"))
        return Response.json({
          agentId: BASE.id,
          model: "m-1",
          overrideModel: null,
          defaultModel: "m-1",
          available: true,
          canManage: true,
        });
      if (path.includes("/models")) return Response.json({ models: [] });
      if (path === "/api/bot-avatars") return Response.json({ avatars: {} });
      if (path === `/api/bot-avatars/${BASE.id}` && method === "PUT") {
        if (avatarPutStatus !== 200)
          return Response.json(
            { error: "头像没能保存。" },
            { status: avatarPutStatus },
          );
        return Response.json({ avatar: body });
      }
      if (path === `/api/agents/${BASE.id}` && method === "PATCH") {
        server = { ...server, ...body };
        return Response.json({ agent: server });
      }
      if (path === `/api/agents/${BASE.id}`)
        return Response.json({ agent: server });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function LivePage() {
  const agent = useQuery(agentQueryOptions(BASE.id)).data ?? BASE;
  return <BotProfilePage agent={agent} />;
}

async function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentQueryOptions(BASE.id).queryKey, BASE);
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: LivePage,
  });
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

async function renameAndPickEmoji(view: Awaited<ReturnType<typeof draw>>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /编辑/ }));
  const form = view.getByTestId("bot-profile-form");
  const name = view.getByDisplayValue(BASE.name);
  await user.clear(name);
  await user.type(name, "改稿助手");
  await user.click(view.getByTestId("ava-open"));
  await user.click(await view.findByTestId("ava-tab-emoji"));
  await user.click(view.getByRole("radio", { name: "🐶" }));
  await act(async () => {
    await user.click(view.getByTestId("ava-done"));
  });
  await act(async () => {
    await user.click(view.getByTestId("bot-profile-submit"));
  });
  return { user, form };
}

test("rename + avatar failure: same form instance, error stays visible, retry only re-sends the avatar", async () => {
  const view = await draw();
  const { user, form } = await renameAndPickEmoji(view);
  const error = await view.findByTestId("bot-profile-error");
  expect(error.textContent).toContain("资料已保存");
  expect(error.textContent).toContain("头像没能保存");
  expect(error.getAttribute("role")).toBe("alert");
  // 名字已经存上了，页头换成了新名字——但表单没有被换掉（同一个 DOM 节点），草稿还在。
  await waitFor(() =>
    expect(view.getByRole("heading", { name: "改稿助手" })).toBeTruthy(),
  );
  expect(view.getByTestId("bot-profile-form")).toBe(form);
  expect((view.getByDisplayValue("改稿助手") as HTMLInputElement).value).toBe(
    "改稿助手",
  );
  expect(writes.filter((w) => w.startsWith("PATCH")).length).toBe(1);

  avatarPutStatus = 200;
  await act(async () => {
    await user.click(view.getByTestId("bot-profile-retry-avatar"));
  });
  await waitFor(() =>
    expect(view.queryByTestId("bot-profile-form")).toBeNull(),
  );
  // 重试不再 PATCH，只补头像。
  expect(writes.filter((w) => w.startsWith("PATCH")).length).toBe(1);
  expect(
    writes.filter((w) => w === `PUT /api/bot-avatars/${BASE.id}`).length,
  ).toBe(2);
});

test("fields point at their notes with aria-describedby (审查 10-13), and a polite status region exists (10-15)", async () => {
  const view = await draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /编辑/ }));
  for (const label of ["名称", /职责/, /它做什么/]) {
    const field = view.getByLabelText(label);
    const id = field.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)).toBeTruthy();
  }
  const status = view.getByTestId("bot-profile-status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  // 提交按钮的三段状态字对读屏是隐藏的，名字只有当前那一个。
  const submit = view.getByTestId("bot-profile-submit");
  const labels = submit.querySelector(".btn-labels");
  expect(labels?.getAttribute("aria-hidden")).toBe("true");
});
