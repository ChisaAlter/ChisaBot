import { useState } from "react";
import { useExternalConnection } from "@/hooks";
import { readSentAt, type SentAtReading } from "@/lib/chat/send-scroll";
import { tryClient } from "@/lib/client";
import { useKeptVisibility } from "@/lib/kept-visible";

type ChatRunningDetail =
  | boolean
  | { running?: boolean; threadId?: string | null };

function shouldRefreshForRunningEvent(
  detail: ChatRunningDetail,
  threadId: string,
): boolean {
  if (typeof detail === "boolean") return detail === false;
  if (!detail || typeof detail !== "object") return false;
  if (detail.running !== false) return false;
  if (detail.threadId && detail.threadId !== threadId) return false;
  return true;
}

/**
 * 服务器记下的两类「一轮」信息（频道聊天读，chat-transcript.tsx 的 compactTurns 画）：
 * 用户停掉的轮次（「◼ 已停止」）和换了备用模型的轮次（§61）。一轮收成「开场一句 → 结果」的规则在 compactTurns。
 * 以前这里还有给 `/bot`（旧聊天界面）DOM 打标记的 useTurnCompaction，随 `/bot` 删了（CB-046，§68）。
 */

function useTurnEndpoint(
  threadId: string | null | undefined,
  load: (id: string, signal: AbortSignal) => Promise<void>,
  reset: () => void,
) {
  // 用非重渲可见性订阅，避免切进/切出 KeepAlive 引起 ChannelChat 重画；
  // 隐藏频道收到全局 chisabot-chat-running 时不立刻发 3 个请求，等切回可见再补偿一次。
  const visibility = useKeptVisibility();
  useExternalConnection(threadId ? `t:${threadId}` : "none", (_key, signal) => {
    reset();
    if (!threadId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingWhileHidden = false;
    const run = () => {
      void load(threadId, signal);
    };
    run();
    const onRunning = (event: Event) => {
      const detail = (event as CustomEvent<ChatRunningDetail>).detail;
      if (!shouldRefreshForRunningEvent(detail, threadId)) return;
      if (!visibility.get()) {
        pendingWhileHidden = true;
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(run, 1500);
    };
    const unsubscribeVisibility = visibility.subscribe(() => {
      if (visibility.get() && pendingWhileHidden) {
        pendingWhileHidden = false;
        clearTimeout(timer);
        timer = undefined;
        run();
      }
    });
    window.addEventListener("chisabot-chat-running", onRunning);
    return () => {
      clearTimeout(timer);
      unsubscribeVisibility();
      window.removeEventListener("chisabot-chat-running", onRunning);
    };
  });
}

/** 这条会话里被用户停掉的轮次（用开启那一轮的用户消息 id 记），服务器记下的。 */
export function useStoppedTurnIds(
  threadId: string | null | undefined,
): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useTurnEndpoint(
    threadId,
    (id, signal) =>
      tryClient(
        `/api/conversations/threads/${encodeURIComponent(id)}/stopped`,
      )
        .then((r) => (r.ok ? r.json() : { userMessageIds: [] }))
        .then((body: { userMessageIds?: string[] }) => {
          if (signal.aborted) return;
          const next = new Set(body.userMessageIds ?? []);
          setIds((previous) => (sameSet(previous, next) ? previous : next));
        })
        .catch(() => {}),
    () => setIds((previous) => (previous.size === 0 ? previous : new Set())),
  );
  return ids;
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/**
 * 换过备用模型的轮次（DESIGN.md §61）：用户消息 id → 「主模型额度用完，已改用 X」。
 * 服务器从这一轮的 RUN_FINISHED 读出来；每轮结束后 1.5 秒重读一次（同「已停止」）。
 */
export function useFallbackTurns(
  threadId: string | null | undefined,
): Map<string, string> {
  const [turns, setTurns] = useState<Map<string, string>>(() => new Map());
  useTurnEndpoint(
    threadId,
    (id, signal) =>
      tryClient(
        `/api/conversations/threads/${encodeURIComponent(id)}/fallbacks`,
      )
        .then((r) => (r.ok ? r.json() : { turns: [] }))
        .then(
          (body: { turns?: { userMessageId?: string; notice?: string }[] }) => {
            if (signal.aborted) return;
            const next = new Map<string, string>();
            for (const turn of body.turns ?? [])
              if (turn.userMessageId && turn.notice)
                next.set(turn.userMessageId, turn.notice);
            setTurns((previous) => (sameMap(previous, next) ? previous : next));
          },
        )
        .catch(() => {}),
    () => setTurns((previous) => (previous.size === 0 ? previous : new Map())),
  );
  return turns;
}

function sameMap(a: Map<string, string>, b: Map<string, string>) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * 最新一条用户消息的服务器发送时刻（换算到本机时钟，DESIGN.md §94）：打开时读一次，每轮结束后 1.5 秒再读
 * （同「已停止」）。决定下一条发出去时要不要翻页对齐（30 分钟内连续聊天不翻；回答中补话也算连续，§94.7）。读不到为 null，由本机时刻兜底。
 */
export function useLastSentAt(
  threadId: string | null | undefined,
): SentAtReading | null {
  const [reading, setReading] = useState<SentAtReading | null>(null);
  useTurnEndpoint(
    threadId,
    (id, signal) =>
      tryClient(
        `/api/conversations/threads/${encodeURIComponent(id)}/sent-at`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((body: unknown) => {
          if (signal.aborted) return;
          const next = readSentAt(body, Date.now());
          if (next)
            setReading((previous) =>
              previous &&
              previous.userMessageId === next.userMessageId &&
              Math.abs(previous.at - next.at) < 1000
                ? previous
                : next,
            );
        })
        .catch(() => {}),
    () => setReading(null),
  );
  return reading;
}
