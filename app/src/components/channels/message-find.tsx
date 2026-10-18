/**
 * DOG-04：地址带 ?message=<id> 时，等气泡挂上后滚到该消息并闪一下（对齐 SettingsFind）。
 */
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  focusMessageInChat,
  MESSAGE_FIND_WAIT_MS,
  normalizeMessageSearchParam,
} from "@/lib/channels/focus-message";

/** 与 channel-page / $channelId 路由 id 一致（此处不 import channel-page，避免环依赖）。 */
const CHANNEL_ROUTE_ID = "/_authed/_app/channel/$channelId";

/**
 * 挂在 ChannelPage 里：只在「这段对话正露着」且 URL 的 channelId 对得上时找消息。
 * message 不进 KeepAlive 地址键，换 ?message= 不会整页重挂。
 */
export function MessageFind({
  channelId,
  visible,
}: {
  channelId: string;
  visible: boolean;
}) {
  const messageId = useRouterState({
    select: (state) => {
      const match = state.matches.find((m) => m.routeId === CHANNEL_ROUTE_ID);
      if (!match) return "";
      if ((match.params as { channelId?: string }).channelId !== channelId)
        return "";
      const search = match.search as { message?: unknown };
      return normalizeMessageSearchParam(search.message) ?? "";
    },
  });

  useEffect(() => {
    if (!visible || !messageId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = Date.now();
    let found = false;
    const attempt = () => {
      if (cancelled || found) return;
      // 只在露着的聊天里找：keep-alive 藏着的对话仍有 DOM（§98）。
      const root =
        document.querySelector<HTMLElement>(
          `[data-channel-id="${CSS.escape(channelId)}"][data-channel-visible]`,
        ) ?? document;
      if (focusMessageInChat(messageId, { root })) {
        found = true;
        return;
      }
      // CR-P2-04：首段 4s 内快轮询；超时后只要还露着就慢轮询（快照晚到 / 慢连），
      // 换 ?message= 或再次点同一命中（visible 抖动）会重跑本 effect。
      const elapsed = Date.now() - started;
      const delay = elapsed < MESSAGE_FIND_WAIT_MS ? 150 : 1000;
      timer = setTimeout(attempt, delay);
    };
    timer = setTimeout(attempt, 60);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, messageId, channelId]);

  return null;
}
