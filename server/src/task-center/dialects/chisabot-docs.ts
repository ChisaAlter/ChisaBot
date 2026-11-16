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

const CHISABOT_CARD_HEADING_RE = /^##\s+(CB-\d+)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const LEGACY_DONE_H2_RE = /^##\s+(?:已完成|已交付|Done|Shipped)(?=$|\s|[（(:：])/i;

type RoadmapPlacement = {
  lane: TaskHorizonLane;
  shipped: boolean;
  lineIndex: number;
  lineStart: number;
  lineEnd: number;
  lineText: string;
  sharedIdsCount: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRoadmapPlacements(
  roadmapRaw: string,
): Map<string, RoadmapPlacement> {
  const lines = splitLinesWithOffsets(roadmapRaw);
  const map = new Map<string, RoadmapPlacement>();
  let section: "now" | "next" | "later" | "shipped" | null = null;
  let fence: FenceState = null;
  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    const h2 = H2_RE.exec(line.text);
    if (h2?.[1]) {
      const heading = h2[1].trim();
      if (/^现在/.test(heading)) section = "now";
      else if (/^接下来/.test(heading)) section = "next";
      else if (/^以后/.test(heading)) section = "later";
      else if (/^最近完成/.test(heading)) section = "shipped";
      else section = null;
      continue;
    }
    if (!section) continue;
    const matches = [...line.text.matchAll(/\bCB-\d+\b/g)].map((m) => m[0]);
    if (!matches.length) continue;
    const uniqueIds = [...new Set(matches)];
    for (const id of uniqueIds) {
      if (map.has(id)) continue;
      map.set(id, {
        lane: section === "shipped" ? "now" : section,
        shipped: section === "shipped",
        lineIndex: line.index,
        lineStart: line.start,
        lineEnd: line.end,
        lineText: line.text,
        sharedIdsCount: uniqueIds.length,
      });
    }
  }
  return map;
}

function extractBacktickTokens(text: string): {
  tags: string[];
  size: string;
  statusToken: string;
} {
  const tags: string[] = [];
  let size = "";
  let statusToken = "";
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const token = match[1]?.trim() ?? "";
    if (!token) continue;
    if (/^status\s*:/i.test(token)) {
      statusToken = token.slice(token.indexOf(":") + 1).trim();
    } else if (/^size\s*:/i.test(token)) {
      size = token.slice(token.indexOf(":") + 1).trim();
    } else if (/^P[0-2]$/i.test(token)) {
      tags.push(token.toUpperCase());
    } else {
      tags.push(token);
    }
  }
  return { tags, size, statusToken };
}

function parseChisabotCardBody(lines: readonly RawLine[]): {
  boldTitle: string;
  tags: string[];
  size: string;
  statusToken: string;
  checkboxes: { checked: number; total: number };
} {
  let boldTitle = "";
  let statusToken = "";
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
    if (!boldTitle) {
      const bm = /^\*\*(.+?)\*\*$/.exec(line.text.trim());
      if (bm?.[1]) {
        boldTitle = bm[1].trim();
        continue;
      }
    }
    if (/(?:^|\s|·)标签\s*[：:]/.test(line.text)) {
      const meta = extractBacktickTokens(line.text);
      for (const tag of meta.tags) tags.push(tag);
      if (meta.size) size = meta.size;
      if (meta.statusToken) statusToken = meta.statusToken;
      continue;
    }
    const cb = parseCheckboxLine(line.text);
    if (cb) {
      total += 1;
      if (cb.checked) checked += 1;
    }
  }
  return { boldTitle, tags, size, statusToken, checkboxes: { checked, total } };
}

function findLegacyDoneStartOffset(backlogRaw: string): number {
  const lines = splitLinesWithOffsets(backlogRaw);
  let fence: FenceState = null;
  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    if (LEGACY_DONE_H2_RE.test(line.text)) {
      return line.start;
    }
  }
  return -1;
}

/** 联合解析 ChisaBot 仓库 `docs/ROADMAP.md` 与 `docs/BACKLOG.md` 双文件。 */
export function parseChisabotDocsBoard(
  roadmapRaw: string,
  backlogRaw: string,
  backlogFile: string,
): ParsedMarkdownBoard {
  const placements = parseRoadmapPlacements(roadmapRaw);
  const lines = splitLinesWithOffsets(backlogRaw);
  const eol = detectEol(backlogRaw);

  const tableMeta = new Map<
    string,
    { title: string; rawMeta: string; hasCheck: boolean }
  >();
  let tableFence: FenceState = null;
  for (const line of lines) {
    const nextFence = updateFenceState(line.text, tableFence);
    const toggled = nextFence !== tableFence;
    tableFence = nextFence;
    if (tableFence || toggled) continue;
    const row =
      /^\|\s*\[?(CB-\d+)\]?(?:\(#[^)]+\))?\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(
        line.text,
      );
    if (!row?.[1] || !row[2] || !row[4]) continue;
    const rawMeta = row[4].trim();
    tableMeta.set(row[1].trim(), {
      title: row[2].trim(),
      rawMeta,
      hasCheck: rawMeta.includes("✅") || /（完成）/.test(row[2]),
    });
  }

  const cards: ParsedBoardCardInternal[] = [];
  let underLegacyDone = false;
  let current: { id: string; startLine: number; legacyDone: boolean } | null =
    null;
  let fence: FenceState = null;

  const flush = (endLineIndex: number) => {
    if (!current) return;
    const startObj = lines[current.startLine];
    if (!startObj) {
      current = null;
      return;
    }
    const endOffset =
      endLineIndex < lines.length
        ? (lines[endLineIndex]?.start ?? backlogRaw.length)
        : backlogRaw.length;
    const bodyStartOffset =
      current.startLine + 1 < lines.length
        ? (lines[current.startLine + 1]?.start ?? backlogRaw.length)
        : backlogRaw.length;
    const bodyLines = lines.slice(current.startLine + 1, endLineIndex);
    const bodyMeta = parseChisabotCardBody(bodyLines);
    const tbl = tableMeta.get(current.id);
    const tblTokens = tbl
      ? extractBacktickTokens(tbl.rawMeta)
      : { tags: [], size: "", statusToken: "" };
    const statusText =
      bodyMeta.statusToken ||
      tblTokens.statusToken ||
      (current.legacyDone ? "done" : "");
    const title = bodyMeta.boldTitle || tbl?.title || current.id;
    const placement = placements.get(current.id);
    const done =
      current.legacyDone ||
      Boolean(tbl?.hasCheck) ||
      Boolean(placement?.shipped) ||
      /^(?:done|dropped|已完成|已交付)/i.test(statusText) ||
      /（完成）/.test(title);
    const blocked = !done && /^(?:blocked|needs-user)/i.test(statusText);
    const inProgress = /^in-progress/i.test(statusText);
    const filedIn: TaskHorizonLane =
      placement?.lane ?? (done || inProgress ? "now" : "later");
    const lane: TaskBoardColumn = done ? "shipped" : filedIn;
    const tags = bodyMeta.tags.length ? bodyMeta.tags : tblTokens.tags;
    const movable = !placement || placement.sharedIdsCount === 1;

    cards.push({
      id: current.id,
      title,
      lane,
      filedIn,
      done,
      blocked,
      movable,
      statusText: statusText || (done ? "done" : "open"),
      size: bodyMeta.size || tblTokens.size,
      tags,
      body: trimBodyBlock(backlogRaw, bodyStartOffset, endOffset),
      line: current.startLine + 1,
      sourceFile: backlogFile,
      checkboxes: bodyMeta.checkboxes,
      blockStartOffset: startObj.start,
      blockEndOffset: endOffset,
      bodyStartOffset,
      rawHeaderLine: startObj.text,
      separator: "·",
      ...(placement
        ? {
            roadmapLineOffset: {
              start: placement.lineStart,
              end: placement.lineEnd,
            },
          }
        : {}),
    });
    current = null;
  };

  for (const line of lines) {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) continue;
    const cardHead = CHISABOT_CARD_HEADING_RE.exec(line.text);
    if (cardHead?.[1]) {
      flush(line.index);
      current = {
        id: cardHead[1],
        startLine: line.index,
        legacyDone: underLegacyDone,
      };
      continue;
    }
    const otherH2 = H2_RE.exec(line.text);
    if (otherH2?.[1]) {
      flush(line.index);
      if (LEGACY_DONE_H2_RE.test(line.text)) underLegacyDone = true;
    }
  }
  flush(lines.length);

  return {
    dialect: "chisabot-docs",
    eol,
    lanes: { now: "现在", next: "接下来", later: "以后" },
    laneHeadings: {
      now: "现在（进行中）",
      next: "接下来（待所有者决策或外部真实账号验证）",
      later: "以后（按需排期）",
    },
    pinned: null,
    cards,
  };
}

function extractRoadmapRowFields(
  lineText: string,
  cardId: string,
  fallbackTitle: string,
): { desc: string; note: string } {
  const trimmed = lineText.trim();
  if (trimmed.startsWith("|")) {
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return {
      desc: cells[1] || fallbackTitle,
      note: cells[2] || "按排期推进",
    };
  }
  const bullet = /^[-*+]\s+\[[^\]]+\]\([^)]+\)\s*[：:]\s*(.+)$/.exec(trimmed);
  if (bullet?.[1]) {
    return { desc: bullet[1].trim(), note: "从进行中调整" };
  }
  const plain = trimmed
    .replace(new RegExp(`\\b${escapeRegExp(cardId)}\\b`, "g"), "")
    .trim();
  return { desc: plain || fallbackTitle, note: "按排期推进" };
}

function updateBacklogStatusTokensInLines(
  blockLines: readonly RawLine[],
  nextStatus: string,
): string[] {
  let replacedMeta = false;
  let boldIdx = -1;
  let fence: FenceState = null;
  const updated = blockLines.map((line, idx) => {
    const nextFence = updateFenceState(line.text, fence);
    const toggled = nextFence !== fence;
    fence = nextFence;
    if (fence || toggled) return line.text;
    if (boldIdx < 0 && /^\*\*(.+?)\*\*$/.test(line.text.trim())) boldIdx = idx;
    if (/(?:^|\s|·)标签\s*[：:]/.test(line.text)) {
      replacedMeta = true;
      if (/`status\s*:[^`]*`/i.test(line.text)) {
        return line.text.replace(
          /`status\s*:[^`]*`/gi,
          `\`status: ${nextStatus}\``,
        );
      }
      return `${line.text} · \`status: ${nextStatus}\``;
    }
    return line.text;
  });
  if (!replacedMeta) {
    const insertAt = boldIdx >= 0 ? boldIdx + 1 : 1;
    updated.splice(insertAt, 0, "", `标签：\`status: ${nextStatus}\``);
  }
  return updated;
}

function updateBacklogIndexTableCell(
  backlogRaw: string,
  cardId: string,
  updater: (parts: {
    left: string;
    titleCell: string;
    mid: string;
    tagsCell: string;
    right: string;
  }) => string,
): string {
  const escaped = escapeRegExp(cardId);
  const rowRe = new RegExp(
    `^(\\|\\s*\\[?${escaped}\\]?(?:\\(#[^)]+\\))?\\s*\\|\\s*)([^|\\r\\n]+?)(\\s*\\|[^|\\r\\n]+\\|\\s*)([^|\\r\\n]+?)(\\s*\\|\\s*)$`,
    "m",
  );
  return backlogRaw.replace(
    rowRe,
    (
      _,
      left: string,
      titleCell: string,
      mid: string,
      tagsCell: string,
      right: string,
    ) => updater({ left, titleCell, mid, tagsCell, right }),
  );
}

function placeCardInRoadmap(
  roadmapRaw: string,
  cardId: string,
  fields: { desc: string; note: string },
  targetLane: TaskHorizonLane,
  beforeCardId?: string | null,
  previousLineOffset?: { start: number; end: number },
): string {
  const eol = detectEol(roadmapRaw);
  const nextRoadmap = previousLineOffset
    ? roadmapRaw.slice(0, previousLineOffset.start) +
      roadmapRaw.slice(previousLineOffset.end)
    : roadmapRaw;

  const lines = splitLinesWithOffsets(nextRoadmap);
  let targetStart = -1;
  let targetEnd = lines.length;
  let fence: FenceState = null;
  for (const line of lines) {
    fence = updateFenceState(line.text, fence);
    if (fence) continue;
    const h2 = H2_RE.exec(line.text);
    if (!h2?.[1]) continue;
    const heading = h2[1].trim();
    const matchesTarget =
      (targetLane === "now" && /^现在/.test(heading)) ||
      (targetLane === "next" && /^接下来/.test(heading)) ||
      (targetLane === "later" && /^以后/.test(heading));
    if (matchesTarget && targetStart < 0) {
      targetStart = line.index;
    } else if (targetStart >= 0) {
      targetEnd = line.index;
      break;
    }
  }
  if (targetStart < 0) {
    throw new BoardMutationError(
      `ROADMAP.md 缺少「${targetLane === "now" ? "现在" : targetLane === "next" ? "接下来" : "以后"}」分段标题。`,
      409,
    );
  }

  const escapedBefore = beforeCardId ? escapeRegExp(beforeCardId) : "";
  const beforeRe = beforeCardId
    ? new RegExp(
        `\\[${escapedBefore}\\]|(?:^|[^A-Za-z0-9_-])${escapedBefore}(?:$|[^A-Za-z0-9_-])`,
      )
    : null;

  let sectionFence: FenceState = null;
  let hasTable = false;
  let tableCols = 3;
  let lastTableLineEnd = -1;
  let lastBulletLineEnd = -1;
  let beforeMatchStart = -1;
  let beforeMatchIsTable = false;
  let hrStart = -1;

  for (let i = targetStart + 1; i < targetEnd; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const nextFence = updateFenceState(line.text, sectionFence);
    const toggled = nextFence !== sectionFence;
    sectionFence = nextFence;
    if (sectionFence || toggled) continue;
    const trimmed = line.text.trim();
    if (/^---+$/.test(trimmed)) {
      hrStart = line.start;
      break;
    }
    if (trimmed.startsWith("|")) {
      if (!hasTable) {
        const parsedCols = trimmed.split("|").slice(1, -1).length;
        if (parsedCols >= 3) tableCols = parsedCols;
      }
      hasTable = true;
      lastTableLineEnd = line.end;
    } else if (/^[-*+]\s+/.test(trimmed)) {
      lastBulletLineEnd = line.end;
    }
    if (beforeRe?.test(line.text)) {
      beforeMatchStart = line.start;
      beforeMatchIsTable = trimmed.startsWith("|");
      break;
    }
  }

  const sectionEndOffset =
    targetEnd < lines.length
      ? (lines[targetEnd]?.start ?? nextRoadmap.length)
      : nextRoadmap.length;

  let insertOffset = sectionEndOffset;
  let insertAsTable = hasTable;
  if (beforeMatchStart >= 0) {
    insertOffset = beforeMatchStart;
    insertAsTable = beforeMatchIsTable;
  } else if (hasTable && lastTableLineEnd >= 0) {
    insertOffset = lastTableLineEnd;
    insertAsTable = true;
  } else if (lastBulletLineEnd >= 0) {
    insertOffset = lastBulletLineEnd;
    insertAsTable = false;
  } else if (hrStart >= 0) {
    insertOffset = hrStart;
    insertAsTable = false;
  }

  const anchor = cardId.toLowerCase();
  const safeDesc = sanitizeSingleLineText(fields.desc).replaceAll("|", "｜");
  const safeNote = sanitizeSingleLineText(fields.note).replaceAll("|", "｜");
  const extraCells =
    tableCols > 3 ? ` ${Array(tableCols - 3).fill(" ").join("|")}|` : "";
  const formattedLine = insertAsTable
    ? `| [${cardId}](BACKLOG.md#${anchor}) | ${safeDesc} | ${safeNote} |${extraCells}${eol}`
    : `- [${cardId}](BACKLOG.md#${anchor})：${safeDesc}${eol}`;

  const prefix = nextRoadmap.slice(0, insertOffset);
  const needsPrefixNl = prefix.length > 0 && !prefix.endsWith("\n") ? eol : "";
  return `${prefix}${needsPrefixNl}${formattedLine}${nextRoadmap.slice(insertOffset)}`;
}

/** 移动 ChisaBot 双文件看板卡片：更新 ROADMAP.md 排期并在需要时将卡片从 `## 已完成` 移回活跃区。 */
export function moveChisabotDocsCard(
  roadmapRaw: string,
  backlogRaw: string,
  cardId: string,
  targetLane: TaskHorizonLane,
  beforeCardId?: string | null,
): { nextRoadmap: string; nextBacklog: string } {
  const board = parseChisabotDocsBoard(roadmapRaw, backlogRaw, "docs/BACKLOG.md");
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  if (!card.movable) {
    throw new BoardMutationError(
      "该卡片在 ROADMAP.md 中与多个编号共用同一行，请直接在文档标签页里调整。",
      409,
    );
  }
  const fields = card.roadmapLineOffset
    ? extractRoadmapRowFields(
        roadmapRaw.slice(
          card.roadmapLineOffset.start,
          card.roadmapLineOffset.end,
        ),
        cardId,
        card.title,
      )
    : { desc: card.title, note: "从任务看板排期" };

  const nextRoadmap = placeCardInRoadmap(
    roadmapRaw,
    cardId,
    fields,
    targetLane,
    beforeCardId === cardId ? null : beforeCardId,
    card.roadmapLineOffset,
  );

  let nextBacklog = backlogRaw;
  const legacyDoneStart = findLegacyDoneStartOffset(backlogRaw);
  const isUnderLegacyDone =
    legacyDoneStart >= 0 && card.blockStartOffset > legacyDoneStart;
  if (card.done || isUnderLegacyDone) {
    const eol = detectEol(backlogRaw);
    const nextStatus = targetLane === "now" ? "in-progress" : "planned";
    const blockLines = splitLinesWithOffsets(
      backlogRaw.slice(card.blockStartOffset, card.blockEndOffset),
    );
    const updatedBlock = updateBacklogStatusTokensInLines(blockLines, nextStatus)
      .join(eol)
      .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "");
    if (isUnderLegacyDone) {
      const { next: withoutBlock } = spliceDeleteRange(
        backlogRaw,
        card.blockStartOffset,
        card.blockEndOffset,
      );
      const nextDoneStart = findLegacyDoneStartOffset(withoutBlock);
      nextBacklog = spliceInsertBlock(
        withoutBlock,
        nextDoneStart >= 0 ? nextDoneStart : withoutBlock.length,
        updatedBlock,
        eol,
      );
    } else {
      nextBacklog = spliceReplaceBlock(
        backlogRaw,
        card.blockStartOffset,
        card.blockEndOffset,
        updatedBlock,
        eol,
      );
    }
    nextBacklog = updateBacklogIndexTableCell(
      nextBacklog,
      cardId,
      ({ left, titleCell, mid, tagsCell, right }) => {
        const cleanedTags = tagsCell.replace(/\s*✅\s*/g, " ").trim();
        const nextTags = /`status\s*:[^`]*`/i.test(cleanedTags)
          ? cleanedTags.replace(
              /`status\s*:[^`]*`/gi,
              `\`status: ${nextStatus}\``,
            )
          : `${cleanedTags} · \`status: ${nextStatus}\``;
        return `${left}${titleCell}${mid}${nextTags}${right}`;
      },
    );
  }
  return { nextRoadmap, nextBacklog };
}

/** 更新 ChisaBot BACKLOG.md 目标卡片正文（严禁修改 `## CB-xxx` 锚点标题）。 */
export function updateChisabotDocsCard(
  backlogRaw: string,
  cardId: string,
  patch: { title?: string; body: string },
): string {
  const board = parseChisabotDocsBoard("", backlogRaw, "docs/BACKLOG.md");
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  const eol = detectEol(backlogRaw);
  let nextBody = sanitizeMarkdownBodyHeadings(patch.body, 4)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "")
    .replace(/\r?\n/g, eol);
  const safeTitle = sanitizeSingleLineText(patch.title ?? "");
  if (safeTitle) {
    const lines = nextBody.split(/\r\n|\r|\n/);
    const boldLineIdx = lines.findIndex((l) => /^\*\*(.+?)\*\*$/.test(l.trim()));
    if (boldLineIdx >= 0) {
      lines[boldLineIdx] = `**${safeTitle}**`;
      nextBody = lines.join(eol);
    } else {
      nextBody = `**${safeTitle}**${eol}${eol}${nextBody}`;
    }
  }
  const replacement = `${card.rawHeaderLine}${eol}${eol}${nextBody}`;
  let result = spliceReplaceBlock(
    backlogRaw,
    card.blockStartOffset,
    card.blockEndOffset,
    replacement,
    eol,
  );
  if (safeTitle) {
    const tableTitle = safeTitle.replaceAll("|", "｜");
    result = updateBacklogIndexTableCell(
      result,
      cardId,
      ({ left, mid, tagsCell, right }) =>
        `${left}${tableTitle}${mid}${tagsCell}${right}`,
    );
  }
  return result;
}

/** 在 ChisaBot 仓库双文件看板中创建新 `CB-xxx` 卡片（插在 `## 已完成` 之前）并登记到 ROADMAP.md。 */
export function createChisabotDocsCard(
  roadmapRaw: string,
  backlogRaw: string,
  input: {
    title: string;
    lane: TaskHorizonLane;
    size?: string;
    tags?: string[];
    body?: string;
  },
): { nextRoadmap: string; nextBacklog: string; cardId: string } {
  const board = parseChisabotDocsBoard(roadmapRaw, backlogRaw, "docs/BACKLOG.md");
  let maxNum = 0;
  for (const c of board.cards) {
    const n = Number(c.id.split("-")[1] ?? 0);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  let scanFence: FenceState = null;
  for (const line of splitLinesWithOffsets(backlogRaw)) {
    const nextFence = updateFenceState(line.text, scanFence);
    const toggled = nextFence !== scanFence;
    scanFence = nextFence;
    if (scanFence || toggled) continue;
    const h = /^##\s+CB-(\d+)\b/.exec(line.text);
    const row = /^\|\s*\[?CB-(\d+)\]?/.exec(line.text);
    const n = Number(h?.[1] ?? row?.[1] ?? 0);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  let rmFence: FenceState = null;
  for (const line of splitLinesWithOffsets(roadmapRaw)) {
    const nextFence = updateFenceState(line.text, rmFence);
    const toggled = nextFence !== rmFence;
    rmFence = nextFence;
    if (rmFence || toggled) continue;
    for (const m of line.text.matchAll(/\[CB-(\d+)\]/g)) {
      const n = Number(m[1] ?? 0);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  }

  const cardId = `CB-${String(maxNum + 1).padStart(3, "0")}`;
  const eol = detectEol(backlogRaw);
  const cleanTitle = sanitizeSingleLineText(input.title) || cardId;
  const tagParts = [
    ...(input.tags ?? []).map(
      (t) => `\`${sanitizeSingleLineText(t).replaceAll("`", "")}\``,
    ),
    ...(input.size?.trim()
      ? [`\`size: ${sanitizeSingleLineText(input.size)}\``]
      : []),
    input.lane === "now" ? "`status: in-progress`" : "`status: planned`",
  ].filter((part) => part !== "``");
  const metaLine = `标签：${tagParts.join(" · ")}`;
  const cleanBody = sanitizeMarkdownBodyHeadings(input.body ?? "", 4)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "")
    .replace(/\r?\n/g, eol);

  const block = [
    `## ${cardId}`,
    "",
    `**${cleanTitle}**`,
    "",
    metaLine,
    ...(cleanBody ? ["", cleanBody] : []),
  ].join(eol);

  const legacyDoneStart = findLegacyDoneStartOffset(backlogRaw);
  const insertOffset =
    legacyDoneStart >= 0 ? legacyDoneStart : backlogRaw.length;
  const nextBacklog = spliceInsertBlock(backlogRaw, insertOffset, block, eol);
  const nextRoadmap = placeCardInRoadmap(
    roadmapRaw,
    cardId,
    { desc: cleanTitle, note: "从任务看板排期" },
    input.lane,
    null,
  );
  return { nextRoadmap, nextBacklog, cardId };
}

/** 将 ChisaBot 双文件看板卡片单趟标记为完成并幂等写入交付摘要。 */
export function completeChisabotDocsCard(
  backlogRaw: string,
  cardId: string,
  summary: string,
  finishedAtIso: string,
): string {
  const board = parseChisabotDocsBoard("", backlogRaw, "docs/BACKLOG.md");
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) {
    throw new BoardMutationError(`找不到编号为 ${cardId} 的卡片。`, 404);
  }
  const eol = detectEol(backlogRaw);
  const bodyLines = splitLinesWithOffsets(
    backlogRaw.slice(card.bodyStartOffset, card.blockEndOffset),
  );
  const withStatus = updateBacklogStatusTokensInLines(bodyLines, "done");
  const withSummary = upsertAutoSummaryInLines(
    withStatus,
    summary,
    finishedAtIso,
  );
  const normalizedBody = withSummary
    .join(eol)
    .replace(/^(?:\r?\n|\r)+|(?:\r?\n|\r)+$/g, "");
  const replacement = normalizedBody
    ? `${card.rawHeaderLine}${eol}${eol}${normalizedBody}`
    : card.rawHeaderLine;
  const updatedBacklog = spliceReplaceBlock(
    backlogRaw,
    card.blockStartOffset,
    card.blockEndOffset,
    replacement,
    eol,
  );
  return updateBacklogIndexTableCell(
    updatedBacklog,
    cardId,
    ({ left, titleCell, mid, tagsCell, right }) => {
      const nextTags = /`status\s*:[^`]*`/i.test(tagsCell)
        ? tagsCell.replace(/`status\s*:[^`]*`/gi, "`status: done`")
        : `${tagsCell.trim()} · \`status: done\``;
      return `${left}${titleCell}${mid}${nextTags}${right}`;
    },
  );
}
