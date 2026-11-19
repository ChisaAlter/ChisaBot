import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  MAX_WEB_SEARCH_OVERRIDES,
  MAX_WEB_SEARCH_TIMEOUT_MS,
  MIN_WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_EXTERNAL_PROVIDERS,
  WEB_SEARCH_PROVIDER_KINDS,
  WEB_SEARCH_PROVIDER_PRESETS,
  type WebSearchExternalProviderKind,
  type WebSearchKeySource,
  type WebSearchModelOverride,
  type WebSearchOverrideMode,
  type WebSearchProviderKind,
  type WebSearchProviderSlotInput,
  type WebSearchProviderSlotView,
  type WebSearchSettingsInput,
  type WebSearchSettingsView,
  type WebSearchTestHit,
  type WebSearchTestResult,
} from "../../../shared/web-search";

export {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  MAX_WEB_SEARCH_OVERRIDES,
  MAX_WEB_SEARCH_TIMEOUT_MS,
  MIN_WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_EXTERNAL_PROVIDERS,
  WEB_SEARCH_PROVIDER_KINDS,
  WEB_SEARCH_PROVIDER_PRESETS,
  type WebSearchExternalProviderKind,
  type WebSearchKeySource,
  type WebSearchModelOverride,
  type WebSearchOverrideMode,
  type WebSearchProviderKind,
  type WebSearchProviderSlotInput,
  type WebSearchProviderSlotView,
  type WebSearchSettingsInput,
  type WebSearchSettingsView,
  type WebSearchTestHit,
  type WebSearchTestResult,
};

export const webSearchKeys = {
  all: ["web-search"] as const,
  settings: ["web-search", "settings"] as const,
};

export type WebSearchTestRequest = {
  query: string;
  count?: number;
  provider?: WebSearchProviderKind;
  baseUrl?: string;
  apiKey?: string;
  fallbackToBuiltin?: boolean;
  timeoutMs?: number;
};

export function webSearchSettingsQueryOptions() {
  return queryOptions({
    queryKey: webSearchKeys.settings,
    queryFn: async ({ signal }): Promise<WebSearchSettingsView> => {
      const response = await client("/api/web-search/settings", {
        signal,
        fallback: "无法加载联网搜索配置。",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as WebSearchSettingsView | null;
      if (!payload || typeof payload !== "object") {
        throw new Error("联网搜索配置响应格式无效。");
      }
      return payload;
    },
  });
}

export async function saveWebSearchSettings(
  input: WebSearchSettingsInput,
): Promise<WebSearchSettingsView> {
  const response = await client("/api/web-search/settings", {
    method: "PUT",
    body: input,
    fallback: "保存联网搜索配置失败，请重试。",
  });
  const payload = (await response
    .json()
    .catch(() => null)) as WebSearchSettingsView | null;
  if (!payload || typeof payload !== "object") {
    throw new Error("保存联网搜索配置返回格式无效。");
  }
  return payload;
}

export async function testWebSearch(
  input: WebSearchTestRequest,
): Promise<WebSearchTestResult> {
  const response = await client("/api/web-search/test", {
    method: "POST",
    body: {
      query: input.query.trim(),
      ...(input.count !== undefined ? { count: input.count } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.fallbackToBuiltin !== undefined
        ? { fallbackToBuiltin: input.fallbackToBuiltin }
        : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
    fallback: "联网试搜失败，请检查接口地址与密钥。",
    timeoutMs: 35_000,
  });
  const payload = (await response
    .json()
    .catch(() => null)) as WebSearchTestResult | null;
  if (!payload || typeof payload.ok !== "boolean") {
    throw new Error("联网试搜返回格式无效。");
  }
  return payload;
}
