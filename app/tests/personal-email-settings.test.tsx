import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PersonalSourcesSection,
  personalSourcesKeys,
} from "@/components/settings/personal-sources";
import { ConfirmHost } from "@/components/ui/confirm";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import type {
  EmailConnectionInput,
  PersonalSourcesStatusView,
} from "../../shared/personal-sources";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
  resetToastsForTest();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

async function mount(
  options: {
    status?: PersonalSourcesStatusView;
    openEmail?: boolean;
    deleteRequest?: (path: string) => Promise<Response>;
  } = {},
) {
  const status: PersonalSourcesStatusView = options.status ?? {
    calendar: null,
    email: null,
    weatherCity: "上海",
  };
  const writes: EmailConnectionInput[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "DELETE" && options.deleteRequest)
        return options.deleteRequest(String(input));
      if (
        String(input) === "/api/personal-sources/email" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as EmailConnectionInput;
        writes.push(body);
        status.email = {
          email: body.email,
          imapHost: body.imapHost,
          imapPort: body.imapPort ?? 993,
          smtpHost: body.smtp?.host,
          smtpPort: body.smtp?.port,
          smtpUser: body.smtp?.user,
          ...(body.smtp ? { smtpCheckedAt: "2026-11-10T10:00:00Z" } : {}),
          hint: "已加密保存",
          unreadCount: 0,
          connectedAt: "2026-11-10T10:00:00Z",
          checkedAt: "2026-11-10T10:00:00Z",
        };
      }
      return NativeResponse.json(status);
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(personalSourcesKeys.all, status);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <PersonalSourcesSection />
        <ConfirmHost />
        <Toaster />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
  });
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const fill = async (id: string, value: string) => {
    const field = view.getByTestId(id);
    if (field.tagName === "SELECT") {
      await user.selectOptions(field, value);
    } else {
      await user.clear(field);
      await user.type(field, value);
    }
  };
  if (options.openEmail !== false) {
    await user.click(view.getByTestId("connect-email-btn"));
    await waitFor(() =>
      expect(view.getByTestId("email-connect-dialog")).toBeTruthy(),
    );
    await fill("email-address-input", "owner@custom.example");
    await fill("email-host-input", "imap.provider.example");
    await fill("email-password-input", "imap-fixture-value");
  }
  return { view, writes, fill, user, client, status };
}

test("IMAP-only form keeps SMTP optional and reports it as unverified", async () => {
  const { view, writes, user } = await mount();
  expect(view.queryByTestId("email-smtp-host-input")).toBeNull();
  await user.click(view.getByTestId("email-save-btn"));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.smtp).toBeUndefined();
  await waitFor(() => expect(view.getByText("SMTP 连接未验证")).toBeTruthy());
});

test("explicit SMTP form submits separate authentication and clears passwords after closing", async () => {
  const { view, writes, fill, user } = await mount();
  await user.click(view.getByTestId("email-configure-smtp"));
  await fill("email-smtp-host-input", "smtp.provider.example");
  await fill("email-smtp-port-input", "587");
  await fill("email-smtp-user-input", "provider-account");
  await fill("email-smtp-password-input", "smtp-fixture-value");
  await user.click(view.getByTestId("email-save-btn"));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.smtp).toEqual({
    host: "smtp.provider.example",
    port: 587,
    user: "provider-account",
    password: "smtp-fixture-value",
  });
  await waitFor(() => expect(view.getByText("SMTP 连接已验证")).toBeTruthy());
  await user.click(view.getByTestId("connect-email-btn"));
  await waitFor(() =>
    expect(
      (view.getByTestId("email-smtp-host-input") as HTMLInputElement).value,
    ).toBe("smtp.provider.example"),
  );
  expect(
    (view.getByTestId("email-password-input") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (view.getByTestId("email-smtp-password-input") as HTMLInputElement).value,
  ).toBe("");
});

const disconnectCases = [
  {
    kind: "calendar",
    label: "断开日历",
    connect: "connect-calendar-btn",
    path: "/api/personal-sources/calendar",
    confirmation: "断开日历？",
    field: "calendar",
  },
  {
    kind: "email",
    label: "断开收件箱",
    connect: "connect-email-btn",
    path: "/api/personal-sources/email",
    confirmation: "断开收件箱？",
    field: "email",
  },
  {
    kind: "notify",
    label: "断开通知推送",
    connect: "connect-notify-webhook-btn",
    path: "/api/personal-sources/notify-webhook",
    confirmation: "断开随身通知推送？",
    field: "notifyWebhook",
  },
] as const;

for (const item of disconnectCases) {
  test(`${item.kind} disconnect confirms, reports HTTP/network failure, and updates only on success`, async () => {
    const status: PersonalSourcesStatusView = {
      weatherCity: "上海",
      calendar: {
        label: "工作日历",
        urlHint: "calendar.example",
        eventCount: 2,
        connectedAt: "2026-11-11T00:00:00Z",
        checkedAt: "2026-11-11T00:00:00Z",
        timeZone: "Asia/Shanghai",
      },
      email: {
        email: "owner@example.test",
        imapHost: "imap.example.test",
        imapPort: 993,
        hint: "已加密保存",
        unreadCount: 1,
        connectedAt: "2026-11-11T00:00:00Z",
        checkedAt: "2026-11-11T00:00:00Z",
      },
      notifyWebhook: {
        label: "随身通知",
        kind: "custom",
        urlHint: "notify.example.test",
        connectedAt: "2026-11-11T00:00:00Z",
      },
    };
    const requests: string[] = [];
    let settle!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const { view, user, client } = await mount({
      status,
      openEmail: false,
      deleteRequest: async (path) => {
        requests.push(path);
        return new Promise<Response>((resolve, fail) => {
          settle = resolve;
          reject = fail;
        });
      },
    });
    const disconnect = view.getByLabelText(item.label, {
      exact: true,
    }) as HTMLButtonElement;
    const confirm = async () => {
      await user.click(disconnect);
      const dialog = await view.findByRole("dialog", {
        name: item.confirmation,
      });
      await user.click(within(dialog).getByRole("button", { name: "断开" }));
    };
    await user.click(disconnect);
    const cancelled = await view.findByRole("dialog", {
      name: item.confirmation,
    });
    await user.click(within(cancelled).getByRole("button", { name: "取消" }));
    expect(requests).toHaveLength(0);

    await confirm();
    await waitFor(() => expect(requests).toEqual([item.path]));
    const pending = disconnect;
    expect(pending.getAttribute("aria-label")).toBe("断开中…");
    expect(pending.disabled).toBe(true);
    expect((view.getByTestId(item.connect) as HTMLButtonElement).disabled).toBe(
      true,
    );
    if (item.kind === "notify")
      expect(
        (view.getByTestId("test-notify-webhook-btn") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    await user.click(pending);
    expect(requests).toHaveLength(1);
    await act(async () => {
      settle(
        NativeResponse.json({ error: "暂时无法撤销连接" }, { status: 503 }),
      );
    });
    await waitFor(() =>
      expect(
        Boolean(view.queryByText(`${item.label}失败：暂时无法撤销连接`)),
      ).toBe(true),
    );
    expect(
      client.getQueryData<PersonalSourcesStatusView>(personalSourcesKeys.all)?.[
        item.field
      ],
    ).toEqual(status[item.field]);
    await waitFor(() => expect(disconnect.disabled).toBe(false));

    // Error feedback temporarily changes the accessible name; its existing button remains retryable.
    await confirm();
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      reject(new Error("网络已断开"));
    });
    await waitFor(() =>
      expect(view.getByText(`${item.label}失败：网络已断开`)).toBeTruthy(),
    );
    expect(
      client.getQueryData<PersonalSourcesStatusView>(personalSourcesKeys.all)?.[
        item.field
      ],
    ).toEqual(status[item.field]);
    await waitFor(() => expect(disconnect.disabled).toBe(false));
    await confirm();
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () => {
      settle(NativeResponse.json({ ...status, [item.field]: null }));
    });
    await waitFor(() =>
      expect(
        client.getQueryData<PersonalSourcesStatusView>(
          personalSourcesKeys.all,
        )?.[item.field],
      ).toBeNull(),
    );
    expect(disconnect.isConnected).toBe(false);
    expect(requests).toEqual([item.path, item.path, item.path]);
  });
}
