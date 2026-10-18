import {
  IconDeviceDesktop,
  IconDots,
  IconLayoutDashboard,
  IconPlayerPause,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarFilled,
  IconStarOff,
  IconTrash,
  IconUserCircle,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PresenceItem, PresenceList } from "@/components/ui/presence";
import { openTriggerByLabel, snapAnchor } from "@/components/ui/snap-anchor";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountCard, AccountMenu } from "@/components/layout/account-menu";
import { SidebarSearchField } from "@/components/layout/sidebar-search-field";
import {
  type Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  useOptionalSidebar,
} from "@/components/ui/sidebar";
import { RailSidebar, RailSidebarEdge } from "@/components/layout/rail-sidebar";
import { requestSidebarSearchFocus, useSidebarSearch } from "@/lib/sidebar-search";
import { cn } from "@/lib/utils";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import {
  highlightParts,
  useChannelMessageSearch,
  type ChannelSearchHit,
} from "@/lib/channels/search";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { latestChannelFor } from "@/lib/channels/latest";
import { prefetchBotChat, usePrefetchBotChats } from "@/lib/channels/prefetch";
import { openCreateBot } from "@/lib/agents/create-bot";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTime, useRelativeNow } from "@/lib/relative-time";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ChannelAvatar } from "@/components/channels/avatar";
import { showPanels } from "@/lib/panels/rail-open";
import { BotChatMenuItems, BotRowComputerChip } from "@/components/agents/bot-chat-actions";
import { useBotChat, useCurrentBotChat } from "@/lib/agents/bot-chat-context";
import {
  type MessageListEmphasis,
  useMainBot,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { usePanelBot } from "@/lib/panels/active-bot";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  attentionSummary,
  needsInput,
  useAttentionNotifications,
} from "../bot-profile/attention";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { lazyDialog } from "@/components/ui/lazy-dialog";
import { LazyBotThreadHistoryDialog } from "@/components/agents/bot-thread-history-lazy";

// 每个机器人行都带这两个弹窗：用到才加载、打开过才挂载（DESIGN.md §41.3）。「电脑操作」以前把整个设备页拖进了左栏的包。
const DeleteBotDialog = lazyDialog(() => import("@/components/agents/delete-bot-dialog").then((m) => m.DeleteBotDialog));
const BotComputerAccessDialog = lazyDialog(() =>
  import("@/components/devices/bot-computer-access").then((m) => m.BotComputerAccessDialog),
);
function preloadBotDialogs() {
  DeleteBotDialog.preload();
  LazyBotThreadHistoryDialog.preload();
  BotComputerAccessDialog.preload();
}
import { Channel } from "./channel";
import { LeftModeSwitch } from "@/components/cloud-cc/left-mode-switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChannelPagination } from "./channel-pagination";

/*
 * 左栏只放机器人（用户 2026-10-10 的要求；DESIGN.md §57 导航收敛）：以前底部的「机器人 / 代理 / 团队 Bot / 记忆」
 * 四个上游入口和列表头的「管理」都去掉了。记忆在 设置 → 记忆，机器人资料在每行的「⋯」里。
 */

/**
 * 左栏本地过滤：会话名、摘要、最后一条（立刻出结果）。
 * 消息正文由 `useChannelMessageSearch` 打服务器（FIX-03），两边合并展示。
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  const now = useRelativeNow();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt, now)
            : undefined
        }
        pinned={channel.pinned}
        unread={unread}
        busy={channel.busy ?? false}
      />
    </motion.div>
  );
}


/** FIX-03：正文命中行 — 第二行是带高亮的摘要。 */
function SearchHitRow({ hit, agentIds = [] }: { hit: ChannelSearchHit; agentIds?: string[] }) {
  const parts = highlightParts(hit.snippet, hit.highlight);
  const title = hit.summary?.trim() || hit.name;
  return (
    <Link
      className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg"
      params={{ channelId: hit.channelId }}
      to="/channel/$channelId"
    >
      <span className="shrink-0">
        <ChannelAvatar participantIds={agentIds} size={32} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9rem] leading-5 font-medium tracking-[-1%]">{title}</span>
        <span className="mt-px block truncate text-[12px] leading-4 text-muted-foreground">
          {parts.before}
          {parts.match ? <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">{parts.match}</mark> : null}
          {parts.after}
        </span>
      </span>
    </Link>
  );
}

/** Kept exported from here for existing callers; lives in lib/channels/latest.ts. */
export { latestChannelFor };

type RosterBot = {
  id: string;
  name: string;
  title?: string | null;
  canManage?: boolean;
  /** 部署包机器人不能改但管理员能删；旧服务器没有这个字段时按 canManage。 */
  canDelete?: boolean;
};

/** 这个人能不能删除这个机器人（服务器 canDeleteAgent 的镜像）。 */
function canDeleteBot(bot: RosterBot) {
  return bot.canDelete ?? bot.canManage ?? false;
}

function BotRow({
  bot,
  selected,
  main,
  latest,
  attention,
  onToggleMain,
}: {
  bot: RosterBot;
  selected: boolean;
  main: boolean;
  latest: ChannelSummary | undefined;
  attention: BotAttention | undefined;
  onToggleMain: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  useEffect(() => {
    if (menuOpen) preloadBotDialogs();
  }, [menuOpen]);
  const resume = useMutation(setBotPausedMutationOptions(queryClient));
  const waiting = attention ? needsInput(attention) : 0;
  const unread = !selected && attention ? attention.unread > 0 : false;
  const paused = attention?.paused ?? false;
  // DESIGN v4.1：当前对话的机器人控件（设置窗格 / 计算机 / 新话题）由聊天页登记，在这一行里操作。
  const chat = useBotChat(bot.id);
  // 手机抽屉里点机器人：进它的对话并收起抽屉（以前抽屉留着盖在对话上，要再点一下遮罩）。
  const sidebar = useOptionalSidebar();
  const closeDrawer = () => {
    if (sidebar?.isMobile && sidebar.openMobile) sidebar.setOpenMobile(false);
  };
  const content = (
    <>
      <span className="glass-bot-ava">
        <ChannelAvatar participantIds={[bot.id]} size={28} />
        {main ? (
          <span aria-hidden className="glass-bot-star">
            <IconStarFilled className="size-2.5" />
          </span>
        ) : null}
      </span>
      <span className="glass-bot-text">
        <span className="glass-item-t">{bot.name}</span>
        {paused ? (
          <span className="glass-item-s">{"已暂停"}</span>
        ) : bot.title ? (
          <span className="glass-item-s">{bot.title}</span>
        ) : null}
      </span>
      {waiting > 0 ? (
        <span className="glass-bot-badge" title={attention ? attentionSummary(attention) : undefined}>
          {waiting}
        </span>
      ) : unread ? (
        <span className="glass-bot-dot" title={attention ? attentionSummary(attention) : undefined} />
      ) : null}
    </>
  );
  return (
    <div
      className={cn("glass-bot-row", (selected || chat) && "is-on", menuOpen && "menu-open")}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {latest ? (
        <Link
          aria-current={selected ? "page" : undefined}
          className="glass-bot-link"
          onClick={closeDrawer}
          onFocus={() => prefetchBotChat(bot.id, latest)}
          onPointerEnter={() => prefetchBotChat(bot.id, latest)}
          onTouchStart={() => prefetchBotChat(bot.id, latest)}
          params={{ channelId: latest.id }}
          title={bot.name}
          to="/channel/$channelId"
        >
          {content}
        </Link>
      ) : (
        <Link
          aria-current={selected ? "page" : undefined}
          className="glass-bot-link"
          onClick={closeDrawer}
          search={{ agent: bot.id }}
          title={bot.name}
          to="/channel/new"
        >
          {content}
        </Link>
      )}
      <BotRowComputerChip chat={chat} />
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger
          render={
            <button
              aria-label={`${bot.name} 机器人菜单`}
              className="glass-bot-more"
              title={"机器人菜单"}
              type="button"
            />
          }
        >
          <IconDots className="size-4" />
        </DropdownMenuTrigger>
        <BotMenuContent
          bot={bot}
          chat={chat}
          latest={latest}
          main={main}
          onComputer={() => setComputerOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onResume={() => resume.mutate({ agentId: bot.id, paused: false })}
          onToggleMain={onToggleMain}
          paused={paused}
        />
      </DropdownMenu>
      {canDeleteBot(bot) ? (
        <DeleteBotDialog
          bot={{ id: bot.id, name: bot.name }}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          selectedBotId={selected ? bot.id : undefined}
        />
      ) : null}
      <BotComputerAccessDialog
        agentId={bot.id}
        botName={bot.name}
        onOpenChange={setComputerOpen}
        open={computerOpen}
      />
    </div>
  );
}

/**
 * 机器人「⋯」菜单（DESIGN v4.1 §W5，在左栏机器人行；DESIGN.md §57 导航收敛后的顺序）：
 * 机器人资料 · 历史对话 · 新话题 · 面板 · 电脑操作… ‖ 设为主机器人 · 恢复运行 ‖ 删除机器人…
 */
function BotMenuContent({
  bot,
  chat,
  latest,
  main,
  paused,
  onToggleMain,
  onResume,
  onDelete,
  onComputer,
}: {
  bot: RosterBot;
  chat: ReturnType<typeof useBotChat>;
  latest: ChannelSummary | undefined;
  main: boolean | null;
  paused: boolean;
  onToggleMain: (() => void) | null;
  onResume: () => void;
  onDelete: () => void;
  /** 「电脑操作…」：账号下关联的设备（所有机器人共用）。null = 不显示（例如隐藏的浏览器机器人）。 */
  onComputer: (() => void) | null;
}) {
  const icon = "size-[18px] shrink-0 opacity-80";
  const navigate = useNavigate();
  const { botId: panelBotId } = usePanelBot();
  // 菜单离左栏卡片右边 8px、顶边与机器人行齐平（DESIGN.md §34.3），而不是挨着 ⋯ 小按钮压在卡片上。
  const anchor = useMemo(
    () =>
      snapAnchor(openTriggerByLabel(`${bot.name} 机器人菜单`), {
        x: ".glass-side-card, .glass-mini-card",
        y: ".glass-bot-row, .glass-mini-slot",
      }),
    [bot.name],
  );
  // 面板跟着「当前机器人」走：不是当前的就先进入它的对话，再打开面板（宽窗口右栏，窄窗口抽屉）。
  const openPanels = async () => {
    if (panelBotId !== bot.id) {
      if (latest) await navigate({ to: "/channel/$channelId", params: { channelId: latest.id } });
      else await navigate({ to: "/channel/new", search: { agent: bot.id } });
    }
    showPanels();
  };
  // 窄窗口（左栏是抽屉、几乎占满窗口）右边放不下：改成贴着机器人行下方弹出、右边与卡片齐平，菜单留在窗口里（DESIGN.md §36.3）。
  const drawer = Boolean(useOptionalSidebar()?.isMobile);
  return (
    <DropdownMenuContent
      align={drawer ? "end" : "start"}
      anchor={anchor}
      className="glass-pop bot-menu-pop"
      side={drawer ? "bottom" : "right"}
      sideOffset={drawer ? 4 : 8}
    >
      <DropdownMenuItem
        className="glass-mi"
        render={<Link params={{ agentId: bot.id }} to="/bots/$agentId" />}
      >
        <IconUserCircle className={icon} />
        <span className="min-w-0 flex-1">{"机器人资料"}</span>
      </DropdownMenuItem>
      <BotChatMenuItems agentId={bot.id} chat={chat} />
      <DropdownMenuItem className="glass-mi" onClick={() => void openPanels()}>
        <IconLayoutDashboard className={icon} />
        <span className="min-w-0 flex-1">
          <span className="block">{"面板"}</span>
          <span className="glass-mi-sub">{"它做的仪表盘、列表和小工具"}</span>
        </span>
      </DropdownMenuItem>
      {onComputer ? (
        <DropdownMenuItem className="glass-mi" onClick={onComputer}>
          <IconDeviceDesktop className={icon} />
          <span className="min-w-0 flex-1">
            <span className="block">{"电脑操作…"}</span>
            <span className="glass-mi-sub">{"你关联的设备，所有机器人共用"}</span>
          </span>
        </DropdownMenuItem>
      ) : null}
      {onToggleMain || paused ? <DropdownMenuSeparator className="glass-sep" /> : null}
      {onToggleMain ? (
        <DropdownMenuItem className="glass-mi" onClick={onToggleMain}>
          {main ? <IconStarOff className={icon} /> : <IconStar className={icon} />}
          <span className="min-w-0 flex-1">{main ? "取消主机器人" : "设为主机器人"}</span>
        </DropdownMenuItem>
      ) : null}
      {paused ? (
        <DropdownMenuItem className="glass-mi" onClick={onResume}>
          <IconPlayerPause className={icon} />
          <span className="min-w-0 flex-1">{"恢复运行"}</span>
        </DropdownMenuItem>
      ) : null}
      {canDeleteBot(bot) ? (
        <>
          <DropdownMenuSeparator className="glass-sep" />
          <DropdownMenuItem className="glass-mi is-danger" onClick={onDelete} variant="destructive">
            <IconTrash className={icon} />
            <span className="min-w-0 flex-1">{"删除机器人…"}</span>
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  );
}

/**
 * 当前对话的机器人不在列表里（隐藏的机器人，例如浏览器机器人）时，在列表顶部临时给它一行，
 * 这样它的「⋯」和计算机提示仍然够得着。
 */
function HiddenChatBotRow({ known }: { known: Set<string> }) {
  const current = useCurrentBotChat();
  const agents = useQuery(agentListQueryOptions());
  if (!current || known.has(current.agentId)) return null;
  const profile = agents.data?.find((a) => a.id === current.agentId);
  const bot: RosterBot = {
    id: current.agentId,
    name: profile?.name ?? current.fallbackName ?? "",
    title: profile?.title ?? null,
  };
  return (
    <>
      <div className="glass-sec">
        <span>{"当前对话"}</span>
      </div>
      <div className="glass-bot-list mb-2">
        <HiddenBotRow bot={bot} chat={current} />
      </div>
    </>
  );
}

function HiddenBotRow({ bot, chat }: { bot: RosterBot; chat: NonNullable<ReturnType<typeof useBotChat>> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={cn("glass-bot-row is-on", menuOpen && "menu-open")}>
      <span className="glass-bot-link">
        <span className="glass-bot-ava">
          <ChannelAvatar participantIds={[bot.id]} size={28} />
        </span>
        <span className="glass-bot-text">
          <span className="glass-item-t">{bot.name}</span>
          {bot.title ? <span className="glass-item-s">{bot.title}</span> : null}
        </span>
      </span>
      <BotRowComputerChip chat={chat} />
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger
          render={
            <button aria-label={`${bot.name} 机器人菜单`} className="glass-bot-more" title={"机器人菜单"} type="button" />
          }
        >
          <IconDots className="size-4" />
        </DropdownMenuTrigger>
        <BotMenuContent
          bot={bot}
          chat={chat}
          latest={undefined}
          main={null}
          onComputer={null}
          onDelete={() => {}}
          onResume={() => {}}
          onToggleMain={null}
          paused={false}
        />
      </DropdownMenu>
    </div>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const search = useSidebarSearch();
  const sidebar = useOptionalSidebar();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const agents = useQuery(agentListQueryOptions());
  const roster = (agents.data ?? []).filter((bot) => !bot.hidden);
  const attention = useQuery(botAttentionQueryOptions());
  useAttentionNotifications(attention.data);
  const attentionById = new Map((attention.data ?? []).map((a) => [a.agentId, a]));
  const { botId: selectedBotId } = usePanelBot();
  const { mainBotId, setMainBot } = useMainBot();
  const mainBot = mainBotId ? roster.find((bot) => bot.id === mainBotId) : undefined;
  const others = mainBot ? roster.filter((bot) => bot.id !== mainBot.id) : roster;
  // 空闲时预取主机器人和左栏前几个的对话，切过去就是现成的（DESIGN.md §83）。
  usePrefetchBotChats(
    [...(mainBot ? [mainBot.id] : []), ...others.map((bot) => bot.id)],
    channels.data,
    selectedBotId,
  );

  const searching = search.trim().length > 0;
  const titleMatches = searching ? pinnedFirst(matchingChannels(channels.data, search)) : [];
  const contentSearch = useChannelMessageSearch(search);
  const contentHits = contentSearch.data ?? [];
  // 标题命中优先；正文命中补上标题没扫到的会话。
  const titleIds = new Set(titleMatches.map((c) => c.id));
  const extraHits = contentHits.filter((hit) => !titleIds.has(hit.channelId));
  const visibleChannels = titleMatches;
  const searchEmpty =
    searching &&
    visibleChannels.length === 0 &&
    extraHits.length === 0 &&
    !contentSearch.isFetching;

  const row = (bot: RosterBot, isMain: boolean) => (
    <BotRow
      attention={attentionById.get(bot.id)}
      bot={bot}
      key={bot.id}
      latest={latestChannelFor(bot.id, channels.data)}
      main={isMain}
      onToggleMain={() => setMainBot(isMain ? null : bot.id)}
      selected={selectedBotId === bot.id}
    />
  );

  const collapsed = Boolean(sidebar && !sidebar.isMobile && sidebar.state === "collapsed");
  if (collapsed) {
    const railBots = mainBot ? [mainBot, ...others] : roster;
    return (
      <RailSidebar collapsible="icon" variant="floating" {...props}>
        <BotMiniRail
          attentionById={attentionById}
          bots={railBots}
          channels={channels.data}
          mainBotId={mainBot?.id}
          selectedBotId={selectedBotId}
          setMainBot={setMainBot}
        />
      </RailSidebar>
    );
  }

  return (
    <RailSidebar collapsible="icon" variant="floating" {...props}>
      <SidebarContent className="glass-side-full gap-3 overflow-hidden" id="chisabot-bot-list">
        <LeftModeSwitch mode="bots" />
        <section
          aria-label={searching ? "搜索结果" : "机器人"}
          className="glass-card glass-side-card min-h-0 flex-1"
        >
          {/* DESIGN-v4：搜索在它要搜的列表上面，同一张卡片里（Ctrl K 聚焦这里）。 */}
          <SidebarSearchField />
          {searching ? (
            <>
              <div className="glass-sec">
                <span>{`搜索“${search.trim()}”`}</span>
              </div>
              <div ref={scrollRoot} className="glass-side-scroll scroll-fade-b">
                <SidebarMenu>
                  <SidebarGroup className="gap-px p-0">
                    {searchEmpty ? (
                      <div className="py-4">
                        <Empty className="border border-dashed min-h-[30dvh]">
                          <EmptyHeader>
                            <EmptyTitle>{"没有会话匹配您的搜索"}</EmptyTitle>
                            <EmptyDescription className="text-pretty">
                              {`“${search.trim()}”不在会话名、摘要里，消息正文里也没有找到。`}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      </div>
                    ) : null}
                    {contentSearch.isFetching && visibleChannels.length === 0 && extraHits.length === 0 ? (
                      <div className="px-2 py-3 text-[12px] text-muted-foreground">{"正在搜索消息…"}</div>
                    ) : null}
                    <AnimatePresence initial={false}>
                      {visibleChannels.map((channel) => {
                        const hit = contentHits.find((h) => h.channelId === channel.id);
                        if (hit) {
                          return (
                            <motion.div
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              initial={{ opacity: 0 }}
                              key={`hit-${channel.id}`}
                            >
                              <SearchHitRow agentIds={channel.agentIds} hit={{ ...hit, name: channel.name, summary: channel.summary ?? hit.summary }} />
                            </motion.div>
                          );
                        }
                        return (
                          <ChannelRow
                            animateOrder={false}
                            channel={channel}
                            emphasis={emphasis}
                            key={channel.id}
                          />
                        );
                      })}
                      {extraHits.map((hit) => (
                        <motion.div
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          initial={{ opacity: 0 }}
                          key={`extra-${hit.channelId}-${hit.messageId ?? hit.snippet.slice(0, 12)}`}
                        >
                          <SearchHitRow
                            agentIds={channels.data?.find((c) => c.id === hit.channelId)?.agentIds ?? []}
                            hit={hit}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    <ChannelPagination
                      query={channels}
                      scrollRoot={scrollRoot}
                      searching={searching}
                    />
                  </SidebarGroup>
                </SidebarMenu>
              </div>
            </>
          ) : (
            <>
              {/* 列表头：标题 + 「＋ 新建机器人」。 */}
              <div className="glass-list-head">
                <span className="glass-list-title">{"机器人"}</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        aria-label={"新建机器人"}
                        className="glass-list-add"
                        onClick={openCreateBot}
                        type="button"
                      />
                    }
                  >
                    <IconPlus className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={6}>
                    {"新建机器人"}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="glass-side-scroll glass-bot-scroll scroll-fade-b">
                <HiddenChatBotRow known={new Set(roster.map((bot) => bot.id))} />
                {mainBot ? (
                  <>
                    <div className="glass-sec">
                      <span className="glass-sec-main">
                        <IconStarFilled className="size-3" />
                        {"主机器人"}
                      </span>
                    </div>
                    <div className="glass-bot-list">{row(mainBot, true)}</div>
                    {others.length > 0 ? (
                      <div className="glass-sec mt-2">
                        <span>{"其他"}</span>
                      </div>
                    ) : null}
                  </>
                ) : null}
                <div className="glass-bot-list relative">
                  <PresenceList>
                    {others.map((bot) => (
                      <PresenceItem key={bot.id}>{row(bot, false)}</PresenceItem>
                    ))}
                  </PresenceList>
                  {roster.length === 0 && agents.isSuccess ? (
                    <button className="glass-list-empty" onClick={openCreateBot} type="button">
                      <IconPlus className="size-4" />
                      {"新建一个机器人"}
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>
        {/* 账号永远在左栏最底下，单独一张小卡：「我是谁」和「我在用什么」分开。 */}
        <AccountCard />
      </SidebarContent>
      <RailSidebarEdge />
    </RailSidebar>
  );
}

function RailTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The roster collapsed (Ctrl+B / the top-bar toggle): a 64px glass rail of Bot avatars, so Bots stay
 * one click away. The selected Bot carries the same blue ring/edge as its full row, the main Bot its
 * star, and unread / waiting states a dot.
 */
function BotMiniRail({
  bots,
  mainBotId,
  selectedBotId,
  channels,
  attentionById,
  setMainBot,
}: {
  bots: RosterBot[];
  mainBotId: string | undefined;
  selectedBotId: string | null | undefined;
  channels: ChannelSummary[] | undefined;
  attentionById: Map<string, BotAttention>;
  setMainBot: (id: string | null) => void;
}) {
  return (
    <nav aria-label={"机器人"} className="glass-mini" id="chisabot-bot-list">
      <MiniSearchButton />
      <RailTip label={"新建机器人"}>
        <button aria-label={"新建机器人"} className="glass-mini-new" onClick={openCreateBot} type="button">
          <IconPlus className="size-5" />
        </button>
      </RailTip>
      <div className="glass-card glass-mini-card">
        <div className="glass-mini-scroll scroll-fade-b">
          <HiddenChatMiniBot known={new Set(bots.map((bot) => bot.id))} />
          {bots.map((bot) => (
            <MiniBot
              attention={attentionById.get(bot.id)}
              bot={bot}
              key={bot.id}
              latest={latestChannelFor(bot.id, channels)}
              main={bot.id === mainBotId}
              onToggleMain={() => setMainBot(bot.id === mainBotId ? null : bot.id)}
              selected={selectedBotId === bot.id}
            />
          ))}
        </div>
      </div>
      <div className="glass-card acct-mini-card">
        <AccountMenu compact />
      </div>
    </nav>
  );
}

/**
 * 收起的左栏里的一个机器人头像（DESIGN v4.2）：右键或悬停 / 聚焦时出现的小「⋯」打开和展开行同一个
 * 菜单（BotMenuContent）；选中的机器人「⋯」常显（头像左下角的小徽标）。计算机打开 / 需要你时，
 * 选中的头像左上角有一个圆点（蓝 = 已打开，琥珀 = 需要你）。
 */
function MiniBot({
  bot,
  selected,
  main,
  latest,
  attention,
  onToggleMain,
}: {
  bot: RosterBot;
  selected: boolean;
  main: boolean;
  latest: ChannelSummary | undefined;
  attention: BotAttention | undefined;
  onToggleMain: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  useEffect(() => {
    if (menuOpen) preloadBotDialogs();
  }, [menuOpen]);
  const resume = useMutation(setBotPausedMutationOptions(queryClient));
  const chat = useBotChat(bot.id);
  const waiting = attention ? needsInput(attention) : 0;
  const unread = !selected && attention ? attention.unread > 0 : false;
  const paused = attention?.paused ?? false;
  const label = main ? `${bot.name}（主机器人）` : bot.name;
  const computer = chat?.canComputer && (chat.needsYou || chat.computerOpen) ? (chat.needsYou ? "needs" : "open") : null;
  const inner = (
    <>
      <ChannelAvatar participantIds={[bot.id]} size={36} />
      {main ? (
        <span aria-hidden className="glass-bot-star">
          <IconStarFilled className="size-2.5" />
        </span>
      ) : null}
      {waiting > 0 ? (
        <span className="glass-mini-badge">{waiting}</span>
      ) : unread ? (
        <span aria-hidden className="glass-mini-dot" />
      ) : null}
    </>
  );
  const linkClass = cn("glass-mini-bot", (selected || chat) && "is-on");
  return (
    <div
      className={cn("glass-mini-slot", (selected || chat) && "is-on", menuOpen && "menu-open")}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <RailTip label={label}>
        {latest ? (
          <Link
            aria-current={selected ? "page" : undefined}
            aria-label={label}
            className={linkClass}
            onFocus={() => prefetchBotChat(bot.id, latest)}
            onPointerEnter={() => prefetchBotChat(bot.id, latest)}
            onTouchStart={() => prefetchBotChat(bot.id, latest)}
            params={{ channelId: latest.id }}
            to="/channel/$channelId"
          >
            {inner}
          </Link>
        ) : (
          <Link
            aria-current={selected ? "page" : undefined}
            aria-label={label}
            className={linkClass}
            search={{ agent: bot.id }}
            to="/channel/new"
          >
            {inner}
          </Link>
        )}
      </RailTip>
      {computer ? (
        <span
          className={cn("glass-mini-comp", computer === "needs" && "is-needs")}
          role="img"
          aria-label={computer === "needs" ? "计算机需要你" : "计算机已打开"}
          title={computer === "needs" ? "计算机需要你" : "计算机已打开"}
        />
      ) : null}
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger
          render={
            <button
              aria-label={`${bot.name} 机器人菜单`}
              className="glass-mini-more"
              title={"机器人菜单"}
              type="button"
            />
          }
        >
          <IconDots className="size-3" />
        </DropdownMenuTrigger>
        <BotMenuContent
          bot={bot}
          chat={chat}
          latest={latest}
          main={main}
          onComputer={() => setComputerOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onResume={() => resume.mutate({ agentId: bot.id, paused: false })}
          onToggleMain={onToggleMain}
          paused={paused}
        />
      </DropdownMenu>
      {canDeleteBot(bot) ? (
        <DeleteBotDialog
          bot={{ id: bot.id, name: bot.name }}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          selectedBotId={selected ? bot.id : undefined}
        />
      ) : null}
      <BotComputerAccessDialog
        agentId={bot.id}
        botName={bot.name}
        onOpenChange={setComputerOpen}
        open={computerOpen}
      />
    </div>
  );
}

/**
 * 收起的左栏里「当前对话」的隐藏机器人（例如浏览器机器人）：和展开时的 HiddenChatBotRow 对应，放在头像列最上面，
 * 下面一道细分隔线和普通机器人隔开。和 MiniBot 一样右键或「⋯」徽标打开同一个菜单（BotMenuContent），
 * 计算机打开 / 需要你时左上角有圆点。它就是当前对话，所以头像本身不是链接。
 */
function HiddenChatMiniBot({ known }: { known: Set<string> }) {
  const current = useCurrentBotChat();
  const agents = useQuery(agentListQueryOptions());
  const [menuOpen, setMenuOpen] = useState(false);
  if (!current || known.has(current.agentId)) return null;
  const profile = agents.data?.find((a) => a.id === current.agentId);
  const bot: RosterBot = {
    id: current.agentId,
    name: profile?.name ?? current.fallbackName ?? "",
    title: profile?.title ?? null,
  };
  const label = `当前对话：${bot.name}`;
  const computer =
    current.canComputer && (current.needsYou || current.computerOpen)
      ? current.needsYou
        ? "needs"
        : "open"
      : null;
  return (
    <>
      <div
        className={cn("glass-mini-slot is-on", menuOpen && "menu-open")}
        data-hidden-chat-bot=""
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <RailTip label={label}>
          <span aria-current="page" aria-label={label} className="glass-mini-bot is-on" role="img">
            <ChannelAvatar participantIds={[bot.id]} size={36} />
          </span>
        </RailTip>
        {computer ? (
          <span
            className={cn("glass-mini-comp", computer === "needs" && "is-needs")}
            role="img"
            aria-label={computer === "needs" ? "计算机需要你" : "计算机已打开"}
            title={computer === "needs" ? "计算机需要你" : "计算机已打开"}
          />
        ) : null}
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          <DropdownMenuTrigger
            render={
              <button
                aria-label={`${bot.name} 机器人菜单`}
                className="glass-mini-more"
                title={"机器人菜单"}
                type="button"
              />
            }
          >
            <IconDots className="size-3" />
          </DropdownMenuTrigger>
          <BotMenuContent
            bot={bot}
            chat={current}
            latest={undefined}
            main={null}
            onComputer={null}
            onDelete={() => {}}
            onResume={() => {}}
            onToggleMain={null}
            paused={false}
          />
        </DropdownMenu>
      </div>
      <span aria-hidden className="glass-mini-sep" />
    </>
  );
}

/** 收起的左栏：搜索变成一个图标，点它（或 Ctrl K）先展开左栏再聚焦搜索框，位置和展开时一致（最上面）。 */
function MiniSearchButton() {
  const sidebar = useOptionalSidebar();
  return (
    <RailTip label={"搜索会话（Ctrl K）"}>
      <button
        aria-label={"搜索会话"}
        className="glass-mini-search"
        onClick={() => {
          sidebar?.setOpen(true);
          requestSidebarSearchFocus();
        }}
        type="button"
      >
        <IconSearch className="size-[18px]" />
      </button>
    </RailTip>
  );
}
