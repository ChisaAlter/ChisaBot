import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { flushUiMemory, resetUiMemory } from "@/lib/chat/ui-memory";
import {
  canPairPanels,
  clampPanelHeight,
  clampPanelRatio,
  dropPanelOnOwnRow,
  dropPanelOnPanel,
  emptyPanelLayout,
  movePanelRow,
  pairPanelWith,
  type PanelLayout,
  PANEL_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  PANEL_PAIR_MIN_WIDTH,
  readPanelLayout,
  reconcilePanelLayout,
  rowGridTemplate,
  sanitizePanelLayout,
  setPanelCollapsed,
  setPanelHeight,
  setRowRatio,
  visiblePanelRows,
  writePanelLayout,
} from "@/lib/panels/panel-layout";

/**
 * 看板布局（2026-10-22，docs/live-panel-sources.md 第 2 节）：行的合并 / 拆分 / 比例夹取、
 * 窄栏单列、高度与折叠落盘。纯函数 + localStorage（ui-memory 的 bots.<id>.panelLayout）。
 */
const registered = !(globalThis as { document?: unknown }).document;
beforeAll(() => {
  if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});
beforeEach(() => {
  resetUiMemory();
  window.localStorage.clear();
});

function layout(rows: string[][], ratios: number[][] = rows.map(() => [])): PanelLayout {
  return { rows, ratios, heights: {}, collapsed: [] };
}

describe("行：默认布局与对齐服务器顺序", () => {
  test("没记录时每张面板各占一行，顺序照服务器", () => {
    const next = reconcilePanelLayout(["p1", "p2", "p3"], null);
    expect(next.rows).toEqual([["p1"], ["p2"], ["p3"]]);
    expect(next.ratios).toEqual([[], [], []]);
    expect(next.heights).toEqual({});
    expect(next.collapsed).toEqual([]);
  });

  test("删掉的面板从行里拿走，新面板接在最后；重复 id 只留一次", () => {
    const saved = layout([["a", "b"], ["gone"], ["a"]], [[0.4], [], []]);
    const next = reconcilePanelLayout(["a", "b", "c"], saved);
    expect(next.rows).toEqual([["a", "b"], ["c"]]);
    // 比例跟着 rows 对齐：第一行还是记下的 0.4，新的单行没有分隔条。
    expect(next.ratios).toEqual([[0.4], []]);
  });

  test("超过两张的行按两张切开（旧数据 / 手改）", () => {
    const next = reconcilePanelLayout(["a", "b", "c"], layout([["a", "b", "c"]]));
    expect(next.rows).toEqual([["a", "b"], ["c"]]);
  });
});

describe("拖动：并入同一行 / 换位 / 单独一行", () => {
  test("拖到另一张卡上 = 同一行（按落点分左右）", () => {
    const start = layout([["a"], ["b"], ["c"]]);
    expect(dropPanelOnPanel(start, "c", "a", "before").rows).toEqual([["c", "a"], ["b"]]);
    expect(dropPanelOnPanel(start, "c", "a", "after").rows).toEqual([["a", "c"], ["b"]]);
  });

  test("同一行里拖 = 换位，比例不变", () => {
    const start = layout([["a", "b"]], [[0.3]]);
    const next = dropPanelOnPanel(start, "a", "b");
    expect(next.rows).toEqual([["b", "a"]]);
    expect(next.ratios).toEqual([[0.3]]);
  });

  test("目标行已经两张：源卡占它的位置，被顶掉的那张去源卡原来的行", () => {
    const start = layout([["a", "b"], ["c"]]);
    const next = dropPanelOnPanel(start, "c", "a");
    expect(next.rows).toEqual([["c", "b"], ["a"]]);
    expect(next.ratios).toEqual([[0.5], []]);
  });

  test("拖到列表空白 = 单独一行（可以指定插到第几行）", () => {
    const start = layout([["a", "b"], ["c"]]);
    expect(dropPanelOnOwnRow(start, "a", 0).rows).toEqual([["a"], ["b"], ["c"]]);
    expect(dropPanelOnOwnRow(start, "c", 0).rows).toEqual([["c"], ["a", "b"]]);
    expect(dropPanelOnOwnRow(start, "b").rows).toEqual([["a"], ["c"], ["b"]]);
  });

  test("↑↓ 换行、←→ 并排 / 拆开（键盘路径）", () => {
    const start = layout([["a"], ["b"], ["c"]]);
    expect(movePanelRow(start, "c", -1).rows).toEqual([["a"], ["c"], ["b"]]);
    expect(movePanelRow(start, "a", -1).rows).toEqual(start.rows);
    // →：并进右边那一行（放在它后面）；←：并进左边那一行（放在它前面）。
    const paired = pairPanelWith(start, "b", 1);
    expect(paired.rows).toEqual([["a"], ["c", "b"]]);
    expect(pairPanelWith(start, "b", -1).rows).toEqual([["b", "a"], ["c"]]);
    // 已经并排时 → / ← 把它拆出来。
    expect(pairPanelWith(paired, "b", -1).rows).toEqual([["a"], ["b"], ["c"]]);
    expect(pairPanelWith(paired, "c", 1).rows).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("分隔条比例（0.25–0.75）", () => {
  test("夹取并使用两位小数", () => {
    const start = layout([["a", "b"]], [[0.5]]);
    expect(setRowRatio(start, 0, 0.1).ratios).toEqual([[0.25]]);
    expect(setRowRatio(start, 0, 0.9).ratios).toEqual([[0.75]]);
    expect(setRowRatio(start, 0, 0.623).ratios).toEqual([[0.62]]);
    expect(clampPanelRatio(Number.NaN)).toBe(0.5);
  });

  test("单张卡的行没有分隔条，比例不动", () => {
    const start = layout([["a"]], [[]]);
    expect(setRowRatio(start, 0, 0.8).ratios).toEqual([[]]);
  });

  test("grid 列宽：中间 12px、两边最小 200px", () => {
    expect(rowGridTemplate(0.3)).toBe("minmax(200px, 0.3fr) 12px minmax(200px, 0.7fr)");
    expect(rowGridTemplate(0.99)).toContain("0.75fr");
  });
});

describe("窄栏 / 抽屉永远单列", () => {
  test("≥480px 才并排，抽屉里永不并排", () => {
    expect(PANEL_PAIR_MIN_WIDTH).toBe(480);
    expect(canPairPanels(479, false)).toBe(false);
    expect(canPairPanels(480, false)).toBe(true);
    expect(canPairPanels(900, true)).toBe(false);
  });

  test("画的时候单列展开行，但记下的并排布局不动", () => {
    const saved = layout([["a", "b"], ["c"]], [[0.3], []]);
    expect(visiblePanelRows(saved, true)).toEqual([
      { ids: ["a", "b"], ratio: 0.3 },
      { ids: ["c"], ratio: 0.5 },
    ]);
    expect(visiblePanelRows(saved, false)).toEqual([
      { ids: ["a"], ratio: 0.5 },
      { ids: ["b"], ratio: 0.5 },
      { ids: ["c"], ratio: 0.5 },
    ]);
    expect(saved.rows).toEqual([["a", "b"], ["c"]]);
  });
});

describe("高度与折叠", () => {
  test("高度最小 120、回自动是删掉记录", () => {
    const start = emptyPanelLayout();
    expect(setPanelHeight(start, "a", 40).heights).toEqual({ a: PANEL_MIN_HEIGHT });
    expect(setPanelHeight(start, "a", 240).heights).toEqual({ a: 240 });
    expect(setPanelHeight(setPanelHeight(start, "a", 240), "a", null).heights).toEqual({});
    expect(clampPanelHeight(PANEL_MAX_HEIGHT + 1)).toBe(PANEL_MAX_HEIGHT);
  });

  test("折叠去重、展开移除；折叠不影响高度", () => {
    let next = setPanelCollapsed(emptyPanelLayout(), "a", true);
    next = setPanelCollapsed(next, "a", true);
    expect(next.collapsed).toEqual(["a"]);
    next = setPanelHeight(next, "a", 300);
    expect(setPanelCollapsed(next, "a", false)).toEqual({ ...next, collapsed: [] });
  });
});

describe("落盘（按机器人记在 ui-memory）", () => {
  test("布局写进 bots.<id>.panelLayout，刷新后还在", () => {
    const saved = setPanelHeight(
      setPanelCollapsed(dropPanelOnPanel(layout([["a"], ["b"]]), "b", "a"), "b", true),
      "a",
      260,
    );
    const withRatio = setRowRatio(saved, 0, 0.4);
    writePanelLayout("bot_1", withRatio);
    // 模拟刷新：落盘、丢掉内存那份，再从 localStorage 读。
    flushUiMemory();
    resetUiMemory();
    const back = readPanelLayout("bot_1");
    expect(back).toEqual(withRatio);
    // 另一个机器人没有这份布局。
    expect(readPanelLayout("bot_2")).toBeNull();
  });

  test("手改过的 localStorage 会被收成合法形状", () => {
    const dirty = sanitizePanelLayout({
      rows: [["a", "a", "b"], "nope", [1 as unknown as string]],
      ratios: [[9], ["x" as unknown as number]],
      heights: { a: 20, b: "300" },
      collapsed: ["a", "a", 3 as unknown as string],
    });
    expect(dirty?.rows).toEqual([["a", "a"]]);
    expect(dirty?.ratios).toEqual([[0.75]]);
    expect(dirty?.heights).toEqual({ a: PANEL_MIN_HEIGHT });
    expect(dirty?.collapsed).toEqual(["a"]);
    expect(sanitizePanelLayout(null)).toBeNull();
    expect(sanitizePanelLayout("x")).toBeNull();
  });
});
