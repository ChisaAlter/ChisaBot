import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  resetToggleTipKeyboardForTest,
  ToggleTip,
} from "@/components/layout/glass-topbar";
import {
  PANEL_SHEET_HEAD_FOCUSABLE,
  panelSheetInitialFocus,
} from "@/components/panels/panel-rail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { settleReactWork } from "./settle-react-work";

/**
 * P2-2（FIX-PLAN §3 4e）：面板里的 ToggleTip 第一次悬停 / 键盘聚焦之前不挂 Base UI Tooltip，
 * 面板抽屉的首个焦点不再靠「整只抽屉逐个 getComputedStyle」去找。
 *
 * 断言的是行为：没碰过时只有按钮本身（没有 Base UI 的 trigger 标记、没有弹层）；悬停当场出现、
 * 离开消失；按过 Tab 之后挂的是真 Trigger，焦点落上去照常出现，焦点不会因为换节点丢掉。
 */

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  resetToggleTipKeyboardForTest();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderTip(onClick?: () => void) {
  const view = render(
    <TooltipProvider>
      <ToggleTip keys="Ctrl+." label="关闭面板" side="bottom">
        <button
          aria-label="关闭面板"
          className="rail-head-icon"
          onClick={onClick}
          type="button"
        >
          x
        </button>
      </ToggleTip>
    </TooltipProvider>,
  );
  const button = () => view.getByRole("button", { name: "关闭面板" });
  const tip = () => document.querySelector('[data-slot="tooltip-content"]');
  return { ...view, button, tip };
}

async function waitHoverArm() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  await settleReactWork();
}

test("没悬停、没聚焦时不挂 Tooltip：按钮原样渲染，没有 Base UI trigger 标记和弹层", () => {
  const { button, tip } = renderTip();
  expect(button().getAttribute("aria-label")).toBe("关闭面板");
  expect(button().getAttribute("data-slot")).toBe("tooltip-trigger");
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
  expect(button().hasAttribute("id")).toBe(false);
  expect(tip()).toBeNull();
});

test("第一次悬停就挂上并当场出现，位置参数不变；离开后消失", async () => {
  const { button, tip } = renderTip();
  await act(async () => {
    fireEvent.pointerEnter(button(), { pointerType: "mouse" });
    fireEvent.mouseEnter(button());
  });
  await waitHoverArm();
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
  const popup = tip();
  expect(popup?.textContent).toBe("关闭面板Ctrl+.");
  expect(popup?.getAttribute("data-side")).toBe("bottom");
  expect(button().getAttribute("aria-label")).toBe("关闭面板");

  await act(async () => {
    fireEvent.mouseLeave(button());
  });
  await settleReactWork();
  await new Promise((r) => setTimeout(r, 50));
  await settleReactWork();
  expect(tip()?.getAttribute("data-open") ?? null).toBeNull();
});

test("快速移入并点击（mouseenter 紧跟 pointerdown → mousedown → mouseup → click）100% 触发 onClick 且不卸载按钮", async () => {
  let clicks = 0;
  const { button, tip } = renderTip(() => {
    clicks += 1;
  });
  const before = button();
  await act(async () => {
    fireEvent.pointerEnter(before, { pointerType: "mouse" });
    fireEvent.mouseEnter(before);
    fireEvent.pointerDown(before, { pointerType: "mouse" });
    fireEvent.mouseDown(before);
    fireEvent.pointerUp(before, { pointerType: "mouse" });
    fireEvent.mouseUp(before);
    fireEvent.click(before);
  });
  await settleReactWork();
  expect(clicks).toBe(1);
  expect(before.isConnected).toBe(true);
  expect(button()).toBe(before);
  expect(before.hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
  expect(tip()).toBeNull();

  // 已取消的悬停计时器不会在点击结束后延迟卸载重挂按钮。
  await waitHoverArm();
  expect(before.isConnected).toBe(true);
  expect(button()).toBe(before);

  // 点击结束后再次稳定悬停，仍可正常挂上并弹出 Tooltip。
  await act(async () => {
    fireEvent.pointerEnter(before, { pointerType: "mouse" });
    fireEvent.mouseEnter(before);
  });
  await waitHoverArm();
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
  expect(tip()?.textContent).toBe("关闭面板Ctrl+.");
});

test("短暂划过按钮未满悬停阈值即移走，不挂载 Tooltip 也不换节点", async () => {
  const { button, tip } = renderTip();
  const before = button();
  await act(async () => {
    fireEvent.pointerEnter(before, { pointerType: "mouse" });
    fireEvent.mouseEnter(before);
    fireEvent.mouseLeave(before);
  });
  await waitHoverArm();
  expect(before.isConnected).toBe(true);
  expect(button()).toBe(before);
  expect(before.hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
  expect(tip()).toBeNull();
});

test("触屏进入不挂、不弹", async () => {
  const { button, tip } = renderTip();
  await act(async () => {
    fireEvent.pointerEnter(button(), { pointerType: "touch" });
    fireEvent.mouseEnter(button());
  });
  await settleReactWork();
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
  expect(tip()).toBeNull();
});

test("按过 Tab 后挂的是真 Trigger；键盘焦点落上去照常出现，焦点还在按钮上", async () => {
  const { button, tip } = renderTip();
  const before = button();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
  });
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
  // 在 keydown 里同步换好：浏览器这之后才移动焦点，落到的就是真 Trigger。
  expect(before.isConnected).toBe(false);
  await act(async () => {
    button().focus();
  });
  await settleReactWork();
  expect(document.activeElement).toBe(button());
  expect(tip()?.textContent).toBe("关闭面板Ctrl+.");
});

test("在输入框里打字不算键盘导航，不会把懒按钮全挂上", async () => {
  const { button } = renderTip();
  const input = document.createElement("textarea");
  document.body.append(input);
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
  });
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
  input.remove();
});

test("拿着焦点的懒按钮被悬停换成真 Trigger 时焦点不丢", async () => {
  const { button } = renderTip();
  act(() => {
    button().focus();
  });
  await act(async () => {
    fireEvent.pointerEnter(button(), { pointerType: "mouse" });
    fireEvent.mouseEnter(button());
  });
  await waitHoverArm();
  expect(button().hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
  expect(document.activeElement).toBe(button());
});

test("面板抽屉首个焦点：顶栏里第一个可 Tab 的控件；触屏给抽屉本身", () => {
  const sheet = document.createElement("div");
  sheet.id = "chisabot-panel-sheet";
  sheet.innerHTML = `
    <header class="rail-head">
      <div role="radiogroup">
        <button role="radio" tabindex="-1" id="r-computer">计算机</button>
        <button role="radio" tabindex="0" id="r-panels">面板</button>
      </div>
      <button disabled id="disabled">x</button>
      <button id="add">新建</button>
      <button id="close">关闭</button>
    </header>
    <div class="rail-pane"><button id="inside">卡片</button></div>`;
  document.body.append(sheet);
  expect((panelSheetInitialFocus("mouse") as HTMLElement).id).toBe("r-panels");
  expect((panelSheetInitialFocus("keyboard") as HTMLElement).id).toBe(
    "r-panels",
  );
  expect(panelSheetInitialFocus("touch")).toBe(sheet);
  sheet.querySelector('[role="radiogroup"]')?.remove();
  expect((panelSheetInitialFocus("mouse") as HTMLElement).id).toBe("add");
  expect(sheet.querySelectorAll(PANEL_SHEET_HEAD_FOCUSABLE).length).toBe(2);
  sheet.querySelector(".rail-head")?.remove();
  // 顶栏没了就交回 Base UI 默认逻辑（第一个可 Tab 的元素）。
  expect(panelSheetInitialFocus("mouse")).toBe(true);
  sheet.remove();
});
