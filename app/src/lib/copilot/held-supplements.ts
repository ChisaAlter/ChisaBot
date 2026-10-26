import { useCallback, useEffect, useRef, useState } from "react";

/**
 * CB-104: follow-ups held by Stop are drawn once — as a held item above the composer with
 * 「发送这条 / 全部发送」 — never also as a sent bubble in the transcript (which then had no reply
 * and drew the red 「这一轮没有收到回答」 card). A 「已停止」 anchored on such a follow-up moves to
 * the person's message that opened the stopped turn.
 */
type Row = { id: string; role: string };

export function hideHeldSupplements<T extends Row>(
  messages: readonly T[],
  heldIds: ReadonlySet<string>,
  stops: ReadonlySet<string>,
): { messages: readonly T[]; stops: ReadonlySet<string> } {
  if (
    !heldIds.size ||
    !messages.some(
      (message) => message.role === "user" && heldIds.has(message.id),
    )
  )
    return { messages, stops };
  const visible: T[] = [];
  const nextStops = new Set(stops);
  let lastUser: string | undefined;
  for (const message of messages) {
    if (message.role === "user" && heldIds.has(message.id)) {
      if (nextStops.delete(message.id) && lastUser) nextStops.add(lastUser);
      continue;
    }
    if (message.role === "user") lastUser = message.id;
    visible.push(message);
  }
  return { messages: visible, stops: nextStops };
}

/**
 * Esc stops the running turn from a focused composer (not mid-IME, not already handled). keyCode 229
 * is the IME still processing the key — some browsers report it without `isComposing`.
 */
export function shouldStopOnEscape(event: {
  key: string;
  keyCode?: number;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  running: boolean;
  stopping?: boolean;
}): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    event.running &&
    !event.stopping
  );
}

/**
 * CB-104: the server half of Stop (POST …/unlock → runner.stop). Resolves false on a network error,
 * a timeout or any non-2xx, so the caller can say so instead of quietly flipping back to 「停止」.
 */
export async function requestStop(
  threadId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<boolean> {
  if (!threadId) return false;
  try {
    const response = await fetchImpl(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/unlock`,
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Turn statuses that mean the turn is over, so a failed stop request no longer matters. */
export const ENDED_TURN_STATUSES: ReadonlySet<string> = new Set(["done", "stopped", "error"]);

export type StopRequestTurn = {
  /** Whether this turn is still running; `undefined` while not known yet (never clears). */
  running?: boolean;
  /** This turn's status, when the caller has one (`done` / `stopped` / `error` end it). */
  status?: string | null;
};

/**
 * Send the stop request; `failed` (prompting 「停止失败，重试」) stays true until a retry succeeds or
 * the turn ends: `running` reported false, or `status` entering done / stopped / error. A new turn
 * (`running` false → true) never inherits the previous turn's failure.
 */
export function useStopRequest(threadId: string, fetchImpl?: typeof fetch, turn: StopRequestTurn = {}) {
  const [failed, setFailed] = useState(false);
  const { running, status } = turn;
  const wasRunning = useRef(running);
  const ended = running === false || (status != null && ENDED_TURN_STATUSES.has(status));
  useEffect(() => {
    const startedAgain = running === true && wasRunning.current === false;
    wasRunning.current = running;
    if (ended || startedAgain) setFailed(false);
  }, [ended, running]);
  const send = useCallback(async () => {
    const ok = await requestStop(threadId, fetchImpl ?? fetch);
    setFailed(!ok);
    return ok;
  }, [threadId, fetchImpl]);
  const clear = useCallback(() => setFailed(false), []);
  return { failed: failed && !ended, send, clear };
}
