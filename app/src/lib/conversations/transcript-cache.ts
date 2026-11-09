import type { Message } from "@ag-ui/core";
import { readThreadMessages } from "@/lib/conversations/thread-messages";

/**
 * 打开对话 / 切换机器人时先画的那一份（DESIGN.md §83）。
 *
 * 只用来「先画出来」，不是第二份对话：对话打开后照旧由运行中的 agent 接入、读存储、合并，读完就换成
 * agent 手里那份。这里存的是上一次在这台设备上看到的样子（离开对话时记下），或者预取时从存储读到的。
 * 切回一个刚看过的机器人时，聊天区第一帧就是它停在底部的样子，而不是空白 → 骨架 → 一条条长出来。
 *
 * 只放在内存里（刷新就没了），最多记 MAX 段对话。
 */
const MAX = 12;
/** 预取的结果多久之内算新的；更旧的照样拿来先画，只是会再预取一次。 */
const FRESH_MS = 30_000;

type Entry = { messages: readonly Message[]; at: number };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

/** 这段对话上次看到的样子；没有就是 null。 */
export function cachedTranscript(threadId: string): readonly Message[] | null {
  const hit = cache.get(threadId);
  if (!hit) return null;
  // 最近用过的排到最后（LRU）。
  cache.delete(threadId);
  cache.set(threadId, hit);
  return hit.messages;
}

/** 记下这段对话现在的样子（空的不记：空白不比骨架好）。 */
export function rememberTranscript(threadId: string, messages: readonly Message[]): void {
  if (!threadId || messages.length === 0) return;
  cache.delete(threadId);
  cache.set(threadId, { messages: [...messages], at: Date.now() });
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 预取（悬停 / 空闲时）：从存储读一次放进来。已经有新的、或者正在读，就什么都不做。
 * 读不到不报错：只是切过去时先显示骨架。
 */
export function prefetchTranscript(threadId: string, agentId: string): Promise<void> {
  const hit = cache.get(threadId);
  if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve();
  const running = inflight.get(threadId);
  if (running) return running;
  const startedAt = Date.now();
  const read = readThreadMessages(threadId, agentId)
    .then((stored) => {
      // 对话打开期间记下的（离开时）比预取的新：不覆盖。
      const now = cache.get(threadId);
      if (now && now.at > startedAt) return;
      if (stored.availability === "ready") rememberTranscript(threadId, stored.messages);
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(threadId);
    });
  inflight.set(threadId, read);
  return read;
}

/** Tests only. */
export function clearTranscriptCache(): void {
  cache.clear();
  inflight.clear();
}
