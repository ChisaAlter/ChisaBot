import {
  detectEol,
  type FenceState,
  parseCheckboxLine,
  type RawLine,
  sanitizeMarkdownBodyHeadings,
  splitLinesWithOffsets,
  updateFenceState,
} from "../../../../shared/markdown-syntax";
import type { TaskBoardColumn } from "../../../../shared/task-board-core";
import type { TaskHorizonLane } from "../../../../shared/task-center";
import {
  type AutobahnConfig,
  BoardMutationError,
  type ParsedBoardCardInternal,
  type ParsedMarkdownBoard,
  sanitizeSingleLineText,
  spliceDeleteRange,
  spliceInsertBlock,
  spliceReplaceBlock,
  trimBodyBlock,
  upsertAutoSummaryInLines,
} from "../markdown-splice";

const CARD_HEADING_RE =
  /^(#{2,3})\s+([A-Z][A-Z0-9]*-\d+)(?:\s+([·•\-–—])\s+|\s*([:：])\s*)(.+)$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const DONE_TITLE_PREFIX_RE = /^(?:✓|✔|\[done\]|\[已完成\])\s*/i;
const DONE_STATUS_RE =
  /\b(?:done|shipped|complete|completed|closed)\b|已完成|已交付/i;
const BLOCKED_STATUS_RE = /\bblocked\b|阻塞|受阻/i;
const EN_STATUS_LINE_RE =
  /^(\s*(?:[-*+]\s+)?\*\*Status\s*(?::\*\*\s*|\*\*\s*:\s*))(.+)$/i;
const CN_STATUS_LINE_RE =
  /^(\s*(?:[-*+]\s+)?\*\*状态\s*(?:[:：]\*\*\s*|\*\*\s*[:：]\s*))(.+)$/i;
const SIZE_LINE_RE =
  /^\s*(?:[-*+]\s+)?\*\*(?:Size|规模)\s*(?:[:：]?\*\*\s*[:：]?)\s*(.+)$/i;
const TAGS_LINE_RE =
  /^\s*(?:[-*+]\s+)?\*\*(?:Tags|标签)\s*(?:[:：]?\*\*\s*[:：]?)\s*(.+)$/i;

function resolveAutobahnLane(
  heading: string,
  configured?: [string, string, string],
): TaskHorizonLane | null {
  const trimmed = heading.trim();
  const stem = trimmed.split(/[（(：:]/)[0]?.trim().toLowerCase() ?? "";
  if (configured) {
    const idx = configured.findIndex(
      (item) =>
        item.trim().toLowerCase() === trimmed.toLowerCase() ||
        item.trim().toLowerCase() === stem,
    );
    if (idx === 0) return "now";
    if (idx === 1) return "next";
    if (idx === 2) return "later";
  }
  if (/^(?:now|现在|当前|进行中)$/i.test(stem)) return "now";
  if (/^(?:next|接下来|下一步|排队)$/i.test(stem)) return "next";
  if (/^(?:later|以后|远期|规划)$/i.test(stem)) return "later";
  return null;
}

function parseCardMetadataAndCheckboxes(lines: readonly RawLine[]): {
  statusText: string;
  size: string;
  tags: string[];
  checkboxes: { checked: number; total: number };
} {
  let statusText = "";
  let size = "";
  const tags: string[] = [];
  let checked = 0;
  let total = 0;
  let fence: FenceState = null;
  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    const statusMatch =
      EN_STATUS_LINE_RE.exec(line.text) ?? CN_STATUS_LINE_RE.exec(line.text);
    if (statusMatch?.[2]) {
      statusText = statusMatch[2].trim();
      continue;
    }
    const sizeMatch = SIZE_LINE_RE.exec(line.text);
    if (sizeMatch?.[1]) {
      size = sizeMatch[1].trim();
      continue;
    }
    const tagsMatch = TAGS_LINE_RE.exec(line.text);
    if (tagsMatch?.[1]) {
      for (const item of tagsMatch[1].split(/[,，·]/)) {
        const clean = item.replaceAll("`", "").trim();
        if (clean) tags.push(clean);
      }
      continue;
    }
    const cb = parseCheckboxLine(line.text);
    if (cb) {
      total += 1;
      if (cb.checked) checked += 1;
    }
  }
  return { statusText, size, tags, checkboxes: { checked, total } };
}

/** 解析 Autobahn 方言（支持中英文泳道及 `autobahn.config.json` 自定义配置）。 */
export function parseAutobahnBoard(
  raw: string,
  backlogFile: string,
  config?: AutobahnConfig,
): ParsedMarkdownBoard {
  const lines = splitLinesWithOffsets(raw);
  const eol = detectEol(raw);
  const laneHeadings: Record<TaskHorizonLane, string> = {
    now: config?.lanes?.[0]?.trim() || "现在",
    next: config?.lanes?.[1]?.trim() || "接下来",
    later: config?.lanes?.[2]?.trim() || "以后",
  };
  const lanes: Record<TaskHorizonLane, string> = {
    now: "现在",
    next: "接下来",
    later: "以后",
  };
  let pinned = null as ParsedMarkdownBoard["pinned"];
  const cards: ParsedBoardCardInternal[] = [];

  type PendingBlock =
    | {
        kind: "card";
        id: string;
        rawTitle: string;
        separator: string;
        filedIn: TaskHorizonLane;
        startLine: number;
      }
    | {
        kind: "pinned";
        title: string;
        startLine: number;
      };

  let currentLane: TaskHorizonLane | null = "now";
  let currentBlock: PendingBlock | null = null;
  let fence: FenceState = null;

  const flush = (endLineIndex: number) => {
    if (!currentBlock) return;
    const endOffset =
      endLineIndex < lines.length
        ? (lines[endLineIndex]?.start ?? raw.length)
        : raw.length;
    const startLineObj = lines[currentBlock.startLine];
    if (!startLineObj) {
      currentBlock = null;
      return;
    }
    const bodyLines = lines.slice(currentBlock.startLine + 1, endLineIndex);
    const bodyStartOffset =
      currentBlock.startLine + 1 < lines.length
        ? (lines[currentBlock.startLine + 1]?.start ?? raw.length)
        : raw.length;
    if (currentBlock.kind === "pinned") {
      if (!pinned) {
        pinned = {
          title: currentBlock.title,
          body: trimBodyBlock(raw, bodyStartOffset, endOffset),
          line: currentBlock.startLine + 1,
        };
      }
      currentBlock = null;
      return;
    }
    const meta = parseCardMetadataAndCheckboxes(bodyLines);
    const titleHasDone = DONE_TITLE_PREFIX_RE.test(currentBlock.rawTitle);
    const done = titleHasDone || DONE_STATUS_RE.test(meta.statusText);
    const blocked =
      !done &&
      (BLOCKED_STATUS_RE.test(meta.statusText) ||
        meta.tags.some((tag) => /^blocked$/i.test(tag)));
    const cleanTitle = currentBlock.rawTitle
      .replace(DONE_TITLE_PREFIX_RE, "")
      .trim();
    const lane: TaskBoardColumn = done ? "shipped" : currentBlock.filedIn;
    cards.push({
      id: currentBlock.id,
      title: cleanTitle || currentBlock.id,
      lane,
      filedIn: currentBlock.filedIn,
      done,
      blocked,
      movable: true,
      statusText: meta.statusText || (done ? "done" : "open"),
      size: meta.size,
      tags: meta.tags,
      body: trimBodyBlock(raw, bodyStartOffset, endOffset),
      line: currentBlock.startLine + 1,
      sourceFile: backlogFile,
      checkboxes: meta.checkboxes,
      blockStartOffset: startLineObj.start,
      blockEndOffset: endOffset,
      bodyStartOffset,
      rawHeaderLine: startLineObj.text,
      separator: currentBlock.separator,
    });
    currentBlock = null;
  };

  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    const cardMatch = CARD_HEADING_RE.exec(line.text);
    if (cardMatch?.[2] && cardMatch[5]) {
      flush(line.index);
      if (!currentLane) continue;
      currentBlock = {
        kind: "card",
        id: cardMatch[2].trim(),
        rawTitle: cardMatch[5].trim(),
        separator: cardMatch[3] ?? cardMatch[4] ?? "·",
        filedIn: currentLane,
        startLine: line.index,
      };
      continue;
    }
    const h2 = H2_RE.exec(line.text);
    if (!h2?.[1]) continue;
    const headingText = h2[1].trim();
    const maybeLane = resolveAutobahnLane(headingText, config?.lanes);
    if (maybeLane) {
      flush(line.index);
      currentLane = maybeLane;
      laneHeadings[maybeLane] = headingText;
      continue;
    }
    flush(line.index);
    if (currentLane === "now" && cards.length === 0 && !pinned) {
      currentBlock = {
        kind: "pinned",
        title: headingText,
        startLine: line.index,
      };
    } else {
      currentLane = null;
    }
  }
  flush(lines.length);

  return {
    dialect: "autobahn",
    eol,
    lanes,
    laneHeadings,
    pinned,
    cards,
  };
}

function findLaneInsertOffset(
  raw: string,
  targetLane: TaskHorizonLane,
  beforeCardId: string | null | undefined,
  config?: AutobahnConfig,
): { offset: number; needsHeading: boolean } {
  const parsed = parseAutobahnBoard(raw, "BACKLOG.md", config);
  if (beforeCardId) {
    const beforeCard = parsed.cards.find(
      (c) => c.id === beforeCardId && c.filedIn === targetLane,
    );
    if (beforeCard) {
      return { offset: beforeCard.blockStartOffset, needsHeading: false };
    }
  }
  const lines = splitLinesWithOffsets(raw);
  let fence: FenceState = null;
  let targetHeadingEnd = -1;
  let nextH2Start = -1;
  for (const line of lines) {
    fence = updateFenceState(line.text, fence);
    if (fence) continue;
    const h2 = H2_RE.exec(line.text);
    if (!h2?.[1]) continue;
    const lane = resolveAutobahnLane(h2[1], config?.lanes);
    if (lane === targetLane && targetHeadingEnd < 0) {
      targetHeadingEnd = line.end;
    } else if (targetHeadingEnd >= 0) {
      nextH2Start = line.start;
      break;
    }
  }
  if (targetHeadingEnd < 0) {
    return { offset: raw.length, needsHeading: true };
  }
  const lastCard = parsed.cards.filter((c) => c.filedIn === targetLane).at(-1);
  if (lastCard) {
    return { offset: lastCard.blockEndOffset, needsHeading: false };
  }
  return {
    offset: nextH2Start >= 0 ? nextH2Start : raw.length,
    needsHeading: false,
  };
}

function resetDoneMarkersInMovedBlock(block: string, eol: string): string {
  const lines = block.split(/\r\n|\r|\n/);
  if (lines[0]) {
    lines[0] = lines[0].replace(
      /^(#{2,3}\s+[A-Z][A-Z0-9]*-\d+(?:\s+[·•\-–—]\s+|\s*[:：]\s*))(?:✓|✔|\[done\]|\[已完成\])\s*/i,
      "$1",
    );
  }
  let fence: FenceState = null;
  const nextLines = lines.map((line) => {
    const nextFence = updateFenceState(line, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) return line;
    const enMatch = EN_STATUS_LINE_RE.exec(line);
    if (enMatch?.[1] && enMatch[2] && DONE_STATUS_RE.test(enMatch[2])) {
      return `${enMatch[1]}open`;
    }
    const cnMatch = CN_STATUS_LINE_RE.exec(line);
    if (cnMatch?.[1] && cnMatch[2] && DONE_STATUS_RE.test(cnMatch[2])) {
      return `${cnMatch[1]}待办`;
    }
    return line;
  });
  return nextLines.join(eol);
}

/** 整块搬运 Autobahn 卡片，不触碰其余卡片与置顶说明的任何字节。 */
export function moveAutobahnCard(
  raw: string,
  cardId: string,
  targetLane: TaskHorizonLane,
  beforeCardId?: string | null,
  config?: AutobahnConfig,
): string {
  const eol = detectEol(raw);
  const parsed = parseAutobahnBoard(raw, "BACKLOG.md", config);
  const card = parsed.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  let block = trimBodyBlock(raw, card.blockStartOffset, card.blockEndOffset);
  if (card.done) {
    block = resetDoneMarkersInMovedBlock(block, eol);
  }
  const { next: withoutCard } = spliceDeleteRange(
    raw,
    card.blockStartOffset,
    card.blockEndOffset,
  );
  const { offset, needsHeading } = findLaneInsertOffset(
    withoutCard,
    targetLane,
    beforeCardId === cardId ? null : beforeCardId,
    config,
  );
  const headingPrefix = needsHeading
    ? `## ${parsed.laneHeadings[targetLane]}${eol}${eol}`
    : "";
  return spliceInsertBlock(withoutCard, offset, block, eol, headingPrefix);
}

function formatAutobahnHeaderLine(
  level: "##" | "###",
  id: string,
  separator: string,
  title: string,
): string {
  const safeTitle = sanitizeSingleLineText(title) || id;
  return separator === ":" || separator === "："
    ? `${level} ${id}${separator} ${safeTitle}`
    : `${level} ${id} ${separator} ${safeTitle}`;
}

/** 仅替换 Autobahn 目标卡片的内容，保持文件其余部分零改动。 */
export function updateAutobahnCard(
  raw: string,
  cardId: string,
  patch: { title?: string; body: string },
  config?: AutobahnConfig,
): string {
  const eol = detectEol(raw);
  const parsed = parseAutobahnBoard(raw, "BACKLOG.md", config);
  const card = parsed.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  const nextTitle =
    sanitizeSingleLineText(patch.title ?? card.title) || card.title;
  const headingLevel = card.rawHeaderLine.startsWith("### ") ? "###" : "##";
  const headerLine = patch.title
    ? formatAutobahnHeaderLine(headingLevel, card.id, card.separator, nextTitle)
    : card.rawHeaderLine;
  const normalizedBody = sanitizeMarkdownBodyHeadings(patch.body, 4)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "")
    .replace(/\r?\n/g, eol);
  const replacement = normalizedBody
    ? `${headerLine}${eol}${eol}${normalizedBody}`
    : headerLine;
  return spliceReplaceBlock(
    raw,
    card.blockStartOffset,
    card.blockEndOffset,
    replacement,
    eol,
  );
}

/** 在 Autobahn 目标泳道末尾新增自动编号卡片。 */
export function createAutobahnCard(
  raw: string,
  input: {
    title: string;
    lane: TaskHorizonLane;
    size?: string;
    tags?: string[];
    body?: string;
  },
  config?: AutobahnConfig,
): { next: string; cardId: string } {
  const eol = detectEol(raw);
  const baseRaw =
    raw.trim().length > 0
      ? raw
      : `## 现在${eol}${eol}## 接下来${eol}${eol}## 以后${eol}`;
  const parsed = parseAutobahnBoard(baseRaw, "BACKLOG.md", config);
  const detectedPrefix =
    config?.prefix?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ||
    parsed.cards[0]?.id.split("-")[0] ||
    "TASK";
  let maxNum = 0;
  for (const card of parsed.cards) {
    const num = Number(card.id.split("-")[1] ?? 0);
    if (Number.isFinite(num) && num > maxNum) maxNum = num;
  }
  const cardId = `${detectedPrefix}-${maxNum + 1}`;
  const metaLines = ["- **Status:** open"];
  const safeSize = sanitizeSingleLineText(input.size ?? "");
  if (safeSize) metaLines.push(`- **Size:** ${safeSize}`);
  if (input.tags?.length) {
    const cleanTags = input.tags
      .map((t) => sanitizeSingleLineText(t).replaceAll("`", ""))
      .filter(Boolean);
    if (cleanTags.length) metaLines.push(`- **Tags:** ${cleanTags.join(", ")}`);
  }
  const cleanBody = sanitizeMarkdownBodyHeadings(input.body ?? "", 4)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "")
    .replace(/\r?\n/g, eol);
  const templateCard = parsed.cards[0];
  const headingLevel = templateCard?.rawHeaderLine.startsWith("### ")
    ? "###"
    : "##";
  const separator = templateCard?.separator ?? "·";
  const block = [
    formatAutobahnHeaderLine(headingLevel, cardId, separator, input.title),
    "",
    ...metaLines,
    ...(cleanBody ? ["", cleanBody] : []),
  ].join(eol);

  const { offset, needsHeading } = findLaneInsertOffset(
    baseRaw,
    input.lane,
    null,
    config,
  );
  const headingPrefix = needsHeading
    ? `## ${parsed.laneHeadings[input.lane]}${eol}${eol}`
    : "";
  return {
    next: spliceInsertBlock(baseRaw, offset, block, eol, headingPrefix),
    cardId,
  };
}

/** 将 Autobahn 卡片标记为完成并幂等追加交付摘要。 */
export function completeAutobahnCard(
  raw: string,
  cardId: string,
  summary: string,
  finishedAtIso: string,
  config?: AutobahnConfig,
): string {
  const parsed = parseAutobahnBoard(raw, "BACKLOG.md", config);
  const card = parsed.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  const bodyLines = card.body ? card.body.split(/\r\n|\r|\n/) : [];
  let updatedStatus = false;
  let fence: FenceState = null;
  const statusUpdatedLines = bodyLines.map((line) => {
    const nextFence = updateFenceState(line, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) return line;
    const enMatch = EN_STATUS_LINE_RE.exec(line);
    if (enMatch?.[1]) {
      updatedStatus = true;
      return `${enMatch[1]}done`;
    }
    const cnMatch = CN_STATUS_LINE_RE.exec(line);
    if (cnMatch?.[1]) {
      updatedStatus = true;
      return `${cnMatch[1]}已完成`;
    }
    return line;
  });
  if (!updatedStatus) {
    statusUpdatedLines.unshift("- **Status:** done");
  }
  const withSummary = upsertAutoSummaryInLines(
    statusUpdatedLines,
    summary,
    finishedAtIso,
  );
  return updateAutobahnCard(
    raw,
    cardId,
    { body: withSummary.join("\n") },
    config,
  );
}
