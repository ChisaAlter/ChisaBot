import { useSyncExternalStore } from "react";
import { botUi, setBotUi } from "@/lib/chat/ui-memory";
import { formatHotkey, type HotkeyCombo } from "@/lib/hotkeys/hotkeys";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";

/**
 * Whether the right-hand 自定义面板 column is open, per device.
 *
 * The toggle lives in the top bar and the column lives beside the chat, so the state is a tiny
 * module store both read, persisted in the same `expanded` / `collapsed` vocabulary as the left
 * roster (`lib/sidebar.ts`). Only an exact `collapsed` starts it closed.
 */
export const PANEL_RAIL_STORAGE_KEY = "chisabot-panel-rail";

/** Ctrl+Alt+B (⌘⌥B on a Mac) — Ctrl+B is the left roster's, so the pair reads as one family. */
export const PANEL_RAIL_HOTKEY: HotkeyCombo = { key: "b", mod: true, alt: true };
export const PANEL_RAIL_HOTKEY_LABEL = formatHotkey(PANEL_RAIL_HOTKEY).join("+");

let open = readStoredPreference(PANEL_RAIL_STORAGE_KEY) !== "collapsed";
const listeners = new Set<() => void>();
/** 右栏现在显示的是哪个机器人的（`PanelRail` 设）：展开 / 收起也按机器人记一份（DESIGN.md §88）。 */
let railBot: string | undefined;

export function setPanelRailOpen(next: boolean) {
  // 按机器人记：哪怕全局的值没变（别的机器人也是这个状态），这个机器人的选择也要记下。
  if (railBot) setBotUi(railBot, { railOpen: next });
  if (next === open) return;
  open = next;
  writeStoredPreference(PANEL_RAIL_STORAGE_KEY, next ? "expanded" : "collapsed");
  for (const listener of listeners) listener();
}

/**
 * 右栏换成另一个机器人的：它记过展开 / 收起就照它的来（同一帧，不闪）；没记过就保持现在的（全局最后一次的选择）。
 * 返回这个机器人记下的宽度（没有就是 undefined）。
 */
export function showRailFor(botId: string | undefined): number | undefined {
  railBot = botId;
  const memo = botUi(botId);
  if (memo?.railOpen !== undefined && memo.railOpen !== open) {
    open = memo.railOpen;
    writeStoredPreference(PANEL_RAIL_STORAGE_KEY, open ? "expanded" : "collapsed");
    for (const listener of listeners) listener();
  }
  return memo?.railWidth;
}

export function togglePanelRail() {
  setPanelRailOpen(!open);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelRailOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => true,
  );
}

/**
 * 窄窗口（< 1280px）里面板栏放不下，改成从右边滑出的抽屉。它的开合只在本次会话里记，不持久化：
 * 窄窗口每次打开都先看聊天，要看面板时点右边缘的「面板」把手或机器人「⋯ → 自定义面板」。
 */
export const PANEL_RAIL_WIDE_QUERY = "(min-width: 1280px)";
let sheetOpen = false;
const sheetListeners = new Set<() => void>();

export function setPanelSheetOpen(next: boolean) {
  if (next === sheetOpen) return;
  sheetOpen = next;
  if (!next) sheetSource = "user";
  for (const listener of sheetListeners) listener();
}

/**
 * 抽屉是怎么打开的（CB-098 状态模型）：`user` = 用户点开，压一条返回标记；`restore` = 带 `watch=true`
 * 新进入页面时恢复，不压标记。由 panel-rail 交给 useBackDismiss。
 */
export type PanelSheetOpenSource = "user" | "restore";
let sheetSource: PanelSheetOpenSource = "user";

export function panelSheetOpenSource(): PanelSheetOpenSource {
  return sheetSource;
}

/**
 * 「用户打开右抽屉」的唯一入口：右边缘「面板」把手、机器人「⋯ → 自定义面板」，以及之后
 * 「在活动里看」这类按钮都走这里。抽屉没开时打开，只压一个返回标记；已经开着时什么都不做、不写
 * history（之后在抽屉里切标签一律 replace）。
 */
export function openPanelSheet(source: PanelSheetOpenSource = "user") {
  if (sheetOpen) return;
  sheetSource = source;
  setPanelSheetOpen(true);
}

export function usePanelSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      sheetListeners.add(listener);
      return () => sheetListeners.delete(listener);
    },
    () => sheetOpen,
    () => false,
  );
}

/** 宽窗口展开右侧面板栏，窄窗口打开面板抽屉。机器人「⋯ → 自定义面板」用它。 */
export function showPanels() {
  if (typeof window !== "undefined" && window.matchMedia(PANEL_RAIL_WIDE_QUERY).matches) {
    setPanelRailOpen(true);
  } else {
    openPanelSheet("user");
  }
}

/** 当前窗口是否放得下右侧面板栏（≥1280px）。 */
export function useWideForRail(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia(PANEL_RAIL_WIDE_QUERY);
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    },
    () => (typeof window === "undefined" ? true : window.matchMedia(PANEL_RAIL_WIDE_QUERY).matches),
    () => true,
  );
}
