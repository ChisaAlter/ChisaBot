import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type { ModelSettingsCurrent } from "./form";

export const modelSettingsKeys = {
  current: ["model-settings", "current"] as const,
  fallbacks: ["admin", "model-fallbacks"] as const,
  historySummary: ["admin", "history-summary-model"] as const,
};

export function modelSettingsQueryOptions() {
  return queryOptions({
    queryKey: modelSettingsKeys.current,
    queryFn: () =>
      client<ModelSettingsCurrent>("/api/admin/model-settings", "config", {
        fallback: "无法加载模型设置。",
      }),
  });
}

/** 设置 → 模型 →「备用模型」（DESIGN.md §61）：主模型用不了时按这个顺序换。 */
export function fallbackModelsQueryOptions() {
  return queryOptions({
    queryKey: modelSettingsKeys.fallbacks,
    queryFn: async ({ signal }): Promise<{ models: string[] }> => {
      const response = await tryClient("/api/admin/model-fallbacks", {
        signal,
      });
      const parsed = (await response.json().catch(() => null)) as {
        models?: string[];
        error?: string;
      } | null;
      if (!response.ok || !parsed || !Array.isArray(parsed.models))
        throw new Error(parsed?.error || "无法加载备用模型");
      return { models: parsed.models };
    },
  });
}

/** 设置 → 模型 →「摘要模型」：长对话压缩前文时用哪个模型写摘要；null = 跟随主模型。 */
export function historySummaryModelQueryOptions() {
  return queryOptions({
    queryKey: modelSettingsKeys.historySummary,
    queryFn: async ({ signal }): Promise<{ model: string | null }> => {
      const response = await tryClient("/api/admin/history-summary-model", {
        signal,
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
        throw new Error(parsed?.error || "无法加载摘要模型");
      return { model: parsed.model ?? null };
    },
  });
}
