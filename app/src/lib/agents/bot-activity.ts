import type { Message } from "@ag-ui/core";
import { useSyncExternalStore } from "react";

/**
 * 机器人此刻在做什么，给头像的变形用（DESIGN.md §81）。打开着的对话页最清楚：
 * - `working`：有工具调用发出去了还没有结果（工具在跑）。
 * - `thinking`：这一轮在跑，但没有在跑的工具（在想 / 在写回答）。
 * 对话页发布，左栏那一行、资料页读；没有打开对话的机器人由左栏按服务器的 busy 当作 working。
 */
export type BotActivity = "thinking" | "working";

const current = new Map<string, BotActivity>();
const listeners = new Set<() => void>();

export function publishBotActivity(
  agentId: string,
  activity: BotActivity | null,
): () => void {
  const before = current.get(agentId) ?? null;
  if (before !== activity) {
    if (activity) current.set(agentId, activity);
    else current.delete(agentId);
    for (const listener of listeners) listener();
  }
  return () => {
    if (current.get(agentId) === activity && activity !== null) {
      current.delete(agentId);
      for (const listener of listeners) listener();
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

/** 这一轮在跑时：最后一条用户消息之后，有没有发出去还没回结果的工具调用。 */
export function activityOf(
  messages: readonly Message[],
  busy: boolean,
): BotActivity | null {
  if (!busy) return null;
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
