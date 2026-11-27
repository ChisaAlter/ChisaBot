import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assessBrowserActionRisk,
  BROWSER_COMPANION_OPERATIONS,
  BROWSER_PERMISSION_INFO,
  type BrowserActionRiskAssessment,
  type BrowserCompanionOperation,
  type BrowserCompanionSession,
  type BrowserSnapshotElement,
  type BrowserSnapshotResult,
  type CompanionAttachedTabContext,
  type CompanionExtensionConfig,
  type CompanionSettingsPatch,
  type CompanionStateReport,
  type CompanionTabSession,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  DEFAULT_COMPANION_EXTENSION_CONFIG,
  normalizeBlockedDomains,
  normalizeBrowserPermissionTier,
  normalizeCompanionExtensionConfig,
  reduceBrowserCompanionSession,
} from "../../../shared/browser-companion";
import {
  isBrowserExtensionPlatform,
  OPERATION_LABEL,
} from "../../../shared/devices";
import type { AuditInitiator } from "../audit";
import { redactText, redactUrl } from "../computer/activity-redact";
import {
  currentConfirmToolCall,
  currentConfirmTurn,
  currentToolAbort,
  TOOL_STOPPED_ZH,
  withConfirmInteractive,
} from "../confirmations/context";
import { deviceLinkableInitiator } from "../confirmations/service";
import { emitToolImage } from "../conversations/tool-images";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { withUntrustedNotice } from "../untrusted-content";
import { type DeviceHub, DeviceRefusedError } from "./hub";
import type { DeviceRecord, DeviceStore } from "./store";

const MAX_SNAPSHOTS_PER_DEVICE = 32;
const SNAPSHOT_TTL_MS = 15 * 60_000;
const MAX_SNAPSHOT_ELEMENTS = 1000;
const MAX_TEXT_CHARS = 400;
const MAX_PAGE_TEXT_CHARS = 24_000;

export const STALE_BROWSER_SNAPSHOT_ERROR =
  "元素引用在服务端快照缓存中不存在或已过期，请先重新调用 browser_snapshot 获取最新页面快照后再操作。";

export type StoredBrowserSnapshot = {
  ownerUserId: string;
  deviceId: string;
  snapshotId: number;
  tabId: number | null;
  url: string;
  title: string;
  elements: Map<string, BrowserSnapshotElement>;
  capturedAt: number;
};

export type BrowserSnapshotResolveResult =
  | {
      ok: true;
      snapshot: StoredBrowserSnapshot;
      element: BrowserSnapshotElement;
    }
  | {
      ok: false;
      code: "STALE_SNAPSHOT";
      error: string;
    };

function partitionKey(ownerUserId: string, deviceId: string): string {
  return JSON.stringify([ownerUserId, deviceId]);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanTabId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeSnapshotElement(raw: unknown): BrowserSnapshotElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const ref = typeof obj.ref === "string" ? obj.ref.trim() : "";
  if (!ref || ref.length > 64) return null;
  const role =
    typeof obj.role === "string" && obj.role.trim()
      ? clip(obj.role.trim(), 80)
      : "generic";
  const name =
    typeof obj.name === "string" ? clip(obj.name.trim(), MAX_TEXT_CHARS) : "";
  const type =
    typeof obj.type === "string" && obj.type.trim()
      ? clip(obj.type.trim().toLowerCase(), 40)
      : undefined;
  const isPassword = type === "password";
  const value =
    !isPassword && typeof obj.value === "string"
      ? clip(obj.value, MAX_TEXT_CHARS)
      : undefined;
  const options = Array.isArray(obj.options)
    ? obj.options
        .filter((item): item is string => typeof item === "string")
        .slice(0, 100)
        .map((item) => clip(item, 120))
    : undefined;
  const backendDOMNodeId =
    typeof obj.backendDOMNodeId === "number" &&
    Number.isInteger(obj.backendDOMNodeId) &&
    obj.backendDOMNodeId > 0
      ? obj.backendDOMNodeId
      : undefined;
  return {
    ref,
    role,
    name,
    ...(value !== undefined ? { value } : {}),
    ...(type ? { type } : {}),
    ...(typeof obj.disabled === "boolean" ? { disabled: obj.disabled } : {}),
    ...(typeof obj.checked === "boolean" ? { checked: obj.checked } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(backendDOMNodeId !== undefined ? { backendDOMNodeId } : {}),
  };
}

/**
 * 服务端浏览器伴侣快照缓存：
 * - 严格按 `(ownerUserId, deviceId)` 分区隔离，防止跨用户/跨设备引用串台；
 * - 每次 `browser_click` / `browser_type` / `browser_key` 只能从本缓存按 `(snapshotId, ref)`
 *   解析真实元素的 `role` / `name` / `type` 与页面 `url`，彻底杜绝模型伪造标签绕过高危或付款审批；
 * - 设备断连、紧急停止或撤销时立即清空全部缓存快照。
 */
export function createBrowserCompanionSnapshotStore(options?: {
  now?: () => number;
  maxSnapshotsPerDevice?: number;
  ttlMs?: number;
}) {
  const now = options?.now ?? Date.now;
  const maxSnapshotsPerDevice = Math.max(
    1,
    options?.maxSnapshotsPerDevice ?? MAX_SNAPSHOTS_PER_DEVICE,
  );
  const ttlMs = Math.max(1_000, options?.ttlMs ?? SNAPSHOT_TTL_MS);

  const partitions = new Map<
    string,
    {
      ownerUserId: string;
      deviceId: string;
      latestSnapshotId: number | null;
      snapshots: Map<number, StoredBrowserSnapshot>;
    }
  >();

  function pruneExpired(
    bucket: Map<number, StoredBrowserSnapshot>,
    currentTime: number,
  ) {
    for (const [id, snapshot] of bucket) {
      if (currentTime - snapshot.capturedAt > ttlMs) {
        bucket.delete(id);
      }
    }
  }

  return {
    saveSnapshot(input: {
      ownerUserId: string;
      deviceId: string;
      snapshotId: number;
      tabId?: number | null;
      url: string;
      title: string;
      elements: readonly unknown[];
    }): StoredBrowserSnapshot {
      const currentTime = now();
      const key = partitionKey(input.ownerUserId, input.deviceId);
      let partition = partitions.get(key);
      if (!partition) {
        partition = {
          ownerUserId: input.ownerUserId,
          deviceId: input.deviceId,
          latestSnapshotId: null,
          snapshots: new Map(),
        };
        partitions.set(key, partition);
      }
      pruneExpired(partition.snapshots, currentTime);

      const snapshotId =
        Number.isSafeInteger(input.snapshotId) && input.snapshotId > 0
          ? input.snapshotId
          : (partition.latestSnapshotId ?? 0) + 1;
      const elements = new Map<string, BrowserSnapshotElement>();
      for (const rawItem of input.elements.slice(0, MAX_SNAPSHOT_ELEMENTS)) {
        const clean = sanitizeSnapshotElement(rawItem);
        if (clean) elements.set(clean.ref, clean);
      }
      const stored: StoredBrowserSnapshot = {
        ownerUserId: input.ownerUserId,
        deviceId: input.deviceId,
        snapshotId,
        tabId: cleanTabId(input.tabId),
        url: typeof input.url === "string" ? input.url.slice(0, 4000) : "",
        title: typeof input.title === "string" ? clip(input.title, 300) : "",
        elements,
        capturedAt: currentTime,
      };
      partition.snapshots.delete(snapshotId);
      partition.snapshots.set(snapshotId, stored);
      partition.latestSnapshotId = snapshotId;
      while (partition.snapshots.size > maxSnapshotsPerDevice) {
        const oldest = partition.snapshots.keys().next().value;
        if (oldest === undefined) break;
        partition.snapshots.delete(oldest);
      }
      return stored;
    },

    resolveElement(
      ownerUserId: string,
      deviceId: string,
      snapshotId: number | undefined,
      ref: string | undefined,
    ): BrowserSnapshotResolveResult {
      if (
        typeof snapshotId !== "number" ||
        !Number.isSafeInteger(snapshotId) ||
        snapshotId <= 0 ||
        typeof ref !== "string" ||
        !ref.trim()
      ) {
        return {
          ok: false,
          code: "STALE_SNAPSHOT",
          error: STALE_BROWSER_SNAPSHOT_ERROR,
        };
      }
      const partition = partitions.get(partitionKey(ownerUserId, deviceId));
      if (!partition) {
        return {
          ok: false,
          code: "STALE_SNAPSHOT",
          error: STALE_BROWSER_SNAPSHOT_ERROR,
        };
      }
      const snapshot = partition.snapshots.get(snapshotId);
      if (!snapshot) {
        return {
          ok: false,
          code: "STALE_SNAPSHOT",
          error: STALE_BROWSER_SNAPSHOT_ERROR,
        };
      }
      if (now() - snapshot.capturedAt > ttlMs) {
        partition.snapshots.delete(snapshotId);
        return {
          ok: false,
          code: "STALE_SNAPSHOT",
          error: STALE_BROWSER_SNAPSHOT_ERROR,
        };
      }
      const element = snapshot.elements.get(ref.trim());
      if (!element) {
        return {
          ok: false,
          code: "STALE_SNAPSHOT",
          error: STALE_BROWSER_SNAPSHOT_ERROR,
        };
      }
      return { ok: true, snapshot, element };
    },

    latestSnapshot(
      ownerUserId: string,
      deviceId: string,
    ): StoredBrowserSnapshot | null {
      const partition = partitions.get(partitionKey(ownerUserId, deviceId));
      if (!partition) return null;
      pruneExpired(partition.snapshots, now());
      if (partition.latestSnapshotId !== null) {
        const direct = partition.snapshots.get(partition.latestSnapshotId);
        if (direct) return direct;
      }
      let latest: StoredBrowserSnapshot | null = null;
      for (const snap of partition.snapshots.values()) {
        latest = snap;
      }
      return latest;
    },

    clearDevice(deviceId: string): void {
      for (const [key, partition] of partitions) {
        if (partition.deviceId === deviceId) {
          partitions.delete(key);
        }
      }
    },
  };
}

export type BrowserCompanionSnapshotStore = ReturnType<
  typeof createBrowserCompanionSnapshotStore
>;

/** 识别用户是否明确点名要操作自己本机的 Chrome / Edge 浏览器。 */
const LOCAL_CHROME_INTENT_PATTERNS: readonly RegExp[] = [
  /(我的|本机|本地|电脑上|电脑里|我打开的|我这边|浏览器里)\s*(的)?\s*(chrome|edge|谷歌浏览器|微软浏览器|浏览器|标签页|网页|页面)/i,
  /用\s*(我(的)?\s*)?(chrome|edge|谷歌浏览器|本机浏览器|本地浏览器)/i,
  /打开\s*我(的)?\s*(chrome|edge|浏览器)/i,
  /(在|去|到|看下?|查下?|操作|控制)\s*我(的)?\s*(chrome|edge|本机浏览器|本地浏览器)/i,
  /\b(my|local)\s+(chrome|edge|browser)\b/i,
  /\b(chrome|edge)\s+(extension|tab|tabs|companion)\b/i,
];

export function detectLocalChromeIntent(
  text: string | null | undefined,
): boolean {
  if (typeof text !== "string") return false;
  const clean = text.trim();
  if (!clean) return false;
  return LOCAL_CHROME_INTENT_PATTERNS.some((pattern) => pattern.test(clean));
}

export type BrowserRouteDecision =
  | {
      mode: "extension";
      reason: "attached_sidepanel" | "remote_dispatch_requested";
      device: DeviceRecord;
      config: CompanionExtensionConfig;
      state: CompanionStateReport;
      attachedTab?: CompanionAttachedTabContext | null;
    }
  | {
      mode: "cloud";
      reason:
        | "no_extension_online"
        | "extension_detached"
        | "extension_paused"
        | "remote_dispatch_disabled"
        | "not_requested_local_chrome";
      fallbackNote?: string;
    };

export type BrowserCompanionShotSaver = (
  ownerUserId: string,
  botId: string,
  id: string,
  frame: { base64: string; url?: string },
) => Promise<{ ok: boolean; shown?: boolean; url?: string | null }>;

type DeviceStateEntry = {
  deviceId: string;
  ownerUserId: string;
  session: BrowserCompanionSession;
  config: CompanionExtensionConfig;
  activeTabTitle: string | null;
  activeTabUrl: string | null;
  updatedAt: number;
};

type CompanionDeviceStore = Pick<
  DeviceStore,
  "get" | "list" | "audit" | "update"
> &
  Partial<Pick<DeviceStore, "extensionsForOwner">>;

type CompanionDeviceHub = Pick<
  DeviceHub,
  "isOnline" | "invoke" | "cancelAllFor" | "pushConfig"
> &
  Partial<Pick<DeviceHub, "sendCompanionCommand" | "sendRaw">>;

export type BrowserCompanionServiceOptions = {
  store: CompanionDeviceStore;
  hub: CompanionDeviceHub;
  saveScreenshot?: BrowserCompanionShotSaver;
  snapshots?: BrowserCompanionSnapshotStore;
  now?: () => number;
};

function detectImageMediaType(
  base64: string,
  declared?: unknown,
): "image/jpeg" | "image/png" | "image/webp" {
  if (declared === "image/png" || declared === "image/webp") return declared;
  if (declared === "image/jpeg") return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

function defaultStepLabel(
  operation: BrowserCompanionOperation,
  args: Record<string, unknown>,
  resolvedElement?: BrowserSnapshotElement,
): string {
  switch (operation) {
    case "browser_tabs": {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action === "new") return "新建浏览器标签页";
      if (action === "activate" || action === "switch")
        return "切换浏览器标签页";
      if (action === "close") return "关闭浏览器标签页";
      return "查看已打开的浏览器标签页";
    }
    case "browser_snapshot":
      return "读取当前网页结构与可交互元素";
    case "browser_read":
      return "读取当前网页正文内容";
    case "browser_navigate": {
      const url = typeof args.url === "string" ? redactUrl(args.url) : "";
      return url ? `打开网页 ${clip(url, 80)}` : "打开网页";
    }
    case "browser_click": {
      const label = resolvedElement?.name || String(args.ref ?? "");
      return label ? `点击「${clip(label, 50)}」` : "点击网页元素";
    }
    case "browser_hover": {
      const label = resolvedElement?.name || String(args.ref ?? "");
      return label ? `悬停查看「${clip(label, 50)}」` : "悬停查看网页元素";
    }
    case "browser_type": {
      const label = resolvedElement?.name || String(args.ref ?? "");
      return label ? `在「${clip(label, 50)}」中输入内容` : "填写网页表单";
    }
    case "browser_key": {
      const key = typeof args.key === "string" ? args.key : "";
      return key ? `按下按键 ${clip(key, 32)}` : "在网页中按键";
    }
    case "browser_scroll": {
      const deltaY = typeof args.deltaY === "number" ? args.deltaY : 600;
      return deltaY < 0 ? "向上滚动浏览网页" : "向下滚动浏览网页";
    }
    case "browser_screenshot":
      return "截取当前网页画面";
    case "browser_control":
      return "同步浏览器接管状态";
  }
}

export function createBrowserCompanionService(
  options: BrowserCompanionServiceOptions,
) {
  const { store, hub } = options;
  const now = options.now ?? Date.now;
  const snapshots =
    options.snapshots ?? createBrowserCompanionSnapshotStore({ now });
  const entries = new Map<string, DeviceStateEntry>();
  const threadAttachments = new Map<
    string,
    {
      ownerUserId: string;
      threadId: string;
      deviceId: string;
      attached: boolean;
      updatedAt: number;
    }
  >();

  function clearThreadAttachmentsForDevice(deviceId: string) {
    for (const [key, binding] of threadAttachments) {
      if (binding.deviceId === deviceId) {
        threadAttachments.delete(key);
      }
    }
  }

  function bindThreadAttachment(input: {
    ownerUserId: string;
    threadId: string | null | undefined;
    deviceId: string | null | undefined;
    attached: boolean;
  }) {
    const cleanThreadId = input.threadId?.trim();
    if (!cleanThreadId) return;
    const key = partitionKey(input.ownerUserId, cleanThreadId);
    const cleanDeviceId = input.deviceId?.trim();
    if (!input.attached || !cleanDeviceId) {
      threadAttachments.delete(key);
      return;
    }
    threadAttachments.delete(key);
    threadAttachments.set(key, {
      ownerUserId: input.ownerUserId,
      threadId: cleanThreadId,
      deviceId: cleanDeviceId,
      attached: true,
      updatedAt: now(),
    });
    while (threadAttachments.size > 2000) {
      const oldest = threadAttachments.keys().next().value;
      if (oldest === undefined) break;
      threadAttachments.delete(oldest);
    }
  }

  function getOrCreateEntry(
    deviceId: string,
    ownerUserId: string,
  ): DeviceStateEntry {
    const existing = entries.get(deviceId);
    if (existing) return existing;
    const timestamp = now();
    const config: CompanionExtensionConfig = {
      ...DEFAULT_COMPANION_EXTENSION_CONFIG,
      blockedDomains: [],
      deviceId,
    };
    const session = createInitialBrowserCompanionSession({
      sessionId: `ext_${deviceId}`,
      deviceId,
      attached: true,
      allowRemoteDispatch: false,
      updatedAt: timestamp,
    });
    const created: DeviceStateEntry = {
      deviceId,
      ownerUserId,
      session,
      config,
      activeTabTitle: null,
      activeTabUrl: null,
      updatedAt: timestamp,
    };
    entries.set(deviceId, created);
    return created;
  }

  function toStateReport(entry: DeviceStateEntry): CompanionStateReport {
    return {
      sessionId: entry.session.sessionId,
      state: entry.session.state,
      tier: entry.config.tier,
      blockedDomains: [...entry.config.blockedDomains],
      allowRemoteDispatch: entry.config.allowRemoteDispatch,
      attached: entry.session.attached,
      attachedTabId: entry.config.attachedTabId,
      activeTabId: entry.session.activeTabId,
      activeTabTitle: entry.activeTabTitle,
      activeTabUrl: entry.activeTabUrl,
      tabGroupId: entry.session.tabGroupId ?? entry.config.tabGroupId,
      tabCount: entry.session.tabCount,
      botId: entry.session.botId,
      botName: entry.session.botName,
      currentStepLabel: entry.session.currentStepLabel,
      yieldReason: entry.session.yieldReason,
      updatedAt: new Date(entry.updatedAt).toISOString(),
    };
  }

  function toTabSession(entry: DeviceStateEntry): CompanionTabSession {
    return {
      sessionId: entry.session.sessionId,
      deviceId: entry.deviceId,
      botId: entry.session.botId,
      botName: entry.session.botName,
      tabGroupId: entry.session.tabGroupId ?? entry.config.tabGroupId,
      activeTabId: entry.session.activeTabId,
      tabCount: entry.session.tabCount,
      state: entry.session.state,
      currentStepLabel: entry.session.currentStepLabel,
      allowRemoteDispatch: entry.config.allowRemoteDispatch,
      tier: entry.config.tier,
      blockedDomains: [...entry.config.blockedDomains],
      activeTabTitle: entry.activeTabTitle,
      activeTabUrl: entry.activeTabUrl,
      yieldReason: entry.session.yieldReason,
      updatedAt: new Date(entry.updatedAt).toISOString(),
    };
  }

  async function listOwnedExtensions(
    ownerUserId: string,
  ): Promise<DeviceRecord[]> {
    if (store.extensionsForOwner) {
      return store.extensionsForOwner(ownerUserId);
    }
    const all = await store.list(ownerUserId);
    return all.filter(
      (device) =>
        !device.revoked && isBrowserExtensionPlatform(device.platform),
    );
  }

  function sendCommand(
    deviceId: string,
    payload: {
      command:
        | "detach"
        | "pause"
        | "resume"
        | "kill_switch"
        | "focus_tab"
        | "sync_config";
      tabId?: number | null;
      reason?: string;
      config?: CompanionSettingsPatch;
    },
  ): boolean {
    if (hub.sendCompanionCommand) {
      return hub.sendCompanionCommand(deviceId, payload);
    }
    if (hub.sendRaw) {
      return hub.sendRaw(deviceId, {
        type: "companion_command",
        ...payload,
      });
    }
    return false;
  }

  function applyStateReport(
    record: DeviceRecord,
    rawReport: Partial<CompanionStateReport>,
  ): CompanionStateReport {
    const entry = getOrCreateEntry(record.id, record.ownerUserId);
    const ts = now();
    if (rawReport.tier !== undefined) {
      entry.config.tier = normalizeBrowserPermissionTier(rawReport.tier);
    }
    if (Array.isArray(rawReport.blockedDomains)) {
      entry.config.blockedDomains = normalizeBlockedDomains(
        rawReport.blockedDomains,
      );
    }
    if (typeof rawReport.allowRemoteDispatch === "boolean") {
      entry.config.allowRemoteDispatch = rawReport.allowRemoteDispatch;
    }
    if (rawReport.attachedTabId !== undefined) {
      entry.config.attachedTabId = cleanTabId(rawReport.attachedTabId);
    }
    if (rawReport.tabGroupId !== undefined) {
      entry.config.tabGroupId = cleanTabId(rawReport.tabGroupId);
    }
    if (typeof rawReport.attached === "boolean") {
      entry.config.attached = rawReport.attached;
    }
    if (rawReport.activeTabTitle !== undefined) {
      entry.activeTabTitle =
        typeof rawReport.activeTabTitle === "string"
          ? clip(rawReport.activeTabTitle, 300)
          : null;
    }
    if (rawReport.activeTabUrl !== undefined) {
      entry.activeTabUrl =
        typeof rawReport.activeTabUrl === "string"
          ? rawReport.activeTabUrl.slice(0, 4000)
          : null;
    }

    const reportedTabId =
      rawReport.activeTabId !== undefined
        ? cleanTabId(rawReport.activeTabId)
        : rawReport.attachedTabId !== undefined
          ? cleanTabId(rawReport.attachedTabId)
          : entry.session.activeTabId;

    const reportedState = rawReport.state;
    if (reportedState === "detached" || rawReport.attached === false) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "detach",
        reason:
          rawReport.attached === false ? "user_toggle_off" : "user_close_hud",
        timestamp: ts,
      });
      snapshots.clearDevice(record.id);
    } else if (reportedState === "yielded_to_human") {
      if (
        entry.session.state === "idle" ||
        entry.session.state === "detached"
      ) {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "attach",
          tabId: reportedTabId,
          deviceId: record.id,
          botId: rawReport.botId ?? entry.session.botId,
          botName: rawReport.botName ?? entry.session.botName,
          allowRemoteDispatch: entry.config.allowRemoteDispatch,
          timestamp: ts,
        });
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "tool_start",
          tabId: reportedTabId,
          tabGroupId: cleanTabId(rawReport.tabGroupId),
          tabCount: rawReport.tabCount,
          stepLabel: rawReport.currentStepLabel ?? undefined,
          timestamp: ts,
        });
      }
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type:
          rawReport.yieldReason === "challenge" ? "challenge" : "human_input",
        reason: rawReport.currentStepLabel ?? undefined,
        timestamp: ts,
      });
    } else if (reportedState === "controlling") {
      if (entry.session.state === "yielded_to_human") {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "resume",
          stepLabel: rawReport.currentStepLabel ?? undefined,
          timestamp: ts,
        });
      } else if (
        entry.session.state === "detached" ||
        entry.session.state === "idle"
      ) {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "attach",
          tabId: reportedTabId,
          deviceId: record.id,
          botId: rawReport.botId ?? entry.session.botId,
          botName: rawReport.botName ?? entry.session.botName,
          allowRemoteDispatch: entry.config.allowRemoteDispatch,
          timestamp: ts,
        });
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "tool_start",
          tabId: reportedTabId,
          tabGroupId: cleanTabId(rawReport.tabGroupId),
          tabCount: rawReport.tabCount,
          botId: rawReport.botId ?? entry.session.botId,
          botName: rawReport.botName ?? entry.session.botName,
          stepLabel: rawReport.currentStepLabel ?? undefined,
          timestamp: ts,
        });
      } else {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "tool_step",
          tabId: reportedTabId,
          tabGroupId: cleanTabId(rawReport.tabGroupId),
          tabCount: rawReport.tabCount,
          stepLabel: rawReport.currentStepLabel ?? undefined,
          timestamp: ts,
        });
      }
    } else if (reportedState === "idle" || rawReport.attached === true) {
      if (entry.session.state === "controlling") {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "turn_complete",
          timestamp: ts,
        });
      }
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "attach",
        tabId: reportedTabId,
        deviceId: record.id,
        botId: rawReport.botId ?? entry.session.botId,
        botName: rawReport.botName ?? entry.session.botName,
        allowRemoteDispatch: entry.config.allowRemoteDispatch,
        timestamp: ts,
      });
    }

    if (rawReport.tabGroupId !== undefined && entry.session.attached) {
      entry.session = {
        ...entry.session,
        tabGroupId: cleanTabId(rawReport.tabGroupId),
        ...(typeof rawReport.tabCount === "number" && rawReport.tabCount >= 0
          ? { tabCount: Math.min(8, Math.trunc(rawReport.tabCount)) }
          : {}),
      };
    }

    entry.updatedAt = ts;
    return toStateReport(entry);
  }

  function updateConfig(
    record: DeviceRecord,
    patch: CompanionSettingsPatch,
  ): { config: CompanionExtensionConfig; state: CompanionStateReport } {
    const entry = getOrCreateEntry(record.id, record.ownerUserId);
    const ts = now();
    const merged = normalizeCompanionExtensionConfig({
      ...entry.config,
      ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
      ...(patch.blockedDomains !== undefined
        ? { blockedDomains: patch.blockedDomains }
        : {}),
      ...(patch.allowRemoteDispatch !== undefined
        ? { allowRemoteDispatch: patch.allowRemoteDispatch }
        : {}),
      ...(patch.attachedTabId !== undefined
        ? { attachedTabId: patch.attachedTabId }
        : {}),
      ...(patch.tabGroupId !== undefined
        ? { tabGroupId: patch.tabGroupId }
        : {}),
      ...(patch.attached !== undefined ? { attached: patch.attached } : {}),
      ...(patch.selectedBotId !== undefined
        ? { selectedBotId: patch.selectedBotId }
        : {}),
      deviceId: record.id,
    });
    entry.config = merged;
    if (patch.paused === true) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "kill_switch",
        timestamp: ts,
      });
      snapshots.clearDevice(record.id);
      sendCommand(record.id, {
        command: "kill_switch",
        reason: "用户紧急停止",
      });
    } else if (patch.attached === false) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "detach",
        reason: "user_toggle_off",
        timestamp: ts,
      });
      snapshots.clearDevice(record.id);
      sendCommand(record.id, { command: "detach", reason: "用户关闭附着" });
    } else if (patch.attached === true || patch.attachedTabId !== undefined) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "attach",
        tabId: merged.attachedTabId,
        deviceId: record.id,
        allowRemoteDispatch: merged.allowRemoteDispatch,
        timestamp: ts,
      });
    } else {
      entry.session = {
        ...entry.session,
        allowRemoteDispatch: merged.allowRemoteDispatch,
        updatedAt: ts,
      };
    }
    entry.updatedAt = ts;
    sendCommand(record.id, {
      command: "sync_config",
      config: {
        tier: merged.tier,
        blockedDomains: merged.blockedDomains,
        allowRemoteDispatch: merged.allowRemoteDispatch,
        attachedTabId: merged.attachedTabId,
        tabGroupId: merged.tabGroupId,
        attached: merged.attached,
      },
    });
    return {
      config: {
        ...entry.config,
        blockedDomains: [...entry.config.blockedDomains],
      },
      state: toStateReport(entry),
    };
  }

  function noteAttachedTab(
    record: DeviceRecord,
    attached: boolean,
    tab?: CompanionAttachedTabContext | null,
  ) {
    const entry = getOrCreateEntry(record.id, record.ownerUserId);
    const ts = now();
    if (!attached) {
      entry.config.attached = false;
      entry.config.attachedTabId = null;
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "detach",
        reason: "user_toggle_off",
        timestamp: ts,
      });
      snapshots.clearDevice(record.id);
      entry.updatedAt = ts;
      return;
    }
    entry.config.attached = true;
    if (tab) {
      entry.config.attachedTabId = cleanTabId(tab.tabId);
      if (tab.groupId !== undefined) {
        entry.config.tabGroupId = cleanTabId(tab.groupId);
      }
      entry.activeTabTitle = clip(tab.title, 300);
      entry.activeTabUrl = tab.url.slice(0, 4000);
    }
    if (entry.session.state === "detached" || entry.session.state === "idle") {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "attach",
        tabId: tab ? cleanTabId(tab.tabId) : entry.config.attachedTabId,
        deviceId: record.id,
        allowRemoteDispatch: entry.config.allowRemoteDispatch,
        timestamp: ts,
      });
    }
    entry.updatedAt = ts;
  }

  function onDisconnect(deviceId: string) {
    snapshots.clearDevice(deviceId);
    clearThreadAttachmentsForDevice(deviceId);
    const entry = entries.get(deviceId);
    if (!entry) return;
    const ts = now();
    entry.session = reduceBrowserCompanionSession(entry.session, {
      type: "remote_disconnect",
      timestamp: ts,
    });
    entry.updatedAt = ts;
  }

  function onKillSwitch(deviceId: string) {
    snapshots.clearDevice(deviceId);
    clearThreadAttachmentsForDevice(deviceId);
    sendCommand(deviceId, { command: "kill_switch", reason: "设备已紧急停止" });
    const entry = entries.get(deviceId);
    if (!entry) return;
    const ts = now();
    entry.session = reduceBrowserCompanionSession(entry.session, {
      type: "kill_switch",
      timestamp: ts,
    });
    entry.updatedAt = ts;
  }

  function onRevoke(deviceId: string) {
    snapshots.clearDevice(deviceId);
    clearThreadAttachmentsForDevice(deviceId);
    entries.delete(deviceId);
  }

  function getConfig(
    deviceId: string,
    ownerUserId?: string,
  ): CompanionExtensionConfig {
    const entry = entries.get(deviceId);
    if (entry) {
      return {
        ...entry.config,
        blockedDomains: [...entry.config.blockedDomains],
      };
    }
    if (ownerUserId) {
      const created = getOrCreateEntry(deviceId, ownerUserId);
      return {
        ...created.config,
        blockedDomains: [...created.config.blockedDomains],
      };
    }
    return {
      ...DEFAULT_COMPANION_EXTENSION_CONFIG,
      blockedDomains: [],
      deviceId,
    };
  }

  function getStateReport(deviceId: string): CompanionStateReport | null {
    const entry = entries.get(deviceId);
    return entry ? toStateReport(entry) : null;
  }

  function getTabSession(deviceId: string): CompanionTabSession | null {
    const entry = entries.get(deviceId);
    return entry ? toTabSession(entry) : null;
  }

  async function resolveRoute(input: {
    ownerUserId: string;
    attachedExtensionDeviceId?: string | null;
    attachedTab?: CompanionAttachedTabContext | null;
    attached?: boolean;
    userPromptText?: string | null;
    preferLocalChrome?: boolean;
  }): Promise<BrowserRouteDecision> {
    const attachedId = input.attachedExtensionDeviceId?.trim() || null;

    if (attachedId) {
      if (input.attached === false) {
        return {
          mode: "cloud",
          reason: "extension_detached",
          fallbackNote: "侧栏已关闭当前页附着，本次将使用云端浏览器。",
        };
      }
      const device = await store.get(attachedId);
      if (
        !device ||
        device.ownerUserId !== input.ownerUserId ||
        device.revoked ||
        !isBrowserExtensionPlatform(device.platform)
      ) {
        return {
          mode: "cloud",
          reason: "no_extension_online",
          fallbackNote: "指定的浏览器伴侣扩展不可用，已回退到云端浏览器。",
        };
      }
      if (device.paused) {
        return {
          mode: "cloud",
          reason: "extension_paused",
          fallbackNote: "浏览器伴侣扩展已处于紧急停止状态，未调度本机 Chrome。",
        };
      }
      if (!hub.isOnline(device.id)) {
        return {
          mode: "cloud",
          reason: "no_extension_online",
          fallbackNote: "浏览器伴侣扩展当前离线，已自动回退到云端浏览器。",
        };
      }
      const entry = getOrCreateEntry(device.id, device.ownerUserId);
      if (input.attachedTab) {
        noteAttachedTab(device, true, input.attachedTab);
      } else if (
        entry.session.state === "detached" &&
        !entry.session.killSwitched
      ) {
        return {
          mode: "cloud",
          reason: "extension_detached",
          fallbackNote: "当前浏览器扩展未附着页面，已回退到云端浏览器。",
        };
      }
      return {
        mode: "extension",
        reason: "attached_sidepanel",
        device,
        config: getConfig(device.id, device.ownerUserId),
        state: toStateReport(entry),
        ...(input.attachedTab ? { attachedTab: input.attachedTab } : {}),
      };
    }

    const wantsLocal =
      input.preferLocalChrome === true ||
      detectLocalChromeIntent(input.userPromptText);
    if (!wantsLocal) {
      return {
        mode: "cloud",
        reason: "not_requested_local_chrome",
      };
    }

    const extensions = await listOwnedExtensions(input.ownerUserId);
    const onlineActive = extensions.filter(
      (device) => !device.revoked && !device.paused && hub.isOnline(device.id),
    );
    if (onlineActive.length === 0) {
      const hasPaused = extensions.some(
        (device) => device.paused && hub.isOnline(device.id),
      );
      return {
        mode: "cloud",
        reason: hasPaused ? "extension_paused" : "no_extension_online",
        fallbackNote: hasPaused
          ? "在线的 Chrome 浏览器扩展已紧急停止，未调度本机浏览器。"
          : "账号下没有在线的 Chrome 浏览器扩展，将使用云端浏览器。",
      };
    }

    const remoteEnabled = onlineActive
      .map((device) => ({
        device,
        entry: getOrCreateEntry(device.id, device.ownerUserId),
      }))
      .filter(({ entry }) => entry.config.allowRemoteDispatch === true)
      .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);

    const chosen = remoteEnabled[0];
    if (!chosen) {
      return {
        mode: "cloud",
        reason: "remote_dispatch_disabled",
        fallbackNote:
          "检测到在线 Chrome 扩展，但「允许从其他设备远程调用此浏览器」开关已关闭，已回退至云端浏览器。",
      };
    }

    return {
      mode: "extension",
      reason: "remote_dispatch_requested",
      device: chosen.device,
      config: getConfig(chosen.device.id, chosen.device.ownerUserId),
      state: toStateReport(chosen.entry),
    };
  }

  async function persistThumbnailIfPresent(input: {
    ownerUserId: string;
    botId: string;
    base64: string;
    mimeType?: unknown;
    url?: string;
    toolCallId?: string;
  }): Promise<{
    shotId: string;
    shotUrl: string;
    companionShotUrl: string;
  } | null> {
    const cleanBase64 = input.base64.trim();
    if (!cleanBase64) return null;
    const rawId =
      input.toolCallId?.trim() ||
      `bshot_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const shotId = /^[A-Za-z0-9_.:-]{1,200}$/.test(rawId)
      ? rawId
      : `bshot_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const shotUrl = `/api/chat-shots/${shotId}`;
    const companionShotUrl = `/api/devices/agent/companion/shots/${shotId}`;

    if (options.saveScreenshot) {
      try {
        await options.saveScreenshot(input.ownerUserId, input.botId, shotId, {
          base64: cleanBase64,
          ...(input.url ? { url: input.url } : {}),
        });
        return { shotId, shotUrl, companionShotUrl };
      } catch {
        // 截图压缩或存库异常时，仍尝试直接 emitToolImage，不阻断浏览器步骤本身。
      }
    }
    emitToolImage({
      mediaType: detectImageMediaType(cleanBase64, input.mimeType),
      data: cleanBase64,
    });
    return { shotId, shotUrl, companionShotUrl };
  }

  async function auditImmediateRefusal(input: {
    device: DeviceRecord;
    operation: BrowserCompanionOperation;
    bot: { id: string; name: string | null };
    summary: string;
    reason: string;
  }) {
    await store
      .audit({
        deviceId: input.device.id,
        ownerUserId: input.device.ownerUserId,
        actorType: "bot",
        actorId: input.bot.id,
        actorName: input.bot.name,
        action: input.operation,
        summary: redactText(input.summary),
        outcome: "refused",
        detail: redactText(input.reason),
        durationMs: 0,
      })
      .catch(() => {});
  }

  /**
   * 统一执行浏览器伴侣操作（服务端强制防篡改快照解析 + assessBrowserActionRisk + 确认卡 + 审计 + 截图缓存）。
   */
  async function executeAction(input: {
    ownerUserId: string;
    deviceId: string;
    botId: string;
    botName: string | null;
    operation: BrowserCompanionOperation;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    toolCallId?: string;
    initiator?: AuditInitiator;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const signal = input.signal ?? currentToolAbort();
    if (signal?.aborted) {
      throw new DeviceRefusedError(TOOL_STOPPED_ZH);
    }

    const device = await store.get(input.deviceId);
    if (
      !device ||
      device.ownerUserId !== input.ownerUserId ||
      !isBrowserExtensionPlatform(device.platform)
    ) {
      throw new DeviceRefusedError("找不到属于当前用户的浏览器伴侣扩展。");
    }
    if (device.revoked) {
      throw new DeviceRefusedError("该浏览器伴侣扩展已被撤销，请重新绑定。");
    }
    if (device.paused) {
      throw new DeviceRefusedError(
        "浏览器伴侣扩展已开启紧急停止，拒绝执行任何页面操作。",
      );
    }
    if (!hub.isOnline(device.id)) {
      throw new DeviceRefusedError("浏览器伴侣扩展当前离线。");
    }

    const entry = getOrCreateEntry(device.id, device.ownerUserId);
    const ts = now();

    // 1. 状态机门禁：礼让/审批/急停/已断开期间绝不越权执行。
    const isMutating =
      ![
        "browser_snapshot",
        "browser_read",
        "browser_scroll",
        "browser_hover",
        "browser_screenshot",
      ].includes(input.operation) &&
      !(
        input.operation === "browser_tabs" &&
        (!input.args.action || input.args.action === "list")
      ) &&
      !(
        input.operation === "browser_control" &&
        ["status", "detach", "hud_update"].includes(
          String(input.args.action ?? ""),
        )
      );

    if (
      entry.session.state === "idle" &&
      entry.session.attached &&
      !entry.session.killSwitched
    ) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "tool_start",
        botId: input.botId,
        botName: input.botName,
        tabId: cleanTabId(input.args.tabId) ?? entry.config.attachedTabId,
        tabGroupId: entry.config.tabGroupId,
        stepLabel: defaultStepLabel(input.operation, input.args),
        timestamp: ts,
      });
    }

    const gate = canCompanionBotAct(entry.session, { mutating: isMutating });
    if (!gate.allowed) {
      const reasonMap: Record<typeof gate.reason, string> = {
        kill_switched: "浏览器伴侣扩展已紧急停止，请用户重新开启附着后再继续。",
        detached: "当前页面已断开附着，机器人无法操控浏览器标签页。",
        idle: "当前未进入接管状态。",
        yielded_to_human:
          "用户正在亲自操作该网页（已自动礼让暂停），请等待用户完成并在页内胶囊点击「继续」后再试。",
        awaiting_approval: "当前存在待用户确认的高危操作，请等待审批完成。",
        snapshot_required:
          "用户刚才亲自操作过该页面，必须先重新调用 browser_snapshot 获取最新页面快照后，才能执行点击或输入操作。",
      };
      const reason = reasonMap[gate.reason];
      await auditImmediateRefusal({
        device,
        operation: input.operation,
        bot: { id: input.botId, name: input.botName },
        summary: defaultStepLabel(input.operation, input.args),
        reason,
      });
      throw new DeviceRefusedError(reason);
    }

    // 2. 强制服务端快照缓存解析（绝不信任模型自报的 name / role / label / type！）
    const requiresRefResolution =
      input.operation === "browser_click" ||
      input.operation === "browser_type" ||
      ((input.operation === "browser_key" ||
        input.operation === "browser_hover") &&
        typeof input.args.ref === "string" &&
        input.args.ref.trim().length > 0);

    let resolvedElement: BrowserSnapshotElement | undefined;
    let resolvedSnapshotUrl: string | null = null;
    let resolvedTabId: number | null =
      cleanTabId(input.args.tabId) ??
      entry.session.activeTabId ??
      entry.config.attachedTabId;

    if (requiresRefResolution) {
      const rawSnapshotId =
        typeof input.args.snapshotId === "number"
          ? input.args.snapshotId
          : undefined;
      const rawRef =
        typeof input.args.ref === "string" ? input.args.ref : undefined;
      const lookup = snapshots.resolveElement(
        input.ownerUserId,
        device.id,
        rawSnapshotId,
        rawRef,
      );
      if (!lookup.ok) {
        await auditImmediateRefusal({
          device,
          operation: input.operation,
          bot: { id: input.botId, name: input.botName },
          summary: `${OPERATION_LABEL[input.operation]}：无效或过期引用 ${String(rawRef ?? "")}`,
          reason: lookup.error,
        });
        throw new DeviceRefusedError(lookup.error);
      }
      resolvedElement = lookup.element;
      resolvedSnapshotUrl = lookup.snapshot.url;
      if (lookup.snapshot.tabId !== null) {
        resolvedTabId = lookup.snapshot.tabId;
      }
    }

    // 3. 收集要评估的 URL（当前页 URL + 导航目标 URL，任何一方命中黑名单立即硬拒绝）。
    const latestSnap = snapshots.latestSnapshot(input.ownerUserId, device.id);
    const targetUrl =
      typeof input.args.url === "string" && input.args.url.trim()
        ? input.args.url.trim()
        : null;
    const currentUrl =
      resolvedSnapshotUrl || entry.activeTabUrl || latestSnap?.url || null;
    const candidateUrls =
      input.operation === "browser_navigate" && input.args.newTab === true
        ? [targetUrl].filter((u): u is string => Boolean(u))
        : [targetUrl, currentUrl].filter((u): u is string => Boolean(u));

    const subAction =
      typeof input.args.action === "string" ? input.args.action : undefined;
    const keyArg =
      typeof input.args.key === "string" ? input.args.key : undefined;
    const submitArg = input.args.submit === true;

    let assessment: BrowserActionRiskAssessment = assessBrowserActionRisk({
      tier: entry.config.tier,
      operation: input.operation,
      action: subAction,
      url: targetUrl ?? currentUrl,
      // 仅传入服务端快照解析出的真实控件属性，绝不采用模型自报文本。
      element: resolvedElement
        ? {
            role: resolvedElement.role,
            name: resolvedElement.name,
            type: resolvedElement.type,
          }
        : null,
      key: keyArg,
      submit: submitArg,
      blockedDomains: entry.config.blockedDomains,
    });

    // 若同时存在目标 URL 与当前页 URL，确保两者均通过黑名单校验。
    if (assessment.decision !== "deny" && candidateUrls.length > 1) {
      for (const extraUrl of candidateUrls) {
        const extra = assessBrowserActionRisk({
          tier: entry.config.tier,
          operation: input.operation,
          action: subAction,
          url: extraUrl,
          element: null,
          blockedDomains: entry.config.blockedDomains,
        });
        if (extra.decision === "deny") {
          assessment = extra;
          break;
        }
      }
    }

    const stepLabel =
      typeof input.args.stepLabel === "string" && input.args.stepLabel.trim()
        ? clip(input.args.stepLabel.trim(), 120)
        : defaultStepLabel(input.operation, input.args, resolvedElement);

    const summaryParts = [stepLabel];
    if (resolvedElement) {
      summaryParts.push(
        `[${resolvedElement.role}]「${resolvedElement.name || resolvedElement.ref}」`,
      );
    }
    if (targetUrl) {
      summaryParts.push(redactUrl(targetUrl));
    } else if (currentUrl) {
      summaryParts.push(redactUrl(currentUrl));
    }
    if (assessment.decision === "ask" && assessment.reason) {
      summaryParts.push(`（${assessment.reason}）`);
    }
    const summary = redactText(summaryParts.join(" · "));

    // 4. 黑名单硬拒绝：立刻写审计并拦截，绝不下发到扩展！
    if (assessment.decision === "deny") {
      await auditImmediateRefusal({
        device,
        operation: input.operation,
        bot: { id: input.botId, name: input.botName },
        summary,
        reason: assessment.reason,
      });
      throw new DeviceRefusedError(assessment.reason);
    }

    // 5. 清洗传给扩展的参数（剔除任何模型伪造字段，附带服务端解析出的可信元数据）。
    const wireArgs: Record<string, unknown> = {
      ...input.args,
      ...(resolvedTabId !== null ? { tabId: resolvedTabId } : {}),
      botName: input.botName ?? "ChisaBot",
      stepLabel,
    };
    delete wireArgs.elementName;
    delete wireArgs.elementRole;
    delete wireArgs.label;
    delete wireArgs._approved;
    if (resolvedElement) {
      wireArgs.ref = resolvedElement.ref;
      if (resolvedElement.backendDOMNodeId !== undefined) {
        wireArgs.backendDOMNodeId = resolvedElement.backendDOMNodeId;
      }
    }

    // 6. 更新会话状态并经由 DeviceHub 调用（自动走确认卡 + device_audit_events 落库）。
    const approvalIdForState =
      assessment.decision === "ask" ? randomUUID() : null;
    if (assessment.decision === "ask" && approvalIdForState) {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "approval_requested",
        approval: {
          approvalId: approvalIdForState,
          operation: input.operation,
          summary,
          category:
            assessment.category === "safe" ? "high_risk" : assessment.category,
          locked: assessment.locked,
        },
        stepLabel,
        timestamp: now(),
      });
      entry.updatedAt = now();
    } else {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "tool_step",
        tabId: resolvedTabId,
        stepLabel,
        operation: input.operation,
        timestamp: now(),
      });
      entry.updatedAt = now();
    }

    const runInvoke = () =>
      hub.invoke({
        device,
        operation: input.operation,
        args: wireArgs,
        bot: { id: input.botId, name: input.botName },
        summary,
        timeoutMs: input.timeoutMs ?? 45_000,
        ...(signal ? { signal } : {}),
        ...(currentConfirmTurn()?.threadId
          ? { conversationId: currentConfirmTurn()?.threadId }
          : {}),
        browserRiskPolicy: {
          decision: assessment.decision,
          reason: assessment.reason,
          locked: assessment.locked === true,
          category: assessment.category,
          ...(resolvedElement?.type === "password"
            ? { isPasswordTarget: true }
            : {}),
        },
      });

    let rawResult: unknown;
    try {
      rawResult = await withConfirmInteractive(
        deviceLinkableInitiator(input.initiator),
        runInvoke,
      );
      if (approvalIdForState && entry.session.state === "awaiting_approval") {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "approval_resolved",
          approvalId: approvalIdForState,
          approved: true,
          stepLabel,
          timestamp: now(),
        });
      }
    } catch (error) {
      if (approvalIdForState && entry.session.state === "awaiting_approval") {
        entry.session = reduceBrowserCompanionSession(entry.session, {
          type: "approval_resolved",
          approvalId: approvalIdForState,
          approved: false,
          endTurn: false,
          timestamp: now(),
        });
      }
      entry.updatedAt = now();
      throw error;
    }

    // 7. 处理返回结果：快照入库 + 截图入 chat-shots 与 emitToolImage + 脱敏包装。
    const obj =
      rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
        ? ({ ...(rawResult as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : { result: rawResult };

    const resultUrl =
      typeof obj.url === "string" && obj.url.trim()
        ? obj.url.trim()
        : (targetUrl ?? currentUrl ?? "");
    const resultTitle =
      typeof obj.title === "string" && obj.title.trim()
        ? clip(obj.title.trim(), 300)
        : (entry.activeTabTitle ?? "");
    const resultTabId = cleanTabId(obj.tabId) ?? resolvedTabId;

    if (resultUrl) entry.activeTabUrl = resultUrl.slice(0, 4000);
    if (resultTitle) entry.activeTabTitle = resultTitle;

    if (input.operation === "browser_snapshot") {
      const snapshotId =
        typeof obj.snapshotId === "number" &&
        Number.isSafeInteger(obj.snapshotId) &&
        obj.snapshotId > 0
          ? obj.snapshotId
          : (latestSnap?.snapshotId ?? 0) + 1;
      const saved = snapshots.saveSnapshot({
        ownerUserId: input.ownerUserId,
        deviceId: device.id,
        snapshotId,
        tabId: resultTabId,
        url: resultUrl,
        title: resultTitle,
        elements: Array.isArray(obj.elements) ? obj.elements : [],
      });
      obj.snapshotId = saved.snapshotId;
      obj.elements = [...saved.elements.values()].map(
        ({ backendDOMNodeId: _omit, ...publicEl }) => publicEl,
      );
      obj.truncated = obj.truncated === true;
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "tool_step",
        tabId: resultTabId,
        stepLabel,
        operation: "browser_snapshot",
        snapshotTaken: true,
        timestamp: now(),
      });
    } else {
      entry.session = reduceBrowserCompanionSession(entry.session, {
        type: "tool_step",
        tabId: resultTabId,
        stepLabel,
        operation: input.operation,
        timestamp: now(),
      });
    }
    entry.updatedAt = now();

    // 统一落库缩略图并回传视觉帧，同时从返回给模型的 JSON 中剔除原始 base64。
    const base64Frame =
      input.operation === "browser_screenshot" && typeof obj.base64 === "string"
        ? obj.base64
        : typeof obj.screenshotBase64 === "string"
          ? obj.screenshotBase64
          : null;
    delete obj.base64;
    delete obj.screenshotBase64;

    let shotMeta: {
      shotId: string;
      shotUrl: string;
      companionShotUrl: string;
    } | null = null;
    if (base64Frame) {
      shotMeta = await persistThumbnailIfPresent({
        ownerUserId: input.ownerUserId,
        botId: input.botId,
        base64: base64Frame,
        mimeType: obj.mimeType,
        url: resultUrl || undefined,
        toolCallId: input.toolCallId ?? currentConfirmToolCall()?.toolCallId,
      });
    }

    if (typeof obj.text === "string" && obj.text.length > MAX_PAGE_TEXT_CHARS) {
      obj.text = `${obj.text.slice(0, MAX_PAGE_TEXT_CHARS)}\n…`;
      obj.truncated = true;
    }

    const enriched: Record<string, unknown> = {
      ok: true,
      source: "extension",
      deviceId: device.id,
      tabId: resultTabId,
      url: resultUrl,
      title: resultTitle,
      stepLabel,
      ...obj,
      ...(resolvedElement
        ? {
            element: {
              role: resolvedElement.role,
              name: resolvedElement.name,
            },
          }
        : {}),
      ...(shotMeta
        ? {
            shown: true,
            shotId: shotMeta.shotId,
            shotUrl: shotMeta.shotUrl,
            companionShotUrl: shotMeta.companionShotUrl,
          }
        : {}),
    };

    if (
      input.operation === "browser_snapshot" ||
      input.operation === "browser_read" ||
      input.operation === "browser_navigate"
    ) {
      return withUntrustedNotice(enriched, "web page", [
        "title",
        "text",
        "elements",
      ]);
    }
    return enriched;
  }

  /** 为已路由至在线浏览器伴侣扩展的回合构造全套 `browser_*` 与双模 `computer_*` 浏览器适配工具。 */
  function toolsForRoute(input: {
    route: Extract<BrowserRouteDecision, { mode: "extension" }>;
    actorId: string;
    botId: string;
    botName: string | null;
    initiator?: AuditInitiator;
    includeComputerAliases?: boolean;
  }): GrantedTool[] {
    const { route, actorId, botId, botName, initiator } = input;
    const device = route.device;
    const tierInfo = BROWSER_PERMISSION_INFO[route.config.tier];
    const tabDesc = route.attachedTab
      ? `当前已附着页面：「${clip(route.attachedTab.title, 80)}」（${redactUrl(route.attachedTab.url)}，tabId=${route.attachedTab.tabId}）`
      : route.state.activeTabUrl
        ? `当前活跃页面：「${clip(route.state.activeTabTitle ?? "", 80)}」（${redactUrl(route.state.activeTabUrl)}）`
        : "已连接用户的本机 Chrome 浏览器扩展";

    const guidance = [
      `【本机 Chrome 浏览器伴侣已接管】你当前直接连接了用户本机的 Chrome 浏览器扩展「${device.name}」（deviceId=${device.id}，权限档位：${tierInfo.label}）。${tabDesc}。`,
      "请优先使用 browser_snapshot / browser_read / browser_click / browser_hover / browser_type / browser_key / browser_scroll / browser_navigate / browser_screenshot / browser_tabs 直接在用户的本机 Chrome 中查看与操作已登录的真实网页。",
      "执行点击或填表前必须先调用 browser_snapshot 获取最新 snapshotId 与 ref，严禁编造 ref；涉及高危按钮或付款操作时系统会自动弹出确认卡片，直接调用工具等待结果即可，不要在聊天里提前问要不要做。",
    ].join("\n");

    const runOp = async (
      operation: BrowserCompanionOperation,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string> => {
      try {
        const res = await executeAction({
          ownerUserId: actorId,
          deviceId: device.id,
          botId,
          botName,
          operation,
          args,
          ...(signal ? { signal } : {}),
          initiator,
        });
        return JSON.stringify(res);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "浏览器伴侣操作失败。";
        return error instanceof DeviceRefusedError
          ? `${REFUSAL_MARKER} ${message}`
          : `${REFUSAL_MARKER} 浏览器伴侣操作失败：${message}`;
      }
    };

    const tabIdField = z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "目标 Chrome 标签页 ID（省略则操作当前附着或受控的活跃标签页）",
      );
    const stepLabelField = z
      .string()
      .max(120)
      .optional()
      .describe("给用户展示的简短中文当前步骤说明，例如「查看内存与流量图表」");

    const snapSchema = z.object({
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const readSchema = z.object({
      tabId: tabIdField,
      maxChars: z.number().int().min(200).max(50_000).optional(),
      stepLabel: stepLabelField,
    });
    const navigateSchema = z.object({
      url: z.string().min(1).max(2048).describe("要打开的 http/https 网址"),
      tabId: tabIdField,
      newTab: z
        .boolean()
        .optional()
        .describe("是否在新标签页打开并加入 Bot 标签组"),
      stepLabel: stepLabelField,
    });
    const clickSchema = z.object({
      ref: z
        .string()
        .min(1)
        .max(64)
        .describe("来自最新 browser_snapshot 的元素 ref"),
      snapshotId: z
        .number()
        .int()
        .positive()
        .describe("该 ref 所属的 snapshotId"),
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const hoverSchema = z.object({
      ref: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("要悬停的元素 ref（如 ECharts/图表节点）"),
      snapshotId: z.number().int().positive().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const typeSchema = z.object({
      ref: z.string().min(1).max(64),
      snapshotId: z.number().int().positive(),
      text: z.string().max(20_000),
      submit: z
        .boolean()
        .optional()
        .describe("输入后是否按 Enter 提交（谨慎操作档位会弹确认卡）"),
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const keySchema = z.object({
      key: z.string().min(1).max(64),
      ref: z.string().min(1).max(64).optional(),
      snapshotId: z.number().int().positive().optional(),
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const scrollSchema = z.object({
      deltaY: z
        .number()
        .finite()
        .optional()
        .describe("垂直滚动像素（正数向下，负数向上，默认 600）"),
      deltaX: z.number().finite().optional(),
      tabId: tabIdField,
      stepLabel: stepLabelField,
    });
    const screenshotSchema = z.object({
      tabId: tabIdField,
      quality: z.number().int().min(30).max(95).optional(),
      stepLabel: stepLabelField,
    });
    const tabsSchema = z.object({
      action: z
        .enum(["list", "new", "activate", "switch", "close"])
        .default("list"),
      tabId: tabIdField,
      id: z.union([z.string(), z.number()]).optional(),
      url: z.string().max(2048).optional(),
    });

    const browserTools: GrantedTool[] = [
      {
        name: "browser_snapshot",
        ref: "browser_companion/snapshot",
        effect: "read",
        guidance,
        description:
          "读取用户本机 Chrome 当前标签页的无障碍控件树快照，返回带 snapshotId 与元素 ref 的列表（供 browser_click / browser_type / browser_hover 使用）。",
        parameters: snapSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_snapshot", snapSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_read",
        ref: "browser_companion/read",
        effect: "read",
        description: "读取用户本机 Chrome 当前标签页的正文文本与标题。",
        parameters: readSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_read", readSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_navigate",
        ref: "browser_companion/navigate",
        effect: "write",
        description: "在用户本机 Chrome 的受控标签组中打开指定网址。",
        parameters: navigateSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp(
            "browser_navigate",
            navigateSchema.parse(raw ?? {}),
            ctx?.signal,
          ),
      },
      {
        name: "browser_click",
        ref: "browser_companion/click",
        effect: "write",
        description:
          "按最新 browser_snapshot 返回的 ref 与 snapshotId 点击用户本机 Chrome 页面中的按钮或链接（高危与付款控件会自动弹确认卡）。",
        parameters: clickSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_click", clickSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_hover",
        ref: "browser_companion/hover",
        effect: "read",
        description:
          "在本机 Chrome 中触发真实鼠标悬停（适合查看图表 ECharts/Canvas Tooltip 或悬浮菜单）。",
        parameters: hoverSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_hover", hoverSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_type",
        ref: "browser_companion/type",
        effect: "write",
        description:
          "在用户本机 Chrome 页面指定输入框中填入文字（需携带最新 ref 与 snapshotId）。",
        parameters: typeSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_type", typeSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_key",
        ref: "browser_companion/key",
        effect: "write",
        description:
          "在用户本机 Chrome 页面发送按键（Enter / Escape / Tab 等）。",
        parameters: keySchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_key", keySchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_scroll",
        ref: "browser_companion/scroll",
        effect: "read",
        description: "滚动用户本机 Chrome 当前受控标签页。",
        parameters: scrollSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp("browser_scroll", scrollSchema.parse(raw ?? {}), ctx?.signal),
      },
      {
        name: "browser_screenshot",
        ref: "browser_companion/screenshot",
        effect: "read",
        description:
          "后台截取用户本机 Chrome 受控标签页的干净画面并同步展示到聊天卡片。",
        parameters: screenshotSchema,
        initiator,
        execute: async (raw, ctx) =>
          runOp(
            "browser_screenshot",
            screenshotSchema.parse(raw ?? {}),
            ctx?.signal,
          ),
      },
      {
        name: "browser_tabs",
        ref: "browser_companion/tabs",
        effect: "read",
        description: "列出、新建、切换或关闭本机 Chrome 受控标签组中的标签页。",
        parameters: tabsSchema,
        initiator,
        execute: async (raw, ctx) => {
          const parsed = tabsSchema.parse(raw ?? {});
          const normalizedAction =
            parsed.action === "switch" ? "activate" : parsed.action;
          const numericId =
            parsed.tabId ??
            (typeof parsed.id === "number"
              ? parsed.id
              : typeof parsed.id === "string" && /^\d+$/.test(parsed.id)
                ? Number(parsed.id)
                : undefined);
          return runOp(
            "browser_tabs",
            {
              action: normalizedAction,
              ...(numericId !== undefined ? { tabId: numericId } : {}),
              ...(parsed.url ? { url: parsed.url } : {}),
            },
            ctx?.signal,
          );
        },
      },
    ];

    if (input.includeComputerAliases === false) {
      return browserTools;
    }

    // 双模路由适配器：在已附着本机 Chrome 扩展的回合中，将常规 computer_* 浏览器工具透明重定向到扩展节点，
    // 确保无论模型调用 browser_* 还是 computer_* 浏览器工具，都命中同一套服务端快照校验与风险确认链。
    const computerAliases: GrantedTool[] = [
      {
        name: "computer_snapshot",
        ref: "browser_companion/computer_snapshot",
        effect: "read",
        description:
          "读取当前本机 Chrome 受控标签页的无障碍控件树快照（双模路由已自动接管至本机 Chrome 扩展）。",
        parameters: z.object({}),
        initiator,
        execute: async (_raw, ctx) =>
          runOp("browser_snapshot", {}, ctx?.signal),
      },
      {
        name: "computer_read",
        ref: "browser_companion/computer_read",
        effect: "read",
        description: "读取当前本机 Chrome 受控标签页的正文文本。",
        parameters: z.object({}),
        initiator,
        execute: async (_raw, ctx) => runOp("browser_read", {}, ctx?.signal),
      },
      {
        name: "computer_navigate",
        ref: "browser_companion/computer_navigate",
        effect: "write",
        description: "在用户本机 Chrome 受控标签页打开指定网址。",
        parameters: z.object({ url: z.string().min(1).max(2048) }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({ url: z.string().min(1).max(2048) })
            .parse(raw ?? {});
          return runOp("browser_navigate", parsed, ctx?.signal);
        },
      },
      {
        name: "computer_click",
        ref: "browser_companion/computer_click",
        effect: "write",
        description:
          "在用户本机 Chrome 受控标签页按 ref 与 snapshotId 点击元素。",
        parameters: z.object({
          ref: z.string().min(1).max(64),
          snapshotId: z.number().int().positive(),
        }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({
              ref: z.string().min(1).max(64),
              snapshotId: z.number().int().positive(),
            })
            .parse(raw ?? {});
          return runOp("browser_click", parsed, ctx?.signal);
        },
      },
      {
        name: "computer_type",
        ref: "browser_companion/computer_type",
        effect: "write",
        description: "在用户本机 Chrome 受控标签页填写输入框。",
        parameters: z.object({
          ref: z.string().min(1).max(64),
          snapshotId: z.number().int().positive(),
          text: z.string(),
          submit: z.boolean().optional(),
        }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({
              ref: z.string().min(1).max(64),
              snapshotId: z.number().int().positive(),
              text: z.string(),
              submit: z.boolean().optional(),
            })
            .parse(raw ?? {});
          return runOp("browser_type", parsed, ctx?.signal);
        },
      },
      {
        name: "computer_key",
        ref: "browser_companion/computer_key",
        effect: "write",
        description: "在用户本机 Chrome 受控标签页发送按键。",
        parameters: z.object({
          key: z.string().min(1).max(64),
          ref: z.string().min(1).max(64).optional(),
          snapshotId: z.number().int().positive().optional(),
        }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({
              key: z.string().min(1).max(64),
              ref: z.string().min(1).max(64).optional(),
              snapshotId: z.number().int().positive().optional(),
            })
            .parse(raw ?? {});
          return runOp("browser_key", parsed, ctx?.signal);
        },
      },
      {
        name: "computer_scroll",
        ref: "browser_companion/computer_scroll",
        effect: "read",
        description: "滚动用户本机 Chrome 受控标签页。",
        parameters: z.object({ deltaY: z.number().optional() }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({ deltaY: z.number().optional() })
            .parse(raw ?? {});
          return runOp("browser_scroll", parsed, ctx?.signal);
        },
      },
      {
        name: "computer_screenshot",
        ref: "browser_companion/computer_screenshot",
        effect: "read",
        description: "截取用户本机 Chrome 受控标签页画面并存入聊天截图缓存。",
        parameters: z.object({}),
        initiator,
        execute: async (_raw, ctx) =>
          runOp("browser_screenshot", {}, ctx?.signal),
      },
      {
        name: "computer_tabs",
        ref: "browser_companion/computer_tabs",
        effect: "read",
        description: "列出、新建、切换或关闭用户本机 Chrome 受控标签页。",
        parameters: z.object({
          action: z.enum(["list", "new", "switch", "close"]),
          id: z.string().optional(),
          url: z.string().optional(),
        }),
        initiator,
        execute: async (raw, ctx) => {
          const parsed = z
            .object({
              action: z.enum(["list", "new", "switch", "close"]),
              id: z.string().optional(),
              url: z.string().optional(),
            })
            .parse(raw ?? {});
          const tabId =
            parsed.id && /^\d+$/.test(parsed.id)
              ? Number(parsed.id)
              : undefined;
          return runOp(
            "browser_tabs",
            {
              action: parsed.action === "switch" ? "activate" : parsed.action,
              ...(tabId !== undefined ? { tabId } : {}),
              ...(parsed.url ? { url: parsed.url } : {}),
            },
            ctx?.signal,
          );
        },
      },
    ];

    return [...browserTools, ...computerAliases];
  }

  async function resolveAgentToolRoute(input: {
    ownerUserId: string;
    threadId?: string | null;
    attachedExtensionDeviceId?: string | null;
  }): Promise<BrowserRouteDecision> {
    const explicitId = input.attachedExtensionDeviceId?.trim() || null;
    const threadBinding = input.threadId?.trim()
      ? threadAttachments.get(
          partitionKey(input.ownerUserId, input.threadId.trim()),
        )
      : undefined;
    const attachedId =
      explicitId ?? (threadBinding?.attached ? threadBinding.deviceId : null);
    if (attachedId) {
      return resolveRoute({
        ownerUserId: input.ownerUserId,
        attachedExtensionDeviceId: attachedId,
        attached: true,
      });
    }
    // 无侧栏附着上下文时严格走跨端路由：必须要求在线扩展显式开启 allowRemoteDispatch === true。
    return resolveRoute({
      ownerUserId: input.ownerUserId,
      preferLocalChrome: true,
    });
  }

  async function executeAgentToolCall(input: {
    ownerUserId: string;
    botId: string;
    botName: string | null;
    threadId?: string | null;
    attachedExtensionDeviceId?: string | null;
    operation: BrowserCompanionOperation;
    args: Record<string, unknown>;
    initiator?: AuditInitiator;
  }): Promise<{ text: string; isError: boolean }> {
    const route = await resolveAgentToolRoute({
      ownerUserId: input.ownerUserId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.attachedExtensionDeviceId
        ? { attachedExtensionDeviceId: input.attachedExtensionDeviceId }
        : {}),
    });
    if (route.mode !== "extension") {
      return {
        text: `${REFUSAL_MARKER} ${route.fallbackNote ?? "当前账号下没有可用于本回合的在线浏览器伴侣扩展。"}`,
        isError: true,
      };
    }
    try {
      const result = await executeAction({
        ownerUserId: input.ownerUserId,
        deviceId: route.device.id,
        botId: input.botId,
        botName: input.botName,
        operation: input.operation,
        args: input.args,
        ...(input.initiator ? { initiator: input.initiator } : {}),
      });
      return { text: JSON.stringify(result), isError: false };
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "浏览器伴侣操作失败。";
      return { text: `${REFUSAL_MARKER} ${msg}`, isError: true };
    }
  }

  return {
    snapshots,
    applyStateReport,
    updateConfig,
    noteAttachedTab,
    bindThreadAttachment,
    onDisconnect,
    onKillSwitch,
    onRevoke,
    getConfig,
    getStateReport,
    getTabSession,
    sendCommand,
    resolveRoute,
    resolveAgentToolRoute,
    executeAction,
    executeAgentToolCall,
    toolsForRoute,
    listOwnedExtensions,
    supportedOperations: BROWSER_COMPANION_OPERATIONS,
  };
}

export type BrowserCompanionService = ReturnType<
  typeof createBrowserCompanionService
>;

/** 从 AG-UI `forwardedProps` 中提取浏览器伴侣侧栏附着上下文。 */
export function extractBrowserCompanionProps(forwardedProps: unknown): {
  attachedExtensionDeviceId: string | null;
  attached?: boolean;
  attachedTab?: CompanionAttachedTabContext | null;
  preferLocalChrome?: boolean;
} {
  if (
    !forwardedProps ||
    typeof forwardedProps !== "object" ||
    Array.isArray(forwardedProps)
  ) {
    return { attachedExtensionDeviceId: null };
  }
  const props = forwardedProps as Record<string, unknown>;
  const nested =
    props.browserCompanion &&
    typeof props.browserCompanion === "object" &&
    !Array.isArray(props.browserCompanion)
      ? (props.browserCompanion as Record<string, unknown>)
      : null;

  const rawDeviceId =
    typeof props.attachedExtensionDeviceId === "string"
      ? props.attachedExtensionDeviceId.trim()
      : typeof nested?.deviceId === "string"
        ? nested.deviceId.trim()
        : "";

  const attached =
    typeof nested?.attached === "boolean"
      ? nested.attached
      : typeof props.attached === "boolean"
        ? props.attached
        : undefined;

  const rawTab = props.attachedTab ?? nested?.tab;
  let attachedTab: CompanionAttachedTabContext | null | undefined;
  if (rawTab === null) {
    attachedTab = null;
  } else if (rawTab && typeof rawTab === "object" && !Array.isArray(rawTab)) {
    const t = rawTab as Record<string, unknown>;
    const tabId = cleanTabId(t.tabId);
    const url = typeof t.url === "string" ? t.url.slice(0, 4000) : "";
    const title = typeof t.title === "string" ? clip(t.title, 300) : "";
    if (tabId !== null) {
      attachedTab = {
        tabId,
        url,
        title,
        ...(typeof t.windowId === "number" ? { windowId: t.windowId } : {}),
        ...(typeof t.favIconUrl === "string"
          ? { favIconUrl: t.favIconUrl }
          : {}),
        ...(typeof t.groupId === "number" ? { groupId: t.groupId } : {}),
      };
    }
  }

  return {
    attachedExtensionDeviceId: rawDeviceId || null,
    ...(attached !== undefined ? { attached } : {}),
    ...(attachedTab !== undefined ? { attachedTab } : {}),
    ...(props.preferLocalChrome === true ? { preferLocalChrome: true } : {}),
  };
}

export type { BrowserSnapshotResult };
