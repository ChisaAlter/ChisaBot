import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingRedirect } from "@/components/agents/landing-redirect";
import { useOpenBotChat } from "@/lib/channels/open-bot-chat";
import { openThreadChannel } from "@/lib/channels/open-thread";

/**
 * 旧地址 `/bot?agent=X(&thread=Y)(&watch=true)`（CB-046，DESIGN.md §68）：机器人聊天只剩左栏那一套（`/channel/*`），
 * 这里只做跳转，旧链接、定时任务通知的「查看」、书签、PC / 安卓里存的地址都照样能用。
 *
 * - 带 `thread`：在频道聊天里打开那一条对话（服务器给没有频道的旧对话建一个频道，同一条对话、不复制消息）；
 * - 只带 `agent`：这个机器人正在用的那段对话（它最近的频道，没有就是空聊天；`useOpenBotChat`）；
 * - 什么都没带：首页的机器人。
 */
export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; thread?: string; watch?: boolean } => ({
    ...(typeof search.agent === "string" && search.agent ? { agent: search.agent } : {}),
    ...(typeof search.thread === "string" && search.thread ? { thread: search.thread } : {}),
    ...(search.watch === true ? { watch: true } : {}),
  }),
});

function RouteComponent() {
  const { agent, thread, watch } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openBotChat = useOpenBotChat();

  useEffect(() => {
    if (!agent) return;
    let alive = true;
    const toBot = () => {
      if (alive) void openBotChat(agent, { watch, replace: true });
    };
    if (!thread) {
      toBot();
      return;
    }
    openThreadChannel(agent, thread, queryClient)
      .then((channel) => {
        if (!alive) return;
        void navigate({
          to: "/channel/$channelId",
          params: { channelId: channel.id },
          search: watch ? { watch: true } : {},
          replace: true,
        });
      })
      .catch(() => {
        // 这条对话不在了（或不是这个人的）：退回这个机器人的聊天，而不是停在空白页。
        if (!alive) return;
        toBot();
      });
    return () => {
      alive = false;
    };
  }, [agent, thread, watch, navigate, queryClient, openBotChat]);

  if (!agent) return <LandingRedirect />;
  return null;
}
