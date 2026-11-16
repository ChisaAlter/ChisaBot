/**
 * 同 Provider 多 API Key 粘性轮换池（CB-045 / Key Pool）。
 *
 * 设计要点：
 * 1. 基于 FNV-1a 哈希 `stickyKey` 计算主索引，使同一会话稳定命中同一把健康 Key，保护上游 Prompt Cache；
 * 2. 主 Key 处于冷却或禁用状态时，按顺延环探找到下一把健康 Key，而不改变其他健康 Key 的映射槽位；
 * 3. 状态转移全部抽离为纯函数，既驱动运行期连接池，也直接供形式化模型检验器穷举验证。
 */

export type ModelPoolKey = {
  id: string;
  label: string;
  apiKey: string;
  disabled?: boolean;
  cooldownUntil?: number;
  lastStatus?: number;
};

export type ModelPoolKeyDescriptor = {
  id: string;
  label: string;
};

export type ModelKeyStatus = {
  id: string;
  label: string;
  healthy: boolean;
  cooldownUntil: number | null;
  lastStatus?: number;
};

export type KeySelection =
  | {
      key: ModelPoolKey;
      nextAvailableAt: null;
    }
  | {
      key: null;
      nextAvailableAt: number | null;
    };

export type KeyPoolHeaders = Headers | Record<string, string | undefined>;

export type ModelKeyPool = {
  setPool: (poolId: string, keys: readonly ModelPoolKey[]) => void;
  selectKey: (poolId: string, stickyKey: string, now?: number) => KeySelection;
  reportResult: (
    poolId: string,
    keyId: string,
    status: number,
    headers?: KeyPoolHeaders,
    now?: number,
  ) => void;
  getPoolStatus: (
    poolId: string,
    keys: readonly ModelPoolKeyDescriptor[],
    now?: number,
  ) => ModelKeyStatus[];
  deletePool: (poolId: string) => void;
};

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

const RETRY_AFTER_MIN_MS = 5_000;
const RETRY_AFTER_MAX_MS = 300_000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const QUOTA_EXHAUSTED_COOLDOWN_MS = 600_000;
const AUTH_FAILURE_COOLDOWN_MS = 3_600_000;

const utf8Encoder = new TextEncoder();

/** 标准 32 位 FNV-1a 哈希（按 UTF-8 字节计算）。 */
export function fnv1a32(input: string): number {
  const bytes = utf8Encoder.encode(input);
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return hash >>> 0;
}

function readHeader(
  headers: KeyPoolHeaders | undefined,
  targetName: string,
): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(targetName) ?? undefined;
  }
  const lower = targetName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lower && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 解析 Retry-After 头（支持秒数与 HTTP-date），并钳位到 [5_000, 300_000] ms。 */
export function parseRetryAfterMs(
  headers: KeyPoolHeaders | undefined,
  now: number = Date.now(),
): number {
  const raw = readHeader(headers, "retry-after")?.trim();
  if (!raw) return RETRY_AFTER_DEFAULT_MS;

  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return clamp(
        Math.round(seconds * 1000),
        RETRY_AFTER_MIN_MS,
        RETRY_AFTER_MAX_MS,
      );
    }
  }

  const parsedDateMs = Date.parse(raw);
  if (Number.isFinite(parsedDateMs)) {
    return clamp(parsedDateMs - now, RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS);
  }

  return RETRY_AFTER_DEFAULT_MS;
}

/** 根据上游状态码计算冷却时长（ms）；`2xx` 返回 `0` 表示解除冷却；其余无关状态码返回 `null`。 */
export function cooldownDurationForStatus(
  status: number,
  headers?: KeyPoolHeaders,
  now: number = Date.now(),
): number | null {
  if (status >= 200 && status < 300) return 0;
  if (status === 429) return parseRetryAfterMs(headers, now);
  if (status === 402) return QUOTA_EXHAUSTED_COOLDOWN_MS;
  if (status === 401 || status === 403) return AUTH_FAILURE_COOLDOWN_MS;
  return null;
}

function isKeyHealthy(key: ModelPoolKey, now: number): boolean {
  if (key.disabled) return false;
  if (key.cooldownUntil !== undefined && key.cooldownUntil > now) return false;
  return true;
}

/** 纯状态转移：从密钥池按粘性哈希选取健康 Key；全池冷却时返回最短恢复时间戳。 */
export function selectKeyFromPool(
  keys: readonly ModelPoolKey[],
  stickyKey: string,
  now: number = Date.now(),
): KeySelection {
  if (keys.length === 0) {
    return { key: null, nextAvailableAt: null };
  }

  const primaryIndex = fnv1a32(stickyKey) % keys.length;
  for (let offset = 0; offset < keys.length; offset++) {
    const candidate = keys[(primaryIndex + offset) % keys.length];
    if (candidate && isKeyHealthy(candidate, now)) {
      return { key: candidate, nextAvailableAt: null };
    }
  }

  let nextAvailableAt: number | null = null;
  for (const candidate of keys) {
    if (candidate.disabled) continue;
    if (
      candidate.cooldownUntil !== undefined &&
      candidate.cooldownUntil > now
    ) {
      if (
        nextAvailableAt === null ||
        candidate.cooldownUntil < nextAvailableAt
      ) {
        nextAvailableAt = candidate.cooldownUntil;
      }
    }
  }

  return { key: null, nextAvailableAt };
}

/** 纯状态转移：根据调用结果更新指定 Key 的冷却截止时间与失败状态标记。 */
export function applyKeyResultToPool(
  keys: readonly ModelPoolKey[],
  keyId: string,
  status: number,
  headers?: KeyPoolHeaders,
  now: number = Date.now(),
): ModelPoolKey[] {
  const duration = cooldownDurationForStatus(status, headers, now);
  if (duration === null) return [...keys];

  return keys.map((item) => {
    if (item.id !== keyId) return item;
    if (duration === 0) {
      const { cooldownUntil: _c, lastStatus: _s, ...rest } = item;
      return rest;
    }
    return {
      ...item,
      cooldownUntil: now + duration,
      lastStatus: status,
    };
  });
}

/**
 * 对比现有池与新配置：仅当配置发生实质变更时返回新数组，
 * 并为未修改 `apiKey` 且未改启用状态的现有 `id` 保留当前冷却状态。
 */
export function reconcilePoolKeys(
  existing: readonly ModelPoolKey[],
  next: readonly ModelPoolKey[],
): { keys: ModelPoolKey[]; changed: boolean } {
  const sameShape =
    existing.length === next.length &&
    existing.every((prev, index) => {
      const target = next[index];
      return (
        target !== undefined &&
        prev.id === target.id &&
        prev.label === target.label &&
        prev.apiKey === target.apiKey &&
        Boolean(prev.disabled) === Boolean(target.disabled)
      );
    });

  if (sameShape) {
    return { keys: [...existing], changed: false };
  }

  const byId = new Map(existing.map((item) => [item.id, item]));
  const merged = next.map((item): ModelPoolKey => {
    const prev = byId.get(item.id);
    const keepCooldown =
      prev !== undefined &&
      prev.apiKey === item.apiKey &&
      Boolean(prev.disabled) === Boolean(item.disabled);
    if (!keepCooldown) {
      return {
        id: item.id,
        label: item.label,
        apiKey: item.apiKey,
        ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
        ...(item.cooldownUntil !== undefined
          ? { cooldownUntil: item.cooldownUntil }
          : {}),
        ...(item.lastStatus !== undefined
          ? { lastStatus: item.lastStatus }
          : {}),
      };
    }
    return {
      id: item.id,
      label: item.label,
      apiKey: item.apiKey,
      ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      ...(prev.cooldownUntil !== undefined
        ? { cooldownUntil: prev.cooldownUntil }
        : {}),
      ...(prev.lastStatus !== undefined ? { lastStatus: prev.lastStatus } : {}),
    };
  });

  return { keys: merged, changed: true };
}

/** 生成不含明文密钥的池健康状态投影。 */
export function projectPoolStatus(
  poolKeys: readonly ModelPoolKey[],
  requestedKeys: readonly ModelPoolKeyDescriptor[],
  now: number = Date.now(),
): ModelKeyStatus[] {
  const byId = new Map(poolKeys.map((item) => [item.id, item]));
  return requestedKeys.map((descriptor) => {
    const current = byId.get(descriptor.id);
    if (!current) {
      return {
        id: descriptor.id,
        label: descriptor.label,
        healthy: true,
        cooldownUntil: null,
      };
    }
    const cooling =
      current.cooldownUntil !== undefined && current.cooldownUntil > now;
    const healthy = !current.disabled && !cooling;
    return {
      id: descriptor.id,
      label: descriptor.label,
      healthy,
      cooldownUntil: cooling ? (current.cooldownUntil ?? null) : null,
      ...(current.lastStatus !== undefined
        ? { lastStatus: current.lastStatus }
        : {}),
    };
  });
}

export function createModelKeyPool(): ModelKeyPool {
  const pools = new Map<string, ModelPoolKey[]>();

  return {
    setPool(poolId, keys) {
      const existing = pools.get(poolId);
      if (!existing) {
        pools.set(
          poolId,
          keys.map((item) => ({ ...item })),
        );
        return;
      }
      const { keys: reconciled, changed } = reconcilePoolKeys(existing, keys);
      if (changed) {
        pools.set(poolId, reconciled);
      }
    },

    selectKey(poolId, stickyKey, now = Date.now()) {
      const pool = pools.get(poolId) ?? [];
      return selectKeyFromPool(pool, stickyKey, now);
    },

    reportResult(poolId, keyId, status, headers, now = Date.now()) {
      const pool = pools.get(poolId);
      if (!pool) return;
      const updated = applyKeyResultToPool(pool, keyId, status, headers, now);
      pools.set(poolId, updated);
    },

    getPoolStatus(poolId, keys, now = Date.now()) {
      const pool = pools.get(poolId) ?? [];
      return projectPoolStatus(pool, keys, now);
    },

    deletePool(poolId) {
      pools.delete(poolId);
    },
  };
}
