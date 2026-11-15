import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { readStoredPanelBot } from "@/lib/panels/active-bot";
import { useMainBot } from "@/lib/settings/message-list";

/** Where "open the app" lands: one Bot's conversation. There is no home page and no "new chat". */
export type LandingTarget =
  | { to: "/channel/$channelId"; params: { channelId: string } }
  | { to: "/channel/new"; search: { agent: string } };

export type Landing =
  | { state: "loading" }
  /** The roster loaded and holds no visible Bot (proposed server-side seeding would make this rare). */
  | { state: "empty" }
  /** The roster never loaded. */
  | { state: "error" }
  | { state: "ready"; botId: string; target: LandingTarget };

/**
 * The Bot the app opens on: the main Bot (主机器人) when configured and visible, else the one last
 * used, else the first on the roster. Its most recent one-to-one conversation when one is loaded,
 * else its empty chat.
 */
export function pickLandingBot(
  roster: Array<{ id: string }>,
  lastUsed: string | null | undefined,
  mainBotId: string | null | undefined,
): string | undefined {
  const has = (id: string | null | undefined): id is string =>
    Boolean(id) && roster.some((bot) => bot.id === id);
  if (has(mainBotId)) return mainBotId;
  if (has(lastUsed)) return lastUsed;
  return roster[0]?.id;
}

export function useLanding(): Landing {
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const { mainBotId, settled } = useMainBot();
  // Waiting on the roster and preferences; a failed channel list only costs the "latest
  // conversation" hop, so it does not hold the landing back.
  if (agents.isPending || !settled || channels.isPending)
    return { state: "loading" };
  const roster = (agents.data ?? []).filter((bot) => !bot.hidden);
  const botId = pickLandingBot(roster, readStoredPanelBot(), mainBotId);
  if (!botId)
    return agents.isError && agents.data === undefined
      ? { state: "error" }
      : { state: "empty" };
  return { state: "ready", botId, target: chatTargetFor(botId, channels.data) };
}

/** A Bot's conversation: its latest one-to-one channel, or its empty chat when it has none yet. */
export function chatTargetFor(
  botId: string,
  channels: ChannelSummary[] | undefined,
): LandingTarget {
  const latest = latestChannelFor(botId, channels);
  return latest
    ? { to: "/channel/$channelId", params: { channelId: latest.id } }
    : { to: "/channel/new", search: { agent: botId } };
}
