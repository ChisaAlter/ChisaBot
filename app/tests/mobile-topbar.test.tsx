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
import { cleanup, render } from "@testing-library/react";
import { GlassTopBar, type ShellScope } from "@/components/layout/glass-topbar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import { countPendingActions } from "@/lib/pending-actions";
import type { ConfirmRequestView } from "../../shared/confirmations";
import { settleReactWork } from "./settle-react-work";

let originalMatchMedia: typeof window.matchMedia;
const activeQueryClients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  while (activeQueryClients.length > 0) {
    activeQueryClients.pop()?.clear();
  }
});

afterAll(async () => {
  await settleReactWork();
  window.matchMedia = originalMatchMedia;
  GlobalRegistrator.unregister();
});

function emptyInbox(): ApprovalInboxData {
  return {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  };
}

function makeConfirm(status: ConfirmRequestView["status"]): ConfirmRequestView {
  return {
    id: `confirm-${status}`,
    agentId: "bot-1",
    threadId: "thread-1",
    toolCallId: null,
    category: "message",
    tool: "send_message",
    title: "测试确认",
    target: null,
    details: [],
    status,
    decidedVia: null,
    createdAt: "2026-11-22T00:00:00Z",
    decidedAt: null,
    expiresAt: "2026-11-22T01:00:00Z",
  };
}

async function renderMobileTopBar({
  scope = "app",
  inbox = emptyInbox(),
  confirms = [],
}: {
  scope?: ShellScope;
  inbox?: ApprovalInboxData;
  confirms?: ConfirmRequestView[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  activeQueryClients.push(queryClient);
  queryClient.setQueryData(approvalInboxOptions().queryKey, inbox);
  queryClient.setQueryData(recentConfirmationsQueryOptions().queryKey, confirms);

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <GlassTopBar scope={scope} />
          <Outlet />
        </SidebarProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

test("手机顶栏不渲染右上角重复头像与账号触发器，仅保留抽屉按钮和搜索按钮", async () => {
  const view = await renderMobileTopBar({ scope: "app" });

  expect(view.getByRole("button", { name: "打开机器人列表" })).toBeTruthy();
  expect(view.getByRole("button", { name: "搜索会话" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "账号与设置" })).toBeNull();
  expect(view.container.querySelector(".hk-avatar-btn")).toBeNull();
  expect(view.container.querySelector(".glass-avatar")).toBeNull();
});

test("手机顶栏待处理红点随待处理数量挂到左上角抽屉按钮上", async () => {
  const emptyView = await renderMobileTopBar();
  const emptyDrawerBtn = emptyView.getByRole("button", {
    name: "打开机器人列表",
  });
  expect(emptyDrawerBtn.querySelector(".glass-avatar-dot")).toBeNull();
  cleanup();

  const pendingInbox = emptyInbox();
  pendingInbox.requests.push({
    id: "req-1",
    status: "pending",
    createdAt: "2026-11-22T00:00:00Z",
    action: {
      botId: "bot-1",
      toolRef: "bash",
      effect: "exec",
      scope: "host",
      threadId: "thread-1",
      args: {},
      target: null,
    },
  });
  const pendingApprovalView = await renderMobileTopBar({ inbox: pendingInbox });
  const approvalDrawerBtn = pendingApprovalView.getByRole("button", {
    name: "打开机器人列表",
  });
  expect(approvalDrawerBtn.querySelector(".glass-avatar-dot")).not.toBeNull();
  cleanup();

  const pendingConfirmView = await renderMobileTopBar({
    confirms: [makeConfirm("pending")],
  });
  const confirmDrawerBtn = pendingConfirmView.getByRole("button", {
    name: "打开机器人列表",
  });
  expect(confirmDrawerBtn.querySelector(".glass-avatar-dot")).not.toBeNull();
});

test("countPendingActions 正确汇总审批请求、待答问题、待确认卡片及空输入", () => {
  expect(countPendingActions(undefined, undefined)).toBe(0);
  expect(countPendingActions(null, null)).toBe(0);

  const count = countPendingActions(
    {
      requests: [
        { status: "pending" },
        { status: "approved" },
        { status: "pending" },
      ],
      questions: [{ id: "q1" }],
    },
    [{ status: "pending" }, { status: "denied" }, { status: "approved" }],
  );
  expect(count).toBe(4);
});
