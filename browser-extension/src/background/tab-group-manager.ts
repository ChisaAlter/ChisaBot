import { MAX_COMPANION_CONTROLLED_TABS } from "../../../shared/browser-companion";
import type {
  ChromeApi,
  ChromeTab,
  ChromeTabGroupColor,
  ChromeWebNavigationTargetDetails,
} from "../types/chrome";
import type { TabContextSummary } from "../types/protocol";

/**
 * Bot 彩色标签组与上下文隔离管理器。
 *
 * 原则：
 * - 打开侧栏默认追踪当前激活标签页上下文（带 attached 开关）；
 * - Bot 首次操控页面或新开链接时，自动创建/复用以当前 Bot 名命名的蓝色标签组（如「鲸鱼娘」）；
 * - 监听 webNavigation.onCreatedNavigationTarget（以及 tabs.onCreated.openerTabId 兜底），
 *   将受控标签页弹出的子标签自动收进同一标签组（上限 8 个），绝不触碰组外任何标签页；
 * - 支持 focusTab(tabId) 响应对话卡片上的「打开标签页」按钮。
 */

export const MAX_CONTROLLED_TABS = MAX_COMPANION_CONTROLLED_TABS;
const DEFAULT_GROUP_COLOR: ChromeTabGroupColor = "blue";

export interface TabGroupSnapshot {
  attached: boolean;
  activeTab: TabContextSummary | null;
  controlledTabIds: number[];
  tabGroupId: number | null;
  tabGroupBotName: string | null;
}

export interface TabGroupManagerOptions {
  chromeApi?: ChromeApi;
  maxTabs?: number;
  initialAttached?: boolean;
  onChange?: (snapshot: TabGroupSnapshot) => void;
  onControlledTabRemoved?: (tabId: number) => void;
}

export function createTabGroupManager(options: TabGroupManagerOptions = {}) {
  const api = options.chromeApi ?? chrome;
  const maxTabs = options.maxTabs ?? MAX_CONTROLLED_TABS;
  let attached = options.initialAttached ?? true;
  let activeTab: TabContextSummary | null = null;
  let tabGroupId: number | null = null;
  let tabGroupWindowId: number | null = null;
  let tabGroupBotName: string | null = null;
  const controlledTabs = new Set<number>();

  function toSummary(tab: ChromeTab): TabContextSummary | null {
    if (typeof tab.id !== "number") return null;
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? tab.pendingUrl ?? "",
      title: tab.title ?? "",
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      inBotGroup: controlledTabs.has(tab.id),
    };
  }

  function snapshot(): TabGroupSnapshot {
    return {
      attached,
      activeTab: activeTab
        ? { ...activeTab, inBotGroup: controlledTabs.has(activeTab.tabId) }
        : null,
      controlledTabIds: [...controlledTabs],
      tabGroupId,
      tabGroupBotName,
    };
  }

  function emitChange() {
    options.onChange?.(snapshot());
  }

  async function refreshActiveTab(): Promise<TabContextSummary | null> {
    try {
      const [tab] = await api.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab) {
        activeTab = toSummary(tab);
      } else {
        const [fallback] = await api.tabs.query({
          active: true,
          currentWindow: true,
        });
        activeTab = fallback ? toSummary(fallback) : null;
      }
    } catch {
      // 无可用窗口时保持空
    }
    emitChange();
    return activeTab;
  }

  function setAttached(next: boolean): void {
    if (attached === next) return;
    attached = next;
    emitChange();
  }

  function isControlledTab(tabId: number): boolean {
    return controlledTabs.has(tabId);
  }

  async function verifyGroupAlive(windowId: number): Promise<boolean> {
    if (tabGroupId === null || tabGroupWindowId !== windowId) return false;
    if (!api.tabGroups) return true;
    try {
      const group = await api.tabGroups.get(tabGroupId);
      return Boolean(group && group.windowId === windowId);
    } catch {
      tabGroupId = null;
      tabGroupWindowId = null;
      return false;
    }
  }

  /**
   * 将指定标签页归入当前 Bot 的彩色标签组（组内最多 maxTabs 个；绝不触碰组外标签页）。
   */
  async function ensureTabInBotGroup(
    tabId: number,
    botName: string,
    color: ChromeTabGroupColor = DEFAULT_GROUP_COLOR,
  ): Promise<{ groupId: number | null; tab: ChromeTab }> {
    const tab = await api.tabs.get(tabId);
    if (!controlledTabs.has(tabId) && controlledTabs.size >= maxTabs) {
      throw new Error(
        `当前 Bot 标签组已达上限（最多 ${maxTabs} 个受控标签页），请关闭不需要的标签页后再继续。`,
      );
    }

    const cleanName = botName.trim() || "ChisaBot";
    const reuseGroup = await verifyGroupAlive(tab.windowId);

    let nextGroupId = tabGroupId;
    if (reuseGroup && tabGroupId !== null) {
      if (tab.groupId !== tabGroupId) {
        nextGroupId = await api.tabs.group({
          groupId: tabGroupId,
          tabIds: [tabId],
        });
      }
    } else {
      nextGroupId = await api.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId: tab.windowId },
      });
      tabGroupWindowId = tab.windowId;
    }

    tabGroupId = nextGroupId;
    tabGroupBotName = cleanName;
    controlledTabs.add(tabId);

    if (api.tabGroups && nextGroupId !== null) {
      try {
        await api.tabGroups.update(nextGroupId, {
          title: cleanName,
          color,
        });
      } catch {
        // 标签组更新失败不应中断页面操作
      }
    }

    if (activeTab?.tabId === tabId) {
      activeTab = toSummary({ ...tab, groupId: nextGroupId ?? tab.groupId });
    }
    emitChange();
    return { groupId: nextGroupId, tab };
  }

  async function openTabInBotGroup(
    url: string,
    botName: string,
    opts: { active?: boolean } = {},
  ): Promise<ChromeTab> {
    if (controlledTabs.size >= maxTabs) {
      throw new Error(
        `当前 Bot 标签组已达上限（最多 ${maxTabs} 个受控标签页），无法继续打开新标签页。`,
      );
    }
    const created = await api.tabs.create({
      url,
      active: opts.active ?? false,
      ...(tabGroupWindowId !== null ? { windowId: tabGroupWindowId } : {}),
    });
    if (typeof created.id === "number") {
      await ensureTabInBotGroup(created.id, botName);
    }
    return created;
  }

  async function listControlledTabs(): Promise<
    Array<{
      tabId: number;
      url: string;
      title: string;
      active: boolean;
      inBotGroup: boolean;
    }>
  > {
    const ids = [...controlledTabs];
    const results: Array<{
      tabId: number;
      url: string;
      title: string;
      active: boolean;
      inBotGroup: boolean;
    }> = [];

    for (const id of ids) {
      try {
        const tab = await api.tabs.get(id);
        results.push({
          tabId: id,
          url: tab.url ?? tab.pendingUrl ?? "",
          title: tab.title ?? "",
          active: tab.active,
          inBotGroup: true,
        });
      } catch {
        controlledTabs.delete(id);
      }
    }

    // 若尚未建立受控标签，且当前已附着，列出当前附着页上下文（不自动改动组外标签）
    if (results.length === 0 && attached && activeTab) {
      try {
        const tab = await api.tabs.get(activeTab.tabId);
        results.push({
          tabId: activeTab.tabId,
          url: tab.url ?? tab.pendingUrl ?? "",
          title: tab.title ?? "",
          active: tab.active,
          inBotGroup: false,
        });
      } catch {
        // 忽略已关闭标签
      }
    }
    return results;
  }

  async function focusTab(tabId: number): Promise<boolean> {
    try {
      const tab = await api.tabs.update(tabId, { active: true });
      if (api.windows && typeof tab.windowId === "number") {
        await api.windows.update(tab.windowId, { focused: true });
      }
      activeTab = toSummary(tab);
      emitChange();
      return true;
    } catch {
      return false;
    }
  }

  async function adoptChildTab(
    sourceTabId: number,
    childTabId: number,
  ): Promise<boolean> {
    // 严格隔离：仅当来源标签属于当前受控标签集合时才吸纳，绝不触碰组外标签
    if (!controlledTabs.has(sourceTabId)) return false;
    if (controlledTabs.has(childTabId)) return true;
    if (controlledTabs.size >= maxTabs) return false;
    try {
      await ensureTabInBotGroup(childTabId, tabGroupBotName ?? "ChisaBot");
      return true;
    } catch {
      return false;
    }
  }

  function clearSessionGroupState(): void {
    controlledTabs.clear();
    tabGroupId = null;
    tabGroupWindowId = null;
    tabGroupBotName = null;
    emitChange();
  }

  const onActivated = (info: { tabId: number; windowId: number }) => {
    void api.tabs
      .get(info.tabId)
      .then((tab) => {
        activeTab = toSummary(tab);
        emitChange();
      })
      .catch(() => {});
  };

  const onUpdated = (
    tabId: number,
    changeInfo: { status?: string; url?: string; title?: string },
    tab: ChromeTab,
  ) => {
    if (
      activeTab?.tabId === tabId &&
      (changeInfo.url !== undefined ||
        changeInfo.title !== undefined ||
        changeInfo.status === "complete")
    ) {
      activeTab = toSummary(tab);
      emitChange();
    }
  };

  const onCreatedNavigationTarget = (
    details: ChromeWebNavigationTargetDetails,
  ) => {
    void adoptChildTab(details.sourceTabId, details.tabId);
  };

  const onTabCreated = (tab: ChromeTab) => {
    if (
      typeof tab.id === "number" &&
      typeof tab.openerTabId === "number" &&
      controlledTabs.has(tab.openerTabId)
    ) {
      void adoptChildTab(tab.openerTabId, tab.id);
    }
  };

  const onTabRemoved = (tabId: number) => {
    let changed = false;
    if (controlledTabs.delete(tabId)) {
      changed = true;
      options.onControlledTabRemoved?.(tabId);
      if (controlledTabs.size === 0) {
        tabGroupId = null;
        tabGroupWindowId = null;
      }
    }
    if (activeTab?.tabId === tabId) {
      activeTab = null;
      changed = true;
    }
    if (changed) emitChange();
  };

  const onGroupRemoved = (group: { id: number }) => {
    if (tabGroupId !== null && group.id === tabGroupId) {
      tabGroupId = null;
      tabGroupWindowId = null;
      emitChange();
    }
  };

  api.tabs.onActivated.addListener(onActivated);
  api.tabs.onUpdated.addListener(onUpdated);
  api.tabs.onCreated.addListener(onTabCreated);
  api.tabs.onRemoved.addListener(onTabRemoved);
  api.webNavigation?.onCreatedNavigationTarget.addListener(
    onCreatedNavigationTarget,
  );
  api.tabGroups?.onRemoved?.addListener(onGroupRemoved);

  function dispose(): void {
    api.tabs.onActivated.removeListener(onActivated);
    api.tabs.onUpdated.removeListener(onUpdated);
    api.tabs.onCreated.removeListener(onTabCreated);
    api.tabs.onRemoved.removeListener(onTabRemoved);
    api.webNavigation?.onCreatedNavigationTarget.removeListener(
      onCreatedNavigationTarget,
    );
    api.tabGroups?.onRemoved?.removeListener(onGroupRemoved);
  }

  return {
    snapshot,
    refreshActiveTab,
    setAttached,
    isControlledTab,
    ensureTabInBotGroup,
    openTabInBotGroup,
    listControlledTabs,
    focusTab,
    adoptChildTab,
    clearSessionGroupState,
    dispose,
  };
}

export type TabGroupManager = ReturnType<typeof createTabGroupManager>;
