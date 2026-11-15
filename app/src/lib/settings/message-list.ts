import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import type { UserPreferences } from "../../../../shared/user-preferences";
import { setPrimaryAgentMutationOptions } from "./mutations";
import { primaryAgentQueryOptions, settingsKeys } from "./queries";

export type { MessageListEmphasis } from "../../../../shared/user-preferences";

export function userPreferencesQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: settingsKeys.preferences(userId),
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
 * them to every device. Saved optimistically across both `settingsKeys` and `primaryAgentKeys`:
 * the roster re-sorts immediately and rolls back on failure without extra refetch rerenders.
 */
export function useMainBot() {
  const queryClient = useQueryClient();
  const preferences = useUserPreferences();
  // 被动观察独立主 Agent 缓存：仅读取 .data，绝不主动挂载发起额外请求或触发无关重绘。
  const cachedPrimary = useQuery({
    ...primaryAgentQueryOptions(preferences.userId),
    enabled: false,
  });
  const save = useMutation(
    setPrimaryAgentMutationOptions(queryClient, preferences.userId),
  );
  const { mutate, mutateAsync } = save;
  const setMainBot = useCallback(
    (botId: string | null) => {
      mutate(botId);
    },
    [mutate],
  );
  const setMainBotAsync = useCallback(
    (botId: string | null) => mutateAsync(botId),
    [mutateAsync],
  );
  const hasPrimaryData = cachedPrimary.data !== undefined;
  return {
    mainBotId: hasPrimaryData
      ? cachedPrimary.data.configuredAgentId
      : (preferences.data?.mainBotId ?? null),
    settled: hasPrimaryData || preferences.settled,
    setMainBot,
    setMainBotAsync,
    isPaused: cachedPrimary.data?.isPaused ?? false,
    primaryAgent: cachedPrimary.data?.primaryAgent ?? null,
    resolution: cachedPrimary.data?.resolution,
  };
}

/** 主动订阅服务端主 Agent 解析状态与生命周期信息（用于详情状态或独立管理面板）。 */
export function usePrimaryAgent() {
  const queryClient = useQueryClient();
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const primary = useQuery(primaryAgentQueryOptions(userId));
  const save = useMutation(setPrimaryAgentMutationOptions(queryClient, userId));
  const { mutate, mutateAsync } = save;
  const setMainBot = useCallback(
    (botId: string | null) => {
      mutate(botId);
    },
    [mutate],
  );
  const setMainBotAsync = useCallback(
    (botId: string | null) => mutateAsync(botId),
    [mutateAsync],
  );
  return {
    userId,
    data: primary.data,
    configuredAgentId: primary.data?.configuredAgentId ?? null,
    primaryAgent: primary.data?.primaryAgent ?? null,
    isPaused: primary.data?.isPaused ?? false,
    resolution: primary.data?.resolution,
    settled: primary.isSuccess || primary.isError || user.isError,
    isPending: primary.isPending,
    error: primary.error,
    setMainBot,
    setMainBotAsync,
  };
}
