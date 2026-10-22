/**
 * 右栏面板的看板布局（2026-10-22，docs/live-panel-sources.md 第 2 节）。
 *
 * 服务端只记机器人建面板的先后（`position`）；「哪两张并排、中间分隔条在哪、每张多高、哪张折叠了」
 * 是这个人、这台设备的选择，存在 `chisabot-ui-memory:v1` 的 `bots.<id>.panelLayout`（DESIGN.md §88）。
 *
 * 这里只有纯函数：行的合并 / 拆分、比例夹取、高度与折叠，以及读 / 写 ui-memory 的那两下。
 * 拖动期怎么不重排整栏在 `components/panels/panel-board.tsx`，不在这里。
 */
import { botUi, setBotUi } from "@/lib/chat/ui-memory";

export type PanelLayout = {
  /** 一行里的卡片 id；最多两张（服务器 position 的顺序就是默认的行顺序）。 */
  rows: string[][];
  /** 与 rows 一一对应：两张卡时是左边那张的比例（0.25–0.75）；单张卡是空数组。 */
  ratios: number[][];
  /** 拖高过的卡片（px，最小 120）；没有记录 = 随内容自动高度。 */
  heights: Record<string, number>;
  /** 折叠了、只留标题行的卡片。折叠的卡片不渲染内容、不取数。 */
  collapsed: string[];
};

/** 两张并排需要的最小内容宽度：两张 200px 的卡 + 中间的细分隔条。 */
export const PANEL_PAIR_MIN_WIDTH = 480;
/** 一张卡片的最小宽度（并排时；窄于这个宽度不并排）。 */
export const PANEL_CARD_MIN_WIDTH = 200;
/** 卡片的最小高度（拖高时的下限）。 */
export const PANEL_MIN_HEIGHT = 120;
/** 拖高的上限：再高也只是一张卡，给个够用的天花板免得把下面的卡挤没。 */
export const PANEL_MAX_HEIGHT = 4000;
/** 一行两张卡时左边那张的比例范围（右边那张是 1 − 它）。 */
export const PANEL_RATIO_MIN = 0.25;
export const PANEL_RATIO_MAX = 0.75;
/** 键盘调比例的步长。 */
export const PANEL_RATIO_STEP = 0.05;

const DEFAULT_RATIO = 0.5;

export function emptyPanelLayout(): PanelLayout {
  return { rows: [], ratios: [], heights: {}, collapsed: [] };
}

export function clampPanelRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  // 留两位小数，落盘的数不会因为指针抖动变成 0.4999999999。
  const rounded = Math.round(value * 100) / 100;
  return Math.min(PANEL_RATIO_MAX, Math.max(PANEL_RATIO_MIN, rounded));
}

export function clampPanelHeight(value: number): number {
  if (!Number.isFinite(value)) return PANEL_MIN_HEIGHT;
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, Math.round(value)));
}

/** 一行的比例数组：单张卡没有分隔条，两张卡一条（多出来的丢掉、少的补 0.5）。 */
function normalizeRatios(row: readonly string[], raw: readonly number[] | undefined): number[] {
  return Array.from({ length: Math.max(0, row.length - 1) }, (_, index) =>
    clampPanelRatio(raw?.[index] ?? DEFAULT_RATIO),
  );
}

/** 一行最多两张；旧数据 / 手改的 localStorage 里更长的行按两张切开。 */
function cappedRows(rows: readonly string[][]): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    if (row.length <= 2) {
      out.push([...row]);
      continue;
    }
    for (let at = 0; at < row.length; at += 2) out.push(row.slice(at, at + 2));
  }
  return out;
}

/**
 * 把记下的布局和服务器现在这批面板对齐：删掉的面板从行里拿走、新面板各占一行（接在最后）；
 * 去重、行最多两张、比例夹回 0.25–0.75、高度不低于 120。纯函数，测试直接用。
 */
export function reconcilePanelLayout(
  panelIds: readonly string[],
  saved: PanelLayout | null | undefined,
): PanelLayout {
  const known = new Set(panelIds);
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const row of saved?.rows ?? []) {
    if (!Array.isArray(row)) continue;
    const kept: string[] = [];
    for (const id of row) {
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      kept.push(id);
    }
    if (kept.length > 0) rows.push(kept);
  }
  for (const id of panelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push([id]);
  }
  const finalRows = cappedRows(rows);
  // 比例跟着「同一批卡片组成的同一行」走：删掉一张后剩下的行不该继承旧行的分隔条位置。
  const savedRatios = new Map<string, number[]>();
  (saved?.rows ?? []).forEach((row, index) => {
    if (Array.isArray(row) && row.length > 0) savedRatios.set(row.join("|"), saved?.ratios?.[index] ?? []);
  });
  const ratios = finalRows.map((row) => normalizeRatios(row, savedRatios.get(row.join("|"))));

  const heights: Record<string, number> = {};
  for (const [id, height] of Object.entries(saved?.heights ?? {})) {
    if (!known.has(id) || typeof height !== "number") continue;
    heights[id] = clampPanelHeight(height);
  }
  const collapsed: string[] = [];
  for (const id of saved?.collapsed ?? []) {
    if (typeof id === "string" && known.has(id) && !collapsed.includes(id)) collapsed.push(id);
  }
  return { rows: finalRows, ratios, heights, collapsed };
}

export function samePanelLayout(a: PanelLayout, b: PanelLayout): boolean {
  if (a === b) return true;
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i += 1) {
    const left = a.rows[i];
    const right = b.rows[i];
    if (!left || !right) return false;
    if (left.length !== right.length) return false;
    for (let j = 0; j < left.length; j += 1) if (left[j] !== right[j]) return false;
    const lr = a.ratios[i] ?? [];
    const rr = b.ratios[i] ?? [];
    if (lr.length !== rr.length) return false;
    for (let j = 0; j < lr.length; j += 1) if (lr[j] !== rr[j]) return false;
  }
  const heightIds = new Set([...Object.keys(a.heights), ...Object.keys(b.heights)]);
  for (const id of heightIds) if (a.heights[id] !== b.heights[id]) return false;
  if (a.collapsed.length !== b.collapsed.length) return false;
  return a.collapsed.every((id) => b.collapsed.includes(id));
}

function locate(layout: PanelLayout, id: string): { row: number; index: number } | null {
  for (let row = 0; row < layout.rows.length; row += 1) {
    const index = layout.rows[row]?.indexOf(id) ?? -1;
    if (index >= 0) return { row, index };
  }
  return null;
}

/** 换了行之后：比例跟着新行重新对齐，高度和折叠不动。 */
function withRows(layout: PanelLayout, rows: string[][], ratios: number[][]): PanelLayout {
  return {
    ...layout,
    rows,
    ratios: rows.map((row, index) => normalizeRatios(row, ratios[index])),
  };
}

/**
 * 拖动握把放到另一张卡片上（`side` 是落在目标的左半还是右半）。
 *
 * - 同一行：两张换位。
 * - 目标行还空着：搬进去，放在目标的左边或右边。
 * - 目标行已经两张：和它换位（源卡进这一行，被顶掉的那张去源卡原来的位置 / 单独一行）。
 */
export function dropPanelOnPanel(
  layout: PanelLayout,
  sourceId: string,
  targetId: string,
  side: "before" | "after" = "after",
): PanelLayout {
  if (sourceId === targetId) return layout;
  const source = locate(layout, sourceId);
  const target = locate(layout, targetId);
  if (!source || !target) return layout;

  const rows = layout.rows.map((row) => [...row]);
  const ratios = layout.ratios.map((row) => [...row]);
  const sourceRow = rows[source.row];
  const targetRow = rows[target.row];
  if (!sourceRow || !targetRow) return layout;

  if (source.row === target.row) {
    const left = sourceRow[source.index];
    const right = sourceRow[target.index];
    if (left === undefined || right === undefined) return layout;
    sourceRow[source.index] = right;
    sourceRow[target.index] = left;
    return withRows(layout, rows, ratios);
  }

  const moving = sourceRow[source.index];
  if (moving === undefined) return layout;
  const at = targetRow.indexOf(targetId);

  if (targetRow.length < 2) {
    const insertAt = side === "before" ? at : at + 1;
    targetRow.splice(insertAt, 0, moving);
    const rest = sourceRow.filter((id) => id !== moving);
    if (rest.length > 0) {
      rows[source.row] = rest;
    } else {
      rows.splice(source.row, 1);
      ratios.splice(source.row, 1);
    }
  } else {
    // 目标行满了：源卡占它的位置，它去源卡原来那一行（源卡走了那里正好空一格）。
    targetRow[at] = moving;
    const rest = sourceRow.filter((id) => id !== moving);
    if (rest.length > 0) rows[source.row] = rest;
    else rows[source.row] = [targetId];
  }
  return withRows(layout, rows, ratios);
}

/**
 * 把卡片拆成单独一行，插到第 `at` 行（默认最后）。拖到列表空白处、或用键盘把并排的卡拆开时用。
 */
export function dropPanelOnOwnRow(
  layout: PanelLayout,
  id: string,
  at: number = layout.rows.length,
): PanelLayout {
  const source = locate(layout, id);
  if (!source) return layout;
  const rows = layout.rows.map((row) => [...row]);
  const ratios = layout.ratios.map((row) => [...row]);
  const sourceRow = rows[source.row];
  if (!sourceRow) return layout;
  sourceRow.splice(source.index, 1);

  let insertAt = Number.isFinite(at) ? Math.max(0, Math.round(at)) : rows.length;
  if (sourceRow.length === 0) {
    rows.splice(source.row, 1);
    ratios.splice(source.row, 1);
    if (insertAt > source.row) insertAt -= 1;
  }
  insertAt = Math.min(Math.max(insertAt, 0), rows.length);
  rows.splice(insertAt, 0, [id]);
  ratios.splice(insertAt, 0, []);
  return withRows(layout, rows, ratios);
}

/** 整行上移 / 下移一格（握把的方向键 ↑↓）。 */
export function movePanelRow(layout: PanelLayout, id: string, delta: number): PanelLayout {
  const source = locate(layout, id);
  if (!source) return layout;
  const to = source.row + delta;
  if (to < 0 || to >= layout.rows.length || delta === 0) return layout;
  const rows = layout.rows.map((row) => [...row]);
  const ratios = layout.ratios.map((row) => [...row]);
  const fromRow = rows[source.row];
  const toRow = rows[to];
  if (!fromRow || !toRow) return layout;
  rows[source.row] = toRow;
  rows[to] = fromRow;
  const fromRatio = ratios[source.row] ?? [];
  const toRatio = ratios[to] ?? [];
  ratios[source.row] = toRatio;
  ratios[to] = fromRatio;
  return withRows(layout, rows, ratios);
}

/**
 * 握把的方向键 ←→：并排的拆成单独一行；单独的并进左边 / 右边那一行（那一行已经两张时与它换位）。
 */
export function pairPanelWith(layout: PanelLayout, id: string, direction: -1 | 1): PanelLayout {
  const source = locate(layout, id);
  if (!source) return layout;
  const row = layout.rows[source.row];
  if (!row) return layout;
  if (row.length > 1) {
    return dropPanelOnOwnRow(layout, id, direction > 0 ? source.row + 1 : source.row);
  }
  const neighbor = layout.rows[source.row + direction];
  if (!neighbor || neighbor.length === 0) return layout;
  const targetId = direction < 0 ? neighbor[neighbor.length - 1] : neighbor[0];
  if (!targetId) return layout;
  return dropPanelOnPanel(layout, id, targetId, direction < 0 ? "before" : "after");
}

/** 行内分隔条：新的左边卡比例（夹到 0.25–0.75）。 */
export function setRowRatio(layout: PanelLayout, rowIndex: number, value: number): PanelLayout {
  const row = layout.rows[rowIndex];
  if (!row || row.length < 2) return layout;
  const ratios = layout.ratios.map((entry) => [...entry]);
  ratios[rowIndex] = [clampPanelRatio(value)];
  return { ...layout, ratios };
}

/** 拖高一张卡；`null` = 回到自动高度（双击底部细条）。 */
export function setPanelHeight(layout: PanelLayout, id: string, height: number | null): PanelLayout {
  const heights = { ...layout.heights };
  if (height === null) delete heights[id];
  else heights[id] = clampPanelHeight(height);
  return { ...layout, heights };
}

/** 折叠 / 展开；折叠只留标题行，卡片不再渲染内容、不再取数。 */
export function setPanelCollapsed(layout: PanelLayout, id: string, collapsed: boolean): PanelLayout {
  const has = layout.collapsed.includes(id);
  if (has === collapsed) return layout;
  const next = collapsed ? [...layout.collapsed, id] : layout.collapsed.filter((item) => item !== id);
  return { ...layout, collapsed: next };
}

export function isPanelCollapsed(layout: PanelLayout, id: string): boolean {
  return layout.collapsed.includes(id);
}

/**
 * 画的时候真正用到的行：窄窗口抽屉 / 栏宽 < 480px 时永远单列（比例不生效），
 * 但记下的布局不动——窗口变宽又并排回去。
 */
export function visiblePanelRows(
  layout: PanelLayout,
  allowPair: boolean,
): { ids: string[]; ratio: number }[] {
  if (allowPair) {
    return layout.rows.map((ids, index) => ({
      ids: [...ids],
      ratio: clampPanelRatio(layout.ratios[index]?.[0] ?? DEFAULT_RATIO),
    }));
  }
  return layout.rows.flatMap((row) => row.map((id) => ({ ids: [id], ratio: DEFAULT_RATIO })));
}

/** 栏宽够不够并排（抽屉里永远不够）。 */
export function canPairPanels(width: number, drawer: boolean): boolean {
  return !drawer && Number.isFinite(width) && width >= PANEL_PAIR_MIN_WIDTH;
}

/** 一行两张卡时的 grid 列宽：中间留 12px 给分隔条，两边最小 200px。 */
export function rowGridTemplate(ratio: number): string {
  const left = clampPanelRatio(ratio);
  const right = Math.round((1 - left) * 100) / 100;
  return `minmax(${PANEL_CARD_MIN_WIDTH}px, ${left}fr) 12px minmax(${PANEL_CARD_MIN_WIDTH}px, ${right}fr)`;
}

/* ------------------------------------------------------------------ */
/* localStorage（ui-memory 的 bots.<id>.panelLayout）                    */
/* ------------------------------------------------------------------ */

/** 把 localStorage 里可能被手改过的记录收成合法形状；没有 / 不是对象时返回 null。 */
export function sanitizePanelLayout(raw: unknown): PanelLayout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<PanelLayout>;
  const rows: string[][] = [];
  for (const row of Array.isArray(value.rows) ? value.rows : []) {
    if (!Array.isArray(row)) continue;
    const ids = row.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) rows.push(ids.slice(0, 2));
  }
  const ratios = rows.map((row, index) => {
    const entry = Array.isArray(value.ratios) ? value.ratios[index] : undefined;
    return normalizeRatios(row, Array.isArray(entry) ? entry : undefined);
  });
  const heights: Record<string, number> = {};
  if (value.heights && typeof value.heights === "object" && !Array.isArray(value.heights)) {
    for (const [id, height] of Object.entries(value.heights)) {
      if (typeof height === "number" && Number.isFinite(height)) heights[id] = clampPanelHeight(height);
    }
  }
  const collapsed = Array.isArray(value.collapsed)
    ? [...new Set(value.collapsed.filter((id): id is string => typeof id === "string"))]
    : [];
  return { rows, ratios, heights, collapsed };
}

export function readPanelLayout(botId: string | undefined): PanelLayout | null {
  return sanitizePanelLayout(botUi(botId)?.panelLayout);
}

export function writePanelLayout(botId: string | undefined, layout: PanelLayout): void {
  if (!botId) return;
  // 空布局也落盘：用户可能刚把最后两张拆开，下次回来仍按这个摆法（读的时候再和服务端顺序对齐）。
  setBotUi(botId, { panelLayout: sanitizePanelLayout(layout) ?? emptyPanelLayout() });
}
