import type { Message } from "@ag-ui/core";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { RegisterBotChat } from "@/components/agents/bot-chat-actions";
import { LandingRedirect } from "@/components/agents/landing-redirect";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { latestChannelFor } from "@/lib/channels/latest";
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
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string; topic?: "new" } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    // 新话题（DESIGN-v3 §5.3）：留在这个机器人的空聊天，不转跳到它已有的对话；第一条消息发出时才建会话。
    ...(search.topic === "new" ? { topic: "new" as const } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent, topic } = Route.useSearch();
  if (!agent) return <LandingRedirect />;
  return <BotChat agent={agent} fresh={topic === "new"} key={`${agent}:${topic ?? ""}`} />;
}

function BotChat({ agent, fresh }: { agent: string; fresh: boolean }) {
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
      void navigate({ to: "/channel/$channelId", params: { channelId: existing }, replace: true });
  }, [existing, navigate]);

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
      ? "AI 同事无法加载。"
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? "此机器人不可用。它可能未发布、未共享或尚未描述。"
          : "AI 同事无法加载。"
        : null;
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");
  const modelSaving = useModelSelectionSaving(chosen?.id ?? "");

  if ((profiles === undefined && !rosterError) || channels.isPending || existing) return null;

  return (
    <div className="relative flex h-full flex-col">
      <RegisterBotChat agentId={chosen?.id} freshTopic />
      {chosen && !sent ? (
        // Quiet identity of the Bot picked in the left column, until the first message replaces it.
        <div aria-hidden className="chat-intro">
          <AbstractAvatar name={chosen.name} seed={chosen.avatarSeed} size={48} />
          <p className="chat-intro-name">{chosen.name}</p>
          {chosen.title ? <p className="chat-intro-sub">{chosen.title}</p> : null}
          {fresh ? <p className="chat-intro-topic">{"新话题 · 之前的对话不会发给它"}</p> : null}
        </div>
      ) : null}
      <ConversationView
        modelControl={chosen ? <BotModelSelector agentId={chosen.id} compact /> : null}
        sendBlocked={modelSaving}
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
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
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;
          assertModelSelectionNotSaving(modelQueryClient, recipient.id);

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(recipient.id, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error ? caught.message : "无法开始会话。",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
