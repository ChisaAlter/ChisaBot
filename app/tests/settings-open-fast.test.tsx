import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 打开设置更快（FIX-PLAN P1-6）：菜单非模态、切页不等退出动画、左栏只在当前行看不见时才滚、
 * 藏着的聊天 / 右栏不重画、空闲时只预取代码块。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(() => GlobalRegistrator.unregister());

const src = (path: string) =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

function rect(top: number, bottom: number) {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect;
}

test("rowOutOfView: only rows outside the scroll box need scrolling", async () => {
  const { rowOutOfView } = await import("@/components/layout/section-rail");
  const box = document.createElement("div");
  const row = document.createElement("div");
  box.getBoundingClientRect = () => rect(100, 500);
  row.getBoundingClientRect = () => rect(200, 240);
  expect(rowOutOfView(row, box)).toBe(false);
  row.getBoundingClientRect = () => rect(480, 520);
  expect(rowOutOfView(row, box)).toBe(true);
  row.getBoundingClientRect = () => rect(80, 120);
  expect(rowOutOfView(row, box)).toBe(true);
});

test("account menu is non-modal and navigates without waiting for preload", () => {
  const menu = src("components/layout/account-menu.tsx");
  expect(menu).toContain("modal={false}");
  expect(menu).not.toContain(".finally(() => void navigate");
  expect(menu).toContain("requestAnimationFrame(() => setTimeout(() => void navigate({ to }), 0))");
  expect(menu).toContain('leaving && "is-leaving"');
  expect(src("styles.css")).toMatch(
    /\.acct-pop\.is-leaving[^{]*\{[^}]*animation: none/,
  );
});

test("hidden chat and panel rail are memoized; idle prefetch has no loader calls", () => {
  const shell = src("components/layout/authed-shell.tsx");
  expect(shell).toContain("memo(PanelRail)");
  expect(shell).toContain("memo(ChannelPage)");
  expect(shell).toContain("requestIdleCallback");
  expect(src("components/channels/channel-page.tsx")).toContain(
    "const ChannelBody = memo(",
  );
  // 设置路由不能有 loader，否则空闲预取会发请求。
  expect(src("routes/_authed/settings/route.tsx")).not.toContain("loader");
  expect(src("routes/_authed/settings/index.tsx")).not.toContain("loader");
});
