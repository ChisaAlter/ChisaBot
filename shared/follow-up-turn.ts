/**
 * The message a follow-up wakes its Bot with, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the same reason `responsibility-turn.ts` gives: the
 * server writes this text into the transcript (inside the `frameFiring` wrap), and the browser has
 * to recognise it again to draw it for a person. Two copies of the layout would be a contract with
 * two authors, and the first rewording would break the renderer silently.
 *
 * Everything except the reason and the "meant to do" is scaffolding addressed to the model: the
 * timestamp it was scheduled at and the reminder to pick it up and maybe re-schedule. A person
 * reading the transcript sees the folded row `RoutineFiring` draws and the rest behind Details.
 */

const HEAD = "You scheduled this follow-up for yourself on ";
const REASON = ". Your reason: ";
const MEANT = "\nWhat you meant to do: ";
const TAIL =
  "Pick it up now. Call the needed tools to check the latest status or finish the next step, and tell the person what you found or did in a sentence or two (if it is still in progress and needs another check later, you may call schedule_follow_up again).";

export type WakeUpParts = {
  scheduledAt: string;
  reason: string;
  /** What the Bot meant to do when it wakes, in its own words. Absent for a bare "check again". */
  instruction?: string;
};

/** The model-facing message for one follow-up firing. */
export function buildWakeUpInstruction(parts: WakeUpParts): string {
  const lines = [`${HEAD}${parts.scheduledAt}${REASON}${parts.reason}`];
  if (parts.instruction)
    lines.push(`What you meant to do: ${parts.instruction}`);
  lines.push(TAIL);
  return lines.join("\n");
}

export type WakeUpTurn = {
  scheduledAt: string;
  reason: string;
  /** The "what you meant to do" line, or "" when the follow-up carried none. */
  instruction: string;
};

/**
 * The person-facing parts back out of a follow-up's wake message, or null if this text is not one.
 *
 * The tail is matched as the LAST line, whole — the reminder is fixed text, and a prefix-only match
 * would let anything that opened with "You scheduled" borrow the shape. The reason ends at the
 * first "What you meant to do" line; both halves of the scaffold are fixed sentences, so nothing
 * the Bot wrote for its own ears is allowed to decide where the fields end.
 */
export function readWakeUpTurn(text: string): WakeUpTurn | null {
  if (!text.startsWith(HEAD) || !text.endsWith(TAIL)) return null;
  const reasonMark = text.indexOf(REASON, HEAD.length);
  const tailMark = text.length - TAIL.length - 1;
  if (
    reasonMark === -1 ||
    tailMark <= reasonMark + REASON.length - 1 ||
    text[tailMark] !== "\n"
  )
    return null;
  const scheduledAt = text.slice(HEAD.length, reasonMark);
  const middle = text.slice(reasonMark + REASON.length, tailMark);
  const meantAt = middle.indexOf(MEANT);
  if (meantAt === -1) return { scheduledAt, reason: middle, instruction: "" };
  return {
    scheduledAt,
    reason: middle.slice(0, meantAt),
    instruction: middle.slice(meantAt + MEANT.length),
  };
}
