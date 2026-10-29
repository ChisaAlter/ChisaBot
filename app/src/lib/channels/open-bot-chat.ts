import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { latestChannelFor } from "./latest";
import { type ChannelSummary, channelListQueryOptions } from "./queries";

/**
 * 「和这个机器人聊天」（资料页「开始聊天」、「去聊天」、交接卡片「去「X」的对话 →」、旧 /bot 地址……）：
 * 进它最近的一对一对话；还没有对话才去 /channel/new。
 *
 * /channel/new 自己不再替人跳到已有对话（它总是开新话题，只复用一个还没说过话的空会话），所以想要「接着聊」的
 * 入口在这里先找到最近的对话。会话列表没加载过就先拉第一页；拉失败就退到 /channel/new，不卡住。
 */
export async function botChatChannelId(
  queryClient: QueryClient,
  agentId: string,
): Promise<string | undefined> {
  const options = channelListQueryOptions();
  try {
    const data = await queryClient.ensureInfiniteQueryData(options);
    const channels: ChannelSummary[] = data.pages.flatMap((page) => page.channels);
    return latestChannelFor(agentId, channels)?.id;
  } catch {
    return undefined;
  }
}

export function useOpenBotChat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useCallback(
    async (agentId: string, options: { watch?: boolean; replace?: boolean } = {}) => {
      const channelId = await botChatChannelId(queryClient, agentId);
      const watch = options.watch ? { watch: true as const } : {};
      if (channelId)
        await navigate({
          to: "/channel/$channelId",
          params: { channelId },
          search: watch,
          replace: options.replace,
        });
      else
        await navigate({
          to: "/channel/new",
          search: { agent: agentId, ...watch },
          replace: options.replace,
        });
    },
    [navigate, queryClient],
  );
}
