import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelChat } from "@/components/channels/channel-chat";
import { DetailPanel } from "@/components/layout/detail-panel";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { useComputerAutoWatch } from "@/lib/computers/auto-watch";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the right column's 计算机 tab. */
  watch: z.boolean().optional(),
});

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];

  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  /*
   * This channel's roster summary, read out of the same infinite query the sidebar renders.
   * The detail query deliberately knows nothing about activity; the roster is where the socket
   * keeps lastMessageAt live, so it is the one honest source for "has something new been said".
   */
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);

  /*
   * Opening the channel marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the
   * unseen check keeps it from writing a row per render. No dependency on the mutation object —
   * its identity changes per render and the effect must not re-fire for that.
   *
   * Keyed on primitives, deliberately. The optimistic mark-read patch changes the summary OBJECT's
   * identity without changing these values, so an object dep would re-fire the effect on its own
   * write — and when lastMessageAt sits ahead of this browser's clock (another device wrote it),
   * that re-fire loops into a PUT per render. Primitives hold still under the patch: one PUT.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate]);

  // 计算机在右栏「面板 | 计算机」里（DESIGN.md §23）；设置窗格仍是聊天旁的详情栏，两者互不挤占。
  const setWatching = useCallback(
    (open: boolean) =>
      void navigate({
        search: (previous) => ({ ...previous, watch: open ? true : undefined }),
      }),
    [navigate],
  );
  // 机器人开始用计算机时自动切到「计算机」，停手后自动切回「面板」（用户没动手的话）。
  useComputerAutoWatch(agentId, isWatching, setWatching);

  return (
    <DetailPanel
      onClose={() =>
        void navigate({
          search: (previous) => ({ ...previous, settings: undefined }),
        })
      }
      open={isSettingsOpen && agentId !== undefined}
      detail={
        agentId === undefined ? null : (
          <AgentProfile
            agentId={agentId}
            key={agentId}
            onOpenComputer={() => setWatching(true)}
          />
        )
      }
    >
      {/* DESIGN v4.1：聊天列没有头部；机器人「⋯」与计算机提示在左栏它那一行。 */}
      <RegisterBotChat
        agentId={agentId}
        computerOpen={isWatching}
        onComputerChange={setWatching}
        onNewTopic={() =>
          agentId
            ? void navigate({
                to: "/channel/new",
                search: { agent: agentId, topic: "new" },
              })
            : undefined
        }
        onSettingsChange={(open) =>
          void navigate({
            search: (previous) => ({
              ...previous,
              settings: open ? true : undefined,
            }),
          })
        }
        settingsOpen={isSettingsOpen}
      />
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. One with several is a group, which
 * redirects to its shared transcript at `/group/$channelId`.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {"无法加载此会话。"}
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId) {
    return (
      <Navigate
        params={{ channelId: channel.id }}
        replace
        to="/group/$channelId"
      />
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}
