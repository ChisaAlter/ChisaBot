import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #374 回退（电脑端布局）：顶栏只有品牌文字和 PC 窗口按钮。
 * 身份只在左栏底部的账号卡；搜索会话在左栏卡片顶部；左栏开关长在左栏上（和右栏「面板」开关对称）。
 */
const read = (rel: string) =>
  readFileSync(path.join(import.meta.dir, "../src", rel), "utf8");
const topbar = read("components/layout/glass-topbar.tsx");
const shell = read("components/layout/glass-shell.tsx");
const account = read("components/layout/account-menu.tsx");
const sidebar = read("components/app-sidebar/app-sidebar.tsx");
const sectionRail = read("components/layout/section-rail.tsx");
const search = read("components/layout/sidebar-search-field.tsx");
const css = read("styles.css");

test("顶栏不放头像、账号菜单、搜索框或左栏开关", () => {
  expect(topbar).not.toContain("BrandAvatar");
  expect(topbar).not.toContain("SidebarSearchField");
  expect(topbar).not.toContain("TopBarSearch");
  expect(topbar).not.toContain("RosterToggle");
});

test("头像（账号菜单）只在手机顶栏上，电脑顶栏没有", () => {
  // 外壳把账号菜单交给顶栏，顶栏只在手机布局里画它。
  expect(shell).toContain(
    '<GlassTopBar account={<AccountMenu placement="topbar" />} scope={scope} />',
  );
  expect(topbar).toMatch(
    /\{mobile \? \(\s*<>\s*<MobileSearchButton scope=\{scope\} \/>\s*\{account\}\s*<\/>\s*\) : null\}/,
  );
  expect(topbar.match(/\{account\}/g)?.length).toBe(1);
  expect(account).toContain("hk-avatar-btn");
});

test("电脑上左栏卡片顶部有搜索会话，左栏开关在卡片和 80px 列上", () => {
  expect(sidebar).toMatch(
    /<div className="side-search-row">\s*<SidebarSearchField \/>/,
  );
  expect(sidebar).toContain('<RosterToggle scope="app" />');
  expect(sidebar).toContain(
    '<RosterToggle className="glass-mini-toggle" scope="app" />',
  );
  expect(sectionRail).toContain("<RosterToggle scope={scope} />");
  expect(sectionRail).toContain(
    '<RosterToggle className="glass-mini-toggle" scope={scope} />',
  );
  expect(search).not.toContain("topbar");
});

test("styles.css 没有顶栏搜索胶囊 / 主页圆钮 / 顶栏头像的残留样式", () => {
  for (const dead of [".hk-topbar", ".hk-search", ".hk-home", ".hk-brand"]) {
    expect(css).not.toContain(dead);
  }
});
