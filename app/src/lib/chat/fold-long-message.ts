export const LONG_MESSAGE_FOLD_THRESHOLD = 20_000;

export type FoldedMessageResult = {
  folded: boolean;
  preview: string;
  totalChars: number;
  hiddenChars: number;
};

/**
 * Splits overly long assistant responses at a line boundary near `threshold`
 * without breaking open Markdown fenced code blocks (`` ``` `` or `~~~`).
 */
export function foldLongMessage(
  text: string,
  threshold = LONG_MESSAGE_FOLD_THRESHOLD,
): FoldedMessageResult {
  if (text.length <= threshold) {
    return {
      folded: false,
      preview: text,
      totalChars: text.length,
      hiddenChars: 0,
    };
  }

  const lines = text.split("\n");
  let offset = 0;
  let activeFence: { markerChar: "`" | "~"; markerLen: number } | null = null;
  let bestOutsideCut = -1;
  let lastLineBeforeThreshold = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    const lineEnd = offset + line.length;

    if (fenceMatch) {
      const token = fenceMatch[1] ?? "";
      const markerChar = token[0] === "~" ? "~" : "`";
      const markerLen = token.length;
      if (!activeFence) {
        activeFence = { markerChar, markerLen };
      } else if (
        activeFence.markerChar === markerChar &&
        markerLen >= activeFence.markerLen &&
        trimmed.slice(markerLen).trim() === ""
      ) {
        activeFence = null;
      }
    }

    if (lineEnd <= threshold) {
      lastLineBeforeThreshold = lineEnd;
      if (!activeFence && lineEnd > 0) {
        bestOutsideCut = lineEnd;
      }
    } else {
      break;
    }

    offset = lineEnd + 1;
  }

  if (bestOutsideCut > Math.floor(threshold * 0.4)) {
    const preview = text.slice(0, bestOutsideCut).trimEnd();
    return {
      folded: true,
      preview,
      totalChars: text.length,
      hiddenChars: Math.max(0, text.length - preview.length),
    };
  }

  // Huge single code fence or unbroken paragraph: cut on the last safe newline and close fence.
  let safeEnd =
    lastLineBeforeThreshold > 0
      ? lastLineBeforeThreshold
      : Math.min(text.length, threshold);
  if (safeEnd < text.length) {
    const code = text.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      safeEnd = Math.max(0, safeEnd - 1);
    }
  }
  let preview = text.slice(0, safeEnd).trimEnd();
  const visibleTextChars = preview.length;

  // Check whether `preview` leaves a fence open and close it cleanly.
  let openFence: { markerChar: "`" | "~"; markerLen: number } | null = null;
  for (const line of preview.split("\n")) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (!fenceMatch) continue;
    const token = fenceMatch[1] ?? "";
    const markerChar = token[0] === "~" ? "~" : "`";
    const markerLen = token.length;
    if (!openFence) {
      openFence = { markerChar, markerLen };
    } else if (
      openFence.markerChar === markerChar &&
      markerLen >= openFence.markerLen &&
      trimmed.slice(markerLen).trim() === ""
    ) {
      openFence = null;
    }
  }
  if (openFence) {
    preview = `${preview}\n${openFence.markerChar.repeat(openFence.markerLen)}`;
  }

  return {
    folded: true,
    preview,
    totalChars: text.length,
    hiddenChars: Math.max(0, text.length - visibleTextChars),
  };
}
