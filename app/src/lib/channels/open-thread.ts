import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { botChatChannelId } from "./open-bot-chat";
import { type AgentChannel, channelKeys } from "./queries";

/**
 * 在频道聊天里打开一条已有对话（CB-046，DESIGN.md §68）：「历史对话」里点的、旧 `/bot?agent=&thread=` 链接。
 * 服务器找这条对话的频道，没有就给它建一个（同一条对话，不复制消息）；别人的 / 不存在的 → 抛错。
 */
export async function openThreadChannel(agentId: string, threadId: string, queryClient?: QueryClient): Promise<AgentChannel> {
  const response = await fetch("/api/channels/open-thread", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, threadId }),
  });
  const body = (await response.json().catch(() => null)) as { channel?: AgentChannel; error?: string } | null;
  if (!response.ok || !body?.channel) throw new Error(response.status === 404 ? "这段对话不在了。" : body?.error || "打不开这段对话，请重试。");
  if (queryClient) {
    queryClient.setQueryData(channelKeys.detail(body.channel.id), body.channel);
    void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
  }
  return body.channel;
}

/**
 * 「查看 / 打开对话」：直接到那段对话的频道聊天；打不开（对话不在了）就到这个机器人的聊天。
 * 定时任务通知、定时任务列表、历史对话共用。
 */
export function useOpenThread() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useCallback(
    async (agentId: string, threadId: string | null | undefined) => {
      if (threadId) {
        try {
          const channel = await openThreadChannel(agentId, threadId, queryClient);
          await navigate({ to: "/channel/$channelId", params: { channelId: channel.id } });
          return;
        } catch {
          // 落到下面：这个机器人的聊天。
        }
      }
      // 这个机器人正在用的那段对话；/channel/new 本身总是开新话题。
      const channelId = await botChatChannelId(queryClient, agentId);
      if (channelId) await navigate({ to: "/channel/$channelId", params: { channelId } });
      else await navigate({ to: "/channel/new", search: { agent: agentId } });
    },
    [navigate, queryClient],
  );
}
