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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarkActionPill } from "@/components/chat/bot-bubbles";
import { ToolRendererProvider, useRenderToolCall } from "@/lib/chat/renderers";
import { ConversationProvider } from "@/lib/conversations/conversation";
import { GithubConnectCard, GithubTool } from "@/lib/conversations/github-tool";
import { githubKeys } from "@/lib/github";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/settings/connected-accounts/$key";
import type { GithubConnectionView } from "../../shared/github";
import { settleReactWork } from "./settle-react-work";

/**
 * DESIGN.md §53：GitHub 连接卡在对话里就地连接——点了不跳设置页，原地弹设置里同一个令牌弹窗；
 * 令牌只发往服务器，不进对话。其它链接卡照常是站内链接。
 */
const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
let requestedPaths: string[] = [];

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
beforeEach(() => {
  requestedPaths = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      requestedPaths.push(path);
      if (path === "/api/github") {
        return NativeResponse.json({ connection: null });
      }
      if (path === "/api/github/connect" && init?.method === "POST") {
        return NativeResponse.json({ connection: CONNECTED_VIEW });
      }
      return new NativeResponse(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (children: React.ReactNode, client = makeClient()) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const CONNECTED_VIEW: GithubConnectionView = {
  login: "octocat",
  name: "The Octocat",
  avatarUrl: null,
  htmlUrl: "https://github.com/octocat",
  tokenKind: "fine-grained",
  scopes: [],
  hint: "1234",
  status: "ok",
  connectedAt: "2026-01-01T00:00:00.000Z",
  checkedAt: "2026-01-01T00:00:00.000Z",
};

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

test("GitHub 链接卡渲染成按钮，点开就地出令牌弹窗", async () => {
  const view = render(
    wrap(
      <HarkActionPill
        href="/settings/connected-accounts/github"
        label="连接 GitHub"
      />,
    ),
  );
  const pill = view.getByTestId("hark-action-pill");
  expect(pill.tagName).toBe("BUTTON");
  fireEvent.click(pill);
  await waitFor(() => {
    expect(document.querySelector("#github-token")).toBeTruthy();
    expect(document.body.textContent).toContain("连接 GitHub");
  });
});

test("其它链接卡照常是站内链接", () => {
  const view = render(
    wrap(
      <HarkActionPill
        href="/settings/connected-accounts"
        label="打开账号连接"
      />,
    ),
  );
  const pill = view.getByTestId("hark-action-pill");
  expect(pill.tagName).toBe("A");
  expect(pill.getAttribute("href")).toBe("/settings/connected-accounts");
});

test("github_connect 工具卡片：未连接态就地弹令牌弹窗，已连接后响应切换为已连接状态", async () => {
  const client = makeClient();
  client.setQueryData(githubKeys.all, null);

  function RenderConnectCall() {
    const draw = useRenderToolCall();
    return draw({
      toolCall: {
        id: "call-gh-connect",
        type: "function",
        function: {
          name: "github_connect",
          arguments: JSON.stringify({
            reason: "需要读取并推送代码到远程仓库",
            repo: "octocat/demo",
          }),
        },
      },
      toolMessage: {
        id: "msg-gh-connect",
        role: "tool",
        toolCallId: "call-gh-connect",
        content: "⟦github:connect⟧ 请点击卡片连接 GitHub。",
      },
    });
  }

  const view = render(
    wrap(
      <ToolRendererProvider>
        <GithubTool />
        <RenderConnectCall />
      </ToolRendererProvider>,
      client,
    ),
  );

  const card = await view.findByTestId("github-connect-card");
  expect(card.getAttribute("data-surface")).toBe("bubble");
  expect(card.getAttribute("data-state")).toBe("open");
  expect(card.textContent).toContain("连接 GitHub");
  expect(card.textContent).toContain("需要读取并推送代码到远程仓库");
  expect(card.textContent).toContain("octocat/demo");

  fireEvent.click(view.getByRole("button", { name: "连接 GitHub" }));
  await waitFor(() => {
    expect(document.querySelector("#github-token")).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "取消" }));
  await act(async () => {
    client.setQueryData(githubKeys.all, CONNECTED_VIEW);
  });

  await waitFor(() => {
    expect(card.getAttribute("data-state")).toBe("done");
    expect(card.textContent).toContain("已连接 @octocat");
    expect(view.getByRole("button", { name: "更换令牌" })).toBeTruthy();
  });
});

test("GithubConnectCard 收到 ⟦github:reconnect⟧ 时展示更换令牌状态", async () => {
  const client = makeClient();
  client.setQueryData(githubKeys.all, null);

  const view = render(
    wrap(
      <GithubConnectCard
        given={{}}
        result="⟦github:reconnect⟧ 令牌已失效，请重新连接。"
      />,
      client,
    ),
  );

  const card = view.getByTestId("github-connect-card");
  expect(card.getAttribute("data-state")).toBe("failed");
  expect(card.textContent).toContain("更换 GitHub 令牌");
  fireEvent.click(view.getByRole("button", { name: "更换令牌" }));
  await waitFor(() => {
    expect(document.querySelector("#github-token")).toBeTruthy();
    expect(document.body.textContent).toContain("更换 GitHub 令牌");
  });
});

test("/settings/connected-accounts/github 深链直接承接 GithubConnectionSection 且不依赖 plugins 查询", async () => {
  const snapshot = captureRouteState(ConnectedAccountRoute);
  const client = makeClient();
  type Updatable = { update: (options: unknown) => unknown };

  try {
    const rootRoute = createRootRoute({ component: Outlet });
    const authedRoute = createRoute({
      id: "/_authed",
      getParentRoute: () => rootRoute,
      component: Outlet,
    });
    const settingsRoute = createRoute({
      path: "/settings",
      getParentRoute: () => authedRoute,
      component: Outlet,
    });
    const indexRoute = createRoute({
      path: "/connected-accounts/",
      getParentRoute: () => settingsRoute,
      component: () => null,
    });
    const account = (ConnectedAccountRoute as unknown as Updatable).update({
      id: "/connected-accounts/$key",
      path: "/connected-accounts/$key",
      getParentRoute: () => settingsRoute,
    });
    const tree = rootRoute.addChildren([
      authedRoute.addChildren([
        settingsRoute.addChildren([indexRoute, account as never]),
      ]),
    ]);
    const router = createRouter({
      routeTree: tree,
      history: createMemoryHistory({
        initialEntries: ["/settings/connected-accounts/github"],
      }),
      context: { queryClient: client },
    });

    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );

    const section = await view.findByTestId("github-connection");
    expect(section).toBeTruthy();
    expect(view.queryByText("找不到这项连接")).toBeNull();
    expect(requestedPaths).toContain("/api/github");
    expect(requestedPaths).not.toContain("/api/plugins");
    expect(requestedPaths).not.toContain("/api/plugins/connections");

    fireEvent.click(view.getByRole("button", { name: "连接" }));
    await waitFor(() => {
      expect(document.querySelector("#github-token")).toBeTruthy();
    });
  } finally {
    restoreRouteState(ConnectedAccountRoute, snapshot);
  }
});

const SAMPLE_TOKEN = "github_pat_11SAMPLETOKENVALUE0000000000000";

async function submitGithubTokenInDialog(token: string) {
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>("#github-token");
    if (!el) throw new Error("missing #github-token");
    return el;
  });
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(input, token);
  const form = input.closest("form");
  if (!form) throw new Error("missing token form");
  const submitButton = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (!submitButton) throw new Error("missing submit button");
  await waitFor(() => {
    expect(submitButton.disabled).toBe(false);
  });
  await user.click(submitButton);
}

test("GithubConnectCard 提交令牌连接成功后自动发送续聊消息继续处理（且不含令牌）", async () => {
  const client = makeClient();
  client.setQueryData(githubKeys.all, null);
  const asked: string[] = [];

  const view = render(
    wrap(
      <ConversationProvider ask={(text) => asked.push(text)}>
        <GithubConnectCard
          given={{
            reason: "需要读取仓库并创建 PR",
            repo: "ChisaAlter/ChisaBot",
          }}
          result="⟦github:connect⟧ 请点击卡片连接 GitHub。"
        />
      </ConversationProvider>,
      client,
    ),
  );

  fireEvent.click(view.getByRole("button", { name: "连接 GitHub" }));
  await submitGithubTokenInDialog(SAMPLE_TOKEN);

  await waitFor(() => {
    expect(asked).toEqual([
      "已连接 GitHub 账号 @octocat，请继续处理 ChisaAlter/ChisaBot。",
    ]);
  });
  expect(asked[0]).not.toContain(SAMPLE_TOKEN);
  await waitFor(() => {
    expect(
      view.getByTestId("github-connect-card").getAttribute("data-state"),
    ).toBe("done");
  });
});

test("GithubConnectCard 在已连接状态下更换令牌成功后自动发送更新续聊消息", async () => {
  const client = makeClient();
  client.setQueryData(githubKeys.all, CONNECTED_VIEW);
  const asked: string[] = [];

  const view = render(
    wrap(
      <ConversationProvider ask={(text) => asked.push(text)}>
        <GithubConnectCard given={{}} />
      </ConversationProvider>,
      client,
    ),
  );

  fireEvent.click(view.getByRole("button", { name: "更换令牌" }));
  await submitGithubTokenInDialog(SAMPLE_TOKEN);

  await waitFor(() => {
    expect(asked).toEqual([
      "已更新 GitHub 令牌（@octocat），请继续刚才的 GitHub 操作。",
    ]);
  });
  expect(asked[0]).not.toContain(SAMPLE_TOKEN);
});

test("HarkActionPill（连接 GitHub 胶囊）在对话内提交令牌成功后自动发送续聊消息", async () => {
  const client = makeClient();
  client.setQueryData(githubKeys.all, null);
  const asked: string[] = [];

  const view = render(
    wrap(
      <ConversationProvider ask={(text) => asked.push(text)}>
        <HarkActionPill
          href="/settings/connected-accounts/github"
          label="连接 GitHub"
        />
      </ConversationProvider>,
      client,
    ),
  );

  fireEvent.click(view.getByTestId("hark-action-pill"));
  await submitGithubTokenInDialog(SAMPLE_TOKEN);

  await waitFor(() => {
    expect(asked).toEqual([
      "已连接 GitHub 账号 @octocat，请继续刚才的 GitHub 操作。",
    ]);
  });
  expect(asked[0]).not.toContain(SAMPLE_TOKEN);
});
