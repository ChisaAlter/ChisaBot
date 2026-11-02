import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createdByLabel } from "@/lib/agents/created-by";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  botFactoryApprovalSpec,
  CreateBotCard,
  createdBotFrom,
  DisableBotCard,
  factorySucceeded,
  ManagedBotsCard,
  managedBotsFrom,
  UpdateBotCard,
} from "@/lib/copilot/bot-factory-tool";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { settleReactWork } from "./settle-react-work";

/**
 * 机器人建机器人的前端（PR3）：四个工具的锚点卡各态、/bots 的「由 X 创建」徽章、
 * 「待处理」审批卡的规格行。
 *
 * 卡片直接渲染导出的组件（和 batch2-features 渲染 BotExchangeCard 同一做法）；
 * /bots 走真实的 Route，挂在两个替身 pathless 父级下（agent-roster-error.test.tsx 的台架）。
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  }
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

/** 卡片里的「去和『X』聊天」是 Link：渲染它需要一个最小的 memory router。 */
async function renderCard(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => ui });
  const channelNew = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => null,
  });
  const channel = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$channelId",
    component: () => null,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([channelNew, channel]),
  });
  await act(async () => {
    await router.load();
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const CREATED_OK =
  `Created the Bot "数据蛙" (bot-9). It runs on this deployment as a private coworker ` +
  `of this person, and you and it may hand work to each other already (mutualHandoff: true). ` +
  `Its details: {"id":"bot-9","name":"数据蛙","title":"看数","mutualHandoff":true}`;

describe("bot factory tool renderers", () => {
  test("factorySucceeded reads each tool's own success wording, JSON-encoded or not", () => {
    // 还没回来 / 正在跑：不算失败，交给调用方看 status。
    expect(factorySucceeded("create_bot", undefined)).toBe(true);

    expect(factorySucceeded("create_bot", CREATED_OK)).toBe(true);
    // 过网络时是 JSON 编码的字符串，先解码再比开头。
    expect(factorySucceeded("create_bot", JSON.stringify(CREATED_OK))).toBe(
      true,
    );
    expect(
      factorySucceeded(
        "create_bot",
        "No Bot was created: Bots you create cannot create Bots of their own.",
      ),
    ).toBe(false);

    expect(
      factorySucceeded("update_bot", 'Updated the Bot "数据蛙" (bot-9).'),
    ).toBe(true);
    expect(
      factorySucceeded(
        "update_bot",
        "Nothing was changed: that is not a Bot you created.",
      ),
    ).toBe(false);
    // 资料改了、模型没改成：算做成了，那句话由卡片原样展示。
    expect(
      factorySucceeded(
        "update_bot",
        "The profile was updated, but the model was not: no such model",
      ),
    ).toBe(true);

    expect(
      factorySucceeded(
        "disable_bot",
        '"数据蛙" (bot-9) is paused: it will not take turns.',
      ),
    ).toBe(true);
    expect(
      factorySucceeded(
        "disable_bot",
        "Nothing was stopped: that is not a Bot you created.",
      ),
    ).toBe(false);

    // list_managed_bots 没有拒绝路径。
    expect(
      factorySucceeded("list_managed_bots", "You have not created any Bots."),
    ).toBe(true);
    // 读不懂的不当成功（除 list 外）。
    expect(factorySucceeded("create_bot", { ok: true })).toBe(false);
  });

  test("createdBotFrom and managedBotsFrom parse the result wording", () => {
    expect(createdBotFrom(CREATED_OK)).toEqual({ id: "bot-9", name: "数据蛙" });
    expect(createdBotFrom("No Bot was created: no.")).toBeNull();

    expect(
      managedBotsFrom(
        'Bots you created: [{"id":"bot-9","name":"数据蛙","title":"看数","paused":false,"createdAt":"2026-11-02"},{"id":"bot-8","name":"旧蛙","title":"x","paused":true,"createdAt":"2026-11-01"}]',
      ),
    ).toEqual([
      { id: "bot-9", name: "数据蛙", paused: false },
      { id: "bot-8", name: "旧蛙", paused: true },
    ]);
    expect(managedBotsFrom("You have not created any Bots.")).toEqual([]);
  });

  test("CreateBotCard: running, created with chat link, and refused", async () => {
    const running = await renderCard(
      <CreateBotCard name="数据蛙" result={undefined} running title="看数" />,
    );
    expect(
      running.getByTestId("bot-factory-card").getAttribute("data-state"),
    ).toBe("running");
    expect(running.getByText("创建中")).toBeTruthy();
    running.unmount();

    const done = await renderCard(
      <CreateBotCard
        knownBots={[{ id: "bot-9", name: "数据蛙" }]}
        model="qwen-max"
        name="数据蛙"
        result={CREATED_OK}
        roleDescription="你只回答数据问题。"
        running={false}
        title="看数"
      />,
    );
    const card = done.getByTestId("bot-factory-card");
    expect(card.getAttribute("data-state")).toBe("done");
    expect(card.textContent).toContain("创建了机器人「数据蛙」");
    expect(card.textContent).toContain("已创建");

    fireEvent.click(card.querySelector("button")!);
    const body = done.getByTestId("bot-factory-body");
    expect(body.textContent).toContain("你只回答数据问题。");
    expect(body.textContent).toContain("qwen-max");
    const link = done.getByText("去和「数据蛙」聊天 →");
    expect(link.getAttribute("href")).toBe("/channel/new?agent=bot-9");
    done.unmount();

    const refused = await renderCard(
      <CreateBotCard
        name="数据蛙"
        result="No Bot was created: this person already has the most Bot-made Bots this deployment allows (20)."
        running={false}
      />,
    );
    expect(
      refused.getByTestId("bot-factory-card").getAttribute("data-state"),
    ).toBe("refused");
    expect(refused.getByText("已阻止")).toBeTruthy();
    fireEvent.click(
      refused.getByTestId("bot-factory-card").querySelector("button")!,
    );
    expect(refused.getByTestId("bot-factory-body").textContent).toContain(
      "most Bot-made Bots",
    );
  });

  test("UpdateBotCard and DisableBotCard: running / done / refused", async () => {
    const updating = await renderCard(
      <UpdateBotCard
        fields={[{ label: "职责", value: "改稿" }]}
        id="bot-9"
        result='Updated the Bot "数据蛙" (bot-9).'
        running={false}
      />,
    );
    expect(
      updating.getByTestId("bot-factory-card").getAttribute("data-state"),
    ).toBe("done");
    expect(updating.getByText(/更新了机器人「数据蛙」/)).toBeTruthy();
    updating.unmount();

    const notManaged = await renderCard(
      <DisableBotCard
        id="bot-9"
        result="Nothing was stopped: that is not a Bot you created."
        running={false}
      />,
    );
    expect(
      notManaged.getByTestId("bot-factory-card").getAttribute("data-state"),
    ).toBe("refused");
    expect(notManaged.getByText(/没能停用机器人/)).toBeTruthy();
    notManaged.unmount();

    const paused = await renderCard(
      <DisableBotCard
        id="bot-9"
        result='"数据蛙" (bot-9) is paused: it will not take turns or handoffs until it is resumed.'
        running={false}
      />,
    );
    expect(
      paused.getByTestId("bot-factory-card").getAttribute("data-state"),
    ).toBe("done");
    expect(paused.getByText("已停用")).toBeTruthy();
    fireEvent.click(
      paused.getByTestId("bot-factory-card").querySelector("button")!,
    );
    expect(paused.getByTestId("bot-factory-body").textContent).toContain(
      "停用不是删除",
    );
  });

  test("ManagedBotsCard lists what it made, and says when there is nothing", async () => {
    const listed = await renderCard(
      <ManagedBotsCard
        result='Bots you created: [{"id":"bot-9","name":"数据蛙","paused":false},{"id":"bot-8","name":"旧蛙","paused":true}]'
        running={false}
      />,
    );
    const card = listed.getByTestId("bot-factory-card");
    fireEvent.click(card.querySelector("button")!);
    const body = listed.getByTestId("bot-factory-body");
    expect(body.textContent).toContain("数据蛙");
    expect(body.textContent).toContain("已暂停");
    listed.unmount();

    const empty = await renderCard(
      <ManagedBotsCard
        result="You have not created any Bots."
        running={false}
      />,
    );
    fireEvent.click(
      empty.getByTestId("bot-factory-card").querySelector("button")!,
    );
    expect(empty.getByTestId("bot-factory-body").textContent).toContain(
      "它还没有创建过机器人",
    );
  });
});

describe("approval card spec (bot/* tool refs)", () => {
  test("botFactoryApprovalSpec lays out name, duty, full prompt and model", () => {
    const spec = botFactoryApprovalSpec("bot/create_bot", {
      bot: "数据蛙",
      title: "看数",
      roleDescription: "你只回答数据问题，一次一段。",
      model: "qwen-max",
    });
    expect(spec?.verb).toBe("创建机器人");
    expect(spec?.rows).toEqual([
      { label: "名字", value: "数据蛙" },
      { label: "职责", value: "看数" },
      { label: "提示词", value: "你只回答数据问题，一次一段。" },
      { label: "模型", value: "qwen-max" },
    ]);

    // 没选模型：写「部署默认」，不是留空让人猜。
    expect(
      botFactoryApprovalSpec("bot/create_bot", {
        bot: "数据蛙",
        title: "看数",
        roleDescription: "x",
      })?.rows.at(-1),
    ).toEqual({ label: "模型", value: "部署默认" });

    expect(
      botFactoryApprovalSpec("bot/disable_bot", {
        bot: "bot-9",
        name: "数据蛙",
      })?.verb,
    ).toBe("停用机器人");
    expect(botFactoryApprovalSpec("bot/message_bot", { bot: "x" })).toBeNull();
    expect(botFactoryApprovalSpec("bot/create_bot", null)?.rows[0]?.value).toBe(
      "",
    );
  });
});

describe("/bots created-by badge", () => {
  test("createdByLabel resolves the creator's name from the roster", () => {
    const roster = [
      { id: "boss", name: "总管" },
      { id: "bot-9", name: "数据蛙" },
    ];
    expect(createdByLabel({ createdByAgentId: "boss" }, roster)).toBe(
      "由「总管」创建",
    );
    // 人建的没有徽章；创建者不在名册（已删 / 不可见）如实说，不露 id。
    expect(createdByLabel({}, roster)).toBeNull();
    expect(createdByLabel({ createdByAgentId: null }, roster)).toBeNull();
    expect(createdByLabel({ createdByAgentId: "gone" }, roster)).toBe(
      "由「另一个机器人」创建",
    );
  });
});

/* ── /bots 页面：真实 Route 下的徽章 ─────────────────────────────── */

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith("/api/agents")) {
        return Response.json({ agents: ROSTER });
      }
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

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

const ROSTER: AgentProfile[] = [
  agent({ id: "boss", name: "总管" }),
  agent({ id: "bot-9", name: "数据蛙", createdByAgentId: "boss" }),
  agent({ id: "hand-made", name: "手搓", createdByAgentId: null }),
];

test("/bots rows carry the「由『X』创建」badge resolved from the roster", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentKeys.list(false), ROSTER);

  /*
   * 挂的是 Route.options.component 而不是 .update() 过的 Route 单例：同进程里
   * agent-roster-error.test.tsx 也在用那个单例，对它 .update() 再恢复仍会踩它的台架。
   */
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
  const botsRoute = createRoute({
    component: BotsRoute.options.component!,
    getParentRoute: () => appRoute,
    path: "/bots",
  });
  const detailRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/bots/$agentId",
    component: () => null,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([botsRoute, detailRoute])]),
  ]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
    routeTree: tree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  await view.findByText("数据蛙");
  const badges = view.getAllByTestId("created-by-badge");
  // 只有 bot 建的那一行有徽章：人建的两行（总管、手搓）都没有。
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent).toBe("由「总管」创建");
});
