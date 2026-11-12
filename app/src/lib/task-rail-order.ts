import { useSyncExternalStore } from "react";
import { taskCenterApi } from "@/lib/task-center-api";

export const TASK_RAIL_ORDER_KEY = "chisabot-task-rail-order:v1";

export type RailOrderSection = "decisions" | "active" | "recent";

export type SectionOrderState = {
  pinned: string[];
  order: string[];
};

export type TaskRailOrderMap = Record<RailOrderSection, SectionOrderState>;

export type ItemOrderMeta = {
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

const MAX_IDS_PER_SECTION = 120;

function emptySection(): SectionOrderState {
  return { pinned: [], order: [] };
}

function emptyOrderMap(): TaskRailOrderMap {
  return {
    decisions: emptySection(),
    active: emptySection(),
    recent: emptySection(),
  };
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0 && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
      if (out.length >= MAX_IDS_PER_SECTION) break;
    }
  }
  return out;
}

function parseSection(value: unknown): SectionOrderState {
  if (!value || typeof value !== "object") return emptySection();
  const record = value as Record<string, unknown>;
  return {
    pinned: sanitizeStringList(record.pinned),
    order: sanitizeStringList(record.order),
  };
}

function parseOrderMap(raw: string | null): TaskRailOrderMap {
  if (!raw) return emptyOrderMap();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return emptyOrderMap();
    return {
      decisions: parseSection(parsed.decisions),
      active: parseSection(parsed.active),
      recent: parseSection(parsed.recent),
    };
  } catch {
    return emptyOrderMap();
  }
}

function safeGetStorage(): string | null {
  try {
    return typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(TASK_RAIL_ORDER_KEY);
  } catch {
    return null;
  }
}

let cachedRaw: string | null = null;
let cachedState: TaskRailOrderMap = emptyOrderMap();
let memoryFallback = false;
const listeners = new Set<() => void>();

export function getTaskRailOrderSnapshot(): TaskRailOrderMap {
  if (memoryFallback) return cachedState;
  const raw = safeGetStorage();
  if (raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  cachedState = parseOrderMap(raw);
  return cachedState;
}

function writeTaskRailOrder(next: TaskRailOrderMap) {
  const serialized = JSON.stringify(next);
  cachedState = next;
  cachedRaw = serialized;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TASK_RAIL_ORDER_KEY, serialized);
      memoryFallback = false;
    } else {
      memoryFallback = true;
    }
  } catch {
    memoryFallback = true;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TASK_RAIL_ORDER_KEY) {
      memoryFallback = false;
      listener();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/**
 * 按置顶优先 + 用户手动排序排列卡片列表：
 * 1. 已置顶项始终排在未置顶项之前；
 * 2. 同一分组内部，若在 `order` 中记录过顺序则按用户顺序排列；
 * 3. 新出现、尚未进入 `order` 的卡片排在同组最前，保持原有的「最新在前」直觉。
 */
export function sortSectionItems<T>(
  items: readonly T[],
  getId: (item: T) => string,
  state: SectionOrderState,
): T[] {
  if (items.length <= 1 && state.pinned.length === 0) return [...items];
  const pinnedSet = new Set(state.pinned);
  const pinnedRank = new Map(state.pinned.map((id, idx) => [id, idx]));
  const orderRank = new Map(state.order.map((id, idx) => [id, idx]));

  const pinnedItems: Array<{ item: T; id: string; incomingIndex: number }> = [];
  const normalItems: Array<{ item: T; id: string; incomingIndex: number }> = [];

  items.forEach((item, incomingIndex) => {
    const id = getId(item);
    if (pinnedSet.has(id)) {
      pinnedItems.push({ item, id, incomingIndex });
    } else {
      normalItems.push({ item, id, incomingIndex });
    }
  });

  pinnedItems.sort((a, b) => {
    const oa = orderRank.get(a.id);
    const ob = orderRank.get(b.id);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    const pa = pinnedRank.get(a.id) ?? a.incomingIndex;
    const pb = pinnedRank.get(b.id) ?? b.incomingIndex;
    return pa - pb;
  });

  normalItems.sort((a, b) => {
    const oa = orderRank.get(a.id);
    const ob = orderRank.get(b.id);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa === undefined && ob === undefined) {
      return a.incomingIndex - b.incomingIndex;
    }
    // 未手动排过序的新卡片默认排在同组前面。
    return oa === undefined ? -1 : 1;
  });

  return [
    ...pinnedItems.map((entry) => entry.item),
    ...normalItems.map((entry) => entry.item),
  ];
}

/** 计算某张卡片在当前已排序分组中的置顶态与可上移 / 可下移边界（组内移动）。 */
export function getItemOrderMeta(
  state: SectionOrderState,
  sortedIds: readonly string[],
  id: string,
): ItemOrderMeta {
  const pinnedSet = new Set(state.pinned);
  const isPinned = pinnedSet.has(id);
  const groupIds = sortedIds.filter(
    (itemId) => pinnedSet.has(itemId) === isPinned,
  );
  const index = groupIds.indexOf(id);
  return {
    pinned: isPinned,
    canMoveUp: index > 0,
    canMoveDown: index !== -1 && index < groupIds.length - 1,
  };
}

function extractTaskId(itemId: string): string | null {
  return itemId.startsWith("task:") ? itemId.slice(5) : null;
}

function syncPriorityForActiveSection(
  section: RailOrderSection,
  nextSectionState: SectionOrderState,
  sortedIds: readonly string[],
  changedIds: readonly string[],
) {
  if (section !== "active") return;
  const pinnedSet = new Set(nextSectionState.pinned);
  const pinnedGroup = sortedIds.filter((id) => pinnedSet.has(id));
  const normalGroup = sortedIds.filter((id) => !pinnedSet.has(id));

  for (const itemId of changedIds) {
    const taskId = extractTaskId(itemId);
    if (!taskId) continue;
    if (pinnedSet.has(itemId)) {
      const idx = Math.max(0, pinnedGroup.indexOf(itemId));
      const priority = Math.max(85, Math.min(99, 98 - idx * 2));
      void taskCenterApi.syncTaskPriority(taskId, priority);
    } else {
      const idx = Math.max(0, normalGroup.indexOf(itemId));
      const priority = Math.max(20, Math.min(80, 75 - idx * 5));
      void taskCenterApi.syncTaskPriority(taskId, priority);
    }
  }
}

export function toggleRailItemPin(
  section: RailOrderSection,
  currentSortedIds: readonly string[],
  id: string,
): boolean {
  const current = getTaskRailOrderSnapshot();
  const prev = current[section];
  const wasPinned = prev.pinned.includes(id);
  const nextPinned = wasPinned
    ? prev.pinned.filter((entry) => entry !== id)
    : [id, ...prev.pinned.filter((entry) => entry !== id)].slice(
        0,
        MAX_IDS_PER_SECTION,
      );

  // 合并当前可见顺序与历史记忆顺序，确保刚置顶的卡片排在置顶组首位。
  const baseOrder = [
    ...currentSortedIds,
    ...prev.order.filter((entry) => !currentSortedIds.includes(entry)),
  ];
  const nextOrder = (
    wasPinned ? baseOrder : [id, ...baseOrder.filter((entry) => entry !== id)]
  ).slice(0, MAX_IDS_PER_SECTION);

  const nextSection: SectionOrderState = {
    pinned: nextPinned,
    order: nextOrder,
  };
  writeTaskRailOrder({
    ...current,
    [section]: nextSection,
  });

  const resortedIds = sortSectionItems(
    currentSortedIds,
    (itemId) => itemId,
    nextSection,
  );
  syncPriorityForActiveSection(section, nextSection, resortedIds, [id]);
  return !wasPinned;
}

export function moveRailItem(
  section: RailOrderSection,
  currentSortedIds: readonly string[],
  id: string,
  direction: -1 | 1,
): boolean {
  const current = getTaskRailOrderSnapshot();
  const prev = current[section];
  const pinnedSet = new Set(prev.pinned);
  const isPinned = pinnedSet.has(id);

  const pinnedIds = currentSortedIds.filter((entry) => pinnedSet.has(entry));
  const normalIds = currentSortedIds.filter((entry) => !pinnedSet.has(entry));
  const targetGroup = isPinned ? [...pinnedIds] : [...normalIds];

  const idx = targetGroup.indexOf(id);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= targetGroup.length) {
    return false;
  }

  const neighborId = targetGroup[swapIdx];
  if (!neighborId) return false;
  targetGroup[idx] = neighborId;
  targetGroup[swapIdx] = id;

  const mergedVisible = isPinned
    ? [...targetGroup, ...normalIds]
    : [...pinnedIds, ...targetGroup];
  const trailingRemembered = prev.order.filter(
    (entry) => !mergedVisible.includes(entry),
  );
  const nextOrder = [...mergedVisible, ...trailingRemembered].slice(
    0,
    MAX_IDS_PER_SECTION,
  );
  const nextPinned = isPinned
    ? [
        ...targetGroup,
        ...prev.pinned.filter((entry) => !targetGroup.includes(entry)),
      ].slice(0, MAX_IDS_PER_SECTION)
    : prev.pinned;

  const nextSection: SectionOrderState = {
    pinned: nextPinned,
    order: nextOrder,
  };
  writeTaskRailOrder({
    ...current,
    [section]: nextSection,
  });

  syncPriorityForActiveSection(section, nextSection, mergedVisible, [
    id,
    neighborId,
  ]);
  return true;
}

export function useTaskRailOrder(): TaskRailOrderMap {
  return useSyncExternalStore(
    subscribe,
    getTaskRailOrderSnapshot,
    emptyOrderMap,
  );
}
