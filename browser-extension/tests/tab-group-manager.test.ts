import { describe, expect, test } from "bun:test";
import {
  createTabGroupManager,
  MAX_CONTROLLED_TABS,
} from "../src/background/tab-group-manager";
import type {
  ChromeApi,
  ChromeTab,
  ChromeTabGroup,
  ChromeWebNavigationTargetDetails,
} from "../src/types/chrome";

function createFakeTabsChrome() {
  let nextTabId = 100;
  let nextGroupId = 500;
  const tabs = new Map<number, ChromeTab>();
  const groups = new Map<number, ChromeTabGroup>();
  const focusedWindows: number[] = [];

  const activatedCbs: Array<
    (info: { tabId: number; windowId: number }) => void
  > = [];
  const updatedCbs: Array<
    (
      tabId: number,
      change: { status?: string; url?: string; title?: string },
      tab: ChromeTab,
    ) => void
  > = [];
  const createdCbs: Array<(tab: ChromeTab) => void> = [];
  const removedCbs: Array<(tabId: number) => void> = [];
  const navTargetCbs: Array<
    (details: ChromeWebNavigationTargetDetails) => void
  > = [];

  function addTab(tab: ChromeTab) {
    if (typeof tab.id === "number") tabs.set(tab.id, tab);
  }

  addTab({
    id: 1,
    windowId: 10,
    index: 0,
    url: "https://dashboard.example.com",
    title: "仪表盘",
    active: true,
    groupId: -1,
  });
  addTab({
    id: 2,
    windowId: 10,
    index: 1,
    url: "https://personal.example.com",
    title: "用户自己的组外标签",
    active: false,
    groupId: -1,
  });

  const chromeApi = {
    tabs: {
      query: async (q: { active?: boolean }) => {
        const list = [...tabs.values()];
        return q.active ? list.filter((t) => t.active) : list;
      },
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        return tab;
      },
      create: async (props: {
        url?: string;
        active?: boolean;
        windowId?: number;
      }) => {
        nextTabId += 1;
        const tab: ChromeTab = {
          id: nextTabId,
          windowId: props.windowId ?? 10,
          index: tabs.size,
          url: props.url ?? "about:blank",
          title: props.url ?? "新标签页",
          active: props.active ?? false,
          groupId: -1,
        };
        tabs.set(nextTabId, tab);
        return tab;
      },
      update: async (
        tabId: number,
        props: { active?: boolean; url?: string },
      ) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        if (props.active) {
          for (const t of tabs.values()) {
            if (t.windowId === tab.windowId) t.active = t.id === tabId;
          }
        }
        if (props.url) tab.url = props.url;
        return tab;
      },
      group: async (opts: {
        tabIds: number | number[];
        groupId?: number;
        createProperties?: { windowId?: number };
      }) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        let gid = opts.groupId;
        if (gid === undefined) {
          nextGroupId += 1;
          gid = nextGroupId;
          groups.set(gid, {
            id: gid,
            windowId: opts.createProperties?.windowId ?? 10,
            collapsed: false,
            color: "grey",
            title: "",
          });
        }
        for (const id of ids) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        return gid;
      },
      onActivated: {
        addListener: (
          cb: (info: { tabId: number; windowId: number }) => void,
        ) => activatedCbs.push(cb),
        removeListener: () => {},
      },
      onUpdated: {
        addListener: (
          cb: (
            tabId: number,
            change: { status?: string; url?: string; title?: string },
            tab: ChromeTab,
          ) => void,
        ) => updatedCbs.push(cb),
        removeListener: () => {},
      },
      onCreated: {
        addListener: (cb: (tab: ChromeTab) => void) => createdCbs.push(cb),
        removeListener: () => {},
      },
      onRemoved: {
        addListener: (cb: (tabId: number) => void) => removedCbs.push(cb),
        removeListener: () => {},
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (groupId: number) => {
        const g = groups.get(groupId);
        if (!g) throw new Error("Group not found");
        return g;
      },
      update: async (
        groupId: number,
        props: { title?: string; color?: ChromeTabGroup["color"] },
      ) => {
        const g = groups.get(groupId);
        if (!g) throw new Error("Group not found");
        if (props.title !== undefined) g.title = props.title;
        if (props.color !== undefined) g.color = props.color;
        return g;
      },
    },
    windows: {
      update: async (windowId: number, info: { focused?: boolean }) => {
        if (info.focused) focusedWindows.push(windowId);
      },
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: (
          cb: (details: ChromeWebNavigationTargetDetails) => void,
        ) => navTargetCbs.push(cb),
        removeListener: () => {},
      },
    },
  } as unknown as ChromeApi;

  return {
    chromeApi,
    tabs,
    groups,
    focusedWindows,
    addTab,
    emitNavTarget: (sourceTabId: number, tabId: number, url: string) => {
      for (const cb of navTargetCbs) {
        cb({
          sourceTabId,
          sourceProcessId: 1,
          sourceFrameId: 0,
          url,
          tabId,
          timeStamp: Date.now(),
        });
      }
    },
  };
}

describe("Bot 彩色标签组与组外隔离", () => {
  test("创建蓝色 Bot 标签组并自动收拢受控页弹出的子标签，绝不触碰组外标签", async () => {
    const fake = createFakeTabsChrome();
    const mgr = createTabGroupManager({ chromeApi: fake.chromeApi });

    const active = await mgr.refreshActiveTab();
    expect(active?.tabId).toBe(1);
    expect(mgr.snapshot().attached).toBe(true);

    // Bot 首次操控 tab 1 -> 创建以 Bot 名命名的蓝色标签组
    const { groupId } = await mgr.ensureTabInBotGroup(1, "鲸鱼娘");
    expect(groupId).not.toBeNull();
    const group = groupId !== null ? fake.groups.get(groupId) : undefined;
    expect(group?.title).toBe("鲸鱼娘");
    expect(group?.color).toBe("blue");

    // 组外标签 tab 2 保持未分组
    expect(fake.tabs.get(2)?.groupId).toBe(-1);
    expect(mgr.isControlledTab(2)).toBe(false);

    // 受控页 tab 1 弹出子标签 tab 3 -> 自动收进同一标签组
    fake.addTab({
      id: 3,
      windowId: 10,
      index: 2,
      url: "https://dashboard.example.com/detail",
      title: "监控详情",
      active: false,
      groupId: -1,
    });
    fake.emitNavTarget(1, 3, "https://dashboard.example.com/detail");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.tabs.get(3)?.groupId).toBe(groupId ?? -999);
    expect(mgr.isControlledTab(3)).toBe(true);

    // 组外标签 tab 2 弹出子标签 tab 4 -> 绝不能被吸纳进 Bot 标签组！
    fake.addTab({
      id: 4,
      windowId: 10,
      index: 3,
      url: "https://personal.example.com/mail",
      title: "私人邮件",
      active: false,
      groupId: -1,
    });
    fake.emitNavTarget(2, 4, "https://personal.example.com/mail");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.tabs.get(4)?.groupId).toBe(-1);
    expect(mgr.isControlledTab(4)).toBe(false);

    mgr.dispose();
  });

  test("受控标签组严格限制最多 8 个标签，且支持 focusTab 聚焦", async () => {
    const fake = createFakeTabsChrome();
    const mgr = createTabGroupManager({ chromeApi: fake.chromeApi });

    await mgr.ensureTabInBotGroup(1, "鲸鱼娘");
    for (let i = 2; i <= MAX_CONTROLLED_TABS; i += 1) {
      await mgr.openTabInBotGroup(`https://example.com/${i}`, "鲸鱼娘");
    }
    expect(mgr.snapshot().controlledTabIds.length).toBe(MAX_CONTROLLED_TABS);

    // 第 9 个标签被拒绝
    await expect(
      mgr.openTabInBotGroup("https://example.com/9", "鲸鱼娘"),
    ).rejects.toThrow("已达上限");

    // 响应卡片「打开标签页」
    const ok = await mgr.focusTab(1);
    expect(ok).toBe(true);
    expect(fake.tabs.get(1)?.active).toBe(true);
    expect(fake.focusedWindows).toContain(10);

    mgr.dispose();
  });
});
