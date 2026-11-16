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
  createRouter,
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
import type { ComponentType } from "react";
import { MyQuotaSection } from "@/components/settings/my-quota-section";
import {
  computeQuotaProgress,
  formatQuotaLimit,
  formatTokenCount,
  myQuotaQueryOptions,
  parseQuotaLimitInput,
  quotaKeys,
  type QuotaOverviewRow,
  type UserQuotaSummary,
  validateQuotaForm,
} from "@/lib/quotas";
import { Route as AccountsRoute } from "@/routes/_authed/admin/accounts";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  await act(async () => cleanup());
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;

test("quota formatting, progress calculation, and limit input parsing behave consistently", () => {
  expect(formatTokenCount(0)).toBe("0");
  expect(formatTokenCount(-12)).toBe("0");
  expect(formatTokenCount(Number.NaN)).toBe("0");
  expect(formatTokenCount(1234567)).toBe("1,234,567");

  expect(formatQuotaLimit(null)).toBe("不限");
  expect(formatQuotaLimit(undefined, " 次")).toBe("不限");
  expect(formatQuotaLimit(500, " 次")).toBe("500 次");

  expect(computeQuotaProgress(500, null)).toEqual({
    percent: null,
    tone: "unlimited",
    exceeded: false,
  });
  expect(computeQuotaProgress(50, 100)).toEqual({
    percent: 50,
    tone: "ok",
    exceeded: false,
  });
  expect(computeQuotaProgress(85, 100)).toEqual({
    percent: 85,
    tone: "warn",
    exceeded: false,
  });
  expect(computeQuotaProgress(120, 100)).toEqual({
    percent: 100,
    tone: "danger",
    exceeded: true,
  });

  expect(parseQuotaLimitInput("")).toEqual({ ok: true, value: null });
  expect(parseQuotaLimitInput("   ")).toEqual({ ok: true, value: null });
  expect(parseQuotaLimitInput("0")).toEqual({ ok: true, value: 0 });
  expect(parseQuotaLimitInput("250000")).toEqual({ ok: true, value: 250000 });
  expect(parseQuotaLimitInput("-1").ok).toBe(false);
  expect(parseQuotaLimitInput("12.5").ok).toBe(false);
  expect(parseQuotaLimitInput("abc").ok).toBe(false);
  expect(parseQuotaLimitInput("9007199254740993").ok).toBe(false);

  expect(
    validateQuotaForm({
      dailyTokenLimit: "",
      monthlyTokenLimit: "100000",
      dailyRequestLimit: "50",
      bypassAdmin: true,
    }),
  ).toEqual({
    ok: true,
    input: {
      dailyTokenLimit: null,
      monthlyTokenLimit: 100000,
      dailyRequestLimit: 50,
      bypassAdmin: true,
    },
  });
});

let adminRows: QuotaOverviewRow[];
let mySummary: UserQuotaSummary;
let putRequests: Array<{ path: string; body: Record<string, unknown> }>;
let myQuotaFetches: number;

beforeEach(() => {
  putRequests = [];
  myQuotaFetches = 0;
  adminRows = [
    {
      userId: "u-admin",
      displayName: "本地管理员",
      email: "admin@example.test",
      role: "admin",
      quota: {
        userId: "u-admin",
        dailyTokenLimit: null,
        monthlyTokenLimit: null,
        dailyRequestLimit: null,
        bypassAdmin: true,
        updatedBy: "u-admin",
        updatedAt: "2026-11-15T00:00:00.000Z",
      },
      usage: {
        dailyInputTokens: 1200,
        dailyOutputTokens: 800,
        dailyCacheReadTokens: 400,
        dailyTotalTokens: 2400,
        dailyRequests: 6,
        monthlyInputTokens: 20000,
        monthlyOutputTokens: 10000,
        monthlyCacheReadTokens: 5000,
        monthlyTotalTokens: 35000,
        monthlyRequests: 42,
        byModel: [
          {
            model: "gpt-5",
            dailyTokens: 2400,
            dailyRequests: 6,
            monthlyTokens: 35000,
            monthlyRequests: 42,
          },
        ],
      },
    },
    {
      userId: "u-member",
      displayName: "测试成员",
      email: "member@example.test",
      role: "user",
      quota: {
        userId: "u-member",
        dailyTokenLimit: 10000,
        monthlyTokenLimit: 100000,
        dailyRequestLimit: 20,
        bypassAdmin: false,
        updatedBy: "u-admin",
        updatedAt: "2026-11-15T00:00:00.000Z",
      },
      usage: {
        dailyInputTokens: 5000,
        dailyOutputTokens: 3500,
        dailyCacheReadTokens: 0,
        dailyTotalTokens: 8500,
        dailyRequests: 12,
        monthlyInputTokens: 50000,
        monthlyOutputTokens: 20000,
        monthlyCacheReadTokens: 0,
        monthlyTotalTokens: 70000,
        monthlyRequests: 88,
        byModel: [],
      },
    },
  ];
  mySummary = {
    userId: "u-member",
    isAdmin: false,
    bypassed: false,
    day: "2026-11-15",
    month: "2026-11",
    resetAtUtc: "2026-11-16T00:00:00.000Z",
    quota: adminRows[1]?.quota ?? null,
    usage: {
      dailyInputTokens: 5000,
      dailyOutputTokens: 3500,
      dailyCacheReadTokens: 500,
      dailyTotalTokens: 9000,
      dailyRequests: 12,
      monthlyInputTokens: 50000,
      monthlyOutputTokens: 20000,
      monthlyCacheReadTokens: 10000,
      monthlyTotalTokens: 80000,
      monthlyRequests: 88,
      byModel: [
        {
          model: "gpt-5",
          dailyTokens: 6000,
          dailyRequests: 8,
          monthlyTokens: 60000,
          monthlyRequests: 60,
        },
        {
          model: "claude-sonnet",
          dailyTokens: 3000,
          dailyRequests: 4,
          monthlyTokens: 20000,
          monthlyRequests: 28,
        },
      ],
    },
  };
});

function installQuotaFetch(options?: { multiAccountAvailable?: boolean }) {
  const multiAccountAvailable = options?.multiAccountAvailable ?? false;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/auth/admin/accounts" && method === "GET") {
        return multiAccountAvailable
          ? Response.json({
              ok: true,
              me: "u-admin",
              invitesEnabled: false,
              accounts: [],
              invites: [],
            })
          : Response.json({ multiAccount: false }, { status: 404 });
      }
      if (path === "/api/admin/quotas" && method === "GET") {
        return Response.json({ quotas: adminRows });
      }
      if (path === "/api/me/quota" && method === "GET") {
        myQuotaFetches += 1;
        return Response.json({ summary: mySummary });
      }
      if (path.startsWith("/api/admin/quotas/") && method === "PUT") {
        const userId = decodeURIComponent(
          path.slice("/api/admin/quotas/".length),
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        putRequests.push({ path, body });
        const nextQuota = {
          userId,
          dailyTokenLimit: (body.dailyTokenLimit as number | null) ?? null,
          monthlyTokenLimit: (body.monthlyTokenLimit as number | null) ?? null,
          dailyRequestLimit: (body.dailyRequestLimit as number | null) ?? null,
          bypassAdmin: Boolean(body.bypassAdmin),
          updatedBy: "u-admin",
          updatedAt: "2026-11-15T12:00:00.000Z",
        };
        adminRows = adminRows.map((row) =>
          row.userId === userId ? { ...row, quota: nextQuota } : row,
        );
        if (mySummary.userId === userId) {
          mySummary = { ...mySummary, quota: nextQuota };
        }
        return Response.json({ quota: nextQuota });
      }
      throw new Error(`Unexpected quota test request: ${method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

function renderAccountsPage(queryClient: QueryClient) {
  const Accounts = AccountsRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/admin/accounts"] }),
    routeTree: createRootRoute({ component: () => <Accounts /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("admin accounts page keeps quota panel usable in single-user mode and updates quota + invalidates queries", async () => {
  installQuotaFetch({ multiAccountAvailable: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = renderAccountsPage(queryClient);

  await view.findByText(/登录网关还没开启多账号/);
  await view.findByText("Token 与请求配额管理");
  await view.findByText("本地管理员");
  await view.findByText("测试成员");
  expect(view.container.textContent).toContain("管理员豁免生效");
  expect(view.container.textContent).toContain("8,500 / 10,000");

  // Pre-warm personal quota query so we can assert mutation invalidates both admin & me caches.
  await queryClient.fetchQuery(myQuotaQueryOptions());
  expect(myQuotaFetches).toBe(1);

  const configButtons = view.getAllByRole("button", { name: "配置配额" });
  expect(configButtons).toHaveLength(2);
  fireEvent.click(configButtons[1] as HTMLButtonElement);

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const dailyInput = await view.findByLabelText("每日 Token 上限");
  const monthlyInput = view.getByLabelText("每月 Token 上限");
  const requestInput = view.getByLabelText("每日请求次数上限");
  const bypassSwitch = view.getByRole("switch", { name: "允许管理员豁免" });

  await user.clear(dailyInput);
  await user.type(dailyInput, "-5");
  expect((dailyInput as HTMLInputElement).value).toBe("-5");
  await user.click(view.getByRole("button", { name: "保存配额" }));
  await view.findByText(/请输入大于或等于 0 的整数/);
  expect(putRequests).toHaveLength(0);

  await user.tripleClick(dailyInput);
  await user.keyboard("{Backspace}");
  await user.tripleClick(monthlyInput);
  await user.keyboard("{Backspace}500000");
  await user.tripleClick(requestInput);
  await user.keyboard("{Backspace}200");
  await user.click(bypassSwitch);
  expect((dailyInput as HTMLInputElement).value).toBe("");
  expect((monthlyInput as HTMLInputElement).value).toBe("500000");
  expect((requestInput as HTMLInputElement).value).toBe("200");
  expect(bypassSwitch.getAttribute("aria-checked")).toBe("true");
  await user.click(view.getByRole("button", { name: "保存配额" }));

  await waitFor(() => expect(putRequests).toHaveLength(1));
  expect(putRequests[0]).toEqual({
    path: "/api/admin/quotas/u-member",
    body: {
      dailyTokenLimit: null,
      monthlyTokenLimit: 500000,
      dailyRequestLimit: 200,
      bypassAdmin: true,
    },
  });

  await waitFor(() =>
    expect(view.container.textContent).toContain("8,500 / 不限"),
  );
  expect(view.container.textContent).toContain("70,000 / 500,000");
  expect(view.container.textContent).toContain("12 次 / 200 次");
  expect(queryClient.getQueryState(quotaKeys.me())?.isInvalidated).toBe(true);
});

test("personal quota section displays limits, unlimited state, admin bypass, and byModel breakdown", async () => {
  installQuotaFetch();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MyQuotaSection />
    </QueryClientProvider>,
  );

  await view.findByText("我的模型配额与用量");
  await view.findByText("按配额限制");
  expect(view.container.textContent).toContain("9,000 / 10,000");
  expect(view.container.textContent).toContain("80,000 / 100,000");
  expect(view.container.textContent).toContain("12 次 / 20 次");
  expect(view.container.textContent).toContain("gpt-5");
  expect(view.container.textContent).toContain("claude-sonnet");
  expect(view.container.textContent).toContain("今日 6,000 Token · 8 次请求");

  // Unlimited state when admin sets no quota.
  mySummary = {
    ...mySummary,
    quota: null,
    usage: { ...mySummary.usage, byModel: [] },
  };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: quotaKeys.me() });
  });
  await view.findByText("不限");
  await view.findByText("当前周期暂无模型调用记录。");

  // Admin bypass state suppresses exceeded alarm even if numbers exceed stored limits.
  mySummary = {
    ...mySummary,
    isAdmin: true,
    bypassed: true,
    quota: {
      userId: "u-admin",
      dailyTokenLimit: 1000,
      monthlyTokenLimit: 2000,
      dailyRequestLimit: 1,
      bypassAdmin: true,
      updatedBy: "u-admin",
      updatedAt: "2026-11-15T00:00:00.000Z",
    },
  };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: quotaKeys.me() });
  });
  await view.findByText("管理员豁免");
  expect(view.container.textContent).not.toContain("已达上限");
});
