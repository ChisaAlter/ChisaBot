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

/** Esc stops the running turn from a focused composer (not mid-IME, not already handled). */
export function shouldStopOnEscape(event: {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  running: boolean;
  stopping?: boolean;
}): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.isComposing &&
    event.running &&
    !event.stopping
  );
}
