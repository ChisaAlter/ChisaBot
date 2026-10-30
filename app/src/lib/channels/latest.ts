import type { ChannelSummary } from "./queries";

/**
 * The conversation a Bot's row opens: its most recent one-to-one channel, or nothing when none is
 * loaded (the caller then opens the Bot's empty chat). Group channels are not any one Bot's chat,
 * so they never count.
 */
export function latestChannelFor(
  botId: string,
  channels: ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  let best: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== botId) continue;
    if (!best || (channel.lastMessageAt ?? "") > (best.lastMessageAt ?? "")) best = channel;
  }
  return best;
}

/** No message was ever sent in it: the roster has neither a time nor a preview for one. */
export function isEmptyChannel(channel: ChannelSummary): boolean {
  return !channel.lastMessageAt && !channel.lastMessage;
}

/**
 * What `/channel/new?agent=…` may reuse instead of opening a new topic: the Bot's most recent
 * one-to-one channel, and only while nothing has been said in it. A conversation with messages is
 * never reopened from there — that route always starts a new topic; callers that mean "the Bot's
 * ongoing chat" resolve it themselves first (`useOpenBotChat`).
 *
 * "Most recent" counts a channel's creation time when it has no messages, so a just-created empty
 * channel beats an older conversation.
 */
export function reusableEmptyChannelFor(
  botId: string,
  channels: ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  let best: ChannelSummary | undefined;
  let bestAt = "";
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== botId)
      continue;
    const at = channel.lastMessageAt ?? channel.createdAt ?? "";
    if (!best || at > bestAt) {
      best = channel;
      bestAt = at;
    }
  }
  return best && isEmptyChannel(best) ? best : undefined;
}
