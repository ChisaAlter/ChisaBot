import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PersonalSourcesSection,
  personalSourcesKeys,
} from "@/components/settings/personal-sources";
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
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

async function mount() {
  const status: PersonalSourcesStatusView = {
    calendar: null,
    email: null,
    weatherCity: "上海",
  };
  const writes: EmailConnectionInput[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
  await user.click(view.getByTestId("connect-email-btn"));
  await waitFor(() =>
    expect(view.getByTestId("email-connect-dialog")).toBeTruthy(),
  );
  const fill = async (id: string, value: string) => {
    const field = view.getByTestId(id);
    if (field.tagName === "SELECT") {
      await user.selectOptions(field, value);
    } else {
      await user.clear(field);
      await user.type(field, value);
    }
  };
  await fill("email-address-input", "owner@custom.example");
  await fill("email-host-input", "imap.provider.example");
  await fill("email-password-input", "imap-fixture-value");
  return { view, writes, fill, user };
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
