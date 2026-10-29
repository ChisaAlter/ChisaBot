import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * 关设置 / 换页不再做的多余事（2026-10-29 设置面板卡顿 PR3，DESIGN.md §41 ③）：
 * - 侧栏收起时由侧栏自己拨 `<body data-has-collapsed-sidebar>`，不用 `.glass-shell:has([data-slot=sidebar][data-state=collapsed])`；
 * - 侧栏里开着 `layout` 的 motion 行都带 `layoutDependency`，普通重渲染不量位置（会话行的 layout 关着，不用）。
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
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const src = (p: string) =>
  readFileSync(join(import.meta.dir, "../src", p), "utf8");

function Shell({
  open,
  collapsible,
}: {
  open: boolean;
  collapsible?: "offcanvas" | "none";
}) {
  return (
    <SidebarProvider open={open}>
      <Sidebar collapsible={collapsible}>{"左栏"}</Sidebar>
    </SidebarProvider>
  );
}

test("桌面侧栏收起时 body 上有 data-has-collapsed-sidebar，展开 / 卸载就去掉", () => {
  const flag = () => document.body.hasAttribute("data-has-collapsed-sidebar");
  const view = render(<Shell open={true} />);
  expect(flag()).toBe(false);
  view.rerender(<Shell open={false} />);
  expect(flag()).toBe(true);
  view.rerender(<Shell open={true} />);
  expect(flag()).toBe(false);
  view.rerender(<Shell open={false} />);
  expect(flag()).toBe(true);
  view.unmount();
  expect(flag()).toBe(false);
});

test("不可收起的侧栏（collapsible=none）不拨开关（和原来的 :has 一样：它没有 data-state）", () => {
  render(<Shell collapsible="none" open={false} />);
  expect(document.body.hasAttribute("data-has-collapsed-sidebar")).toBe(false);
});

test("styles.css 不再用 .glass-shell:has(…) 判断侧栏收起", () => {
  const css = src("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/\.glass-shell:has\(/);
  expect(css).toContain(
    "body[data-has-collapsed-sidebar] .glass-shell .glass-topbar-start",
  );
});

test("侧栏带 layout 的 motion 行都给了 layoutDependency", () => {
  // PresenceItem（机器人列表）：只有 layoutKey 变了才量位置；左栏传的是列表下标。
  expect(src("components/ui/presence.tsx")).toContain(
    "layoutDependency={layoutKey}",
  );
  const sidebar = src("components/app-sidebar/app-sidebar.tsx");
  expect(sidebar).toContain("<PresenceItem key={bot.id} layoutKey={index}>");
  // 会话行（ChannelRow）：唯一的调用点传 animateOrder={false}，motion 的 layout 是关着的，不量位置，
  // 也就不需要 layoutDependency（#403 审查：之前加的 orderKey 实际不起作用，删掉了）。
  expect(sidebar).toContain("animateOrder={false}");
  expect(sidebar).not.toContain("animateOrder={true}");
  expect(sidebar).not.toContain("layoutDependency={orderKey}");
});
