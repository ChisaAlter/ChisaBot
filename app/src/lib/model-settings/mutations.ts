import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { credentialKeys } from "@/lib/credentials/queries";
import type { ModelSettingsCurrent, ModelSettingsInput } from "./form";
import { modelSettingsKeys } from "./queries";

export type ModelConnectionResult = {
  ok: boolean;
  message: string;
  latencyMs: number;
};

export function saveModelSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    gcTime: 0,
    mutationFn: (input: ModelSettingsInput) =>
      client<ModelSettingsCurrent>("/api/admin/model-settings", "config", {
        method: "PUT",
        body: input,
        fallback: "无法保存模型设置。",
      }),
    onSuccess: (config) => {
      queryClient.setQueryData(modelSettingsKeys.current, config);
      return queryClient.invalidateQueries({ queryKey: credentialKeys.all });
    },
  });
}

export function testModelConnectionMutationOptions() {
  return mutationOptions({
    gcTime: 0,
    mutationFn: async (
      input: ModelSettingsInput,
    ): Promise<ModelConnectionResult> => {
      const response = await client("/api/admin/model-settings/test", {
        method: "POST",
        body: input,
        fallback: "无法测试模型连接。",
      });
      return response.json();
    },
  });
}

/** 保存「备用模型」顺序。响应就是存下的那份，缓存直接吃响应。 */
export function saveFallbackModelsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (models: string[]): Promise<{ models: string[] }> => {
      const response = await tryClient("/api/admin/model-fallbacks", {
        method: "PUT",
        body: { models },
      });
      const parsed = (await response.json().catch(() => null)) as {
        models?: string[];
        error?: string;
      } | null;
      if (!response.ok || !parsed || !Array.isArray(parsed.models))
        throw new Error(parsed?.error || "保存失败，请重试");
      return { models: parsed.models };
    },
    onSuccess: (result) =>
      queryClient.setQueryData(modelSettingsKeys.fallbacks, result),
  });
}

/** 保存「摘要模型」（null = 跟随主模型）。响应就是存下的那份，缓存直接吃响应。 */
export function saveHistorySummaryModelMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      model: string | null,
    ): Promise<{ model: string | null }> => {
      const response = await tryClient("/api/admin/history-summary-model", {
        method: "PUT",
        body: { model },
      });
      const parsed = (await response.json().catch(() => null)) as {
        model?: string | null;
        error?: string;
      } | null;
      if (
        !response.ok ||
        !parsed ||
        (parsed.model !== null && typeof parsed.model !== "string")
      )
        throw new Error(parsed?.error || "保存失败，请重试");
      return { model: parsed.model ?? null };
    },
    onSuccess: (result) =>
      queryClient.setQueryData(modelSettingsKeys.historySummary, result),
  });
}
