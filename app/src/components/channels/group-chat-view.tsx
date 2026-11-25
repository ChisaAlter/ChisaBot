import {
  IconAt,
  IconDownload,
  IconRefresh,
  IconSend,
  IconTarget,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent,
  memo,
  type SyntheticEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Label } from "@/components/ui/label";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { EmptyState, ErrorCard } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useExternalConnection } from "@/hooks";
import {
  applyMentionCompletion,
  detectGoalDeliverableIds,
  detectTrailingMention,
  formatGroupTranscriptMarkdown,
  type GroupBotMember,
  type GroupMessageStatus,
  type GroupTranscriptMessage,
  groupDetailQueryOptions,
  insertBotMention,
  sendGroupMessageMutationOptions,
  splitGroupMentionSegments,
} from "@/lib/channels/group-api";
import type { AgentChannel } from "@/lib/channels/queries";
import { useKeptVisible } from "@/lib/kept-visible";
import { newId } from "@/lib/new-id";
import { relativeTime, useRelativeNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

export type GroupChatChannel = Pick<
  AgentChannel,
  "id" | "name" | "agentIds"
> & {
  active?: boolean;
};

export type GroupChatViewProps = {
  channel: GroupChatChannel;
};

const STATUS_META: Record<
  GroupMessageStatus,
  { label: string; badgeClass: string; pulse?: boolean }
> = {
  queued: {
    label: "排队中",
    badgeClass: "bg-muted text-muted-foreground",
  },
  running: {
    label: "生成中…",
    badgeClass: "bg-primary/15 text-primary",
    pulse: true,
  },
  waiting: {
    label: "等待确认",
    badgeClass:
      "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  },
  completed: {
    label: "已完成",
    badgeClass:
      "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  },
  failed: {
    label: "执行失败",
    badgeClass: "bg-destructive/15 text-destructive",
  },
};

const BOT_BADGE_TONES = [
  "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
] as const;

const BOT_MENTION_ON_USER_TONES = [
  "border-sky-300/60 bg-sky-50/90 text-sky-800 dark:border-sky-400/40 dark:bg-sky-950/75 dark:text-sky-200",
  "border-violet-300/60 bg-violet-50/90 text-violet-800 dark:border-violet-400/40 dark:bg-violet-950/75 dark:text-violet-200",
  "border-teal-300/60 bg-teal-50/90 text-teal-800 dark:border-teal-400/40 dark:bg-teal-950/75 dark:text-teal-200",
  "border-amber-300/60 bg-amber-50/90 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/75 dark:text-amber-200",
] as const;

function downloadMarkdownFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StatusBadge({ status }: { status: GroupMessageStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.badgeClass,
      )}
      data-message-status={status}
    >
      {meta.pulse ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current animate-pulse"
        />
      ) : null}
      {meta.label}
    </span>
  );
}

function MentionHighlightedText({
  text,
  bots,
  botIndexMap,
  onUserBubble = false,
}: {
  text: string;
  bots: readonly GroupBotMember[];
  botIndexMap: ReadonlyMap<string, number>;
  onUserBubble?: boolean;
}) {
  const segments = useMemo(
    () => splitGroupMentionSegments(text, bots),
    [text, bots],
  );
  const tones = onUserBubble ? BOT_MENTION_ON_USER_TONES : BOT_BADGE_TONES;

  return (
    <p className="whitespace-pre-wrap break-words">
      {segments.map((segment) => {
        if (segment.kind === "text") {
          return <span key={segment.key}>{segment.text}</span>;
        }
        const toneIndex = botIndexMap.get(segment.bot.id) ?? 0;
        const tone = tones[toneIndex % tones.length];
        return (
          <span
            className={cn(
              "mx-0.5 inline-flex items-center rounded-full border px-1.5 py-px text-[0.92em] font-medium align-baseline",
              tone,
            )}
            data-mention-bot={segment.bot.id}
            key={segment.key}
          >
            {segment.text}
          </span>
        );
      })}
    </p>
  );
}

const GroupMessageRow = memo(function GroupMessageRow({
  message,
  bots,
  botIndexMap,
  botNameMap,
  now,
  isGoalDeliverable,
}: {
  message: GroupTranscriptMessage;
  bots: readonly GroupBotMember[];
  botIndexMap: ReadonlyMap<string, number>;
  botNameMap: ReadonlyMap<string, string>;
  now: number;
  isGoalDeliverable: boolean;
}) {
  const timestamp = relativeTime(message.createdAt, now);

  if (message.agentId === null) {
    return (
      <Message align="end" data-group-message-id={message.id}>
        <MessageContent>
          <MessageHeader className="justify-end gap-2">
            <span>{"你"}</span>
          </MessageHeader>
          <Bubble align="end" variant="default">
            <BubbleContent>
              <MentionHighlightedText
                botIndexMap={botIndexMap}
                bots={bots}
                onUserBubble
                text={message.text}
              />
            </BubbleContent>
          </Bubble>
          <MessageFooter className="justify-end">
            <span>{timestamp}</span>
          </MessageFooter>
        </MessageContent>
      </Message>
    );
  }

  const botId = message.agentId;
  const botName = botNameMap.get(botId) ?? botId;
  const toneIndex = botIndexMap.get(botId) ?? 0;
  const botTone = BOT_BADGE_TONES[toneIndex % BOT_BADGE_TONES.length];
  const answeredByName = message.answeredBy
    ? (botNameMap.get(message.answeredBy) ?? message.answeredBy)
    : null;
  const isWaiting = message.status === "waiting";
  const isRunning = message.status === "running";
  const isFailed = message.status === "failed";

  return (
    <Message align="start" data-group-message-id={message.id}>
      <MessageAvatar className="bg-transparent">
        <BotAvatar
          agentId={botId}
          decorative
          name={botName}
          size={32}
          working={isRunning}
        />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className="flex-wrap gap-1.5 px-1">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              botTone,
            )}
          >
            {botName}
          </span>
          {answeredByName ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {`代答 · ${answeredByName}`}
            </span>
          ) : null}
          <StatusBadge status={message.status} />
          {isGoalDeliverable ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
              data-goal-deliverable="true"
            >
              <IconTarget className="size-3" />
              {"目标结论"}
            </span>
          ) : null}
        </MessageHeader>
        <Bubble align="start" variant={isFailed ? "destructive" : "secondary"}>
          <BubbleContent
            className={cn(
              isGoalDeliverable &&
                "border-emerald-500/45 ring-1 ring-emerald-500/20 dark:border-emerald-400/40 dark:ring-emerald-400/20",
            )}
            data-goal-deliverable-card={isGoalDeliverable ? "true" : undefined}
          >
            {isRunning && !message.text ? (
              <p className="text-muted-foreground italic">
                {"正在思考并组织回复…"}
              </p>
            ) : (
              <MentionHighlightedText
                botIndexMap={botIndexMap}
                bots={bots}
                text={message.text}
              />
            )}
            {isWaiting && message.reason ? (
              <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
                {message.reason}
              </p>
            ) : null}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="gap-2 px-1">
          <span>{timestamp}</span>
          {isGoalDeliverable ? (
            <CopyButton
              aria-label="复制结论"
              size="xs"
              value={message.text}
              variant="outline"
            >
              {"复制结论"}
            </CopyButton>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
});

type ReconcileState =
  | { kind: "reconciled" }
  | { kind: "unconfirmed"; message: string };

export function GroupChatView({ channel }: GroupChatViewProps) {
  const queryClient = useQueryClient();
  const keptVisible = useKeptVisible();
  const now = useRelativeNow();
  const goalSwitchId = useId();
  const textareaId = useId();
  const mentionListId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingMessageIdRef = useRef<string | null>(null);
  const isComposingRef = useRef(false);

  const [draft, setDraft] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [goalMode, setGoalMode] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<
    number | null
  >(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileState, setReconcileState] = useState<ReconcileState | null>(
    null,
  );
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const wasHiddenRef = useRef(!keptVisible);
  useExternalConnection(keptVisible ? `group-vis:${channel.id}` : false, () => {
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      void queryClient.invalidateQueries({
        queryKey: groupDetailQueryOptions(channel.id).queryKey,
      });
    }
    return () => {
      wasHiddenRef.current = true;
    };
  });

  const groupQuery = useQuery({
    ...groupDetailQueryOptions(channel.id),
    refetchInterval: (query) => {
      if (!keptVisible) return false;
      if (query.state.status === "error") return false;
      const active = query.state.data?.messages.some(
        (msg) => msg.status === "queued" || msg.status === "running",
      );
      return active ? 1000 : 4000;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: keptVisible,
  });

  const sendMutation = useMutation(
    sendGroupMessageMutationOptions(queryClient),
  );

  const bots: GroupBotMember[] = useMemo(() => {
    if (groupQuery.data?.bots && groupQuery.data.bots.length > 0) {
      return groupQuery.data.bots;
    }
    return channel.agentIds.map((id) => ({ id, name: id }));
  }, [groupQuery.data?.bots, channel.agentIds]);

  const botNameMap = useMemo(
    () => new Map(bots.map((bot) => [bot.id, bot.name])),
    [bots],
  );
  const botIndexMap = useMemo(
    () => new Map(bots.map((bot, index) => [bot.id, index])),
    [bots],
  );

  const messages = groupQuery.data?.messages ?? [];

  const goalDeliverableIds = useMemo(
    () => detectGoalDeliverableIds(messages),
    [messages],
  );

  const runningBotIds = useMemo(() => {
    const running = new Set<string>();
    for (const msg of messages) {
      if (
        msg.agentId &&
        (msg.status === "running" || msg.status === "queued")
      ) {
        running.add(msg.agentId);
      }
    }
    return running;
  }, [messages]);

  const trailingMention = useMemo(
    () => detectTrailingMention(draft, cursorPos),
    [draft, cursorPos],
  );

  const mentionCandidates = useMemo(() => {
    if (!trailingMention) return [];
    if (dismissedMentionStart === trailingMention.start) return [];
    const query = trailingMention.query.normalize("NFC").toLowerCase();
    if (!query) return bots;
    const startsWith: GroupBotMember[] = [];
    const includes: GroupBotMember[] = [];
    for (const bot of bots) {
      const normalized = bot.name.normalize("NFC").toLowerCase();
      if (normalized.startsWith(query)) startsWith.push(bot);
      else if (normalized.includes(query)) includes.push(bot);
    }
    return [...startsWith, ...includes];
  }, [bots, dismissedMentionStart, trailingMention]);

  const isMentionMenuOpen =
    mentionCandidates.length > 0 && channel.active !== false;
  const safeMentionIndex =
    mentionCandidates.length > 0
      ? Math.min(activeMentionIndex, mentionCandidates.length - 1)
      : 0;

  const updateDraftAndCursor = useCallback(
    (nextDraft: string, nextCursor: number) => {
      setDraft(nextDraft);
      setCursorPos(nextCursor);
      if (!nextDraft.trim()) {
        pendingMessageIdRef.current = null;
        setReconcileState(null);
      } else {
        setReconcileState((prev) =>
          prev?.kind === "reconciled" ? null : prev,
        );
      }
      const nextMatch = detectTrailingMention(nextDraft, nextCursor);
      setDismissedMentionStart((prev) =>
        nextMatch && prev === nextMatch.start ? prev : null,
      );
      setActiveMentionIndex(0);
    },
    [],
  );

  const handleInsertMention = (botName: string) => {
    const nextDraft = insertBotMention(draft, botName);
    updateDraftAndCursor(nextDraft, nextDraft.length);
    textareaRef.current?.focus();
  };

  const handleSelectMentionCandidate = (bot: GroupBotMember) => {
    const completed = applyMentionCompletion(draft, cursorPos, bot.name);
    updateDraftAndCursor(completed.text, completed.cursor);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(completed.cursor, completed.cursor);
      }
    });
  };

  const handleExportMarkdown = async () => {
    if (messages.length === 0) return;
    const title = channel.name || "多 Bot 群聊";
    const markdown = formatGroupTranscriptMarkdown(title, messages, botNameMap);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
        setExportNotice("已复制 Markdown 到剪贴板");
        toast.success("已复制 Markdown 到剪贴板");
        return;
      }
    } catch {
      // Fallback to file download when clipboard permission is unavailable.
    }
    const safeName = title.replace(/[\\/:*?"<>|]/g, "-").trim() || "group-chat";
    downloadMarkdownFile(`${safeName}.md`, markdown);
    setExportNotice("已导出 Markdown 文件");
    toast.success("已导出 Markdown 文件");
  };

  const canSend =
    channel.active !== false &&
    draft.trim().length > 0 &&
    !sendMutation.isPending &&
    !isReconciling;

  const submitMessage = () => {
    if (!canSend) return;
    if (!pendingMessageIdRef.current) {
      pendingMessageIdRef.current = newId();
    }
    const messageId = pendingMessageIdRef.current;
    setReconcileState(null);

    sendMutation.mutate(
      {
        channelId: channel.id,
        id: messageId,
        text: draft,
        goalMode,
      },
      {
        onSuccess: () => {
          pendingMessageIdRef.current = null;
          setDraft("");
          setCursorPos(0);
          setDismissedMentionStart(null);
          setActiveMentionIndex(0);
          setReconcileState(null);
        },
        onError: async (error) => {
          setIsReconciling(true);
          try {
            const refetched = await groupQuery.refetch();
            const landed =
              refetched.data?.messages.some((msg) => msg.id === messageId) ??
              false;
            if (landed) {
              pendingMessageIdRef.current = null;
              setDraft("");
              setCursorPos(0);
              setDismissedMentionStart(null);
              setActiveMentionIndex(0);
              sendMutation.reset();
              setReconcileState({ kind: "reconciled" });
            } else {
              setReconcileState({
                kind: "unconfirmed",
                message: error.message,
              });
            }
          } finally {
            setIsReconciling(false);
          }
        },
      },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitMessage();
  };

  const handleSelectCursor = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const nextCursor =
      event.currentTarget.selectionStart ?? event.currentTarget.value.length;
    setCursorPos(nextCursor);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.nativeEvent.isComposing ||
      isComposingRef.current ||
      event.keyCode === 229
    ) {
      return;
    }

    if (isMentionMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveMentionIndex(
          (prev) =>
            (prev - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (
        (event.key === "Enter" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey) ||
        event.key === "Tab"
      ) {
        event.preventDefault();
        const picked = mentionCandidates[safeMentionIndex];
        if (picked) {
          handleSelectMentionCandidate(picked);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (trailingMention) {
          setDismissedMentionStart(trailingMention.start);
        }
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  };

  const peopleCount = groupQuery.data?.people.length ?? 0;

  return (
    <section
      aria-label={channel.name || "多 Bot 群聊"}
      className="mx-auto flex h-full min-h-0 w-full max-w-[920px] flex-col gap-3 p-4"
      data-group-chat-channel={channel.id}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line-strong)] bg-[var(--glass-1)] px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">
              {channel.name || "多 Bot 群聊"}
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              <IconUsers className="size-3.5" />
              {`${bots.length} Bot · ${peopleCount} 成员`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {bots.map((bot, index) => {
              const isBusy = runningBotIds.has(bot.id);
              const tone = BOT_BADGE_TONES[index % BOT_BADGE_TONES.length];
              return (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
                    tone,
                  )}
                  key={bot.id}
                >
                  <BotAvatar
                    agentId={bot.id}
                    decorative
                    name={bot.name}
                    size={18}
                    working={isBusy}
                  />
                  <span>{bot.name}</span>
                  {isBusy ? (
                    <span className="inline-flex items-center">
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-current animate-pulse"
                      />
                      <span className="sr-only">{`${bot.name} 正在处理`}</span>
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {exportNotice ? (
            <span className="text-xs text-muted-foreground" role="status">
              {exportNotice}
            </span>
          ) : null}
          <Button
            aria-label="导出 Markdown"
            disabled={messages.length === 0}
            onClick={() => void handleExportMarkdown()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconDownload />
            {"导出 Markdown"}
          </Button>
          <Button
            aria-label="刷新群聊消息"
            loading={groupQuery.isFetching}
            onClick={() => void groupQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh />
            {"刷新"}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--line-strong)] bg-[var(--glass-1)] p-4">
        {groupQuery.isPending ? (
          <PageSkeleton rows={4} />
        ) : groupQuery.error ? (
          <ErrorCard
            action={
              <Button
                className="mt-2"
                onClick={() => void groupQuery.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                {"重试"}
              </Button>
            }
            description={groupQuery.error.message}
            title="无法加载群聊内容"
          />
        ) : messages.length === 0 ? (
          <EmptyState
            description="点击下方 @Bot 按钮指定成员，或开启 /goal 收敛模式让多位 Bot 协同得出最终结论。"
            title="还没有群聊记录"
          />
        ) : (
          messages.map((message) => (
            <GroupMessageRow
              botIndexMap={botIndexMap}
              botNameMap={botNameMap}
              bots={bots}
              isGoalDeliverable={goalDeliverableIds.has(message.id)}
              key={message.id}
              message={message}
              now={now}
            />
          ))
        )}
      </div>

      <form
        className="relative flex flex-col gap-2.5 rounded-2xl border border-[var(--line-strong)] bg-[var(--glass-2)] p-3"
        onSubmit={handleSubmit}
      >
        {isMentionMenuOpen ? (
          <div
            aria-label="成员点名补全"
            className="absolute bottom-full left-0 right-0 z-20 mb-2 flex max-h-52 flex-col gap-1 overflow-y-auto rounded-xl border border-[var(--line-strong)] p-1.5 shadow-[var(--shadow-3)]"
            data-mention-popover="true"
            data-surface="control"
            id={mentionListId}
            role="listbox"
          >
            {mentionCandidates.map((bot, index) => {
              const selected = index === safeMentionIndex;
              const toneIndex = botIndexMap.get(bot.id) ?? 0;
              const tone = BOT_BADGE_TONES[toneIndex % BOT_BADGE_TONES.length];
              return (
                <button
                  aria-selected={selected}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                    selected
                      ? "bg-primary/12 text-foreground"
                      : "text-foreground/85 hover:bg-muted/70",
                  )}
                  data-mention-option={bot.id}
                  id={`${mentionListId}-${bot.id}`}
                  key={bot.id}
                  onClick={() => handleSelectMentionCandidate(bot)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveMentionIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <BotAvatar
                      agentId={bot.id}
                      decorative
                      name={bot.name}
                      size={18}
                    />
                    <span className="truncate font-medium">{`@${bot.name}`}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]",
                      tone,
                    )}
                  >
                    {bot.id}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <IconAt className="size-3.5" />
              {"点名:"}
            </span>
            {bots.map((bot) => (
              <Button
                className="h-7 px-2.5 text-xs"
                key={bot.id}
                onClick={() => handleInsertMention(bot.name)}
                size="xs"
                type="button"
                variant="outline"
              >
                <BotAvatar
                  agentId={bot.id}
                  decorative
                  name={bot.name}
                  size={16}
                />
                {`@${bot.name}`}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={goalMode}
              id={goalSwitchId}
              onCheckedChange={setGoalMode}
              size="sm"
            />
            <Label
              className="cursor-pointer text-xs text-foreground"
              htmlFor={goalSwitchId}
            >
              <IconTarget className="size-3.5 text-primary" />
              {"/goal 收敛模式"}
            </Label>
          </div>
        </div>

        {goalMode ? (
          <p className="rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
            {
              "目标收敛模式已开启：发送时将自动附带 /goal，Bot 在有限跳数内推进并在得出结论后直接总结，不再互 @。"
            }
          </p>
        ) : null}

        {channel.active === false ? (
          <p className="text-xs text-muted-foreground" role="status">
            {"此群聊中部分 Bot 已停用或删除，当前仅可查看历史记录。"}
          </p>
        ) : null}

        {isReconciling ? (
          <p className="text-xs text-muted-foreground" role="status">
            {"发送响应异常，正在与服务端对账确认消息状态…"}
          </p>
        ) : reconcileState?.kind === "reconciled" ? (
          <p
            className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300"
            role="status"
          >
            {"刚才的发送已确认入库，无需重复发送。"}
          </p>
        ) : reconcileState?.kind === "unconfirmed" ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200"
            role="alert"
          >
            <span>{reconcileState.message}</span>
            <Button
              disabled={!canSend}
              onClick={submitMessage}
              size="xs"
              type="button"
              variant="outline"
            >
              {"可能未送达 · 点此安全重试"}
            </Button>
          </div>
        ) : sendMutation.error ? (
          <p className="text-xs text-destructive" role="alert">
            {sendMutation.error.message}
          </p>
        ) : null}

        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor={textareaId}>
            {"群聊消息输入框"}
          </label>
          <Textarea
            aria-activedescendant={
              isMentionMenuOpen && mentionCandidates[safeMentionIndex]
                ? `${mentionListId}-${mentionCandidates[safeMentionIndex].id}`
                : undefined
            }
            aria-autocomplete={isMentionMenuOpen ? "list" : undefined}
            aria-controls={isMentionMenuOpen ? mentionListId : undefined}
            aria-expanded={isMentionMenuOpen}
            className="min-h-[56px] flex-1 resize-none bg-background/60"
            disabled={
              channel.active === false ||
              sendMutation.isPending ||
              isReconciling
            }
            id={textareaId}
            onChange={(event) => {
              const nextValue = event.target.value;
              const rawSelection = event.target.selectionStart;
              const nextCursor =
                rawSelection === null ||
                rawSelection === undefined ||
                (rawSelection === 0 &&
                  document.activeElement !== event.target &&
                  nextValue.length > 0)
                  ? nextValue.length
                  : rawSelection;
              updateDraftAndCursor(nextValue, nextCursor);
            }}
            onClick={handleSelectCursor}
            onCompositionEnd={(event) => {
              isComposingRef.current = false;
              updateDraftAndCursor(
                event.currentTarget.value,
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            onSelect={handleSelectCursor}
            placeholder={
              goalMode
                ? "输入需要群内 Bot 协同收敛的目标（自动附带 /goal）…"
                : "输入消息，使用 @BotName 点名或直接发送给所有群成员（Enter 发送）…"
            }
            ref={textareaRef}
            rows={2}
            value={draft}
          />
          <Button
            disabled={!canSend}
            loading={sendMutation.isPending || isReconciling}
            type="submit"
          >
            <IconSend />
            {"发送"}
          </Button>
        </div>
      </form>
    </section>
  );
}
