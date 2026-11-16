import {
  type FenceState,
  sanitizeSummaryLines,
  updateFenceState,
} from "../../../shared/markdown-syntax";
import type {
  MarkdownBoardCard,
  MarkdownBoardDialect,
  MarkdownBoardPinnedNote,
} from "../../../shared/task-board-core";
import type { TaskHorizonLane } from "../../../shared/task-center";

export const AUTO_SUMMARY_HEADING = "#### 交付摘要（ChisaBot 自动回写）";

export type AutobahnConfig = {
  prefix?: string;
  backlog?: string;
  lanes?: [string, string, string];
  docs?: string[];
};

export type ParsedBoardCardInternal = Omit<
  MarkdownBoardCard,
  "sourceRef" | "linkedTask"
> & {
  blockStartOffset: number;
  blockEndOffset: number;
  bodyStartOffset: number;
  rawHeaderLine: string;
  separator: string;
  roadmapLineOffset?: { start: number; end: number };
};

export type ParsedMarkdownBoard = {
  dialect: MarkdownBoardDialect;
  eol: string;
  lanes: Record<TaskHorizonLane, string>;
  laneHeadings: Record<TaskHorizonLane, string>;
  pinned: MarkdownBoardPinnedNote | null;
  cards: ParsedBoardCardInternal[];
};

export function trimBodyBlock(
  raw: string,
  startOffset: number,
  endOffset: number,
): string {
  return raw
    .slice(startOffset, endOffset)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "");
}

export function sanitizeSingleLineText(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

/**
 * 看板文档改写失败的结构化领域错误，显式区分 404（未找到）、409（结构冲突）与 400（参数非法）。
 */
export class BoardMutationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "BoardMutationError";
  }
}

/**
 * 删除原始字节区间，并在删除后合并多余的连续空行，确保其余段落字节不受影响。
 */
export function spliceDeleteRange(
  raw: string,
  start: number,
  end: number,
): { next: string; removedLen: number } {
  let cleanEnd = end;
  const before = raw.slice(0, start);
  const after = raw.slice(cleanEnd);
  if (/(?:\r?\n){2}$/.test(before) && /^(?:\r?\n)/.test(after)) {
    cleanEnd += /^\r?\n/.exec(after)?.[0].length ?? 0;
  } else if (start > 0 && before.endsWith("\n") && /^(?:\r?\n){2}/.test(after)) {
    cleanEnd += /^\r?\n/.exec(after)?.[0].length ?? 0;
  }
  return {
    next: `${raw.slice(0, start)}${raw.slice(cleanEnd)}`,
    removedLen: cleanEnd - start,
  };
}

/**
 * 用新块精确替换卡片原始字节区间，并维持卡片后的正常双换行边界。
 */
export function spliceReplaceBlock(
  raw: string,
  blockStart: number,
  blockEnd: number,
  replacement: string,
  eol: string,
): string {
  const before = raw.slice(0, blockStart);
  const after = raw.slice(blockEnd);
  const trail =
    after.length === 0
      ? eol
      : /^(?:\r?\n){2}/.test(after)
        ? ""
        : /^(?:\r?\n)/.test(after)
          ? eol
          : `${eol}${eol}`;
  return `${before}${replacement}${trail}${after}`;
}

/**
 * 在指定偏移前插入一个完整块，并自动计算前后空行分隔符。
 */
export function spliceInsertBlock(
  raw: string,
  insertOffset: number,
  block: string,
  eol: string,
  headingPrefix = "",
): string {
  const before = raw.slice(0, insertOffset);
  const after = raw.slice(insertOffset);
  const lead =
    before.length === 0
      ? ""
      : before.endsWith(`${eol}${eol}`)
        ? ""
        : before.endsWith("\n")
          ? eol
          : `${eol}${eol}`;
  const trail =
    after.length === 0
      ? eol
      : /^(?:\r?\n){2}/.test(after)
        ? ""
        : /^(?:\r?\n)/.test(after)
          ? eol
          : `${eol}${eol}`;
  return `${before}${lead}${headingPrefix}${block}${trail}${after}`;
}

/**
 * 在卡片正文中幂等插入或替换自动交付摘要，同时清洗摘要内部的 ATX 标题防止伪造卡片或结构漂移。
 */
export function upsertAutoSummaryInLines(
  cardBodyLines: readonly string[],
  summary: string,
  finishedAtIso: string,
): string[] {
  const safeBody = sanitizeSummaryLines(summary);
  const timestamp = finishedAtIso.slice(0, 16).replace("T", " ");
  const summarySection = [
    AUTO_SUMMARY_HEADING,
    "",
    `> 完成时间：${timestamp} UTC`,
    "",
    ...safeBody,
  ];
  let headingIdx = -1;
  let fence: FenceState = null;
  for (let i = 0; i < cardBodyLines.length; i += 1) {
    const line = cardBodyLines[i] ?? "";
    const nextFence = updateFenceState(line, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    if (line.trim() === AUTO_SUMMARY_HEADING) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx >= 0) {
    let endIdx = cardBodyLines.length;
    let bodyFence: FenceState = null;
    for (let i = headingIdx + 1; i < cardBodyLines.length; i += 1) {
      const line = cardBodyLines[i] ?? "";
      const nextFence = updateFenceState(line, bodyFence);
      const toggled = nextFence !== bodyFence;
      bodyFence = nextFence;
      if (bodyFence || toggled) continue;
      if (/^#{1,4}\s+/.test(line)) {
        endIdx = i;
        break;
      }
    }
    return [
      ...cardBodyLines.slice(0, headingIdx),
      ...summarySection,
      ...cardBodyLines.slice(endIdx),
    ];
  }
  const trimmed = [...cardBodyLines];
  while (trimmed.length > 0 && trimmed.at(-1)?.trim() === "") trimmed.pop();
  return trimmed.length ? [...trimmed, "", ...summarySection] : summarySection;
}
