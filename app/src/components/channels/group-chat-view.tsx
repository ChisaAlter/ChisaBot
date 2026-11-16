import {
  IconAt,
  IconRefresh,
  IconSend,
  IconTarget,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
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
import {
  type GroupBotMember,
  type GroupMessageStatus,
  type GroupTranscriptMessage,
  groupDetailQueryOptions,
  insertBotMention,
  sendGroupMessageMutationOptions,
} from "@/lib/channels/group-api";
import type { AgentChannel } from "@/lib/channels/queries";
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

function GroupMessageRow({
  message,
  botIndexMap,
  botNameMap,
  now,
}: {
  message: GroupTranscriptMessage;
  botIndexMap: ReadonlyMap<string, number>;
  botNameMap: ReadonlyMap<string, string>;
  now: number;
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
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
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
        </MessageHeader>
        <Bubble align="start" variant={isFailed ? "destructive" : "secondary"}>
          <BubbleContent>
            {isRunning && !message.text ? (
              <p className="text-muted-foreground italic">
                {"正在思考并组织回复…"}
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            )}
            {isWaiting && message.reason ? (
              <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
                {message.reason}
              </p>
            ) : null}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="px-1">
          <span>{timestamp}</span>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

export function GroupChatView({ channel }: GroupChatViewProps) {
  const queryClient = useQueryClient();
  const now = useRelativeNow();
  const goalSwitchId = useId();
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState("");
  const [goalMode, setGoalMode] = useState(false);

  const groupQuery = useQuery({
    ...groupDetailQueryOptions(channel.id),
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const active = query.state.data?.messages.some(
        (msg) => msg.status === "queued" || msg.status === "running",
      );
      return active ? 1000 : 4000;
    },
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

  const runningBotIds = useMemo(() => {
    const running = new Set<string>();
    for (const msg of groupQuery.data?.messages ?? []) {
      if (
        msg.agentId &&
        (msg.status === "running" || msg.status === "queued")
      ) {
        running.add(msg.agentId);
      }
    }
    return running;
  }, [groupQuery.data?.messages]);

  const handleInsertMention = (botName: string) => {
    setDraft((prev) => insertBotMention(prev, botName));
    textareaRef.current?.focus();
  };

  const canSend =
    channel.active !== false &&
    draft.trim().length > 0 &&
    !sendMutation.isPending;

  const submitMessage = () => {
    if (!canSend) return;
    sendMutation.mutate(
      {
        channelId: channel.id,
        id: newId(),
        text: draft,
        goalMode,
      },
      {
        onSuccess: () => {
          setDraft("");
        },
      },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
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
        ) : groupQuery.data.messages.length === 0 ? (
          <EmptyState
            description="点击下方 @Bot 按钮指定成员，或开启 /goal 收敛模式让多位 Bot 协同得出最终结论。"
            title="还没有群聊记录"
          />
        ) : (
          groupQuery.data.messages.map((message) => (
            <GroupMessageRow
              botIndexMap={botIndexMap}
              botNameMap={botNameMap}
              key={message.id}
              message={message}
              now={now}
            />
          ))
        )}
      </div>

      <form
        className="flex flex-col gap-2.5 rounded-2xl border border-[var(--line-strong)] bg-[var(--glass-2)] p-3"
        onSubmit={handleSubmit}
      >
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

        {sendMutation.error ? (
          <p className="text-xs text-destructive" role="alert">
            {sendMutation.error.message}
          </p>
        ) : null}

        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor={textareaId}>
            {"群聊消息输入框"}
          </label>
          <Textarea
            className="min-h-[56px] flex-1 resize-none bg-background/60"
            disabled={channel.active === false || sendMutation.isPending}
            id={textareaId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
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
            loading={sendMutation.isPending}
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
