import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import type { UserPreferences } from "../../../../shared/user-preferences";
import { settingsKeys } from "./queries";

export type { MessageListEmphasis } from "../../../../shared/user-preferences";

export function userPreferencesQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: [...settingsKeys.all, "preferences", userId] as const,
    enabled: Boolean(userId),
    queryFn: ({ signal }): Promise<UserPreferences> =>
      client("/api/settings/preferences", "preferences", {
        signal,
        fallback: "无法加载您的偏好设置",
      }),
  });
}

export function useUserPreferences() {
  const user = useQuery(currentUserQueryOptions());
  const preferences = useQuery(userPreferencesQueryOptions(user.data?.id));
  /*
   * 只读出调用方用得到的三样（data / userId / settled），不要把整个查询结果展开。TanStack Query 只在
   * 「读过的字段」变了时才让组件重渲染；`...preferences` 会把 isFetching、dataUpdatedAt 等全部读一遍，
   * 于是每次后台重读（数据没变）都让所有用到偏好的组件渲染两次（开始读、读完）。ChatStage 经 useLanding →
   * useMainBot 用到它，从设置回聊天约 100ms 后整段聊天跟着重渲染，就是这里（本 PR 的 DEVLOG）。
   */
  return {
    userId: user.data?.id,
    data: preferences.data,
    /*
     * 当前用户读失败时，偏好查询根本不会开始（没 userId → enabled: false），isSuccess / isError 都是
     * false。调用方按「偏好已经定下来」来等就永远等不到：首页 landing 会一直 loading，`/` 渲染成空白，
     * 连错误都没有（2026-10-20 清测试基线时发现）。所以把「用户读失败」也算作定下来。
     */
    settled: preferences.isSuccess || preferences.isError || user.isError,
  };
}

export function useMessageListEmphasis() {
  return useUserPreferences().data?.messageListEmphasis ?? "thread";
}

/**
 * Close the self-host banner for this person, on every device they sign in from.
 *
 * Patched in onMutate so the bar is gone the moment the button is pressed, and put back if the save
 * fails, because a banner that vanished and then reappeared on the next load would read as ignoring
 * the click. The reply seeds the cache with what the server stored.
 */
export function dismissSelfHostBannerMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  const queryKey = userPreferencesQueryOptions(userId).queryKey;
  return mutationOptions({
    mutationFn: (): Promise<UserPreferences> => {
      if (!userId) throw new Error("登录以保存您的偏好设置。");
      return client("/api/settings/preferences", "preferences", {
        method: "PATCH",
        body: { selfHostBannerDismissed: true },
        fallback: "无法保存您的偏好设置",
      });
    },
    onMutate: () => {
      const previous = queryClient.getQueryData(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, {
          ...previous,
          selfHostBannerDismissed: true,
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (preferences) => queryClient.setQueryData(queryKey, preferences),
  });
}

export function saveUserPreferencesMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  return mutationOptions({
    mutationFn: (
      preferences: Partial<UserPreferences>,
    ): Promise<UserPreferences> => {
      if (!userId) throw new Error("登录以保存您的偏好设置。");
      return client("/api/settings/preferences", "preferences", {
        method: "PATCH",
        body: preferences,
        fallback: "无法保存您的偏好设置",
      });
    },
    onSuccess: (preferences) =>
      queryClient.setQueryData(
        userPreferencesQueryOptions(userId).queryKey,
        preferences,
      ),
  });
}

/**
 * The Bot this person pinned as their main Bot, stored with their other preferences so it follows
 * them to every device. Saved optimistically: the roster re-sorts the moment the menu is clicked and
 * goes back if the save fails.
 */
export function useMainBot() {
  const queryClient = useQueryClient();
  const preferences = useUserPreferences();
  const queryKey = userPreferencesQueryOptions(preferences.userId).queryKey;
  const save = useMutation({
    mutationFn: (mainBotId: string | null): Promise<UserPreferences> => {
      if (!preferences.userId) throw new Error("登录以保存您的偏好设置。");
      return client("/api/settings/preferences", "preferences", {
        method: "PATCH",
        body: { mainBotId },
        fallback: "无法保存主机器人",
      });
    },
    onMutate: (mainBotId) => {
      const previous = queryClient.getQueryData(queryKey);
      if (previous) queryClient.setQueryData(queryKey, { ...previous, mainBotId });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });
  return {
    mainBotId: preferences.data?.mainBotId ?? null,
    settled: preferences.settled,
    setMainBot: (botId: string | null) => save.mutate(botId),
  };
}
