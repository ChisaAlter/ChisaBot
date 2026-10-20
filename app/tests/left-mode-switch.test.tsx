import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { LeftModeSwitch } from "@/components/cloud-cc/left-mode-switch";
import { LeftRailPanes } from "@/components/layout/left-rail";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authKeys } from "@/lib/auth/queries";
import { lastBotsLocation, modeOfPath, modeTarget, rememberBotsLocation, resetLeftModeMemory } from "@/lib/left-mode";
import { selectOpenBotManualChunk } from "../vite.config";
import { settleReactWork } from "./settle-react-work";

/**
 * 「机器人 ↔ Claude Code」切换整屏刷新（DESIGN.md §84）：以前两边各是一个布局路由、各自一个 GlassShell，
 * 每切一次外壳、顶栏、左栏全部卸载重挂，左栏数据全部重新请求。现在共用一个外壳，左栏两块内容都留着。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  resetLeftModeMemory();
  localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("mode follows the address: /cc and below is Claude Code, everything else is bots", () => {
  expect(modeOfPath("/cc")).toBe("cc");
  expect(modeOfPath("/cc/s_1")).toBe("cc");
  expect(modeOfPath("/channel/c_1")).toBe("bots");
  expect(modeOfPath("/ccx")).toBe("bots");
  expect(modeOfPath("/")).toBe("bots");
});

test("switching back to bots returns to the last conversation, not to the / bounce", () => {
  expect(modeTarget("bots")).toEqual({ to: "/" });
  rememberBotsLocation("/channel/c_1", { panel: "x" });
  rememberBotsLocation("/", {});
  rememberBotsLocation("/cc/s_1", {});
  expect(lastBotsLocation()).toEqual({ pathname: "/channel/c_1", search: { panel: "x" } });
  expect(modeTarget("bots")).toEqual({ to: "/channel/c_1", search: { panel: "x" } });
});

test("switching to Claude Code returns to the last session", () => {
  expect(modeTarget("cc")).toEqual({ to: "/cc" });
  localStorage.setItem("chisabot-cc-last-session", "s_9");
  expect(modeTarget("cc")).toEqual({ to: "/cc/$sessionId", params: { sessionId: "s_9" } });
});

test("Claude Code route pages get their own chunk even though they now live under _app", () => {
  expect(selectOpenBotManualChunk("/repo/app/src/routes/_authed/_app/cc/$sessionId.tsx?tsr-split=component")).toBe("route-cc");
  expect(selectOpenBotManualChunk("/repo/app/src/routes/_authed/_app/cc/index.tsx?tsr-split=component")).toBe("route-cc");
  expect(selectOpenBotManualChunk("/repo/app/src/routes/_authed/_app/memory.tsx?tsr-split=component")).toBe("route-app-secondary");
});

function counter() {
  const c = { mounts: 0, unmounts: 0 };
  function Probe({ label }: { label: string }) {
    useEffect(() => {
      c.mounts++;
      return () => {
        c.unmounts++;
      };
    }, []);
    return <div data-label={label}>{label}</div>;
  }
  return { c, Probe };
}

test("the rail keeps both panes mounted: switching never remounts the frame or the other pane", async () => {
  const bots = counter();
  const cc = counter();
  const view = (mode: "bots" | "cc") => (
    <SidebarProvider>
      <div data-testid="frame">
        <LeftRailPanes bots={<bots.Probe label="bots" />} cc={<cc.Probe label="cc" />} mode={mode} />
      </div>
    </SidebarProvider>
  );
  const { container, rerender } = render(view("bots"));
  const frame = container.querySelector('[data-testid="frame"]');
  const stack = container.querySelector('[data-testid="left-rail"]');
  expect(container.querySelector('[data-pane="cc"]')).toBeNull(); // 没用过的那块不挂
  rerender(view("cc"));
  await settleReactWork();
  expect(container.querySelector('[data-testid="frame"]')).toBe(frame);
  expect(container.querySelector('[data-testid="left-rail"]')).toBe(stack);
  const botsPane = container.querySelector('[data-pane="bots"]') as HTMLElement;
  const ccPane = container.querySelector('[data-pane="cc"]') as HTMLElement;
  expect(botsPane.dataset.active).toBe("false");
  expect(botsPane.hasAttribute("inert")).toBe(true);
  expect(botsPane.getAttribute("aria-hidden")).toBe("true");
  expect(ccPane.dataset.active).toBe("true");
  expect(ccPane.hasAttribute("inert")).toBe(false);
  rerender(view("bots"));
  rerender(view("cc"));
  rerender(view("bots"));
  await settleReactWork();
  expect(container.querySelector('[data-pane="bots"]')).toBe(botsPane);
  expect(container.querySelector('[data-pane="cc"]')).toBe(ccPane);
  expect(bots.c).toEqual({ mounts: 1, unmounts: 0 });
  expect(cc.c).toEqual({ mounts: 1, unmounts: 0 });
  expect(container.querySelector('[data-testid="left-rail"]')?.getAttribute("data-mode")).toBe("bots");
});

test("while the Claude Code chunk is on its way the bots pane stays on screen (no blank rail)", () => {
  const bots = counter();
  const view = (mode: "bots" | "cc", cc: ReactNode | null) => (
    <SidebarProvider>
      <LeftRailPanes bots={<bots.Probe label="bots" />} cc={cc} mode={mode} />
    </SidebarProvider>
  );
  const { container, rerender } = render(view("bots", null));
  rerender(view("cc", null));
  expect((container.querySelector('[data-pane="bots"]') as HTMLElement).dataset.active).toBe("true");
  expect((container.querySelector('[data-pane="cc"]') as HTMLElement).dataset.active).toBe("false");
  rerender(view("cc", <div>cc</div>));
  expect((container.querySelector('[data-pane="cc"]') as HTMLElement).dataset.active).toBe("true");
  expect(bots.c.unmounts).toBe(0);
});

test("opening /cc directly with no bots pane yet shows a local rail skeleton, never a full-page loader", () => {
  const { container } = render(
    <SidebarProvider>
      <LeftRailPanes bots={<div>bots</div>} cc={null} mode="cc" />
    </SidebarProvider>,
  );
  const ccPane = container.querySelector('[data-pane="cc"]') as HTMLElement;
  expect(ccPane.dataset.active).toBe("true");
  expect(ccPane.querySelector('[role="status"]')).not.toBeNull();
  expect(container.querySelector(".sky-skel")).toBeNull();
});

/**
 * 「机器人｜Claude Code」的键盘约定（2026-10-20 审查）。
 *
 * 它一直是 `role="radio"` 的 radiogroup，按钮本身能点、也能 Tab 到，但缺了 ARIA radio 组的两条：
 * Tab 会挨个停在两项上（没有 roving tabindex），方向键什么都不做。补上以后：Tab 只停在选中项，
 * 方向键换选项、焦点跟着走。
 */
async function mountSwitch(mode: "bots" | "cc", at: string) {
  const rootRoute = createRootRoute({
    component: () => <LeftModeSwitch mode={mode} />,
  });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const ccRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cc", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, ccRoute]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(authKeys.currentUser(), { role: "admin" });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

test("切换是一个 radiogroup，两个选项各自报出选中状态", async () => {
  const { view } = await mountSwitch("bots", "/");
  const group = await view.findByRole("radiogroup");
  expect(group.getAttribute("aria-orientation")).toBe("horizontal");
  expect(view.getByRole("radio", { name: "机器人" }).getAttribute("aria-checked")).toBe("true");
  expect(view.getByRole("radio", { name: "Claude Code" }).getAttribute("aria-checked")).toBe("false");
});

test("Tab 只停在选中那一项（roving tabindex）", async () => {
  const { view } = await mountSwitch("bots", "/");
  await view.findByRole("radiogroup");
  expect((view.getByRole("radio", { name: "机器人" }) as HTMLElement).tabIndex).toBe(0);
  expect((view.getByRole("radio", { name: "Claude Code" }) as HTMLElement).tabIndex).toBe(-1);
});

test("方向键换到对面那块", async () => {
  const { router, view } = await mountSwitch("bots", "/");
  const group = await view.findByRole("radiogroup");
  fireEvent.keyDown(group, { key: "ArrowRight" });
  await waitFor(() => expect(router.state.location.pathname).toBe("/cc"));
});

test("在 Claude Code 那边按左键回到机器人", async () => {
  const { router, view } = await mountSwitch("cc", "/cc");
  const group = await view.findByRole("radiogroup");
  expect(view.getByRole("radio", { name: "Claude Code" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(group, { key: "ArrowLeft" });
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});
