import {
  CARD_CHECKBOX_RE,
  type FenceState,
  splitLinesWithOffsets,
  updateFenceState,
} from "../../../shared/markdown-syntax";
import type { MarkdownBoardDialect } from "../../../shared/task-board-core";
import {
  completeAutobahnCard,
  parseAutobahnBoard,
} from "./dialects/autobahn";
import {
  completeChisabotDocsCard,
  parseChisabotDocsBoard,
} from "./dialects/chisabot-docs";
import {
  type AutobahnConfig,
  BoardMutationError,
} from "./markdown-splice";

export { detectEol, splitLinesWithOffsets } from "../../../shared/markdown-syntax";
export {
  completeAutobahnCard,
  createAutobahnCard,
  moveAutobahnCard,
  parseAutobahnBoard,
  updateAutobahnCard,
} from "./dialects/autobahn";
export {
  completeChisabotDocsCard,
  createChisabotDocsCard,
  moveChisabotDocsCard,
  parseChisabotDocsBoard,
  updateChisabotDocsCard,
} from "./dialects/chisabot-docs";
export {
  type AutobahnConfig,
  BoardMutationError,
  type ParsedBoardCardInternal,
  type ParsedMarkdownBoard,
} from "./markdown-splice";

/** 单行精确翻转目标卡片内的第 N 个 Markdown 任务复选框（`- [ ]` ↔ `- [x]`）。 */
export function toggleMarkdownCardCheckbox(
  raw: string,
  dialect: MarkdownBoardDialect,
  cardId: string,
  checkboxIndex: number,
  checked: boolean,
  config?: AutobahnConfig,
): string {
  const parsed =
    dialect === "chisabot-docs"
      ? parseChisabotDocsBoard("", raw, "docs/BACKLOG.md")
      : parseAutobahnBoard(raw, "BACKLOG.md", config);
  const card = parsed.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  const cardSlice = raw.slice(card.blockStartOffset, card.blockEndOffset);
  const lines = splitLinesWithOffsets(cardSlice);
  let seen = 0;
  let fence: FenceState = null;
  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    const match = CARD_CHECKBOX_RE.exec(line.text);
    if (!match?.[1] || !match[3] || !(match[4] ?? "").trim()) continue;
    if (seen === checkboxIndex) {
      const nextMark = checked ? "x" : " ";
      const replacedLine = `${match[1]}${nextMark}${match[3]}${match[4] ?? ""}`;
      const absStart = card.blockStartOffset + line.start;
      const absEnd = absStart + line.text.length;
      return raw.slice(0, absStart) + replacedLine + raw.slice(absEnd);
    }
    seen += 1;
  }
  throw new BoardMutationError(
    `卡片 ${cardId} 中找不到第 ${checkboxIndex + 1} 个待办勾选框。`,
    404,
  );
}

/**
 * 任务执行成功后自动把对应 Markdown 卡片标为完成并附上交付摘要（幂等且不破坏其他卡片字节）。
 */
export function markCardCompletedInMarkdown(
  raw: string,
  dialect: MarkdownBoardDialect,
  cardId: string,
  summary: string,
  finishedAtIso: string,
  config?: AutobahnConfig,
): string {
  return dialect === "chisabot-docs"
    ? completeChisabotDocsCard(raw, cardId, summary, finishedAtIso)
    : completeAutobahnCard(raw, cardId, summary, finishedAtIso, config);
}
