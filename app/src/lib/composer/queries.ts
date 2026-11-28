import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 输入框智能的服务端形状。设置与快捷短语按登录用户隔离；候选按 (用户, Bot) 隔离，
 * 服务器已经算好来源与排序，浏览器只渲染，不重新推导规则。
 */

export type ComposerSettings = {
  /** 总开关：关掉后候选、学习与将来的 AI 功能全部停止。 */
  enabled: boolean;
  /** AI 建议开关（PR5 上线前只作为偏好保存）。 */
  aiEnabled: boolean;
  /** 行内补全开关（PR6 上线前只作为偏好保存）。 */
  completionEnabled: boolean;
  /** 学习习惯开关：关时不记录新习惯，也不出习惯候选。 */
  learningEnabled: boolean;
  /** 本地候选开关：关时快捷短语与习惯都不出。 */
  localCompletionEnabled: boolean;
};

export type QuickPhrase = {
  id: string;
  text: string;
  position: number;
};

export type ComposerCandidate = {
  source: "phrase" | "habit";
  text: string;
  useCount: number;
};

export const composerKeys = {
  all: ["composer"] as const,
  settings: () => ["composer", "settings"] as const,
  phrases: () => ["composer", "quick-phrases"] as const,
  candidates: (botId: string | null, prefix: string) =>
    ["composer", "candidates", { botId, prefix }] as const,
};

export function composerSettingsQueryOptions() {
  return queryOptions({
    queryKey: composerKeys.settings(),
    queryFn: (): Promise<ComposerSettings> =>
      client("/api/composer/settings", "settings", {
        fallback: "无法加载输入框设置。",
      }),
  });
}

export function quickPhrasesQueryOptions() {
  return queryOptions({
    queryKey: composerKeys.phrases(),
    queryFn: (): Promise<QuickPhrase[]> =>
      client("/api/composer/quick-phrases", "phrases", {
        fallback: "无法加载快捷短语。",
      }),
  });
}

/**
 * 候选随输入逐键变化：prefix 进 key，每个前缀一条缓存。候选条只在有前缀时查询，
 * 空输入不发请求；调用方自行 debounce，避免一键一请求。
 */
export function composerCandidatesQueryOptions(
  botId: string | null,
  prefix: string,
) {
  const params = new URLSearchParams();
  if (botId) params.set("botId", botId);
  params.set("prefix", prefix);
  return queryOptions({
    queryKey: composerKeys.candidates(botId, prefix),
    queryFn: (): Promise<ComposerCandidate[]> =>
      client(`/api/composer/candidates?${params}`, "candidates", {
        fallback: "无法加载输入候选。",
      }),
    enabled: prefix.trim().length > 0,
    staleTime: 30_000,
  });
}
