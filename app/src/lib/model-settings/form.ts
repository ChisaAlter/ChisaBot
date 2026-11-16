import { normalizeModelBaseUrl } from "../../../../shared/model-base-url";

export type PooledApiKeyProjection = {
  id: string;
  label: string;
  hasApiKey: boolean;
  healthy: boolean;
  cooldownUntil: number | null;
  lastStatus?: number;
};

export type PooledApiKeySubmission = {
  id?: string;
  label: string;
  apiKey?: string;
  remove?: boolean;
};

export type PooledKeyDraft =
  | {
      kind: "existing";
      id: string;
      label: string;
      hasApiKey: boolean;
      newApiKey: string;
      removed: boolean;
    }
  | {
      kind: "new";
      clientKey: string;
      label: string;
      apiKey: string;
    };

export type PooledKeyFieldErrors = {
  label?: string;
  apiKey?: string;
};

export type ModelSettingsDraft = {
  provider: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  useApiKey: boolean;
  apiKey: string;
  pooledKeys?: PooledKeyDraft[];
};

export type ModelSettingsCurrent = Omit<
  ModelSettingsDraft,
  "apiKey" | "pooledKeys"
> & {
  hasApiKey: boolean;
  source: "environment" | "saved";
  pooledKeys?: PooledApiKeyProjection[];
};

export type ModelSettingsErrors = Partial<
  Record<"provider" | "model" | "baseUrl" | "apiKey", string>
> & {
  pooledKeys?: Record<string, PooledKeyFieldErrors>;
};

export type ModelSettingsInput = Omit<
  ModelSettingsDraft,
  "apiKey" | "pooledKeys"
> & {
  apiKey?: string;
  pooledKeys?: PooledApiKeySubmission[];
};

export function pooledKeyDraftKey(entry: PooledKeyDraft): string {
  return entry.kind === "existing" ? entry.id : entry.clientKey;
}

export function pooledKeyDraftsFromCurrent(
  pooledKeys?: readonly PooledApiKeyProjection[],
): PooledKeyDraft[] {
  if (!pooledKeys?.length) return [];
  return pooledKeys.map((entry) => ({
    kind: "existing",
    id: entry.id,
    label: entry.label,
    hasApiKey: entry.hasApiKey,
    newApiKey: "",
    removed: false,
  }));
}

export function pooledKeysInputFromDraft(
  draft: ModelSettingsDraft,
): PooledApiKeySubmission[] | undefined {
  if (!draft.useApiKey || !draft.pooledKeys?.length) return undefined;
  const submissions: PooledApiKeySubmission[] = [];
  for (const entry of draft.pooledKeys) {
    if (entry.kind === "existing") {
      if (entry.removed) {
        submissions.push({
          id: entry.id,
          label: entry.label.trim(),
          remove: true,
        });
        continue;
      }
      const nextKey = entry.newApiKey.trim();
      submissions.push({
        id: entry.id,
        label: entry.label.trim(),
        ...(nextKey ? { apiKey: nextKey } : {}),
      });
    } else {
      submissions.push({
        label: entry.label.trim(),
        apiKey: entry.apiKey.trim(),
      });
    }
  }
  return submissions.length > 0 ? submissions : undefined;
}

export type PooledKeyHealthView = {
  state: "healthy" | "cooldown" | "ready" | "unhealthy";
  label: string;
  detail?: string;
  badgeClass: string;
  dotClass: string;
};

export function describePooledKeyHealth(
  key: PooledApiKeyProjection,
  nowMs: number,
): PooledKeyHealthView {
  const statusDetail =
    typeof key.lastStatus === "number"
      ? `最近状态码 HTTP ${key.lastStatus}`
      : undefined;
  if (key.healthy) {
    return {
      state: "healthy",
      label: "健康",
      detail: statusDetail,
      badgeClass: "magpie-badge is-ok",
      dotClass: "model-health-dot is-ok",
    };
  }
  if (key.cooldownUntil !== null) {
    if (key.cooldownUntil > nowMs) {
      const remainingSec = Math.max(
        1,
        Math.ceil((key.cooldownUntil - nowMs) / 1000),
      );
      return {
        state: "cooldown",
        label: `冷却中，剩余 ${remainingSec} 秒`,
        detail: statusDetail,
        badgeClass: "magpie-badge is-warn",
        dotClass: "model-health-dot is-off",
      };
    }
    return {
      state: "ready",
      label: "冷却已结束（待恢复）",
      detail: statusDetail,
      badgeClass: "magpie-badge is-warn",
      dotClass: "model-health-dot is-off",
    };
  }
  return {
    state: "unhealthy",
    label: key.lastStatus ? `异常（HTTP ${key.lastStatus}）` : "异常",
    detail: statusDetail,
    badgeClass: "magpie-badge is-danger",
    dotClass: "model-health-dot is-bad",
  };
}

export function modelSettingsInput(
  draft: ModelSettingsDraft,
): ModelSettingsInput {
  const apiKey = draft.apiKey.trim();
  const pooledKeys = pooledKeysInputFromDraft(draft);
  return {
    provider: draft.provider,
    model: draft.model.trim(),
    baseUrl:
      normalizedEndpoint(draft.baseUrl, draft.provider) ?? draft.baseUrl.trim(),
    useApiKey: draft.useApiKey,
    ...(draft.useApiKey && apiKey ? { apiKey } : {}),
    ...(pooledKeys ? { pooledKeys } : {}),
  };
}

export function modelSettingsValidation(
  draft: ModelSettingsDraft,
  current: ModelSettingsCurrent,
): ModelSettingsErrors {
  const errors: ModelSettingsErrors = {};
  if (!draft.model.trim()) errors.model = "请输入模型名称。";
  const endpoint = normalizedEndpoint(draft.baseUrl, draft.provider);
  if (!endpoint) {
    errors.baseUrl =
      "请输入完整的 HTTP 或 HTTPS 地址，地址中不要包含密钥、查询参数或片段。";
  }
  if (
    draft.useApiKey &&
    !draft.apiKey.trim() &&
    (!current.useApiKey ||
      !current.hasApiKey ||
      draft.provider !== current.provider ||
      endpoint !== normalizedEndpoint(current.baseUrl, current.provider))
  ) {
    errors.apiKey = "请为此接口填写 API Key，或关闭“此接口需要 API Key”。";
  }
  if (draft.useApiKey && draft.pooledKeys?.length) {
    const pooledErrors: Record<string, PooledKeyFieldErrors> = {};
    for (const entry of draft.pooledKeys) {
      if (entry.kind === "existing" && entry.removed) continue;
      const entryErrors: PooledKeyFieldErrors = {};
      if (!entry.label.trim()) {
        entryErrors.label = "请填写备选 Key 的别名。";
      }
      if (entry.kind === "new" && !entry.apiKey.trim()) {
        entryErrors.apiKey = "请填写新增备选 Key 的 API Key。";
      } else if (
        entry.kind === "existing" &&
        !entry.hasApiKey &&
        !entry.newApiKey.trim()
      ) {
        entryErrors.apiKey = "请填写此备选 Key 的 API Key，或将其移除。";
      }
      if (entryErrors.label || entryErrors.apiKey) {
        pooledErrors[pooledKeyDraftKey(entry)] = entryErrors;
      }
    }
    if (Object.keys(pooledErrors).length > 0) {
      errors.pooledKeys = pooledErrors;
    }
  }
  return errors;
}

function normalizedEndpoint(
  value: string,
  provider: ModelSettingsDraft["provider"],
): string | null {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return normalizeModelBaseUrl(provider, url.toString());
  } catch {
    return null;
  }
}
