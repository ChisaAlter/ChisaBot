import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import type * as React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import {
  BrowserActivity,
  groupBrowserSteps,
} from "@/components/channels/browser-activity";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { settleReactWork } from "./settle-react-work";

// 待处理页里有 <Link>（去审批偏好），测试里没有路由：换成普通 <a>。
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));
const { PendingInbox } = await import("@/components/approvals/inbox");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const role: "user" | "admin" = "user";
let confirmations: unknown[] = [];
const sent: { path: string; method: string; body: unknown }[] = [];

const inbox = {
  enabled: false,
  requests: [
    {
      id: "request-1",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: {
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "thread",
        args: { element: "Pay now" },
        target: {},
        toolCallId: "pay-call",
        policy: {
          behaviour: "hand_off",
          source: "safety",
          reason:
            "Paying, purchasing or moving money is always done by the person.",
        },
      },
    },
  ],
  rules: [
    {
      id: "mine",
      botId: "*",
      toolRef: "mcp/gmail/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    },
  ],
  teamRules: [
    {
      id: "locked",
      botId: "*",
      toolRef: "mcp/drive/share",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    },
  ],
  preferences: { enabled: false, autoReview: false, hostCommands: "allow" },
  team: {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
  },
  hostCommands: "ask",
  questions: [],
};

beforeEach(() => {
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals") return Response.json(inbox);
      if (url.startsWith("/api/confirmations/requests")) return Response.json({ requests: confirmations });
      if (url.startsWith("/api/agents")) return Response.json({ agents: [{ id: "Shopper", name: "购物助手" }, { id: "agent_mail", name: "邮件助手" }] });
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PendingInbox />
    </QueryClientProvider>,
  );
}

test("待处理：交给你的一步只能标记自己完成或不要执行，不能替你允许", async () => {
  confirmations = [];
  const view = draw();
  await view.findByText("购物助手把这一步交给你亲自完成");
  expect(view.queryByRole("button", { name: "允许一次" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "我已自己完成" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("待处理：不再有上游的开关和规则表，只放等你点头的事和去审批偏好的入口", async () => {
  confirmations = [];
  const view = draw();
  await view.findByText("购物助手把这一步交给你亲自完成");
  expect(view.queryByText("自动审核")).toBeNull();
  expect(view.queryByText("更改前询问")).toBeNull();
  expect(view.queryByText("添加规则")).toBeNull();
  expect(view.getByText("哪些事先问我")).toBeTruthy();
});

test("待处理：聊天里没点的确认卡片带机器人名字，能直接确认", async () => {
  confirmations = [
    {
      id: "c1",
      agentId: "agent_mail",
      threadId: "t1",
      toolCallId: "x",
      category: "message",
      tool: "send_email",
      title: "给张三发邮件",
      target: "zhangsan@example.com",
      details: [],
      status: "pending",
      decidedVia: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  ];
  const view = draw();
  await view.findByText("给张三发邮件");
  expect(view.getByText(/邮件助手 · /)).toBeTruthy();
  expect(view.getByText("等你确认 · 1")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(sent.some((s) => s.path.includes("/api/confirmations/") && s.method === "POST")).toBe(true));
});

test("a pending change is drawn in the conversation where the action was, and decided there", async () => {
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <InlineApproval toolCallId="pay-call" fallback={<p>Clicked on page</p>} />
      <InlineApproval
        toolCallId="other-call"
        fallback={<p>Filled in field</p>}
      />
    </QueryClientProvider>,
  );
  await view.findByRole("region", { name: /^需要你确认：/ });
  expect(view.getByText(/付款、购买、转账要你亲自完成/)).toBeTruthy();
  // 动作的对象仍是这一行自己的事实，随标题下方单独一行给出。
  expect(view.getByText("shop.example")).toBeTruthy();
  // Another call's line is left to its own renderer.
  expect(view.getByText("Filled in field")).toBeTruthy();
  expect(view.queryByText("Clicked on page")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "我已自己完成" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("in the real transcript shape a waiting click is folded into browser activity, so its card is drawn beside the group", async () => {
  // What the channel transcript builds from the conversation: a navigate that finished and the
  // click the chat stopped on, unanswered, grouped into one browser-activity line.
  const items = groupBrowserSteps(
    toVisibleChatItems([
      { id: "u1", role: "user", content: "Order a pizza on httpbin" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "nav-call",
            type: "function",
            function: {
              name: "computer_navigate",
              arguments: '{"url":"https://httpbin.org/forms/post"}',
            },
          },
          {
            id: "pay-call",
            type: "function",
            function: {
              name: "computer_click",
              arguments: '{"ref":"e7","snapshotId":3}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "nav-call",
        content: '{"ok":true,"url":"https://httpbin.org/forms/post"}',
      },
    ] as never),
  );
  const group = items.find((item) => item.kind === "browser");
  if (group?.kind !== "browser") throw new Error("no browser group");
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* BrowserActivity mounts the waiting cards beside its folded line itself. */}
      <BrowserActivity group={group} active={false} />
    </QueryClientProvider>,
  );
  await view.findByRole("region", { name: /^需要你确认：/ });
  // Only the waiting call gets a card; the finished navigate does not.
  expect(
    view.getAllByRole("region", { name: /^需要你确认：/ }),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "我已自己完成" })).toBeTruthy();
});
