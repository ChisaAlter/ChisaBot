import type { Message } from "@ag-ui/core";
import { useSyncExternalStore } from "react";

/**
 * 机器人此刻在做什么，给头像的变形用（DESIGN.md §81）。打开着的对话页最清楚：
 * - `working`：有工具调用发出去了还没有结果（工具在跑）。
 * - `thinking`：这一轮在跑，但没有在跑的工具（在想 / 在写回答）。
 * 对话页发布，左栏那一行、资料页读；没有打开对话的机器人由左栏按服务器的 busy 当作 working。
 */
/** `interrupted`：这一轮刚被停止或出错结束（头像不跳「做完了」，直接静止）。 */
export type BotActivity = "thinking" | "working" | "interrupted";

const current = new Map<string, BotActivity>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;
let cachedWorkingIds: readonly string[] = [];

function notifyListeners() {
  snapshotVersion += 1;
  const next: string[] = [];
  for (const [id, status] of current.entries()) {
    if (status === "working" || status === "thinking") {
      next.push(id);
    }
  }
  cachedWorkingIds = next;
  for (const listener of listeners) listener();
}

export function publishBotActivity(
  agentId: string,
  activity: BotActivity | null,
): () => void {
  const before = current.get(agentId) ?? null;
  if (before !== activity) {
    if (activity) current.set(agentId, activity);
    else current.delete(agentId);
    notifyListeners();
  }
  return () => {
    if (current.get(agentId) === activity && activity !== null) {
      current.delete(agentId);
      notifyListeners();
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotActivity(
  agentId: string | undefined,
): BotActivity | null {
  return useSyncExternalStore(
    subscribe,
    () => (agentId ? (current.get(agentId) ?? null) : null),
    () => null,
  );
}

const EMPTY_IDS: readonly string[] = [];

/** 订阅当前所有正在思考或执行工具的 Bot ID 列表（供顶栏 WorkingCrewStrip 使用）。 */
export function useActiveBotIds(): readonly string[] {
  void snapshotVersion;
  return useSyncExternalStore(
    subscribe,
    () => cachedWorkingIds,
    () => EMPTY_IDS,
  );
}

/** 这一轮在跑时：最后一条用户消息之后，有没有发出去还没回结果的工具调用。 */
export function activityOf(
  messages: readonly Message[],
  busy: boolean,
  /** 这一轮是被停止（停止中）或出错（runError）结束的。 */
  interrupted = false,
): BotActivity | null {
  if (!busy) return interrupted ? "interrupted" : null;
  const answered = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role === "tool") {
      answered.add(message.toolCallId);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls)
        if (!answered.has(call.id)) return "working";
    }
  }
  return "thinking";
}
