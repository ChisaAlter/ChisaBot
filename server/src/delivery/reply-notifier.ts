import {
  buildChannelDeepLink,
  DEFAULT_NOTIFICATION_FREQUENCY,
  type NotificationFrequency,
  type NotificationKind,
  type ReplyNotificationEvent,
  shouldNotifyReply,
  truncateNotificationText,
} from "../../../shared/notifications";
import type { ForegroundRegistry } from "./foreground-registry";
import type { PushDeliveryOutcome, PushService } from "./push-service";

/** 单 Bot（按 userId:agentId 隔离）保留的已见消息 ID 上限，防内存无限增长。 */
export const MAX_SEEN_MESSAGES_PER_BOT = 256;

/** 冷启动尚未完成 `seedBaseline` 时的最大事件缓冲数。 */
const MAX_PENDING_BEFORE_SEED = 512;

export type ReplyBaselineEntry = {
  userId: string;
  agentId: string;
  messageId: string;
};

export type ReplyNotifierInput = {
  userId: string;
  channelId: string;
  agentId: string;
  agentName?: string;
  messageId: string;
  text: string;
  kind: NotificationKind;
  createdAt?: string;
};

export type ReplyNotifyVerdict =
  | { verdict: "deferred" }
  | { verdict: "duplicate" }
  | { verdict: "muted" }
  | { verdict: "foreground-suppressed" }
  | { verdict: "frequency-filtered" }
  | {
      verdict: "delivered";
      event: ReplyNotificationEvent;
      pushOutcomes: PushDeliveryOutcome[];
    };

export type ReplyNotifierOptions = {
  foregroundRegistry: Pick<ForegroundRegistry, "isChannelForeground">;
  getFrequency?: (userId: string) => Promise<NotificationFrequency>;
  resolveAgentName?: (
    userId: string,
    agentId: string,
  ) => Promise<string | null>;
  pushService?: Pick<PushService, "sendToUser">;
  onInAppNotification?: (
    userId: string,
    event: ReplyNotificationEvent,
  ) => void | Promise<void>;
  now?: () => number;
};

export function createReplyNotifier(options: ReplyNotifierOptions) {
  const clock = options.now ?? (() => Date.now());
  const seenByBot = new Map<string, Set<string>>();
  const listenersByUser = new Map<
    string,
    Set<(event: ReplyNotificationEvent) => void>
  >();
  const pending: ReplyNotifierInput[] = [];
  let seeded = false;

  function botKey(userId: string, agentId: string): string {
    return `${userId}:${agentId}`;
  }

  function dedupeToken(kind: NotificationKind, messageId: string): string {
    return kind === "needs-input" ? `needs-input:${messageId}` : messageId;
  }

  function hasSeen(userId: string, agentId: string, token: string): boolean {
    return seenByBot.get(botKey(userId, agentId))?.has(token) ?? false;
  }

  function recordSeen(userId: string, agentId: string, token: string): boolean {
    const key = botKey(userId, agentId);
    let history = seenByBot.get(key);
    if (!history) {
      history = new Set<string>();
      seenByBot.set(key, history);
    }
    if (history.has(token)) return false;
    history.add(token);
    if (history.size > MAX_SEEN_MESSAGES_PER_BOT) {
      const oldest = history.values().next().value;
      if (oldest !== undefined) history.delete(oldest);
    }
    return true;
  }

  async function processEvent(
    input: ReplyNotifierInput,
  ): Promise<ReplyNotifyVerdict> {
    const token = dedupeToken(input.kind, input.messageId);
    if (hasSeen(input.userId, input.agentId, token)) {
      return { verdict: "duplicate" };
    }

    let frequency: NotificationFrequency = DEFAULT_NOTIFICATION_FREQUENCY;
    if (options.getFrequency) {
      try {
        frequency = await options.getFrequency(input.userId);
      } catch {
        frequency = DEFAULT_NOTIFICATION_FREQUENCY;
      }
    }

    const nowMs = clock();
    const channelForeground = options.foregroundRegistry.isChannelForeground(
      input.userId,
      input.channelId,
      nowMs,
    );

    if (
      !shouldNotifyReply({
        frequency,
        kind: input.kind,
        channelForeground,
      })
    ) {
      if (frequency === "muted") return { verdict: "muted" };
      if (channelForeground) return { verdict: "foreground-suppressed" };
      return { verdict: "frequency-filtered" };
    }

    // 仅在通过频率与前台校验、准备实际派发前同步占坑：
    // 1. 避免 task-complete 模式下先到的 kind="reply" 占坑吞掉同 messageId 的 kind="task-complete"；
    // 2. 同时阻断并发同 messageId 跨过 await getFrequency 后产生双发。
    if (!recordSeen(input.userId, input.agentId, token)) {
      return { verdict: "duplicate" };
    }

    let agentName = input.agentName?.trim() || "";
    if (!agentName && options.resolveAgentName) {
      try {
        agentName =
          (
            await options.resolveAgentName(input.userId, input.agentId)
          )?.trim() || "";
      } catch {
        agentName = "";
      }
    }
    if (!agentName) agentName = "ChisaBot";

    const preview =
      truncateNotificationText(input.text, 140) ||
      (input.kind === "needs-input"
        ? "需要你的回复或批准。"
        : "收到一条新回复。");
    const deepLink = buildChannelDeepLink(input.channelId, input.agentId);
    const createdAt = input.createdAt ?? new Date(nowMs).toISOString();
    const event: ReplyNotificationEvent = {
      id: `${input.kind}:${input.agentId}:${input.messageId}`,
      kind: input.kind,
      channelId: input.channelId,
      agentId: input.agentId,
      agentName,
      preview,
      deepLink,
      createdAt,
    };

    try {
      await options.onInAppNotification?.(input.userId, event);
    } catch {
      // 站内派发异常不影响移动推送
    }

    for (const listener of listenersByUser.get(input.userId) ?? []) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不阻断其他订阅者
      }
    }

    let pushOutcomes: PushDeliveryOutcome[] = [];
    if (options.pushService) {
      const title =
        input.kind === "needs-input" ? `${agentName} · 需要你处理` : agentName;
      try {
        pushOutcomes = await options.pushService.sendToUser(input.userId, {
          id: event.id,
          title,
          body: preview,
          channelId: input.channelId,
          agentId: input.agentId,
          deepLink,
          kind: input.kind,
        });
      } catch {
        pushOutcomes = [];
      }
    }

    return {
      verdict: "delivered",
      event,
      pushOutcomes,
    };
  }

  /**
   * 写入启动基线（已存在的历史消息 ID），防止服务重启后对旧对话产生重发风暴。
   * 调用后立即回放启动阶段缓冲的新事件。
   */
  async function seedBaseline(
    entries: readonly ReplyBaselineEntry[],
  ): Promise<ReplyNotifyVerdict[]> {
    for (const entry of entries) {
      if (!entry.userId || !entry.agentId || !entry.messageId) continue;
      recordSeen(entry.userId, entry.agentId, entry.messageId);
    }
    seeded = true;
    const queued = pending.splice(0);
    const results: ReplyNotifyVerdict[] = [];
    for (const item of queued) {
      results.push(await processEvent(item));
    }
    return results;
  }

  async function notifyReply(
    input: ReplyNotifierInput,
  ): Promise<ReplyNotifyVerdict> {
    if (!seeded) {
      if (pending.length < MAX_PENDING_BEFORE_SEED) {
        pending.push(input);
      }
      return { verdict: "deferred" };
    }
    return processEvent(input);
  }

  function subscribe(
    userId: string,
    listener: (event: ReplyNotificationEvent) => void,
  ): () => void {
    let set = listenersByUser.get(userId);
    if (!set) {
      set = new Set();
      listenersByUser.set(userId, set);
    }
    set.add(listener);
    return () => {
      const current = listenersByUser.get(userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listenersByUser.delete(userId);
    };
  }

  function forgetBot(userId: string, agentId: string): void {
    seenByBot.delete(botKey(userId, agentId));
  }

  function isSeeded(): boolean {
    return seeded;
  }

  return {
    seedBaseline,
    notifyReply,
    subscribe,
    forgetBot,
    isSeeded,
  };
}

export type ReplyNotifier = ReturnType<typeof createReplyNotifier>;
