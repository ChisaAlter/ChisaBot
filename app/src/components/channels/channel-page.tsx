import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { LazyBotThreadHistoryDialog } from "@/components/agents/bot-thread-history-lazy";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelChat } from "@/components/channels/channel-chat";
import { MessageFind } from "@/components/channels/message-find";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { ErrorCard } from "@/components/ui/skyglass";
import { normalizeMessageSearchParam } from "@/lib/channels/focus-message";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import { useOpenThread } from "@/lib/channels/open-thread";
import {
  type AgentChannel,
  channelFromRoster,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { useBotComputerTab } from "@/lib/chat/use-bot-computer";
import { useComputerAutoWatch } from "@/lib/computers/auto-watch";
import { useMarkBotHidden } from "@/lib/kept-visible";

export const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the right column's 计算机 tab. */
  watch: z.boolean().optional(),
  /** DOG-04：Ctrl+K 正文命中深链到这条消息（滚入并短暂高亮）。 */
  message: z
    .string()
    .optional()
    .transform((v) => normalizeMessageSearchParam(v)),
});

/** 聊天路由的 id（外壳按它认出「地址是一段聊天」）。 */
export const CHANNEL_ROUTE_ID = "/_authed/_app/channel/$channelId";

export type ChannelPageProps = {
  channelId: string;
  settings?: boolean;
  watch?: boolean;
  /** 地址正停在这个聊天上。藏起来时（在设置等页面）不写地址、不标已读、不占左栏「⋯」和快捷键。 */
  visible: boolean;
  /** 每次从藏着变回看得见时加一：地址在离开期间变了（比如 `?watch` 没带回来）不当作「用户关掉了」。 */
  epoch: number;
};

/**
 * 一段聊天的整页（聊天列 + 机器人设置窗格 + 历史对话 + 暂停横幅）。由外壳的 `KeepAliveStage` 挂着，
 * 离开聊天时不卸载（DESIGN.md §98）。
 */
export function ChannelPage({
  channelId,
  settings,
  watch,
  visible,
  epoch,
}: ChannelPageProps) {
  const queryClient = useQueryClient();
  /*
   * 左栏里点过来的对话，左栏的列表里已经有它（DESIGN.md §83）：先用那一行画聊天，详情读到再换上，
   * 不再空白等一次 `/api/channels/:id`。
   */
  const channel = useQuery({
    ...channelQueryOptions(channelId),
    placeholderData: () => channelFromRoster(queryClient, channelId),
  });
  const navigate = useNavigate({ from: "/channel/$channelId" });
  /** 藏着的时候（DESIGN.md §98），地址属于别的页面：这里不改地址。 */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const isSettingsOpen = settings === true;
  /**
   * Channel routing currently supports one coworker. 刷新时对话详情还没读到：先用这台设备记下的「这段对话是哪个
   * 机器人的」（DESIGN.md §88），右栏第一帧就画对。
   */
  const agentId = channel.data?.agentIds[0] ?? threadUi(channelId)?.agent;
  useEffect(() => {
    const id = channel.data?.agentIds[0];
    if (id && threadUi(channelId)?.agent !== id)
      setThreadUi(channelId, { agent: id });
  }, [channelId, channel.data]);

  // 藏着时，全局的组件授权轮询不再为这个机器人跑（DESIGN.md §98.3）。
  useMarkBotHidden(agentId, !visible);

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
    // 藏着时机器人回复了不算「看过」：回来时再标。
    if (unseen && visible) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate, visible]);

  // 计算机在右栏「面板 | 计算机」里（DESIGN.md §23）；设置窗格仍是聊天旁的详情栏，两者互不挤占。
  // 按机器人记住选的是哪个标签（DESIGN.md §88）：地址里没有 `watch` 时用上次的。
  const writeWatch = useCallback(
    (open: boolean, replace: boolean) => {
      if (!visibleRef.current) return;
      void navigate({
        search: (previous) => ({ ...previous, watch: open ? true : undefined }),
        replace,
      });
    },
    [navigate],
  );
  const [isWatching, setWatching] = useBotComputerTab(
    agentId,
    watch,
    writeWatch,
    epoch,
  );
  // 机器人开始用计算机时自动切到「计算机」，停手后自动切回「面板」（用户没动手的话）。
  useComputerAutoWatch(agentId, isWatching, setWatching);
  // 「历史对话」（DESIGN.md §42.6 / §68）：这个机器人的所有对话（频道的、旧 `/bot` 的），点一条在这里打开。
  const [historyOpen, setHistoryOpen] = useState(false);
  // 离开聊天时收起「历史对话」弹窗：它画在 body 上，不跟着聊天藏起来。
  if (!visible && historyOpen) setHistoryOpen(false);
  const openThread = useOpenThread();

  return (
    <div
      className="contents"
      data-channel-id={channelId}
      {...(visible ? { "data-channel-visible": "" } : {})}
    >
      <MessageFind channelId={channelId} visible={visible} />
      <DetailPanel
        onClose={() => {
          if (visibleRef.current)
            void navigate({
              search: (previous) => ({ ...previous, settings: undefined }),
            });
        }}
        // 设置窗格在窄窗口里是画在 body 上的抽屉：藏着时关掉，别盖在别的页面上。
        open={visible && isSettingsOpen && agentId !== undefined}
        detail={
          agentId === undefined ? null : <AgentProfile agentId={agentId} />
        }
      >
        {/* DESIGN v4.1：聊天列没有头部；机器人「⋯」与计算机提示在左栏它那一行。藏着时不登记（§98）。 */}
        {visible ? (
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
            onHistory={() => setHistoryOpen(true)}
          />
        ) : null}
        {agentId ? (
          <LazyBotThreadHistoryDialog
            agentId={agentId}
            currentThreadId={channel.data?.threadId}
            onOpenChange={setHistoryOpen}
            onPick={(threadId) => void openThread(agentId, threadId)}
            open={historyOpen}
          />
        ) : null}
        {agentId && channel.data?.agentIds.length === 1 ? (
          <BotPausedBanner agentId={agentId} />
        ) : null}
        <ChannelBody
          channel={channel.data}
          isPending={channel.isPending}
          hasError={Boolean(channel.error)}
        />
      </DetailPanel>
    </div>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. Old multi-Bot group conversations
 * have no page since slimming P4b; they say so instead of redirecting to the removed `/group`.
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
      // 旧链接 / 删掉的对话：一张错误卡和出路（DESIGN.md §71.3），不是左上角一行红字。
      <div className="mx-auto w-full max-w-[520px] p-6 pt-16">
        <ErrorCard
          action={
            <Button
              className="mt-2"
              nativeButton={false}
              render={<Link to="/" />}
              size="sm"
              variant="outline"
            >
              {"回到聊天"}
            </Button>
          }
          description={"可能已经删掉了，或者这个链接不是你账号里的对话。"}
          title={"找不到这段对话"}
        />
      </div>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status">
        {"这是旧的多机器人群聊，已不再支持。数据仍保留。"}
      </p>
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
