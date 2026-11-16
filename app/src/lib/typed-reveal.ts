import { useReducedMotion } from "motion/react";
import { useState } from "react";
import { useAnimationFrame } from "@/hooks";

/**
 * Types a conversation's name in as it arrives, so the line reads as learning something rather than
 * as a glitch. Only on arrival: otherwise opening the app sets the whole roster typing at once.
 */

/** Per character, not per title, so every length types at the same speed. Capped so none outstays. */
export const TYPING_SECONDS_PER_CHARACTER = 0.014;
export const TYPING_MAX_SECONDS = 0.45;

export function typingSeconds(length: number): number {
  return Math.min(length * TYPING_SECONDS_PER_CHARACTER, TYPING_MAX_SECONDS);
}

/** Naming is none-to-some. A name replacing another name is not this, and must not replay. */
export function isNaming(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return !previous && Boolean(next);
}

export type TypedReveal = {
  /** What to draw right now: the whole name, or as much of it as has landed. */
  text: string | undefined;
  /** Whether the characters are still arriving, so the caller can show a cursor. */
  typing: boolean;
};

export function useTypedReveal(summary: string | undefined): TypedReveal {
  const reduce = useReducedMotion();
  const [prevSummary, setPrevSummary] = useState(summary);
  const [reveal, setReveal] = useState<{
    text: string;
    typed: number;
    startedAt: number;
  } | null>(null);

  if (prevSummary !== summary) {
    setPrevSummary(summary);
    // A row that arrives already named is not a naming.
    if (summary && isNaming(prevSummary, summary) && !reduce) {
      setReveal({ text: summary, typed: 0, startedAt: performance.now() });
    } else if (reveal !== null) {
      setReveal(null);
    }
  } else if (reduce && reveal !== null) {
    // The gentler version of a reveal made entirely of movement is no movement.
    setReveal(null);
  }

  useAnimationFrame((now) => {
    if (!reveal) return;
    const total = typingSeconds(reveal.text.length) * 1000;
    // Linear, because this is constant motion. An eased typewriter reads as a machine hesitating.
    const progress =
      total <= 0 ? 1 : Math.min(Math.max(0, (now - reveal.startedAt) / total), 1);
    if (progress < 1) {
      const nextTyped = Math.round(progress * reveal.text.length);
      if (nextTyped !== reveal.typed) {
        setReveal({ ...reveal, typed: nextTyped });
      }
      return;
    }
    // Null, not the full length, so later renders draw the string rather than re-slicing it.
    setReveal(null);
  }, reveal !== null);

  if (reveal === null || !summary) return { text: summary, typing: false };
  return { text: summary.slice(0, reveal.typed), typing: true };
}
