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

const RETRY_AFTER_NUM_RE = /^-?\d+(?:\.\d+)?$/;

/** 标准 32 位 FNV-1a 哈希（按 UTF-8 字节流在线计算，与 TextEncoder 逐字节一致且零堆分配）。 */
export function fnv1a32(input: string): number {
  let hash = FNV1A_OFFSET_BASIS;
  const len = input.length;
  for (let i = 0; i < len; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      hash ^= code;
      hash = Math.imul(hash, FNV1A_PRIME);
    } else if (code < 0x800) {
      hash ^= 0xc0 | (code >> 6);
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, FNV1A_PRIME);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < len) {
        const low = input.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          i++;
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          hash ^= 0xf0 | (code >> 18);
          hash = Math.imul(hash, FNV1A_PRIME);
          hash ^= 0x80 | ((code >> 12) & 0x3f);
          hash = Math.imul(hash, FNV1A_PRIME);
          hash ^= 0x80 | ((code >> 6) & 0x3f);
          hash = Math.imul(hash, FNV1A_PRIME);
          hash ^= 0x80 | (code & 0x3f);
          hash = Math.imul(hash, FNV1A_PRIME);
          continue;
        }
      }
      // 孤立高代理按 WHATWG TextEncoder 规范编码为 U+FFFD (EF BF BD)
      hash ^= 0xef;
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0xbf;
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0xbd;
      hash = Math.imul(hash, FNV1A_PRIME);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低代理按 WHATWG TextEncoder 规范编码为 U+FFFD (EF BF BD)
      hash ^= 0xef;
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0xbf;
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0xbd;
      hash = Math.imul(hash, FNV1A_PRIME);
    } else {
      hash ^= 0xe0 | (code >> 12);
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0x80 | ((code >> 6) & 0x3f);
      hash = Math.imul(hash, FNV1A_PRIME);
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, FNV1A_PRIME);
    }
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
  const direct = headers[targetName];
  if (typeof direct === "string") return direct;
  const lower = targetName.toLowerCase();
  for (const name in headers) {
    if (name.toLowerCase() === lower) {
      const value = headers[name];
      if (typeof value === "string") return value;
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

  if (RETRY_AFTER_NUM_RE.test(raw)) {
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

function clearKeyCooldown(item: ModelPoolKey): ModelPoolKey {
  if (item.disabled !== undefined) {
    return {
      id: item.id,
      label: item.label,
      apiKey: item.apiKey,
      disabled: item.disabled,
    };
  }
  return {
    id: item.id,
    label: item.label,
    apiKey: item.apiKey,
  };
}

function setKeyCooldown(
  item: ModelPoolKey,
  cooldownUntil: number,
  lastStatus: number,
): ModelPoolKey {
  if (item.disabled !== undefined) {
    return {
      id: item.id,
      label: item.label,
      apiKey: item.apiKey,
      disabled: item.disabled,
      cooldownUntil,
      lastStatus,
    };
  }
  return {
    id: item.id,
    label: item.label,
    apiKey: item.apiKey,
    cooldownUntil,
    lastStatus,
  };
}

/** 纯状态转移：从密钥池按粘性哈希选取健康 Key；全池冷却时返回最短恢复时间戳。 */
export function selectKeyFromPool(
  keys: readonly ModelPoolKey[],
  stickyKey: string,
  now: number = Date.now(),
): KeySelection {
  const len = keys.length;
  if (len === 0) {
    return { key: null, nextAvailableAt: null };
  }

  const primaryIndex = fnv1a32(stickyKey) % len;
  const primary = keys[primaryIndex];
  if (primary && isKeyHealthy(primary, now)) {
    return { key: primary, nextAvailableAt: null };
  }

  let nextAvailableAt: number | null =
    primary &&
    !primary.disabled &&
    primary.cooldownUntil !== undefined &&
    primary.cooldownUntil > now
      ? primary.cooldownUntil
      : null;

  let idx = primaryIndex + 1;
  if (idx === len) idx = 0;
  for (let step = 1; step < len; step++) {
    const candidate = keys[idx];
    if (candidate) {
      if (isKeyHealthy(candidate, now)) {
        return { key: candidate, nextAvailableAt: null };
      }
      if (
        !candidate.disabled &&
        candidate.cooldownUntil !== undefined &&
        candidate.cooldownUntil > now &&
        (nextAvailableAt === null || candidate.cooldownUntil < nextAvailableAt)
      ) {
        nextAvailableAt = candidate.cooldownUntil;
      }
    }
    idx++;
    if (idx === len) idx = 0;
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

  const len = keys.length;
  const out = new Array<ModelPoolKey>(len);
  for (let i = 0; i < len; i++) {
    const item = keys[i];
    if (!item) continue;
    if (item.id !== keyId) {
      out[i] = item;
    } else if (duration === 0) {
      out[i] =
        item.cooldownUntil === undefined && item.lastStatus === undefined
          ? item
          : clearKeyCooldown(item);
    } else {
      out[i] = setKeyCooldown(item, now + duration, status);
    }
  }
  return out;
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

function buildStatusEntry(
  descriptor: ModelPoolKeyDescriptor,
  current: ModelPoolKey | undefined,
  now: number,
): ModelKeyStatus {
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
  const cooldownUntil = cooling ? (current.cooldownUntil ?? null) : null;
  if (current.lastStatus !== undefined) {
    return {
      id: descriptor.id,
      label: descriptor.label,
      healthy,
      cooldownUntil,
      lastStatus: current.lastStatus,
    };
  }
  return {
    id: descriptor.id,
    label: descriptor.label,
    healthy,
    cooldownUntil,
  };
}

/** 生成不含明文密钥的池健康状态投影。 */
export function projectPoolStatus(
  poolKeys: readonly ModelPoolKey[],
  requestedKeys: readonly ModelPoolKeyDescriptor[],
  now: number = Date.now(),
): ModelKeyStatus[] {
  const reqLen = requestedKeys.length;
  const poolLen = poolKeys.length;
  const out = new Array<ModelKeyStatus>(reqLen);
  let byId: Map<string, ModelPoolKey> | null = null;

  for (let i = 0; i < reqLen; i++) {
    const descriptor = requestedKeys[i];
    if (!descriptor) continue;
    let current: ModelPoolKey | undefined;
    if (i < poolLen && poolKeys[i]?.id === descriptor.id) {
      current = poolKeys[i];
    } else if (poolLen > 0) {
      if (byId === null) {
        byId = new Map<string, ModelPoolKey>();
        for (let j = 0; j < poolLen; j++) {
          const item = poolKeys[j];
          if (item) byId.set(item.id, item);
        }
      }
      current = byId.get(descriptor.id);
    }
    out[i] = buildStatusEntry(descriptor, current, now);
  }
  return out;
}

type PoolEntry = {
  keys: ModelPoolKey[];
  indexById: Map<string, number>;
};

function buildIndexById(keys: readonly ModelPoolKey[]): Map<string, number> {
  const indexById = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    const item = keys[i];
    if (item) indexById.set(item.id, i);
  }
  return indexById;
}

export function createModelKeyPool(): ModelKeyPool {
  const pools = new Map<string, PoolEntry>();

  return {
    setPool(poolId, keys) {
      const existing = pools.get(poolId);
      if (!existing) {
        const cloned = keys.map((item) => ({ ...item }));
        pools.set(poolId, {
          keys: cloned,
          indexById: buildIndexById(cloned),
        });
        return;
      }
      const { keys: reconciled, changed } = reconcilePoolKeys(
        existing.keys,
        keys,
      );
      if (changed) {
        pools.set(poolId, {
          keys: reconciled,
          indexById: buildIndexById(reconciled),
        });
      }
    },

    selectKey(poolId, stickyKey, now = Date.now()) {
      const entry = pools.get(poolId);
      if (!entry) return { key: null, nextAvailableAt: null };
      return selectKeyFromPool(entry.keys, stickyKey, now);
    },

    reportResult(poolId, keyId, status, headers, now = Date.now()) {
      const entry = pools.get(poolId);
      if (!entry) return;
      const duration = cooldownDurationForStatus(status, headers, now);
      if (duration === null) return;
      const idx = entry.indexById.get(keyId);
      if (idx === undefined) return;
      const item = entry.keys[idx];
      if (!item) return;
      if (duration === 0) {
        if (item.cooldownUntil === undefined && item.lastStatus === undefined) {
          return;
        }
        entry.keys[idx] = clearKeyCooldown(item);
      } else {
        entry.keys[idx] = setKeyCooldown(item, now + duration, status);
      }
    },

    getPoolStatus(poolId, keys, now = Date.now()) {
      const entry = pools.get(poolId);
      const reqLen = keys.length;
      const out = new Array<ModelKeyStatus>(reqLen);
      if (!entry) {
        for (let i = 0; i < reqLen; i++) {
          const descriptor = keys[i];
          if (descriptor) {
            out[i] = {
              id: descriptor.id,
              label: descriptor.label,
              healthy: true,
              cooldownUntil: null,
            };
          }
        }
        return out;
      }

      const poolKeys = entry.keys;
      const poolLen = poolKeys.length;
      const indexById = entry.indexById;
      for (let i = 0; i < reqLen; i++) {
        const descriptor = keys[i];
        if (!descriptor) continue;
        let current: ModelPoolKey | undefined;
        if (i < poolLen && poolKeys[i]?.id === descriptor.id) {
          current = poolKeys[i];
        } else {
          const idx = indexById.get(descriptor.id);
          if (idx !== undefined) current = poolKeys[idx];
        }
        out[i] = buildStatusEntry(descriptor, current, now);
      }
      return out;
    },

    deletePool(poolId) {
      pools.delete(poolId);
    },
  };
}
