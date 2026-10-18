import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { type AgentChannel, type ChannelPage, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/channels", {
        method: "POST",
        body: { agentIds },
        fallback: "无法启动会话",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Report the last thing said in a channel.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * Fire-and-forget on purpose: a failed preview update is a stale roster line, not a lost message.
 */
export function recordChannelActivityMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      text: string;
      agentId: string | null;
      at: string;
    }) => {
      /* Fire-and-forget for UX, but count failures so a silent 500 is not invisible (CR-P2-06). */
      const response = await tryClient(`/api/channels/${variables.channelId}/activity`, {
        method: "POST",
        body: {
          agentId: variables.agentId,
          at: variables.at,
          text: variables.text,
        },
      });
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            type: "channel-activity-write-failed",
            channelId: variables.channelId,
            status: response.status,
          }),
        );
      }
    },
  });
}

/**
 * Tell the roster this channel is (or is no longer) running a turn.
 *
 * Fire-and-forget, like recorded activity: a working indicator that fails to appear or to clear is
 * worth nothing next to the run itself, and a person is never shown an error for it. The server
 * broadcasts it to the channel's members, so the row shows a working dot even on a tab that has
 * navigated elsewhere.
 *
 * A plain function, not a mutation handle: the turn it reports on outlives the screen that started
 * it, and `mutate` on an unmounted component is a no-op.
 */
export async function setChannelBusy(variables: {
  channelId: string;
  busy: boolean;
}) {
  const response = await tryClient(`/api/channels/${variables.channelId}/busy`, {
    method: "POST",
    body: { busy: variables.busy },
  });
  if (!response.ok) {
    console.warn(
      JSON.stringify({
        type: "channel-busy-write-failed",
        channelId: variables.channelId,
        busy: variables.busy,
        status: response.status,
      }),
    );
  }
}

/** Pin or unpin a channel for this member. A marker, not a reorder, so no optimistic sort. */
export function setChannelPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; pinned: boolean }) => {
      await client(`/api/channels/${variables.channelId}/pin`, {
        method: "PUT",
        body: { pinned: variables.pinned },
        fallback: "无法固定此会话",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Stamp a channel read for this member, patching the cache before the wire answers.
 *
 * Patched in onMutate rather than refetched on success: the dot must clear the instant the channel
 * opens, not a round-trip later. On failure we roll the list cache back (CR-P2-06) so a failed PUT
 * does not leave the unread dot cleared locally until something else refetches.
 */
export function markChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}/read`, {
        method: "PUT",
        fallback: "无法标记此会话为已读",
      });
    },
    onMutate: async (channelId) => {
      await queryClient.cancelQueries({ queryKey: channelKeys.list() });
      const previous = queryClient.getQueryData<InfiniteData<ChannelPage>>(
        channelKeys.list(),
      );
      const now = new Date().toISOString();
      queryClient.setQueryData(
        channelKeys.list(),
        (data: InfiniteData<ChannelPage> | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              channels: page.channels.map((row) =>
                row.id === channelId
                  ? {
                      ...row,
                      /*
                       * The later of now and the row's own lastMessageAt: lastMessageAt comes from
                       * another clock, and a marker stamped "now" by a clock running behind it
                       * would leave the row still reading as unseen — and the dot still lit.
                       */
                      lastReadAt:
                        row.lastMessageAt && row.lastMessageAt > now
                          ? row.lastMessageAt
                          : now,
                    }
                  : row,
              ),
            })),
          },
      );
      return { previous };
    },
    onError: (_error, _channelId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(channelKeys.list(), context.previous);
      }
    },
  });
}

/** Soft-delete a channel for everyone in it. The server keeps the transcript; the roster forgets. */
export function deleteChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}`, {
        method: "DELETE",
        fallback: "无法删除此会话",
      });
    },
    // The roster only. The open channel's detail query would refetch into the fresh 404 and
    // flash an error before the navigate-home lands; left alone, it keeps its cache and the
    // navigation happens with nothing to complain about.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  });
}
