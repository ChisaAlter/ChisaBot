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
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolRendererProvider, useRenderToolCall } from "@/lib/chat/renderers";
import { ConversationProvider } from "@/lib/conversations/conversation";
import {
  PersonalSourceConnectCard,
  PersonalSourcesTool,
} from "@/lib/conversations/personal-sources-tool";
import { personalSourcesKeys } from "@/lib/personal-sources/queries";
import type { PersonalSourcesStatusView } from "../../shared/personal-sources";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;

const EMPTY_STATUS: PersonalSourcesStatusView = {
  calendar: null,
  email: null,
  weatherCity: "上海",
  notifyWebhook: null,
  inboundWebhook: null,
  deliveries: [],
};

const CALENDAR_CONNECTED_STATUS: PersonalSourcesStatusView = {
  ...EMPTY_STATUS,
  calendar: {
    label: "工作日程",
    urlHint: "••••.ics",
    eventCount: 5,
    connectedAt: "2026-11-24T00:00:00.000Z",
    checkedAt: "2026-11-24T00:00:00.000Z",
    timeZone: "Asia/Shanghai",
  },
};

const NOTIFY_CONNECTED_STATUS: PersonalSourcesStatusView = {
  ...EMPTY_STATUS,
  notifyWebhook: {
    kind: "feishu",
    label: "飞书群提醒",
    urlHint: "••••hook",
    connectedAt: "2026-11-24T00:00:00.000Z",
  },
};

const EMAIL_CONNECTED_STATUS: PersonalSourcesStatusView = {
  ...EMPTY_STATUS,
  email: {
    email: "alice@qq.com",
    imapHost: "imap.qq.com",
    imapPort: 993,
    hint: "••••1234",
    unreadCount: 3,
    connectedAt: "2026-11-24T00:00:00.000Z",
    checkedAt: "2026-11-24T00:00:00.000Z",
  },
};

let serverStatus: PersonalSourcesStatusView = EMPTY_STATUS;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
beforeEach(() => {
  serverStatus = EMPTY_STATUS;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (path === "/api/personal-sources") {
        return NativeResponse.json(serverStatus);
      }
      if (path === "/api/personal-sources/calendar" && init?.method === "POST") {
        serverStatus = CALENDAR_CONNECTED_STATUS;
        return NativeResponse.json(serverStatus);
      }
      if (
        path === "/api/personal-sources/notify-webhook" &&
        init?.method === "POST"
      ) {
        serverStatus = NOTIFY_CONNECTED_STATUS;
        return NativeResponse.json(serverStatus);
      }
      if (path === "/api/personal-sources/email" && init?.method === "POST") {
        serverStatus = EMAIL_CONNECTED_STATUS;
        return NativeResponse.json(serverStatus);
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

const SAMPLE_ICS_URL =
  "https://calendar.example.com/private-secret-token/basic.ics";
const SAMPLE_WEBHOOK_URL =
  "https://open.feishu.cn/open-apis/bot/v2/hook/secret-webhook-id";

test("calendar_connect 工具卡片：连接日历成功后自动续聊且不含私密 ICS 链接", async () => {
  const client = makeClient();
  client.setQueryData(personalSourcesKeys.all, EMPTY_STATUS);
  const asked: string[] = [];

  function RenderCalendarCall() {
    const draw = useRenderToolCall();
    return draw({
      toolCall: {
        id: "call-cal-connect",
        type: "function",
        function: { name: "calendar_connect", arguments: "{}" },
      },
      toolMessage: {
        id: "msg-cal-connect",
        role: "tool",
        toolCallId: "call-cal-connect",
        content: "界面已推出「连接个人日历」安全连接卡片。",
      },
    });
  }

  const view = render(
    <QueryClientProvider client={client}>
      <ConversationProvider ask={(text) => asked.push(text)}>
        <ToolRendererProvider>
          <PersonalSourcesTool />
          <RenderCalendarCall />
        </ToolRendererProvider>
      </ConversationProvider>
    </QueryClientProvider>,
  );

  const card = await view.findByTestId("personal-source-connect-card");
  expect(card.getAttribute("data-source-kind")).toBe("calendar");
  expect(card.getAttribute("data-state")).toBe("open");

  fireEvent.click(view.getByRole("button", { name: "连接日历" }));
  const urlInput = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="calendar-url-input"]',
    );
    if (!el) throw new Error("missing calendar-url-input");
    return el;
  });
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(urlInput, SAMPLE_ICS_URL);
  const saveBtn = document.querySelector<HTMLButtonElement>(
    '[data-testid="calendar-save-btn"]',
  );
  if (!saveBtn) throw new Error("missing calendar-save-btn");
  await waitFor(() => expect(saveBtn.disabled).toBe(false));
  await user.click(saveBtn);

  await waitFor(() => {
    expect(asked).toEqual(["已连接个人日历（工作日程），请继续刚才的日程操作。"]);
  });
  expect(asked[0]).not.toContain(SAMPLE_ICS_URL);
  await waitFor(() => {
    expect(card.getAttribute("data-state")).toBe("done");
    expect(card.textContent).toContain("工作日程");
  });
});

test("notify_webhook_connect 卡片：绑定与更新随身通知后自动续聊且不含 Webhook 密钥", async () => {
  const client = makeClient();
  client.setQueryData(personalSourcesKeys.all, EMPTY_STATUS);
  const asked: string[] = [];

  const view = render(
    <QueryClientProvider client={client}>
      <ConversationProvider ask={(text) => asked.push(text)}>
        <PersonalSourceConnectCard kind="notify" />
      </ConversationProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(view.getByRole("button", { name: "绑定推送" }));
  const urlInput = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="notify-url-input"]',
    );
    if (!el) throw new Error("missing notify-url-input");
    return el;
  });
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(urlInput, SAMPLE_WEBHOOK_URL);
  const form = urlInput.closest("form");
  const submitBtn = form?.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (!submitBtn) throw new Error("missing submit button");
  await waitFor(() => expect(submitBtn.disabled).toBe(false));
  await user.click(submitBtn);

  await waitFor(() => {
    expect(asked).toEqual([
      "已绑定随身通知推送（飞书群提醒），请继续刚才的通知操作。",
    ]);
  });
  expect(asked[0]).not.toContain(SAMPLE_WEBHOOK_URL);

  await waitFor(() => {
    expect(view.getByRole("button", { name: "修改配置" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "修改配置" }));
  const urlInput2 = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="notify-url-input"]',
    );
    if (!el) throw new Error("missing notify-url-input on edit");
    return el;
  });
  await user.type(urlInput2, SAMPLE_WEBHOOK_URL);
  const submitBtn2 = urlInput2
    .closest("form")
    ?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submitBtn2) throw new Error("missing submit button on edit");
  await waitFor(() => expect(submitBtn2.disabled).toBe(false));
  await user.click(submitBtn2);

  await waitFor(() => {
    expect(asked).toEqual([
      "已绑定随身通知推送（飞书群提醒），请继续刚才的通知操作。",
      "已更新随身通知推送配置（飞书群提醒），请继续刚才的通知操作。",
    ]);
  });
});

test("email_connect 卡片：未连接时展示连接邮箱入口并响应状态变化", async () => {
  const client = makeClient();
  client.setQueryData(personalSourcesKeys.all, EMPTY_STATUS);
  const asked: string[] = [];

  const view = render(
    <QueryClientProvider client={client}>
      <ConversationProvider ask={(text) => asked.push(text)}>
        <PersonalSourceConnectCard kind="email" />
      </ConversationProvider>
    </QueryClientProvider>,
  );

  const card = view.getByTestId("personal-source-connect-card");
  expect(card.getAttribute("data-source-kind")).toBe("email");
  fireEvent.click(view.getByRole("button", { name: "连接邮箱" }));
  await waitFor(() => {
    expect(
      document.querySelector('[data-testid="email-connect-dialog"]'),
    ).toBeTruthy();
  });

  const user = userEvent.setup({ document: globalThis.document });
  await user.type(
    document.querySelector('[data-testid="email-address-input"]') as Element,
    "alice@qq.com",
  );
  await user.type(
    document.querySelector('[data-testid="email-password-input"]') as Element,
    "app-secret-pass",
  );
  const saveBtn = document.querySelector<HTMLButtonElement>(
    '[data-testid="email-save-btn"]',
  );
  if (!saveBtn) throw new Error("missing email-save-btn");
  await waitFor(() => expect(saveBtn.disabled).toBe(false));
  await user.click(saveBtn);

  await waitFor(() => {
    expect(asked).toEqual([
      "已连接电子邮箱（alice@qq.com），请继续刚才的邮件操作。",
    ]);
  });
  expect(asked[0]).not.toContain("app-secret-pass");
});
