import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import * as AdminSidebarModule from "@/components/admin/admin-sidebar";
import * as AppSidebarModule from "@/components/app-sidebar/app-sidebar";
import { ShellSidebar } from "@/components/layout/authed-shell";
import { RailParked } from "@/components/layout/rail-sidebar";
import { SidebarSearchField } from "@/components/layout/sidebar-search-field";
import * as SettingsSidebarModule from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  requestSidebarSearchFocus,
  takeSidebarSearchFocus,
} from "@/lib/sidebar-search";
import { settleReactWork } from "./settle-react-work";

/**
 * #403：关设置时聊天左栏不再卸载重挂（以前按 scope 三选一，关设置 = 整份名单重画 + 重新拉列表，4× 下约 30ms）。
 * 左栏的内容（`AppSidebar`）换成计数的替身（模块命名空间 spyOn，用完还原），数它挂上 / 卸下 / 画了几次。
 */

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1440,
    height: 900,
  }),
);
afterEach(async () => {
  cleanup();
  await settleReactWork();
  document.body.removeAttribute("data-has-collapsed-sidebar");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function stubSidebars() {
  const counts = { mounts: 0, unmounts: 0, renders: 0 };
  const app = spyOn(AppSidebarModule, "AppSidebar");
  app.mockImplementation((() => {
    counts.renders++;
    useEffect(() => {
      counts.mounts++;
      return () => {
        counts.unmounts++;
      };
    }, []);
    return <nav data-testid="app-sidebar">{"机器人名单"}</nav>;
  }) as unknown as typeof AppSidebarModule.AppSidebar);
  const settings = spyOn(SettingsSidebarModule, "SettingsSidebar");
  settings.mockImplementation((() => (
    <nav data-testid="settings-sidebar">{"设置"}</nav>
  )) as unknown as typeof SettingsSidebarModule.SettingsSidebar);
  const admin = spyOn(AdminSidebarModule, "AdminSidebar");
  admin.mockImplementation((() => (
    <nav data-testid="admin-sidebar">{"管理"}</nav>
  )) as unknown as typeof AdminSidebarModule.AdminSidebar);
  return {
    counts,
    restore() {
      app.mockRestore();
      settings.mockRestore();
      admin.mockRestore();
    },
  };
}

const parkedWrapper = (el: HTMLElement) =>
  el.closest("[data-left-rail-parked]");

test("聊天 → 设置 → 聊天 → 管理 → 聊天：聊天左栏只挂一次、从不卸载，在设置 / 管理里藏着", async () => {
  const { counts, restore } = stubSidebars();
  try {
    const shell = (scope: "app" | "settings" | "admin") => (
      <SidebarProvider open>
        <ShellSidebar scope={scope} />
      </SidebarProvider>
    );
    const view = render(shell("app"));
    await settleReactWork();
    // 左栏是 lazyPart（DESIGN.md §41.5）：settleReactWork 只把 React 的活排干，import() 什么时候落地
    // 看运行器和批次，所以第一下露面用 findBy 等，不拿骨架当断言失败。
    const roster = await view.findByTestId("app-sidebar");
    expect(parkedWrapper(roster)).toBeNull();
    expect(counts.mounts).toBe(1);

    view.rerender(shell("settings"));
    await settleReactWork();
    expect(await view.findByTestId("settings-sidebar")).toBeTruthy();
    // 还是同一个节点，只是外面那层藏起来了（display:none）。
    expect(view.getByTestId("app-sidebar")).toBe(roster);
    expect(parkedWrapper(roster)?.className).toBe("hidden");

    view.rerender(shell("app"));
    await settleReactWork();
    expect(view.queryByTestId("settings-sidebar")).toBeNull();
    expect(view.getByTestId("app-sidebar")).toBe(roster);
    expect(parkedWrapper(roster)).toBeNull();

    view.rerender(shell("admin"));
    await settleReactWork();
    expect(await view.findByTestId("admin-sidebar")).toBeTruthy();
    expect(parkedWrapper(roster)?.className).toBe("hidden");
    view.rerender(shell("app"));
    await settleReactWork();

    expect(counts.mounts).toBe(1);
    expect(counts.unmounts).toBe(0);
  } finally {
    restore();
  }
});

test("在设置里切分类（外壳重画、scope 不变）时，藏着的聊天左栏一次都不画", async () => {
  const { counts, restore } = stubSidebars();
  try {
    let bump: () => void = () => {};
    function Frame() {
      // 外壳每换一次地址都重画；这里用一个计数状态模拟。
      const [, setN] = useState(0);
      bump = () => setN((n) => n + 1);
      return <ShellSidebar scope="settings" />;
    }
    const view = render(
      <SidebarProvider open>
        <Frame />
      </SidebarProvider>,
    );
    // 等藏着的左栏真的挂上再数：import() 晚一拍落地时中途的挂载会把 renders 算进去。
    await view.findByTestId("app-sidebar");
    const before = counts.renders;
    for (let i = 0; i < 5; i++) {
      await act(async () => bump());
    }
    expect(counts.renders).toBe(before);
  } finally {
    restore();
  }
});

test("藏着的聊天左栏不拨 has-collapsed-sidebar（管理左栏没有收起态，以前这时聊天左栏根本不在）", async () => {
  const { restore } = stubSidebars();
  try {
    const shell = (scope: "app" | "admin") => (
      <SidebarProvider open={false}>
        <ShellSidebar scope={scope} />
      </SidebarProvider>
    );
    const view = render(shell("app"));
    // 同上：has-collapsed-sidebar 由 LeftRail 里的 Sidebar 拨，先等它挂上。
    await view.findByTestId("app-sidebar");
    expect(document.body.hasAttribute("data-has-collapsed-sidebar")).toBe(true);
    view.rerender(shell("admin"));
    await settleReactWork();
    expect(document.body.hasAttribute("data-has-collapsed-sidebar")).toBe(
      false,
    );
    view.rerender(shell("app"));
    await settleReactWork();
    expect(document.body.hasAttribute("data-has-collapsed-sidebar")).toBe(true);
  } finally {
    restore();
  }
});

test("设置里按 Ctrl K：藏着的搜索框不抢请求，回到聊天、左栏露出来时才聚焦", async () => {
  takeSidebarSearchFocus();
  const field = (parked: boolean) => (
    <RailParked.Provider value={parked}>
      <SidebarSearchField />
    </RailParked.Provider>
  );
  const view = render(field(true));
  await settleReactWork();
  const input = view.getByRole("combobox", { name: "搜索会话" });
  // 设置里：先记下请求（外壳随后导航回聊天）。
  requestSidebarSearchFocus();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(document.activeElement).not.toBe(input);
  // 回到聊天：左栏露出来，请求还在，这时才接。
  view.rerender(field(false));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(document.activeElement).toBe(input);
  expect(takeSidebarSearchFocus()).toBe(false);
});
