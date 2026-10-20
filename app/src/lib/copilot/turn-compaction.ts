import { useEffect, useState } from "react";
import { readSentAt, type SentAtReading } from "@/lib/chat/send-scroll";

/**
 * 服务器记下的两类「一轮」信息（频道聊天读，chat-transcript.tsx 的 compactTurns 画）：
 * 用户停掉的轮次（「◼ 已停止」）和换了备用模型的轮次（§61）。一轮收成「开场一句 → 结果」的规则在 compactTurns。
 * 以前这里还有给 `/bot`（CopilotChat）DOM 打标记的 useTurnCompaction，随 `/bot` 删了（CB-046，§68）。
 */

/** 这条会话里被用户停掉的轮次（用开启那一轮的用户消息 id 记），服务器记下的。 */
export function useStoppedTurnIds(threadId: string | null | undefined): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const load = () =>
      fetch(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/stopped`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { userMessageIds: [] }))
        .then((body: { userMessageIds?: string[] }) => {
          if (alive) setIds(new Set(body.userMessageIds ?? []));
        })
        .catch(() => {});
    void load();
    const onRunning = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail === false) setTimeout(load, 1500);
    };
    window.addEventListener("chisabot-chat-running", onRunning);
    return () => {
      alive = false;
      window.removeEventListener("chisabot-chat-running", onRunning);
    };
  }, [threadId]);
  return ids;
}

/**
 * 换过备用模型的轮次（DESIGN.md §61）：用户消息 id → 「主模型额度用完，已改用 X」。
 * 服务器从这一轮的 RUN_FINISHED 读出来；每轮结束后 1.5 秒重读一次（同「已停止」）。
 */
export function useFallbackTurns(threadId: string | null | undefined): Map<string, string> {
  const [turns, setTurns] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    setTurns(new Map());
    if (!threadId) return;
    let alive = true;
    const load = () =>
      fetch(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/fallbacks`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { turns: [] }))
        .then((body: { turns?: { userMessageId?: string; notice?: string }[] }) => {
          if (!alive) return;
          const next = new Map<string, string>();
          for (const turn of body.turns ?? []) if (turn.userMessageId && turn.notice) next.set(turn.userMessageId, turn.notice);
          setTurns((previous) => (sameMap(previous, next) ? previous : next));
        })
        .catch(() => {});
    void load();
    const onRunning = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail === false) setTimeout(load, 1500);
    };
    window.addEventListener("chisabot-chat-running", onRunning);
    return () => {
      alive = false;
      window.removeEventListener("chisabot-chat-running", onRunning);
    };
  }, [threadId]);
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
export function useLastSentAt(threadId: string | null | undefined): SentAtReading | null {
  const [reading, setReading] = useState<SentAtReading | null>(null);
  useEffect(() => {
    setReading(null);
    if (!threadId) return;
    let alive = true;
    const load = () =>
      fetch(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/sent-at`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: unknown) => {
          if (!alive) return;
          const next = readSentAt(body, Date.now());
          if (next) setReading((previous) => (previous && previous.userMessageId === next.userMessageId && Math.abs(previous.at - next.at) < 1000 ? previous : next));
        })
        .catch(() => {});
    void load();
    const onRunning = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail === false) setTimeout(load, 1500);
    };
    window.addEventListener("chisabot-chat-running", onRunning);
    return () => {
      alive = false;
      window.removeEventListener("chisabot-chat-running", onRunning);
    };
  }, [threadId]);
  return reading;
}
