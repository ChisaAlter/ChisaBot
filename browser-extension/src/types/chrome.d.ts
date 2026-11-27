/**
 * 精简精准的 Chrome / Edge Manifest V3 API 类型声明（零外部 @types/chrome 依赖）。
 */

export interface ChromeEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener?(callback: T): boolean;
}

export interface ChromeTab {
  id?: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  active: boolean;
  groupId: number;
  openerTabId?: number;
  status?: "unloaded" | "loading" | "complete";
}

export type ChromeTabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface ChromeTabGroup {
  id: number;
  windowId: number;
  collapsed: boolean;
  color: ChromeTabGroupColor;
  title?: string;
}

export interface ChromeDebuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

export interface ChromePort {
  name: string;
  sender?: ChromeMessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown, port: ChromePort) => void>;
  onDisconnect: ChromeEvent<(port: ChromePort) => void>;
}

export interface ChromeMessageSender {
  tab?: ChromeTab;
  frameId?: number;
  id?: string;
  url?: string;
  origin?: string;
}

export interface ChromeStorageArea {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ChromeWebNavigationTargetDetails {
  sourceTabId: number;
  sourceProcessId: number;
  sourceFrameId: number;
  url: string;
  tabId: number;
  timeStamp: number;
}

export interface ChromeApi {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getManifest(): { version: string; name: string; [key: string]: unknown };
    getURL(path: string): string;
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    connect(connectInfo?: { name?: string }): ChromePort;
    onMessage: ChromeEvent<
      (
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | undefined
    >;
    onConnect: ChromeEvent<(port: ChromePort) => void>;
    onInstalled: ChromeEvent<(details: { reason: string }) => void>;
  };
  action?: {
    onClicked: ChromeEvent<(tab: ChromeTab) => void>;
    setBadgeText?(details: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor?(details: {
      color: string;
      tabId?: number;
    }): Promise<void>;
  };
  sidePanel?: {
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
    setPanelBehavior?(options: {
      openPanelOnActionClick?: boolean;
    }): Promise<void>;
  };
  tabs: {
    TAB_ID_NONE?: number;
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
      groupId?: number;
      windowId?: number;
      url?: string | string[];
    }): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(createProperties: {
      url?: string;
      active?: boolean;
      windowId?: number;
      openerTabId?: number;
    }): Promise<ChromeTab>;
    update(
      tabId: number,
      updateProperties: { url?: string; active?: boolean },
    ): Promise<ChromeTab>;
    remove(tabIds: number | number[]): Promise<void>;
    group(options: {
      tabIds: number | number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }): Promise<number>;
    ungroup(tabIds: number | number[]): Promise<void>;
    sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    onActivated: ChromeEvent<
      (activeInfo: { tabId: number; windowId: number }) => void
    >;
    onUpdated: ChromeEvent<
      (
        tabId: number,
        changeInfo: { status?: string; url?: string; title?: string },
        tab: ChromeTab,
      ) => void
    >;
    onCreated: ChromeEvent<(tab: ChromeTab) => void>;
    onRemoved: ChromeEvent<
      (
        tabId: number,
        removeInfo: { windowId: number; isWindowClosing: boolean },
      ) => void
    >;
  };
  tabGroups?: {
    TAB_GROUP_ID_NONE: number;
    get(groupId: number): Promise<ChromeTabGroup>;
    update(
      groupId: number,
      updateProperties: {
        title?: string;
        color?: ChromeTabGroupColor;
        collapsed?: boolean;
      },
    ): Promise<ChromeTabGroup>;
    onRemoved?: ChromeEvent<(group: ChromeTabGroup) => void>;
  };
  windows?: {
    update(
      windowId: number,
      updateInfo: { focused?: boolean },
    ): Promise<unknown>;
  };
  debugger: {
    attach(target: ChromeDebuggee, requiredVersion: string): Promise<void>;
    detach(target: ChromeDebuggee): Promise<void>;
    sendCommand<T = unknown>(
      target: ChromeDebuggee,
      method: string,
      commandParams?: Record<string, unknown>,
    ): Promise<T>;
    onDetach: ChromeEvent<(source: ChromeDebuggee, reason: string) => void>;
    onEvent?: ChromeEvent<
      (source: ChromeDebuggee, method: string, params?: unknown) => void
    >;
  };
  scripting: {
    executeScript<T = unknown, A extends unknown[] = unknown[]>(injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: (...args: A) => T | Promise<T>;
      args?: A;
      world?: "ISOLATED" | "MAIN";
    }): Promise<Array<{ frameId: number; result?: T }>>;
  };
  storage: {
    local: ChromeStorageArea;
    session?: ChromeStorageArea;
    onChanged?: ChromeEvent<
      (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        areaName: string,
      ) => void
    >;
  };
  webNavigation?: {
    onCreatedNavigationTarget: ChromeEvent<
      (details: ChromeWebNavigationTargetDetails) => void
    >;
  };
}

declare global {
  const chrome: ChromeApi;
}
