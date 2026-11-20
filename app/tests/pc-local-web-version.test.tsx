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
import { ClientUpdateSection } from "@/components/settings/client-update-section";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { approvalInboxOptions } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/keys";
import { ClientError, client } from "@/lib/client";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import type { PcBridge, PcLocalState } from "@/lib/pc-bridge";
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
  delete (window as { chisabotPC?: PcBridge }).chisabotPC;
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
    "无法加载新功能：当前服务端版本（v0.1.149）低于桌面端（v0.1.154），请在「设置 → 版本与更新」升级服务端。",
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

test("AccountMenu hides version subtitle and server upgrade item (moved to 设置 → 版本与更新)", async () => {
  setBundledPcVersionForTest("0.1.154");
  const adminView = await renderAccountMenu("admin", "0.1.149");
  expect(adminView.queryByText(/v0\.1\.154/)).toBeNull();
  expect(adminView.queryByText(/服务端 v0\.1\.149/)).toBeNull();

  fireEvent.click(adminView.getByRole("button", { name: "账号与设置" }));
  await waitFor(() => {
    expect(adminView.getByText("设置")).toBeTruthy();
  });
  expect(adminView.queryByText(/升级服务端/)).toBeNull();
  expect(adminView.queryByText(/v0\.1\.154/)).toBeNull();

  cleanup();
  const memberView = await renderAccountMenu("user", "0.1.149");
  expect(memberView.queryByText(/v0\.1\.154/)).toBeNull();
  fireEvent.click(memberView.getByRole("button", { name: "账号与设置" }));
  await waitFor(() => {
    expect(memberView.getByText("设置")).toBeTruthy();
  });
  expect(memberView.queryByText(/升级服务端/)).toBeNull();
});

test("ClientUpdateSection displays desktop & server versions and triggers desktop update check / install", async () => {
  setBundledPcVersionForTest("0.1.173");
  let checked = 0;
  let installed = 0;
  let localState: PcLocalState = {
    version: "0.1.173",
    platform: "win32",
    hostname: "dev-pc",
    serverUrl: `http://127.0.0.1:${serverPort}`,
    deviceId: "dev-1",
    agentState: "online",
    statusText: "在线",
    tokenProtected: true,
    localPaused: false,
    forceLocalApproval: false,
    autoStart: true,
    startHidden: false,
    autoUpdate: true,
    update: {
      supported: true,
      status: "none",
      signing: true,
    },
    webUi: {
      hasLocalBundle: true,
      mode: "local",
      bundledVersion: "0.1.173",
      serverVersion: "0.1.171",
    },
  };
  (window as { chisabotPC?: PcBridge }).chisabotPC = {
    state: async () => localState,
    setLocal: async (patch) => {
      localState = { ...localState, ...patch };
      return localState;
    },
    pickFolders: async () => [],
    logout: async () => true,
    checkUpdate: async () => {
      checked += 1;
      localState = {
        ...localState,
        update: {
          supported: true,
          status: "downloaded",
          version: "0.1.174",
          signing: true,
        },
      };
      return localState.update!;
    },
    installUpdate: async () => {
      installed += 1;
      return true;
    },
    onChange: () => () => {},
  };

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(["app-version"], {
    version: "0.1.171",
    buildId: "srv-0.1.171",
  });

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ClientUpdateSection />
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const devicesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/devices",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, devicesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);

  await waitFor(() => {
    expect(
      view.getByText(
        /桌面端 v0\.1\.173 · 服务端 v0\.1\.171 · 本地内置前端 · 服务端版本低于桌面端/,
      ),
    ).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "检查更新" }));
  await waitFor(() => {
    expect(checked).toBe(1);
    expect(view.getByRole("button", { name: "立即重启以安装" })).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "立即重启以安装" }));
  await waitFor(() => {
    expect(installed).toBe(1);
  });
});
