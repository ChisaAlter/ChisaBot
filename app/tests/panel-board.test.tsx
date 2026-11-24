import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { PanelBoard } from "@/components/panels/panel-board";
import { flushUiMemory, resetUiMemory } from "@/lib/chat/ui-memory";
import { readPanelLayout, writePanelLayout } from "@/lib/panels/panel-layout";
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

test("固定高度切换、折叠卸高与双击底部横条恢复自动高度", async () => {
  writePanelLayout("bot_1", {
    rows: [["lp_a"], ["lp_b"]],
    ratios: [[], []],
    heights: { lp_a: 240 },
    collapsed: [],
  });

  const { container, getByLabelText, getByText } = renderBoard(380);
  const slotA = container.querySelector<HTMLElement>(
    "[data-live-panel-slot='lp_a']",
  );
  expect(slotA?.dataset.height).toBe("1");
  expect(slotA?.style.height).toBe("240px");

  // 折叠后卸掉固定高度，只留标题行；再展开恢复 240px。
  fireEvent.click(getByText("折叠 比特币价格"));
  await act(async () => {});
  expect(slotA?.dataset.collapsed).toBe("1");
  expect(slotA?.dataset.height).toBeUndefined();
  expect(slotA?.style.height).toBe("");

  fireEvent.click(getByText("展开 比特币价格"));
  await act(async () => {});
  expect(slotA?.dataset.collapsed).toBeUndefined();
  expect(slotA?.dataset.height).toBe("1");
  expect(slotA?.style.height).toBe("240px");

  // 键盘微调高度立即落盘，双击底部横条回到自动高度。
  const hbarA = getByLabelText(/拖动调整「比特币价格」的高度/);
  fireEvent.keyDown(hbarA, { key: "ArrowDown" });
  await act(async () => {});
  expect(readPanelLayout("bot_1")?.heights.lp_a).toBe(260);
  expect(slotA?.style.height).toBe("260px");

  fireEvent.doubleClick(hbarA);
  await act(async () => {});
  expect(readPanelLayout("bot_1")?.heights.lp_a).toBeUndefined();
  expect(slotA?.dataset.height).toBeUndefined();
  expect(slotA?.style.height).toBe("");
});

test("自定义面板经 SmoothCollapse 包裹后仍完整传递 flex/grid 高度链并防止内容溢出卡片外", () => {
  const livePanelsTsx = readFileSync(
    path.join(import.meta.dir, "../src/components/panels/live-panels.tsx"),
    "utf8",
  );
  expect(livePanelsTsx).toContain('className="live-panel-content"');
  expect(livePanelsTsx).toContain(
    'innerClassName="live-panel-content-inner flex flex-col gap-2"',
  );

  const css = readFileSync(
    path.join(import.meta.dir, "../src/styles.css"),
    "utf8",
  );
  // 历史失效的直子选择器（被 SmoothCollapse 隔断）不得再出现。
  expect(css).not.toContain(".live-board-slot > .live-panel > .live-panel-body");
  // 看板自身在 flex-col 滚动栏内不可被压扁。
  expect(css).toMatch(/\.live-board\s*\{[^}]*flex:\s*none;/);
  // 标题与底栏固定高度、不可被挤压。
  expect(css).toMatch(/\.live-panel-head\s*\{[^}]*flex:\s*none;/);
  expect(css).toMatch(/\.live-panel-foot\s*\{[^}]*flex:\s*none;/);
  // SmoothCollapse 容器与内层必须向下传递高度并锁住列宽。
  expect(css).toMatch(
    /\.live-panel-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*min-height:\s*0;/,
  );
  expect(css).toMatch(
    /\.live-panel-content\[data-open="true"\]\s*\{[^}]*flex:\s*1 1 auto;/,
  );
  expect(css).toMatch(
    /\.live-board-slot\[data-height\] \.live-panel-content\[data-open="true"\]\s*\{[^}]*flex:\s*1 1 0%;[^}]*min-height:\s*0;/,
  );
  expect(css).toMatch(
    /\.live-board-slot\[data-height\] \.live-panel-content-inner\s*\{[^}]*height:\s*100%;/,
  );
  expect(css).toMatch(
    /\.live-board-slot\[data-height\] \.live-panel-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/,
  );
});

test("自定义面板富组件样式守卫：强调色弧线高对比、Ring 窄列自适应、KV 省略与分隔线、dark/cossui 前景色", () => {
  const css = readFileSync(
    path.join(import.meta.dir, "../src/styles.css"),
    "utf8",
  );
  // Ring/Gauge 默认强调色走高对比 --accent-blue-ink。
  expect(css).toMatch(
    /\.jr-tone-accent\s*\{[^}]*--tone:\s*var\(--accent-blue-ink\);/,
  );
  // Ring 窄列不溢出：width 用 min(..., 100%) + aspect-ratio: 1。
  expect(css).toMatch(
    /\.jr-ring-fig\s*\{[^}]*width:\s*min\(92px,\s*100%\);[^}]*aspect-ratio:\s*1;/,
  );
  expect(css).toMatch(
    /\.jr-ring\.is-sm \.jr-ring-fig\s*\{[^}]*width:\s*min\(52px,\s*100%\);/,
  );
  expect(css).toMatch(
    /\.jr-ring\.is-lg \.jr-ring-fig\s*\{[^}]*width:\s*min\(128px,\s*100%\);/,
  );
  // KV 长标签可省略且 2 列折单列时保留第 2 行顶分隔线。
  expect(css).toMatch(
    /\.jr-kv-k > span\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/,
  );
  expect(css).toMatch(
    /\.jr-kv\.is-2\s*\{[^}]*container-type:\s*inline-size;/,
  );
  expect(css).toMatch(
    /@container\s*\(min-width:\s*298px\)\s*\{\s*\.jr-kv\.is-2 > \.jr-kv-row:nth-child\(2\)\s*\{\s*border-top:\s*0;\s*\}\s*\}/,
  );
  // 强调色底徽章/主按钮用 --ink-on-accent，避免 dark/cossui 白底白字。
  expect(css).toMatch(
    /\.jr-product-badge\s*\{[^}]*color:\s*var\(--ink-on-accent\);/,
  );
  expect(css).toMatch(
    /\.bm-text-btn\.is-primary\s*\{[^}]*color:\s*var\(--ink-on-accent\);/,
  );
});
