import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { PanelBoard } from "@/components/panels/panel-board";
import { flushUiMemory, resetUiMemory } from "@/lib/chat/ui-memory";
import { readPanelLayout } from "@/lib/panels/panel-layout";
import { settleReactWork } from "./settle-react-work";

/**
 * 看板组件本身（DESIGN.md §109.2、docs/live-panel-sources.md 第 2 节）：能画出来、并排只在够宽时生效、
 * 折叠落盘。纯逻辑（合并 / 拆分 / 比例夹取）在 `panel-layout.test.ts`；这里防的是 JSX / 事件那一层的回归。
 */
class Observer implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  resize(target: Element, width: number) {
    this.callback(
      [{ target, contentRect: new DOMRect(0, 0, width, 640), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }],
      this,
    );
  }
}

let originalObserver: typeof ResizeObserver;

beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
  flushUiMemory();
  resetUiMemory();
  window.localStorage.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.ResizeObserver = originalObserver;
  /*
   * 收掉自己注册的 happy-dom（`settle-react-work.ts` 写了为什么：bun 把每个测试文件走一遍同一个进程，
   * 下一个自己 `register()` 的文件会撞「Happy DOM has already been globally registered」）。
   * 少了这一行，`plugin-logo.test.tsx` 在整套里必红、单独跑却全绿。
   */
  GlobalRegistrator.unregister();
});

const panels = [
  { id: "lp_a", title: "比特币价格" },
  { id: "lp_b", title: "服务器性能" },
];

type Chrome = { collapsed: boolean; toggleCollapsed: () => void; grip: ReactNode };

function renderBoard(width: number, drawer = false) {
  return render(
    <PanelBoard
      botId="bot_1"
      drawer={drawer}
      panels={panels}
      renderCard={(panel, chrome: Chrome) => (
        <article data-testid={`card-${panel.id}`}>
          {chrome.grip}
          <button onClick={chrome.toggleCollapsed} type="button">
            {chrome.collapsed ? `展开 ${panel.title}` : `折叠 ${panel.title}`}
          </button>
        </article>
      )}
      width={width}
    />,
  );
}

test("每张面板先各占一行；折叠状态写进这个机器人的 panelLayout", async () => {
  const { getByTestId, getByText, container } = renderBoard(560);
  expect(container.querySelectorAll("[data-live-panel-slot]").length).toBe(2);
  expect(container.querySelectorAll("[data-live-board-row]").length).toBe(2);
  expect(getByTestId("card-lp_a")).toBeTruthy();

  fireEvent.click(getByText("折叠 比特币价格"));
  await act(async () => {});
  expect(readPanelLayout("bot_1")?.collapsed).toEqual(["lp_a"]);
  expect(getByText("展开 比特币价格")).toBeTruthy();
});

test("宽栏里能把两张并到一行；窄栏 / 抽屉里仍然单列", async () => {
  const { container, getByLabelText } = renderBoard(560);
  const gripA = getByLabelText(/拖动「比特币价格」/);
  fireEvent.keyDown(gripA, { key: "ArrowRight" });
  await act(async () => {});

  expect(container.querySelectorAll("[data-pair='1']").length).toBe(1);
  const row = container.querySelector("[data-pair='1']");
  expect(row?.querySelectorAll("[data-live-panel-slot]").length).toBe(2);

  // 窄栏：同一份布局，渲染成两行（并排的记法不丢）。
  cleanup();
  const narrow = renderBoard(380);
  expect(narrow.container.querySelectorAll("[data-pair='1']").length).toBe(0);
  expect(narrow.container.querySelectorAll("[data-live-panel-slot]").length).toBe(2);

  // 抽屉：无论多宽都单列。
  cleanup();
  const drawer = renderBoard(900, true);
  expect(drawer.container.querySelectorAll("[data-pair='1']").length).toBe(0);
});
