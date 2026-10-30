import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ROSTER_ID } from "@/components/layout/glass-topbar";
import { RosterToggle } from "@/components/layout/roster-toggle";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * 左栏开关的键盘往返：展开时开关在左栏卡片右上角，收起时换成 80px 列顶的另一个按钮。
 * 旧按钮被卸掉后焦点不能掉到 body，要落在新出现的开关上，空格 / 回车才能再切回来。
 */

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** 和 section-rail / app-sidebar 一样：两种状态各渲染一个不同的开关。 */
function Rail() {
  const { open } = useSidebar();
  return open ? (
    <div className="glass-card">
      <div className="rail-title rail-title-row">
        <span className="rail-title-text">设置</span>
        <RosterToggle scope="settings" />
      </div>
    </div>
  ) : (
    <nav className="glass-mini" id={ROSTER_ID}>
      <RosterToggle className="glass-mini-toggle" scope="settings" />
    </nav>
  );
}

function toggle() {
  return document.querySelector<HTMLButtonElement>(".glass-roster-toggle");
}

test("切换左栏后焦点落在新出现的开关上（收起、展开两个方向）", () => {
  render(
    <SidebarProvider>
      <Rail />
    </SidebarProvider>,
  );
  const first = toggle();
  expect(first?.getAttribute("aria-label")).toBe("收起设置分区");
  expect(first?.getAttribute("aria-expanded")).toBe("true");
  act(() => first?.focus());
  // ToggleTip 懒挂载：键盘焦点（:focus-visible）第一次进来时才挂 Tooltip，按钮会换成新节点并接住焦点。
  const armed = toggle();
  expect(document.activeElement).toBe(armed);
  act(() => armed?.click());

  const collapsed = toggle();
  expect(collapsed).not.toBe(armed);
  expect(collapsed?.classList.contains("glass-mini-toggle")).toBe(true);
  expect(document.activeElement).toBe(collapsed);
  // 收起列里的展开按钮：能用 Tab 到达，aria 正确。
  expect(collapsed?.tagName).toBe("BUTTON");
  expect(collapsed?.tabIndex).toBe(0);
  expect(collapsed?.disabled).toBe(false);
  expect(collapsed?.getAttribute("aria-label")).toBe("展开设置分区");
  expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
  expect(collapsed?.getAttribute("aria-controls")).toBe(ROSTER_ID);

  act(() => collapsed?.click());
  const expanded = toggle();
  expect(expanded?.classList.contains("glass-mini-toggle")).toBe(false);
  expect(expanded?.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(expanded);
});
