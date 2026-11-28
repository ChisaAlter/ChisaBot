import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type ComposerSettings,
  composerKeys,
  type QuickPhrase,
} from "./queries";

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "输入框设置操作失败，请稍后重试。";

export type ComposerSettingsInput = Partial<ComposerSettings>;

export type QuickPhraseInput = {
  text: string;
};

function invalidateComposer(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: composerKeys.all });
}

export function updateComposerSettingsMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: ComposerSettingsInput): Promise<ComposerSettings> =>
      client("/api/composer/settings", "settings", {
        method: "PUT",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateComposer(queryClient),
  });
}

export function createQuickPhraseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: QuickPhraseInput): Promise<QuickPhrase> =>
      client("/api/composer/quick-phrases", "phrase", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateComposer(queryClient),
  });
}

export function updateQuickPhraseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      input: QuickPhraseInput;
    }): Promise<QuickPhrase> =>
      client(`/api/composer/quick-phrases/${variables.id}`, "phrase", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateComposer(queryClient),
  });
}

export function deleteQuickPhraseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string): Promise<Response> =>
      client(`/api/composer/quick-phrases/${id}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateComposer(queryClient),
  });
}

export function reorderQuickPhrasesMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (ids: string[]): Promise<Response> =>
      client("/api/composer/quick-phrases/reorder", {
        method: "POST",
        body: { ids },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateComposer(queryClient),
  });
}

export function clearComposerHabitsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (botId?: string): Promise<Response> => {
      const params = botId ? `?botId=${encodeURIComponent(botId)}` : "";
      return client(`/api/composer/habits${params}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateComposer(queryClient),
  });
}

/**
 * 发送成功后记录一条习惯。故意不走 mutation 工厂：成败都不影响发送语义，
 * 失败沉默（候选只是少一些），也没有任何东西需要失效——正在输入的人不该被候选刷新打断。
 */
export async function recordComposerHabit(input: {
  botId: string;
  text: string;
}): Promise<void> {
  try {
    await client("/api/composer/habits/record", {
      method: "POST",
      body: input,
      fallback: FALLBACK,
    });
  } catch {
    // 习惯记录永远不该打断发送后的任何路径；丢一条习惯只是候选少一条。
  }
}
