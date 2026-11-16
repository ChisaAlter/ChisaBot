import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AccountMenu } from "@/components/layout/account-menu";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { approvalInboxOptions } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/keys";
import { ClientError, client } from "@/lib/client";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import {
  formatAccountVersionLabel,
  recordServedVersion,
  resetVersionSkewForTest,
  serverSkewBehindBundled,
  setBundledPcVersionForTest,
} from "@/lib/version-skew";
import { settleReactWork } from "./settle-react-work";

let server: Server;
let serverPort = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    if (urlPath === "/api/new-feature") {
      const body = "Not Found";
      res.writeHead(404, {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }
    if (urlPath === "/api/channels/missing") {
      const body = JSON.stringify({ error: "会话不存在" });
      res.writeHead(404, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }
    const okBody = JSON.stringify({ ok: true });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(okBody)),
    });
    res.end(okBody);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${serverPort}/` });
});

afterEach(() => {
  cleanup();
  resetVersionSkewForTest();
});

afterAll(async () => {
  await settleReactWork();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  GlobalRegistrator.unregister();
});

test("version-skew helpers compute dual-version label only when bundled PC UI is ahead of server", () => {
  setBundledPcVersionForTest("0.1.154");
  recordServedVersion("0.1.149");
  expect(serverSkewBehindBundled()).toEqual({
    uiVersion: "0.1.154",
    serverVersion: "0.1.149",
  });
  expect(formatAccountVersionLabel("0.1.149")).toBe("v0.1.154 · 服务端 v0.1.149");

  recordServedVersion("0.1.154");
  expect(serverSkewBehindBundled()).toBeNull();
  expect(formatAccountVersionLabel("0.1.154")).toBe("v0.1.154");

  recordServedVersion("0.1.155");
  expect(serverSkewBehindBundled()).toBeNull();
  expect(formatAccountVersionLabel("0.1.155")).toBe("v0.1.155");
});

test("client turns bare 404 into actionable version-skew message when bundled UI is ahead", async () => {
  setBundledPcVersionForTest("0.1.154");
  recordServedVersion("0.1.149");

  await expect(
    client("/api/new-feature", { fallback: "无法加载新功能", timeoutMs: 5000 }),
  ).rejects.toThrow(
    "无法加载新功能：当前服务端版本（v0.1.149）低于桌面端（v0.1.154），请在「设置 → 系统更新」升级服务端。",
  );

  try {
    await client("/api/channels/missing", {
      fallback: "无法加载会话",
      timeoutMs: 5000,
    });
    throw new Error("expected ClientError");
  } catch (error) {
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).message).toBe("会话不存在");
  }
});

async function renderAccountMenu(role: "admin" | "user", servedVersion: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "u1",
    email: "user@example.com",
    name: "测试用户",
    role,
    onboarding: null,
  });
  queryClient.setQueryData(approvalInboxOptions().queryKey, {
    enabled: false,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
  queryClient.setQueryData(recentConfirmationsQueryOptions().queryKey, []);
  queryClient.setQueryData(["app-version"], {
    version: servedVersion,
    buildId: `srv-${servedVersion}`,
  });

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TaskCenterProvider>
            <AccountMenu />
            <Outlet />
          </TaskCenterProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>{"home"}</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div>{"settings"}</div>,
  });
  const systemUpdateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/system-update",
    component: () => <div>{"system-update"}</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      settingsRoute,
      systemUpdateRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return {
    router,
    ...render(<RouterProvider router={router} />),
  };
}

test("AccountMenu shows dual version subtitle and admin upgrade link only when bundled UI is ahead", async () => {
  setBundledPcVersionForTest("0.1.154");
  const adminView = await renderAccountMenu("admin", "0.1.149");
  expect(adminView.getByText("v0.1.154 · 服务端 v0.1.149")).toBeTruthy();

  fireEvent.click(adminView.getByRole("button", { name: "账号与设置" }));
  await waitFor(() => {
    expect(adminView.getByText("升级服务端（当前 v0.1.149）")).toBeTruthy();
  });

  cleanup();
  const memberView = await renderAccountMenu("user", "0.1.149");
  expect(memberView.getByText("v0.1.154 · 服务端 v0.1.149")).toBeTruthy();
  fireEvent.click(memberView.getByRole("button", { name: "账号与设置" }));
  await waitFor(() => {
    expect(memberView.getByText("设置")).toBeTruthy();
  });
  expect(memberView.queryByText("升级服务端（当前 v0.1.149）")).toBeNull();
});
