import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useRef, useState } from "react";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { LazyBotThreadHistoryDialog } from "@/components/agents/bot-thread-history-lazy";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelChat } from "@/components/channels/channel-chat";
import { MessageFind } from "@/components/channels/message-find";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { lazyPart } from "@/components/ui/lazy-part";
import { ErrorCard } from "@/components/ui/skyglass";
import { useExternalConnection } from "@/hooks";
import {
  holdDraftChannel,
  releasedDraftRedirect,
} from "@/lib/channels/draft-channel";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import { useOpenThread } from "@/lib/channels/open-thread";
import {
  type AgentChannel,
  type ChannelPage as ChannelListPage,
  channelFromRoster,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { useBotComputerTab } from "@/lib/chat/use-bot-computer";
import { useComputerAutoWatch } from "@/lib/computers/auto-watch";
import { createSideThreadMutationOptions } from "@/lib/conversations/side-threads";
import { useMarkBotHidden } from "@/lib/kept-visible";
import { restampOverlayMarker } from "@/lib/overlay-back";

/*
 * 机器人资料窗格（?settings=true）、多机器人群聊、分支侧栏（?side=true）不进入单聊首屏闭包，
 * 按需加载，剥离 agent-profile / devices / pair-phone / group-chat-view / side-chat-drawer 等非单聊首屏代码。
 */
const LazyAgentProfile = lazyPart(() =>
  import("@/components/agents/agent-profile").then((m) => m.AgentProfile),
);
const LazyGroupChatView = lazyPart(() =>
  import("@/components/channels/group-chat-view").then((m) => m.GroupChatView),
);
const LazySideChatDrawer = lazyPart(() =>
  import("@/components/channels/side-chat-drawer").then(
    (m) => m.SideChatDrawer,
  ),
);

export type ChannelPageProps = {
  channelId: string;
  settings?: boolean;
  watch?: boolean;
  side?: boolean;
  /** 地址正停在这个聊天上。藏起来时（在设置等页面）不写地址、不标已读、不占左栏「⋯」和快捷键。 */
  visible: boolean;
  /** 每次从藏着变回看得见时加一：地址在离开期间变了（比如 `?watch` 没带回来）不当作「用户关掉了」。 */
  epoch: number;
};

/**
 * 一段聊天的整页（聊天列 + 机器人设置窗格 + 历史对话 + 暂停横幅）。由外壳的 `KeepAliveStage` 挂着，
 * 离开聊天时不卸载（DESIGN.md §98）。
 *
 * `memo`：外壳（`AuthedShell` → `ChatStage`）跟着地址的 pathname 重画，每换一页（打开 / 关闭设置、切分类）
 * 都会带着这一整页和下面的聊天列表、输入框重画一遍，而这里的 props 全是原始值、根本没变。关设置时 4× 降速下
 * 这一遍约 10ms 的渲染 + 提交。只有 `visible` / `epoch` / 地址参数真的变了才重画。
 */
export const ChannelPage = memo(function ChannelPage({
  channelId,
  settings,
  watch,
  side,
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
  const isSideOpen = side === true;
  // 首次打开侧栏后保持挂载以平滑完成收起动画；未打开过前不触发 chunk 下载。
  const [sideEverOpened, setSideEverOpened] = useState(isSideOpen);
  if (isSideOpen && !sideEverOpened) setSideEverOpened(true);
  const isGroupChannel = (channel.data?.agentIds.length ?? 0) > 1;
  /**
   * 单机器人对话按左栏记住的 Bot 预填首帧（DESIGN.md §88）；多机器人群聊不绑定单个 Bot 的右侧设置或计算机面板。
   */
  const channelAgentId =
    channel.data && channel.data.agentIds.length === 1
      ? channel.data.agentIds[0]
      : undefined;
  const agentId = isGroupChannel
    ? undefined
    : (channelAgentId ?? threadUi(channelId)?.agent);
  useExternalConnection(
    channelAgentId ? `${channelId}\0${channelAgentId}` : false,
    () => {
      if (channelAgentId && threadUi(channelId)?.agent !== channelAgentId)
        setThreadUi(channelId, { agent: channelAgentId });
    },
  );

  // 新话题页上加附件时建的草稿对话（A1）：没发就离开（这一页卸载）时删掉，见 `draft-channel.ts`。
  useExternalConnection(channelId || "__channel__", () =>
    holdDraftChannel(channelId),
  );

  /*
   * 本标签页回收过的草稿对话（二轮复审）：再打开它（后退、旧地址）拿到 404 时，不显示「找不到这段对话」，
   * 用 replace 静默换成这个机器人的新话题页。别的 404 照旧显示错误卡。
   */
  const releasedAgent = channel.error
    ? releasedDraftRedirect(channelId, channel.error)
    : null;
  useExternalConnection(
    visible && releasedAgent ? `${releasedAgent}\0` : false,
    () => {
      if (!visible || !releasedAgent) return;
      void navigate({
        to: "/channel/new",
        search: { agent: releasedAgent, topic: "new" },
        replace: true,
      });
    },
  );

  // 藏着时，全局的组件授权轮询不再为这个机器人跑（DESIGN.md §98.3）。
  useMarkBotHidden(agentId, !visible);

  // 计算机在右栏「面板 | 计算机」里（DESIGN.md §23）；设置窗格仍是聊天旁的详情栏，两者互不挤占。
  // 按机器人记住选的是哪个标签（DESIGN.md §88）：地址里没有 `watch` 时用上次的。
  const writeWatch = useCallback(
    (open: boolean, replace: boolean) => {
      if (!visibleRef.current) return;
      void navigate({
        search: (previous) => ({ ...previous, watch: open ? true : undefined }),
        replace,
      }).then(() => {
        if (replace) restampOverlayMarker();
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
  const [mainBusy, setMainBusy] = useState(false);
  const [sideThreadFocusId, setSideThreadFocusId] = useState<string | null>(
    null,
  );
  const createSideThread = useMutation(
    createSideThreadMutationOptions(queryClient),
  );
  const sideHelperRef = useRef({
    parentThreadId: channel.data?.threadId,
    mutateAsync: createSideThread.mutateAsync,
  });
  sideHelperRef.current = {
    parentThreadId: channel.data?.threadId,
    mutateAsync: createSideThread.mutateAsync,
  };
  const setSideOpen = useCallback(
    (open: boolean) => {
      if (!visibleRef.current) return;
      void navigate({
        search: (previous) => ({ ...previous, side: open ? true : undefined }),
      });
    },
    [navigate],
  );
  const handleOpenSideChat = useCallback(
    (initialQuestion?: string) => {
      setSideOpen(true);
      const { parentThreadId, mutateAsync } = sideHelperRef.current;
      if (!initialQuestion || !parentThreadId) return;
      void mutateAsync({
        parentThreadId,
        question: initialQuestion,
      })
        .then((created) => {
          setSideThreadFocusId(created.id);
        })
        .catch(() => {});
    },
    [setSideOpen],
  );

  const handleCloseDetail = useCallback(() => {
    if (visibleRef.current)
      void navigate({
        search: (previous) => ({ ...previous, settings: undefined }),
      });
  }, [navigate]);

  return (
    <div
      className="contents"
      data-channel-id={channelId}
      {...(visible ? { "data-channel-visible": "" } : {})}
    >
      {visible ? (
        <ChannelMarkRead channelId={channelId} visible={visible} />
      ) : null}
      <MessageFind channelId={channelId} visible={visible} />
      <DetailPanel
        onClose={handleCloseDetail}
        // 设置窗格在窄窗口里是画在 body 上的抽屉：藏着时关掉，别盖在别的页面上。
        open={
          visible && isSettingsOpen && !isGroupChannel && agentId !== undefined
        }
        detail={
          !isGroupChannel && agentId !== undefined ? (
            <LazyAgentProfile agentId={agentId} />
          ) : null
        }
      >
        {/* DESIGN v4.1：聊天列没有头部；机器人「⋯」与计算机提示在左栏它那一行。藏着时不登记（§98）。 */}
        {visible && !isGroupChannel ? (
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
        {!isGroupChannel && agentId ? (
          <LazyBotThreadHistoryDialog
            agentId={agentId}
            currentThreadId={channel.data?.threadId}
            onOpenChange={setHistoryOpen}
            onPick={(threadId) => void openThread(agentId, threadId)}
            open={historyOpen}
          />
        ) : null}
        {!isGroupChannel && agentId && channel.data?.agentIds.length === 1 ? (
          <BotPausedBanner agentId={agentId} />
        ) : null}
        <ChannelBody
          channel={channel.data}
          hasError={Boolean(channel.error)}
          isPending={channel.isPending || releasedAgent !== null}
          onBusyChange={setMainBusy}
          onOpenSideChat={handleOpenSideChat}
        />
      </DetailPanel>
      {sideEverOpened && !isGroupChannel && channel.data?.threadId ? (
        <LazySideChatDrawer
          initialSideThreadId={sideThreadFocusId}
          isMainRunning={mainBusy}
          onOpenChange={setSideOpen}
          open={visible && isSideOpen}
          parentThreadId={channel.data.threadId}
        />
      ) : null}
    </div>
  );
});

/**
 * 仅在当前频道可见时订阅 `channelListQueryOptions()`，并通过 `select` 投影为当前 `channelId` 的标量
 * `unseen: boolean`：避免发消息乐观更新或无关频道的 WebSocket 补丁唤醒整页 `ChannelPage` 及所有 KeepAlive 保活频道。
 */
const ChannelMarkRead = memo(function ChannelMarkRead({
  channelId,
  visible,
}: {
  channelId: string;
  visible: boolean;
}) {
  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  const selectUnseen = useCallback(
    (data: InfiniteData<ChannelListPage>): boolean => {
      for (const page of data.pages) {
        for (const row of page.channels) {
          if (row.id === channelId) return hasUnseenActivity(row);
        }
      }
      return false;
    },
    [channelId],
  );
  const { data: unseen = false } = useInfiniteQuery({
    ...channelListQueryOptions(),
    select: selectUnseen,
  });
  const markReadMutate = markRead.mutate;
  useExternalConnection(
    unseen && visible ? channelId || "__channel__" : false,
    () => {
      // 藏着时机器人回复了不算「看过」：回来时再标。
      if (unseen && visible) {
        markReadMutate(channelId);
      }
    },
  );
  return null;
});

/**
 * 渲染当前频道的主体内容：单机器人频道进入完整会话视图，多机器人频道进入原生群聊协作视图。
 */
// `memo`：`visible` 变了（从设置回来）`ChannelPage` 要重画，但聊天本身（props 是同一个对话对象和两个布尔）
// 不用跟着重画——要知道「看不看得见」的地方读 `KeptVisibleContext` / `useKeptVisibility`。
const ChannelBody = memo(function ChannelBody({
  channel,
  isPending,
  hasError,
  onOpenSideChat,
  onBusyChange,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
  onOpenSideChat?: (initialQuestion?: string) => void;
  onBusyChange?: (busy: boolean) => void;
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

  if (channel.agentIds.length > 1) {
    return <LazyGroupChatView channel={channel} key={channel.id} />;
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status">
        {"当前频道尚未分配可用的机器人成员。"}
      </p>
    );
  }

  // Remount on channel changes so 会话客户端 agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      onBusyChange={onBusyChange}
      onOpenSideChat={onOpenSideChat}
      runtimeAgentId={runtimeAgentId}
    />
  );
});
