import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPANION_EXTENSION_CONFIG } from "../../shared/browser-companion";
import {
  checkExplicitTabScope,
  evaluateLocalCallRisk,
  planSafeNavigationTarget,
} from "../src/background/call-guard";
import { initializeBackgroundRuntime } from "../src/background/index";
import { defaultSettings } from "../src/background/storage";
import type { WsLike } from "../src/background/ws-client";
import type { ChromeApi, ChromeTab } from "../src/types/chrome";

class TestWs implements WsLike {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event: unknown = {}) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(event);
    }
  }
}

function createHarnessChrome(options?: {
  delayStorageMs?: number;
  initialTabs?: ChromeTab[];
  initialStorage?: Record<string, unknown>;
}) {
  const storageData: Record<string, unknown> = {
    ...(options?.initialStorage ?? {}),
  };
  const tabs = new Map<number, ChromeTab>();
  let nextTabId = 200;
  let nextGroupId = 700;
  for (const t of options?.initialTabs ?? [
    {
      id: 1,
      windowId: 10,
      index: 0,
      url: "https://vault.bitwarden.com/#/vault",
      title: "Bitwarden Vault",
      active: true,
      groupId: -1,
      status: "complete",
    },
    {
      id: 99,
      windowId: 10,
      index: 1,
      url: "https://personal.example.com",
      title: "私人组外标签",
      active: false,
      groupId: -1,
      status: "complete",
    },
  ]) {
    if (typeof t.id === "number") tabs.set(t.id, { ...t });
  }

  const listenerCounts = {
    actionClicked: 0,
    onConnect: 0,
    onMessage: 0,
    tabsActivated: 0,
    tabsUpdated: 0,
    tabsCreated: 0,
    tabsRemoved: 0,
    navTarget: 0,
    debuggerDetach: 0,
  };

  let messageHandler:
    | ((
        msg: unknown,
        sender: unknown,
        sendResponse: (res?: unknown) => void,
      ) => boolean | undefined)
    | null = null;

  const groupedCalls: number[] = [];
  const attachedDebuggerTabs: number[] = [];
  const createdTabs: Array<{ id: number; url?: string }> = [];

  const chromeApi = {
    runtime: {
      id: "test-ext",
      getManifest: () => ({ version: "0.1.192", name: "ChisaBot 浏览器伴侣" }),
      getURL: (p: string) => `chrome-extension://test-ext/${p}`,
      onConnect: {
        addListener: () => {
          listenerCounts.onConnect += 1;
        },
        removeListener: () => {},
      },
      onMessage: {
        addListener: (
          cb: (
            msg: unknown,
            sender: unknown,
            sendResponse: (res?: unknown) => void,
          ) => boolean | undefined,
        ) => {
          listenerCounts.onMessage += 1;
          messageHandler = cb;
        },
        removeListener: () => {
          messageHandler = null;
        },
      },
      onInstalled: { addListener: () => {}, removeListener: () => {} },
    },
    action: {
      onClicked: {
        addListener: () => {
          listenerCounts.actionClicked += 1;
        },
        removeListener: () => {},
      },
    },
    sidePanel: {
      open: async () => {},
      setPanelBehavior: async () => {},
    },
    storage: {
      local: {
        get: async (key: string) => {
          if (options?.delayStorageMs) {
            await new Promise((r) => setTimeout(r, options.delayStorageMs));
          }
          return { [key]: storageData[key] };
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(storageData, items);
        },
        remove: async (key: string) => {
          delete storageData[key];
        },
        clear: async () => {},
      },
    },
    tabs: {
      query: async (q: { active?: boolean }) => {
        const list = [...tabs.values()];
        return q.active ? list.filter((t) => t.active) : list;
      },
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
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
          status: "complete",
        };
        tabs.set(nextTabId, tab);
        createdTabs.push({ id: nextTabId, url: props.url });
        return tab;
      },
      update: async (
        tabId: number,
        props: { active?: boolean; url?: string },
      ) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
        if (props.url) tab.url = props.url;
        if (props.active) tab.active = true;
        return tab;
      },
      remove: async (tabId: number) => {
        tabs.delete(tabId);
      },
      group: async (opts: { tabIds: number | number[]; groupId?: number }) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        const gid = opts.groupId ?? ++nextGroupId;
        for (const id of ids) {
          groupedCalls.push(id);
          const tab = tabs.get(id);
          if (tab) tab.groupId = gid;
        }
        return gid;
      },
      sendMessage: async () => ({ ok: true }),
      onActivated: {
        addListener: () => {
          listenerCounts.tabsActivated += 1;
        },
        removeListener: () => {},
      },
      onUpdated: {
        addListener: () => {
          listenerCounts.tabsUpdated += 1;
        },
        removeListener: () => {},
      },
      onCreated: {
        addListener: () => {
          listenerCounts.tabsCreated += 1;
        },
        removeListener: () => {},
      },
      onRemoved: {
        addListener: () => {
          listenerCounts.tabsRemoved += 1;
        },
        removeListener: () => {},
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (id: number) => ({
        id,
        windowId: 10,
        collapsed: false,
        color: "blue" as const,
        title: "鲸鱼娘",
      }),
      update: async (id: number) => ({
        id,
        windowId: 10,
        collapsed: false,
        color: "blue" as const,
        title: "鲸鱼娘",
      }),
    },
    windows: {
      update: async () => ({}),
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: () => {
          listenerCounts.navTarget += 1;
        },
        removeListener: () => {},
      },
    },
    scripting: {
      executeScript: async () => [{ frameId: 0, result: { ok: true } }],
    },
    debugger: {
      attach: async (target: { tabId?: number }) => {
        if (typeof target.tabId === "number") {
          attachedDebuggerTabs.push(target.tabId);
        }
      },
      detach: async () => {},
      sendCommand: async (
        target: { tabId?: number },
        method: string,
        params?: Record<string, unknown>,
      ) => {
        const tabId = target.tabId ?? 0;
        if (method === "Page.navigate" && typeof params?.url === "string") {
          const tab = tabs.get(tabId);
          if (tab) {
            tab.url = params.url;
            tab.title = "安全目标页";
          }
          return {};
        }
        if (method === "Runtime.evaluate") {
          const tab = tabs.get(tabId);
          return {
            result: {
              value: {
                url: tab?.url ?? "",
                title: tab?.title ?? "",
                text: "页面正文",
              },
            },
          };
        }
        if (method === "Page.captureScreenshot") {
          return { data: "ZmFrZQ==" };
        }
        return {};
      },
      onDetach: {
        addListener: () => {
          listenerCounts.debuggerDetach += 1;
        },
        removeListener: () => {},
      },
    },
  } as unknown as ChromeApi;

  function sendRuntimeMessage(msg: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      if (!messageHandler) throw new Error("onMessage not registered!");
      const keepAlive = messageHandler(msg, {}, (res) => resolve(res));
      expect(keepAlive).toBe(true);
    });
  }

  return {
    chromeApi,
    listenerCounts,
    groupedCalls,
    attachedDebuggerTabs,
    createdTabs,
    sendRuntimeMessage,
  };
}

describe("MV3 Service Worker 同步注册、标签隔离与会话管理回归", () => {
  test("defaultSettings.allowRemoteDispatch 与 shared 默认值一致为 false", () => {
    expect(defaultSettings().allowRemoteDispatch).toBe(
      DEFAULT_COMPANION_EXTENSION_CONFIG.allowRemoteDispatch,
    );
    expect(defaultSettings().allowRemoteDispatch).toBe(false);
  });

  test("所有 MV3 监听器在顶层同步注册（零 await 阻断），冷启动首条消息绝不丢失", async () => {
    const harness = createHarnessChrome({
      delayStorageMs: 30,
      initialStorage: {
        chisabot_companion_auth_v1: {
          serverUrl: "https://bot.example.com:8443",
          deviceToken: "cbd_cold_start_token",
          deviceId: "dev-cold",
          deviceName: "Chrome 伴侣",
          enrolledAt: "2026-11-28T00:00:00.000Z",
        },
      },
    });

    const runtime = initializeBackgroundRuntime({
      chromeApi: harness.chromeApi,
      createWebSocket: () => new TestWs(),
    });

    // 同步断言（0 microtask 前所有事件监听器已经就位）
    expect(harness.listenerCounts.actionClicked).toBe(1);
    expect(harness.listenerCounts.onConnect).toBe(1);
    expect(harness.listenerCounts.onMessage).toBe(1);
    expect(harness.listenerCounts.tabsActivated).toBe(1);
    expect(harness.listenerCounts.tabsUpdated).toBe(1);
    expect(harness.listenerCounts.tabsCreated).toBe(1);
    expect(harness.listenerCounts.tabsRemoved).toBe(1);
    expect(harness.listenerCounts.navTarget).toBe(1);
    expect(harness.listenerCounts.debuggerDetach).toBe(1);

    // 立刻在 storage 尚未完成加载时派发消息，不丢事件并等到恢复完成才返回
    const resp = (await harness.sendRuntimeMessage({
      type: "PANEL_GET_STATE",
    })) as {
      ok: boolean;
      state: {
        auth: { deviceId: string } | null;
        settings: { allowRemoteDispatch: boolean };
      };
    };
    expect(resp.ok).toBe(true);
    expect(resp.state.auth?.deviceId).toBe("dev-cold");
    expect(resp.state.settings.allowRemoteDispatch).toBe(false);

    runtime.dispose();
  });

  test("call-guard 严格阻止显式越界 tabId、newTab 黑名单以及劫持黑名单标签页", () => {
    const snap = {
      attached: true,
      activeTab: {
        tabId: 1,
        windowId: 10,
        url: "https://vault.bitwarden.com/#/vault",
        title: "Vault",
        inBotGroup: false,
      },
      controlledTabIds: [10, 11],
    };

    // 1. 显式 tabId 指向组外用户标签 99 -> 拒绝
    expect(checkExplicitTabScope(99, snap).allowed).toBe(false);
    // 2. 组内标签 10 与已附着当前标签 1 -> 允许
    expect(checkExplicitTabScope(10, snap).allowed).toBe(true);
    expect(checkExplicitTabScope(1, snap).allowed).toBe(true);

    // 3. newTab 目标命中黑名单 -> 直接 deny，绝不开新标签
    const blockedNewTab = planSafeNavigationTarget({
      targetUrl: "https://ebank.icbc.com.cn/pay",
      newTab: true,
      explicitTabId: null,
      candidateTabId: 10,
      candidateCurrentUrl: "https://example.com",
      tabGroupSnapshot: snap,
      blockedDomains: ["icbc.com.cn"],
    });
    expect(blockedNewTab.ok).toBe(false);
    expect(blockedNewTab.mode).toBe("deny");

    // 4. 当前活跃页是黑名单站点且 Bot 要导航到安全站点（未指定 tabId）-> 强制新开干净标签页，绝不触碰黑名单页
    const isolateFromBlocked = planSafeNavigationTarget({
      targetUrl: "https://example.com/docs",
      newTab: false,
      explicitTabId: null,
      candidateTabId: 1,
      candidateCurrentUrl: "https://vault.bitwarden.com/#/vault",
      tabGroupSnapshot: snap,
      blockedDomains: [],
    });
    expect(isolateFromBlocked).toEqual({ ok: true, mode: "open_new_tab" });

    // 5. 显式指定黑名单 tabId 导航 -> 直接 deny
    const explicitBlockedTab = planSafeNavigationTarget({
      targetUrl: "https://example.com/docs",
      newTab: false,
      explicitTabId: 1,
      candidateTabId: 1,
      candidateCurrentUrl: "https://vault.bitwarden.com/#/vault",
      tabGroupSnapshot: snap,
      blockedDomains: [],
    });
    expect(explicitBlockedTab.ok).toBe(false);
    expect(explicitBlockedTab.mode).toBe("deny");

    // 6. 本地风控同时检查当前标签页 URL，黑名单页上任何非导航操作直接 deny
    expect(
      evaluateLocalCallRisk({
        tier: "full",
        operation: "browser_read",
        currentTabUrl: "https://vault.bitwarden.com/#/vault",
        blockedDomains: [],
      }).decision,
    ).toBe("deny");
  });

  test("实战运行态：在黑名单活跃页导航安全地址时绝不对黑名单页收组或挂接 CDP，且拒绝操作组外 tabId", async () => {
    const wsInstances: TestWs[] = [];
    const harness = createHarnessChrome({
      initialStorage: {
        chisabot_companion_auth_v1: {
          serverUrl: "https://bot.example.com:8443",
          deviceToken: "cbd_nav_token",
          deviceId: "dev-nav",
          deviceName: "Chrome 伴侣",
          enrolledAt: "2026-11-28T00:00:00.000Z",
        },
        chisabot_companion_settings_v1: {
          tier: "full",
          blockedDomains: ["icbc.com.cn"],
          allowRemoteDispatch: false,
          attachedByDefault: true,
        },
      },
    });

    const runtime = initializeBackgroundRuntime({
      chromeApi: harness.chromeApi,
      createWebSocket: () => {
        const ws = new TestWs();
        wsInstances.push(ws);
        return ws;
      },
    });
    await runtime.readyPromise;
    const ws = wsInstances[0]!;
    ws.emit("open");

    // 1. 当前活跃页 tab 1 是 Bitwarden（内置黑名单），Bot 调用 browser_navigate({ url: "https://example.com" })
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "nav-safe",
        operation: "browser_navigate",
        args: { url: "https://example.com" },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const navResult = ws.sent.find(
      (m) => m.type === "result" && m.id === "nav-safe",
    );
    expect(navResult?.ok).toBe(true);
    // 黑名单原标签 tab 1 绝未被收组，也绝未被挂接 CDP！
    expect(harness.groupedCalls).not.toContain(1);
    expect(harness.attachedDebuggerTabs).not.toContain(1);
    // 而是新开了受控标签页 tab 201
    expect(harness.createdTabs.length).toBe(1);
    expect(harness.attachedDebuggerTabs).toContain(201);

    // 2. browser_navigate({ url: "https://ebank.icbc.com.cn", newTab: true }) 必须前置拦截，绝不新开标签页
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "nav-blocked-new",
        operation: "browser_navigate",
        args: { url: "https://ebank.icbc.com.cn", newTab: true },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const blockedNewRes = ws.sent.find(
      (m) => m.type === "result" && m.id === "nav-blocked-new",
    );
    expect(blockedNewRes?.ok).toBe(false);
    expect(harness.createdTabs.length).toBe(1);

    // 3. 显式 tabId: 99（组外私人标签）调用 browser_tabs(activate) 与 browser_read 必须被拒绝
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "outside-activate",
        operation: "browser_tabs",
        args: { action: "activate", tabId: 99 },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "outside-read",
        operation: "browser_read",
        args: { tabId: 99 },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(
      ws.sent.find((m) => m.type === "result" && m.id === "outside-activate")
        ?.ok,
    ).toBe(false);
    expect(
      ws.sent.find((m) => m.type === "result" && m.id === "outside-read")?.ok,
    ).toBe(false);
    expect(harness.groupedCalls).not.toContain(99);
    expect(harness.attachedDebuggerTabs).not.toContain(99);

    runtime.dispose();
  });

  test("PANEL_OPEN_THREAD({ fresh: true }) 清空后台旧 activeThreadId 并向服务端创建新会话", async () => {
    const openThreadBodies: Array<Record<string, unknown>> = [];
    const harness = createHarnessChrome({
      initialStorage: {
        chisabot_companion_auth_v1: {
          serverUrl: "https://bot.example.com:8443",
          deviceToken: "cbd_thread_token",
          deviceId: "dev-thread",
          deviceName: "Chrome 伴侣",
          enrolledAt: "2026-11-28T00:00:00.000Z",
        },
      },
    });

    const runtime = initializeBackgroundRuntime({
      chromeApi: harness.chromeApi,
      createWebSocket: () => new TestWs(),
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/api/devices/agent/companion/open-thread")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          openThreadBodies.push(body);
          const isFresh = body.fresh === true;
          return new Response(
            JSON.stringify({
              channelId: isFresh ? "thread-new-2" : "thread-old-1",
              threadId: isFresh ? "thread-new-2" : "thread-old-1",
              botId: String(body.botId ?? "bot-1"),
              running: false,
              messages: [],
              history: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await runtime.readyPromise;

    await harness.sendRuntimeMessage({
      type: "PANEL_OPEN_THREAD",
      botId: "bot-1",
    });
    expect(runtime.getActiveThreadId()).toBe("thread-old-1");

    await harness.sendRuntimeMessage({
      type: "PANEL_OPEN_THREAD",
      botId: "bot-1",
      fresh: true,
    });
    expect(runtime.getActiveThreadId()).toBe("thread-new-2");
    expect(openThreadBodies[1]).toEqual({ botId: "bot-1", fresh: true });

    runtime.dispose();
  });
});
