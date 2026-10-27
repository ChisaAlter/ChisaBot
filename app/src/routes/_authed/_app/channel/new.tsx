import type { Message } from "@ag-ui/core";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { restampOverlayMarker } from "@/lib/overlay-back";
import { useBotComputerTab } from "@/lib/chat/use-bot-computer";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { LandingRedirect } from "@/components/agents/landing-redirect";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PermissionChip } from "@/components/chat/permission-chip";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { useModelSelectionSaving } from "@/lib/model-selection/hooks";
import { assertModelSelectionNotSaving } from "@/lib/model-selection/mutations";
import { canSend, type Recipient } from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import {
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * A Bot's chat before its first conversation exists. There is no "new chat" any more: without
 * `?agent=` this forwards to the landing Bot, and with one whose one-to-one conversation already
 * exists it forwards there, so every "open this Bot" link lands in the same ongoing chat.
 *
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
/** 空聊天里的「试试这样问」：都是问问题、不改任何东西的句子（成熟度扫查 F2，DESIGN.md §61）。 */
const INTRO_TRIES = [
  "你能帮我做哪些事？",
  "帮我查一下今天的科技新闻要点",
  "怎么把我的电脑连上，让你帮我改文件？",
  "我想让你记住一些我的习惯，该怎么说？",
  "请调用 personal_morning_brief 生成我的今日晨报卡片",
  "请调用 connect_service (action='list') 查看我所有连接器状态",
] as const;

/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string; topic?: "new"; watch?: boolean } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    // 新话题（DESIGN-v3 §5.3）：留在这个机器人的空聊天，不转跳到它已有的对话；第一条消息发出时才建会话。
    ...(search.topic === "new" ? { topic: "new" as const } : {}),
    // 旧 `/bot?watch=true`（打开机器人的浏览器）跳过来时带着，转到已有对话时一起带过去（CB-046）。
    ...(search.watch === true ? { watch: true } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent, topic, watch } = Route.useSearch();
  if (!agent) return <LandingRedirect />;
  return <BotChat agent={agent} fresh={topic === "new"} watch={watch === true} key={`${agent}:${topic ?? ""}`} />;
}

function BotChat({ agent, fresh, watch }: { agent: string; fresh: boolean; watch: boolean }) {
  const modelQueryClient = useQueryClient();
  const navigate = useNavigate();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const { startChosen, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // This Bot already has a conversation: open it rather than an empty chat beside it.
  const existing = sent || fresh ? undefined : latestChannelFor(agent, channels.data)?.id;
  useEffect(() => {
    if (existing)
      void navigate({ to: "/channel/$channelId", params: { channelId: existing }, search: watch ? { watch: true } : {}, replace: true });
  }, [existing, navigate, watch]);

  // 右栏「计算机」开关（DESIGN.md §79）：和对话页一样记在 `watch` 搜索参数里（刷新保留、后退关闭）。
  // 按机器人记住选的是哪个标签（DESIGN.md §88）：地址里没有 `watch` 时用上次的。
  const navigateHere = Route.useNavigate();
  const writeWatch = useCallback(
    (open: boolean, replace: boolean) =>
      void navigateHere({
        search: (previous) => ({ ...previous, watch: open ? true : undefined }),
        replace,
      }).then(() => {
        if (replace) restampOverlayMarker();
      }),
    [navigateHere],
  );
  const [isWatching, setWatching] = useBotComputerTab(
    // 马上要转到已有对话：交给那边记，这里不补地址（两次导航会互相顶掉）。
    existing ? undefined : agent,
    watch ? true : undefined,
    writeWatch,
  );

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    error: detailFailure,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined);
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  // The Bot is chosen in the left roster only (no "至：" picker here); `?agent=` carries the choice.
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "机器人列表没有加载出来，请刷新重试。"
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? "这个机器人不存在或已被删除。"
          : "这个机器人没有加载出来，请刷新重试。"
        : null;
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");
  const modelSaving = useModelSelectionSaving(chosen?.id ?? "");

  const start = async (text: string) => {
    const recipient = recipients[0];
    if (!recipient || !canSend(recipients, text)) return;
    assertModelSelectionNotSaving(modelQueryClient, recipient.id);

    setError(null);
    setSent(seedMessage(text, newId()));

    try {
      // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
      // home screen, and the trail has to say so for both.
      await startChosen(recipient.id, text, { watch: isWatching });
    } catch (caught) {
      // Preserve the unsent draft when channel creation fails.
      setSent(null);
      setError(caught instanceof Error ? caught.message : "无法开始会话。");
      throw caught;
    }
  };

  if ((profiles === undefined && !rosterError) || channels.isPending || existing) return null;

  return (
    <div className="relative flex h-full flex-col">
      {/*
       * 空聊天也是这个机器人的对话：右栏照样是「面板 | 计算机」（DESIGN.md §23 / §79）。计算机属于机器人、
       * 不属于某条对话，所以还没发第一条消息也能打开；发出第一条时 `watch` 跟着带进新对话。
       */}
      <RegisterBotChat
        agentId={chosen?.id}
        computerOpen={isWatching}
        freshTopic
        onComputerChange={setWatching}
      />
      {chosen && !sent ? (
        // Quiet identity of the Bot picked in the left column, until the first message replaces it.
        <div className="chat-intro">
          <ChannelAvatar participantIds={[chosen.id]} size={48} />
          <p className="chat-intro-name">{chosen.name}</p>
          {chosen.title ? <p className="chat-intro-sub">{chosen.title}</p> : null}
          {fresh ? <p className="chat-intro-topic">{"新话题 · 之前的对话不会发给它"}</p> : null}
          {/* 新朋友不知道能问什么（成熟度扫查 F2）：几句不带副作用的开场，点了直接发。 */}
          {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了 */}
          <div className="chat-intro-tries" role="group" aria-label="试试这样问">
            {INTRO_TRIES.map((text) => (
              <button
                className="chat-intro-try"
                disabled={pending || Boolean(loadError) || waitingForUrlAgent}
                key={text}
                onClick={() => void start(text).catch(() => undefined)}
                type="button"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ConversationView
        modelControl={chosen ? <BotModelSelector agentId={chosen.id} compact /> : null}
        leadingControl={chosen ? <PermissionChip agentId={chosen.id} /> : null}
        sendBlocked={modelSaving}
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // 还没开对话前写的字也按机器人记着（DESIGN.md §88）。
        draftKey={`new:${agent}`}
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={(draft) => start(draft.text)}
        pending={pending}
      />
    </div>
  );
}
