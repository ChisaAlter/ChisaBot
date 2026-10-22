import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { CloudWorkspaceView } from "../../shared/cloud-cc";
import { Route as CloudWorkspaceRoute } from "@/routes/_authed/settings/cloud-workspace";

/**
 * 设置 → 云端工作区（DESIGN.md §73.1）：节点还在跑旧版节点程序时，账号卡下面要说清楚，
 * 并给出路——认得出自己指纹的节点给「重启节点」，比这个功能还旧的节点给 docker 命令。
 * 用户 2026-10-22 的「退出 Claude 还是不管用」就是旧节点回的旧结论。
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
let posts: { path: string; method: string }[];
let stale = true;
let restartable = true;

function view(): CloudWorkspaceView {
  return {
    node: { deviceId: "dev_x", name: "云端工作区", online: true, claudeVersion: "2.1.165", lastSeenAt: null, scriptStale: stale, scriptRestartable: restartable },
    claude: { loggedIn: true, email: "a@example.com", plan: "pro", method: "claude.ai", checkedAt: new Date().toISOString() },
    running: 0,
    maxConcurrent: 2,
    browserLogin: true,
    proxy: { configured: false, masked: null, kind: null, protocol: null, converter: { available: true, version: "1.14.3", lastError: null } },
  } as CloudWorkspaceView;
}

beforeEach(() => {
  posts = [];
  stale = true;
  restartable = true;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") posts.push({ path, method });
      if (path === "/api/cloud-workspace" && method === "GET") return Response.json(view());
      if (path === "/api/cloud-workspace/node/restart" && method === "POST") return Response.json({ restarting: true });
      if (path === "/api/cloud-workspace/activity") return Response.json({ events: [] });
      if (path === "/api/cloud-workspace/permission-rules") return Response.json({ rules: [] });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function draw() {
  const Page = CloudWorkspaceRoute.options.component as ComponentType;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: createRootRoute({ component: () => <Page /> }) });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("节点程序旧、认得出指纹：提示 +「重启节点」，点它真的发请求", async () => {
  const page = draw();
  const notice = await page.findByTestId("cc-node-stale");
  expect(notice.textContent).toContain("旧版节点程序");
  const restart = await page.findByRole("button", { name: "重启节点" });
  await act(async () => restart.click());
  await waitFor(() => expect(posts.some((p) => p.path === "/api/cloud-workspace/node/restart" && p.method === "POST")).toBe(true));
});

test("节点程序旧、比这个功能还旧：给服务器上的 docker 命令，不给按钮", async () => {
  restartable = false;
  const page = draw();
  const notice = await page.findByTestId("cc-node-stale");
  expect(notice.textContent).toContain("不支持在线更新");
  expect(page.getByRole("button", { name: /复制命令/ })).toBeTruthy();
  expect(page.queryByRole("button", { name: "重启节点" })).toBeNull();
});

test("节点程序是新的：不出现提示", async () => {
  stale = false;
  const page = draw();
  await page.findByText("已登录 · a@example.com · Pro");
  expect(page.queryByTestId("cc-node-stale")).toBeNull();
});
