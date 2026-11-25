import { parseDesktopRef } from "../../../shared/devices";
import { withUntrustedNotice } from "../untrusted-content";

export type StoredDesktopBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StoredDesktopWindow = {
  hwnd?: number | string | null;
  pid?: number | null;
  processStartTicks?: string | number | null;
  processName?: string | null;
  bundleId?: string | null;
  title?: string | null;
};

export type StoredDesktopElement = {
  ref: string;
  role: string;
  name: string | null;
  automationId: string | null;
  description: string | null;
  patterns: string[];
  isPassword: boolean;
  value?: string | null;
  runtimeId?: string | number[] | null;
  uniqueAtCapture?: boolean;
  bounds?: StoredDesktopBounds | null;
};

export type StoredDesktopSnapshot = {
  ownerUserId: string;
  deviceId: string;
  snapshotId: number;
  driver?: string;
  window: StoredDesktopWindow;
  elements: Map<string, StoredDesktopElement>;
  capturedAt: number;
};

export type SaveDesktopSnapshotInput = {
  ownerUserId: string;
  deviceId: string;
  snapshotId: number;
  driver?: string;
  window: StoredDesktopWindow;
  elements: readonly StoredDesktopElement[];
};

export type ResolveDesktopRefResult =
  | {
      ok: true;
      snapshot: StoredDesktopSnapshot;
      element: StoredDesktopElement;
    }
  | {
      ok: false;
      code: "STALE_REF";
      error: string;
    };

export const STALE_DESKTOP_REF_ERROR =
  "控件引用已过期或不存在，请重新调用 device_desktop_snapshot 获取最新快照。";

const DEFAULT_MAX_SNAPSHOTS_PER_DEVICE = 32;
const DEFAULT_TTL_MS = 15 * 60_000;
const SHORT_ELEMENT_KEY_PATTERN = /^e[1-9]\d*$/;

const MAX_WINDOW_TITLE_LEN = 300;
const MAX_ELEMENT_TEXT_LEN = 400;
const MAX_TREE_TEXT_LEN = 16_000;
const MAX_MODEL_ELEMENTS = 1000;
const MAX_PATTERNS_PER_ELEMENT = 32;

function partitionKey(ownerUserId: string, deviceId: string): string {
  return JSON.stringify([ownerUserId, deviceId]);
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanOptionalString(
  value: unknown,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return clipText(value, max);
}

function cleanNullableString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return clipText(value, max);
}

function cleanBounds(value: unknown): StoredDesktopBounds | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const left = typeof raw.left === "number" ? raw.left : raw.x;
  const top = typeof raw.top === "number" ? raw.top : raw.y;
  const width = raw.width;
  const height = raw.height;
  if (
    typeof left === "number" &&
    Number.isFinite(left) &&
    typeof top === "number" &&
    Number.isFinite(top) &&
    typeof width === "number" &&
    Number.isFinite(width) &&
    typeof height === "number" &&
    Number.isFinite(height)
  ) {
    return { left, top, width, height };
  }
  return null;
}

function normalizeWindow(
  raw: StoredDesktopWindow | null | undefined,
): StoredDesktopWindow {
  if (!raw || typeof raw !== "object") return {};
  const out: StoredDesktopWindow = {};
  if (
    raw.hwnd === null ||
    typeof raw.hwnd === "number" ||
    typeof raw.hwnd === "string"
  ) {
    out.hwnd = raw.hwnd;
  }
  if (
    raw.pid === null ||
    (typeof raw.pid === "number" && Number.isFinite(raw.pid))
  ) {
    out.pid = raw.pid;
  }
  if (
    raw.processStartTicks === null ||
    typeof raw.processStartTicks === "string" ||
    typeof raw.processStartTicks === "number"
  ) {
    out.processStartTicks = raw.processStartTicks;
  }
  const processName = cleanOptionalString(raw.processName, 160);
  if (processName !== undefined) out.processName = processName;
  const bundleId = cleanOptionalString(raw.bundleId, 200);
  if (bundleId !== undefined) out.bundleId = bundleId;
  const title = cleanOptionalString(raw.title, MAX_WINDOW_TITLE_LEN);
  if (title !== undefined) out.title = title;
  return out;
}

function normalizeRef(rawRef: unknown, snapshotId: number): string | null {
  if (typeof rawRef !== "string") return null;
  const trimmed = rawRef.trim();
  if (!trimmed) return null;
  const parsed = parseDesktopRef(trimmed);
  if (parsed) {
    return `@${parsed.snapshotId}:${parsed.elementKey}`;
  }
  if (SHORT_ELEMENT_KEY_PATTERN.test(trimmed)) {
    return `@${snapshotId}:${trimmed}`;
  }
  return null;
}

function normalizeStoredElement(
  raw: StoredDesktopElement,
  snapshotId: number,
): StoredDesktopElement | null {
  const ref = normalizeRef(raw.ref, snapshotId);
  if (!ref) return null;
  const isPassword = raw.isPassword === true;
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns
        .filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
        .slice(0, MAX_PATTERNS_PER_ELEMENT)
    : [];
  const runtimeId =
    raw.runtimeId === null || typeof raw.runtimeId === "string"
      ? raw.runtimeId
      : Array.isArray(raw.runtimeId)
        ? raw.runtimeId.filter(
            (item): item is number => typeof item === "number",
          )
        : undefined;
  const bounds = cleanBounds(raw.bounds);

  return {
    ref,
    role:
      typeof raw.role === "string" && raw.role.trim()
        ? clipText(raw.role.trim(), 120)
        : "Unknown",
    name: cleanNullableString(raw.name, MAX_ELEMENT_TEXT_LEN),
    automationId: cleanNullableString(raw.automationId, MAX_ELEMENT_TEXT_LEN),
    description: cleanNullableString(raw.description, MAX_ELEMENT_TEXT_LEN),
    patterns,
    isPassword,
    // 密码框严禁落存任何值，强制置空。
    value: isPassword
      ? null
      : (cleanOptionalString(raw.value, MAX_ELEMENT_TEXT_LEN) ?? null),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(typeof raw.uniqueAtCapture === "boolean"
      ? { uniqueAtCapture: raw.uniqueAtCapture }
      : {}),
    ...(bounds !== undefined ? { bounds } : {}),
  };
}

/**
 * 服务端桌面控件快照仓库：
 * - 按 `(ownerUserId, deviceId)` 隔离，防止跨用户/跨设备引用串台；
 * - 强制要求快照限定引用 `@<snapshotId>:e<N>`，拒绝裸 `@eN`；
 * - 密码框 (`isPassword === true`) 强制不落存任何 `value`；
 * - 每设备最多保留 `maxSnapshotsPerDevice`（默认 32）份，超过 `ttlMs`（默认 15 分钟）即失效。
 */
export function createDesktopSnapshotStore(options?: {
  maxSnapshotsPerDevice?: number;
  ttlMs?: number;
  now?: () => number;
}) {
  const maxSnapshotsPerDevice = Math.max(
    1,
    options?.maxSnapshotsPerDevice ?? DEFAULT_MAX_SNAPSHOTS_PER_DEVICE,
  );
  const ttlMs = Math.max(1, options?.ttlMs ?? DEFAULT_TTL_MS);
  const now = options?.now ?? Date.now;

  const partitions = new Map<
    string,
    {
      ownerUserId: string;
      deviceId: string;
      lastSnapshotId: number;
      snapshots: Map<number, StoredDesktopSnapshot>;
    }
  >();

  function pruneExpired(
    bucket: Map<number, StoredDesktopSnapshot>,
    currentTime: number,
  ) {
    for (const [id, snapshot] of bucket) {
      if (currentTime - snapshot.capturedAt > ttlMs) {
        bucket.delete(id);
      }
    }
  }

  return {
    saveSnapshot(input: SaveDesktopSnapshotInput): StoredDesktopSnapshot {
      const currentTime = now();
      const key = partitionKey(input.ownerUserId, input.deviceId);
      let partition = partitions.get(key);
      if (!partition) {
        partition = {
          ownerUserId: input.ownerUserId,
          deviceId: input.deviceId,
          lastSnapshotId: 0,
          snapshots: new Map(),
        };
        partitions.set(key, partition);
      }
      pruneExpired(partition.snapshots, currentTime);

      const snapshotId =
        Number.isSafeInteger(input.snapshotId) && input.snapshotId > 0
          ? input.snapshotId
          : partition.lastSnapshotId + 1;
      partition.lastSnapshotId = Math.max(partition.lastSnapshotId, snapshotId);

      const elementMap = new Map<string, StoredDesktopElement>();
      for (const rawElement of input.elements) {
        if (!rawElement || typeof rawElement !== "object") continue;
        const normalized = normalizeStoredElement(rawElement, snapshotId);
        if (!normalized) continue;
        elementMap.set(normalized.ref, normalized);
      }

      const stored: StoredDesktopSnapshot = {
        ownerUserId: input.ownerUserId,
        deviceId: input.deviceId,
        snapshotId,
        ...(typeof input.driver === "string" && input.driver.trim()
          ? { driver: clipText(input.driver.trim(), 80) }
          : {}),
        window: normalizeWindow(input.window),
        elements: elementMap,
        capturedAt: currentTime,
      };

      partition.snapshots.delete(snapshotId);
      partition.snapshots.set(snapshotId, stored);
      while (partition.snapshots.size > maxSnapshotsPerDevice) {
        const oldestKey = partition.snapshots.keys().next().value;
        if (oldestKey === undefined) break;
        partition.snapshots.delete(oldestKey);
      }
      return stored;
    },

    resolveRef(
      ownerUserId: string,
      deviceId: string,
      rawRef: string,
    ): ResolveDesktopRefResult {
      const parsed = parseDesktopRef(rawRef);
      if (!parsed) {
        return {
          ok: false,
          code: "STALE_REF",
          error: STALE_DESKTOP_REF_ERROR,
        };
      }
      const key = partitionKey(ownerUserId, deviceId);
      const partition = partitions.get(key);
      if (!partition) {
        return {
          ok: false,
          code: "STALE_REF",
          error: STALE_DESKTOP_REF_ERROR,
        };
      }
      const snapshot = partition.snapshots.get(parsed.snapshotId);
      if (!snapshot) {
        return {
          ok: false,
          code: "STALE_REF",
          error: STALE_DESKTOP_REF_ERROR,
        };
      }
      if (now() - snapshot.capturedAt > ttlMs) {
        partition.snapshots.delete(parsed.snapshotId);
        return {
          ok: false,
          code: "STALE_REF",
          error: STALE_DESKTOP_REF_ERROR,
        };
      }
      const canonicalRef = `@${parsed.snapshotId}:${parsed.elementKey}`;
      const element = snapshot.elements.get(canonicalRef);
      if (!element) {
        return {
          ok: false,
          code: "STALE_REF",
          error: STALE_DESKTOP_REF_ERROR,
        };
      }
      return { ok: true, snapshot, element };
    },

    clearDevice(deviceId: string): void {
      for (const [key, partition] of partitions) {
        if (partition.deviceId === deviceId) {
          partitions.delete(key);
        }
      }
    },

    snapshotCount(ownerUserId: string, deviceId: string): number {
      const partition = partitions.get(partitionKey(ownerUserId, deviceId));
      if (!partition) return 0;
      pruneExpired(partition.snapshots, now());
      return partition.snapshots.size;
    },
  };
}

export type DesktopSnapshotStore = ReturnType<
  typeof createDesktopSnapshotStore
>;

function sanitizeNodeForModel(
  node: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const isPassword = node.isPassword === true;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "value") {
      if (isPassword) {
        out.value = null;
      } else if (typeof value === "string") {
        out.value = clipText(value, MAX_ELEMENT_TEXT_LEN);
      } else if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        out.value = value;
      } else {
        out.value = null;
      }
      continue;
    }
    if (
      (key === "name" ||
        key === "title" ||
        key === "description" ||
        key === "automationId" ||
        key === "helpText" ||
        key === "label") &&
      typeof value === "string"
    ) {
      out[key] = clipText(value, MAX_ELEMENT_TEXT_LEN);
      continue;
    }
    if (key === "children" && Array.isArray(value) && depth < 16) {
      out.children = value
        .slice(0, MAX_MODEL_ELEMENTS)
        .map((child) =>
          child && typeof child === "object"
            ? sanitizeNodeForModel(child as Record<string, unknown>, depth + 1)
            : child,
        );
      continue;
    }
    out[key] = value;
  }
  if (isPassword) {
    out.value = null;
  }
  return out;
}

/**
 * 清洗 PC 端返回的桌面控件树快照以供模型读取：
 * 1) 强制清除所有 `isPassword === true` 节点的 `value`（置为 `null`）；
 * 2) 截断窗口标题、控件文本与文本树，防止超长内容撑爆上下文；
 * 3) 使用 `withUntrustedNotice` 包裹不可信内容边界提示，防范窗口标题 / 控件文案中的间接提示词注入。
 */
export function sanitizeDesktopSnapshotForModel(
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return withUntrustedNotice(
      {
        ok: false,
        raw:
          typeof raw === "string"
            ? clipText(raw, MAX_ELEMENT_TEXT_LEN)
            : (raw ?? null),
      },
      "desktop UI snapshot",
      ["raw"],
    );
  }

  const source = raw as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "untrusted") continue;
    if (
      key === "window" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      cleaned.window = normalizeWindow(value as StoredDesktopWindow);
      continue;
    }
    if (key === "elements" && Array.isArray(value)) {
      cleaned.elements = value
        .slice(0, MAX_MODEL_ELEMENTS)
        .map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? sanitizeNodeForModel(item as Record<string, unknown>)
            : item,
        );
      continue;
    }
    if (key === "tree") {
      if (typeof value === "string") {
        cleaned.tree = clipText(value, MAX_TREE_TEXT_LEN);
      } else if (Array.isArray(value)) {
        cleaned.tree = value
          .slice(0, MAX_MODEL_ELEMENTS)
          .map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? sanitizeNodeForModel(item as Record<string, unknown>)
              : item,
          );
      } else if (value && typeof value === "object") {
        cleaned.tree = sanitizeNodeForModel(value as Record<string, unknown>);
      } else {
        cleaned.tree = value;
      }
      continue;
    }
    if (
      (key === "title" ||
        key === "error" ||
        key === "note" ||
        key === "text") &&
      typeof value === "string"
    ) {
      cleaned[key] = clipText(value, MAX_ELEMENT_TEXT_LEN);
      continue;
    }
    cleaned[key] = value;
  }

  return withUntrustedNotice(cleaned, "desktop UI snapshot", [
    "window",
    "elements",
    "tree",
    "title",
    "text",
  ]);
}
