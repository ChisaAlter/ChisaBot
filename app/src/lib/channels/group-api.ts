import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export type GroupMessageStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type GroupBotMember = {
  id: string;
  name: string;
};

export type GroupPersonMember = {
  userId: string;
  email: string;
  name: string | null;
  creator: boolean;
};

export type GroupConsentNotice = {
  botId: string;
  serverId: string;
};

export type GroupTranscriptMessage = {
  id: string;
  channelId: string;
  ownerUserId: string;
  agentId: string | null;
  threadId: string | null;
  text: string;
  status: GroupMessageStatus;
  createdAt: string;
  answeredBy?: string;
  consent?: GroupConsentNotice;
  reason?: string;
};

export type GroupConversationDetail = {
  bots: GroupBotMember[];
  people: GroupPersonMember[];
  messages: GroupTranscriptMessage[];
};

export type GroupMembersSummary = {
  bots: GroupBotMember[];
  people: GroupPersonMember[];
};

export type SendGroupMessageInput = {
  channelId: string;
  id: string;
  text: string;
  agentId?: string | null;
  goalMode?: boolean;
};

export type SendGroupMessageResult = {
  id: string;
  queued: boolean;
};

export type GroupAccessProbe =
  | { available: true; detail: GroupConversationDetail }
  | { available: false; status: number };

const FALLBACK = "群聊操作失败";

export const groupKeys = {
  all: ["groups"] as const,
  detail: (channelId: string) => ["groups", "detail", channelId] as const,
  members: (channelId: string) => ["groups", "members", channelId] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroupMessageStatus(value: unknown): value is GroupMessageStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed"
  );
}

function parseBotMember(raw: unknown): GroupBotMember | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return { id: raw.id, name: raw.name };
}

function parsePersonMember(raw: unknown): GroupPersonMember | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.userId !== "string" || typeof raw.email !== "string") {
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : null;
  return {
    userId: raw.userId,
    email: raw.email,
    name,
    creator: raw.creator === true,
  };
}

function parseMessage(raw: unknown): GroupTranscriptMessage | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.channelId !== "string" ||
    typeof raw.ownerUserId !== "string" ||
    typeof raw.text !== "string" ||
    !isGroupMessageStatus(raw.status)
  ) {
    return null;
  }
  const consent =
    isRecord(raw.consent) &&
    typeof raw.consent.botId === "string" &&
    typeof raw.consent.serverId === "string"
      ? { botId: raw.consent.botId, serverId: raw.consent.serverId }
      : undefined;
  return {
    id: raw.id,
    channelId: raw.channelId,
    ownerUserId: raw.ownerUserId,
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    text: raw.text,
    status: raw.status,
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date().toISOString(),
    ...(typeof raw.answeredBy === "string"
      ? { answeredBy: raw.answeredBy }
      : {}),
    ...(consent ? { consent } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  };
}

function parseGroupDetail(raw: unknown): GroupConversationDetail | null {
  if (!isRecord(raw)) return null;
  if (
    !Array.isArray(raw.bots) ||
    !Array.isArray(raw.people) ||
    !Array.isArray(raw.messages)
  ) {
    return null;
  }
  const bots = raw.bots
    .map(parseBotMember)
    .filter((entry): entry is GroupBotMember => entry !== null);
  const people = raw.people
    .map(parsePersonMember)
    .filter((entry): entry is GroupPersonMember => entry !== null);
  const messages = raw.messages
    .map(parseMessage)
    .filter((entry): entry is GroupTranscriptMessage => entry !== null);
  return { bots, people, messages };
}

/**
 * Format outgoing group message text, automatically prefixing `/goal ` when goal-convergence mode
 * is active unless the author already started with `/goal`.
 */
export function formatGroupMessagePayload(input: {
  text: string;
  goalMode?: boolean;
}): string {
  const trimmed = input.text.trim();
  if (!trimmed) return "";
  if (!input.goalMode) return trimmed;
  if (/^\/goal(?:\s*[:：]|\s)/i.test(trimmed)) return trimmed;
  return `/goal ${trimmed}`;
}

/** Insert a `@BotName ` mention token into a composer draft cleanly. */
export function insertBotMention(draft: string, botName: string): string {
  const trimmedName = botName.trim();
  if (!trimmedName) return draft;
  const token = `@${trimmedName}`;
  if (!draft.trim()) return `${token} `;
  const prefix = /\s$/.test(draft) ? draft : `${draft} `;
  return `${prefix}${token} `;
}

export type GroupMentionSegment =
  | { kind: "text"; text: string; key: string }
  | { kind: "mention"; text: string; bot: GroupBotMember; key: string };

export type TrailingMentionMatch = {
  start: number;
  end: number;
  query: string;
  trigger: "@" | "＠";
};

export type MentionCompletionResult = {
  text: string;
  cursor: number;
};

const GOAL_COMMAND_RE = /^\/goal(?:\s*[:：]\s*|\s+)([\s\S]+)$/i;

function maskSpanWithSpaces(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) {
    if (chars[index] !== "\n" && chars[index] !== "\r") {
      chars[index] = " ";
    }
  }
}

/**
 * Mask non-prose spans (fenced code blocks including unclosed fences, blockquotes,
 * inline code spans, Markdown link targets, absolute URLs, and path fragments
 * containing `@`/`＠`) with equal-length spaces, aligned with `server/src/channels/group.ts`.
 */
export function maskNonProseMentions(text: string): string {
  const chars = text.split("");
  let offset = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;
  const lines = text.split("\n");
  for (const line of lines) {
    const lineLen = line.length;
    const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (fence) {
      maskSpanWithSpaces(chars, offset, offset + lineLen);
      const closeMatch = stripped.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      const closeRun = closeMatch?.[1];
      if (
        closeRun &&
        closeRun[0] === fence.char &&
        closeRun.length >= fence.length
      ) {
        fence = null;
      }
    } else {
      const openTick = stripped.match(/^[ \t]*(`{3,})([^`]*)$/);
      const openTilde = stripped.match(/^[ \t]*(~{3,})(.*)$/);
      const tickRun = openTick?.[1];
      const tildeRun = openTilde?.[1];
      if (tickRun) {
        fence = { char: "`", length: tickRun.length };
        maskSpanWithSpaces(chars, offset, offset + lineLen);
      } else if (tildeRun) {
        fence = { char: "~", length: tildeRun.length };
        maskSpanWithSpaces(chars, offset, offset + lineLen);
      } else if (/^[ \t]*>/.test(stripped)) {
        maskSpanWithSpaces(chars, offset, offset + lineLen);
      }
    }
    offset += lineLen + 1;
  }

  let current = chars.join("");
  let pos = 0;
  while (pos < current.length) {
    if (current[pos] !== "`") {
      pos += 1;
      continue;
    }
    let runEnd = pos + 1;
    while (runEnd < current.length && current[runEnd] === "`") runEnd += 1;
    const tickCount = runEnd - pos;
    let scan = runEnd;
    let closeEnd = -1;
    while (scan < current.length) {
      if (current[scan] !== "`") {
        scan += 1;
        continue;
      }
      let scanEnd = scan + 1;
      while (scanEnd < current.length && current[scanEnd] === "`") scanEnd += 1;
      if (scanEnd - scan === tickCount) {
        closeEnd = scanEnd;
        break;
      }
      scan = scanEnd;
    }
    if (closeEnd !== -1) {
      maskSpanWithSpaces(chars, pos, closeEnd);
      pos = closeEnd;
    } else {
      pos = runEnd;
    }
  }

  current = chars.join("");
  pos = 0;
  while (pos < current.length - 1) {
    const start = current.indexOf("](", pos);
    if (start === -1) break;
    let scan = start + 2;
    let depth = 1;
    let closed = false;
    while (scan < current.length) {
      const ch = current[scan];
      if (ch === "\\" && scan + 1 < current.length) {
        scan += 2;
        continue;
      }
      if (ch === "\n") {
        const rest = current.slice(scan + 1);
        if (/^[ \t]*\r?\n/.test(rest)) break;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          scan += 1;
          closed = true;
          break;
        }
      }
      scan += 1;
    }
    if (closed) {
      maskSpanWithSpaces(chars, start, scan);
      pos = scan;
    } else {
      pos = start + 2;
    }
  }

  current = chars.join("");
  for (const match of current.matchAll(/https?:\/\/[^\s<>"'`()[\]{}]+/gi)) {
    const idx = match.index;
    maskSpanWithSpaces(chars, idx, idx + match[0].length);
  }

  current = chars.join("");
  const pathPatterns = [
    /(?:[^\s"'`<>()[\]{}]*[\\/])+[@＠][^\s"'`<>()[\]{}]*/gu,
    /(?<![\p{L}\p{N}_./\\-])[@＠][\p{L}\p{N}._-]+(?:[\\/][^\s"'`<>()[\]{}]+)+/gu,
  ];
  for (const pattern of pathPatterns) {
    for (const match of current.matchAll(pattern)) {
      const idx = match.index;
      maskSpanWithSpaces(chars, idx, idx + match[0].length);
    }
  }

  return chars.join("");
}

/**
 * Split message text into plain-text and valid `@BotName` highlight segments,
 * using NFC normalization, full-width `＠` support, non-prose masking, and
 * longest-name-wins shadowing aligned with `mentionedPeers` on the server.
 */
export function splitGroupMentionSegments(
  text: string,
  bots: readonly GroupBotMember[],
): GroupMentionSegment[] {
  const normalizedText = text.normalize("NFC");
  if (!normalizedText) return [];
  if (bots.length === 0) {
    return [{ kind: "text", text: normalizedText, key: "0:text" }];
  }

  const prose = maskNonProseMentions(normalizedText);
  const hits: Array<{
    bot: GroupBotMember;
    start: number;
    end: number;
    length: number;
    rosterIndex: number;
  }> = [];

  for (const [rosterIndex, bot] of bots.entries()) {
    const normalizedName = bot.name.normalize("NFC").trim();
    if (!normalizedName) continue;
    const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])[@＠]${escaped}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    for (const match of prose.matchAll(pattern)) {
      const start = match.index;
      const length = match[0].length;
      hits.push({
        bot,
        start,
        end: start + length,
        length,
        rosterIndex,
      });
    }
  }

  if (hits.length === 0) {
    return [{ kind: "text", text: normalizedText, key: "0:text" }];
  }

  hits.sort(
    (left, right) =>
      left.start - right.start ||
      right.length - left.length ||
      left.rosterIndex - right.rosterIndex,
  );

  const segments: GroupMentionSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) {
      segments.push({
        kind: "text",
        text: normalizedText.slice(cursor, hit.start),
        key: `${cursor}:text`,
      });
    }
    segments.push({
      kind: "mention",
      text: normalizedText.slice(hit.start, hit.end),
      bot: hit.bot,
      key: `${hit.start}:mention:${hit.bot.id}`,
    });
    cursor = hit.end;
  }

  if (cursor < normalizedText.length) {
    segments.push({
      kind: "text",
      text: normalizedText.slice(cursor),
      key: `${cursor}:text`,
    });
  }

  return segments;
}

/**
 * Detect a trailing `@`/`＠` mention trigger directly before `cursor`,
 * excluding email addresses, URLs, markdown link targets, and path fragments.
 */
export function detectTrailingMention(
  draft: string,
  cursor: number,
): TrailingMentionMatch | null {
  const clamped = Math.max(0, Math.min(cursor, draft.length));
  const beforeCursor = draft.slice(0, clamped);
  const tokenMatch = beforeCursor.match(/(\S+)$/);
  if (!tokenMatch) return null;

  const token = tokenMatch[1] ?? "";
  if (!token || /^https?:\/\//i.test(token) || /[\\/]/.test(token)) {
    return null;
  }

  const atIndex = Math.max(token.lastIndexOf("@"), token.lastIndexOf("＠"));
  if (atIndex === -1) return null;

  const beforeAt = token.slice(0, atIndex);
  if (/\]\([^)]*$/.test(beforeAt)) return null;

  const prevChar = beforeAt.slice(-1);
  if (prevChar && /[\p{L}\p{N}_./\\-]/u.test(prevChar)) {
    return null;
  }

  const triggerChar = token[atIndex];
  const trigger: "@" | "＠" = triggerChar === "＠" ? "＠" : "@";
  const tokenStart = clamped - token.length;
  return {
    start: tokenStart + atIndex,
    end: clamped,
    query: token.slice(atIndex + 1),
    trigger,
  };
}

/**
 * Replace the trailing `@`/`＠` trigger at `cursor` with `@BotName ` and
 * return both the updated text and the new caret offset.
 */
export function applyMentionCompletion(
  draft: string,
  cursor: number,
  botName: string,
): MentionCompletionResult {
  const clamped = Math.max(0, Math.min(cursor, draft.length));
  const trimmedName = botName.trim();
  if (!trimmedName) {
    return { text: draft, cursor: clamped };
  }

  const match = detectTrailingMention(draft, clamped);
  const mentionToken = `@${trimmedName}`;
  if (match) {
    const before = draft.slice(0, match.start);
    const after = draft.slice(match.end);
    const spacer = after.startsWith(" ") ? "" : " ";
    const text = `${before}${mentionToken}${spacer}${after}`;
    return {
      text,
      cursor: match.start + mentionToken.length + 1,
    };
  }

  const before = draft.slice(0, clamped);
  const after = draft.slice(clamped);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.startsWith(" ") ? "" : " ";
  const text = `${before}${leading}${mentionToken}${trailing}${after}`;
  return {
    text,
    cursor: before.length + leading.length + mentionToken.length + 1,
  };
}

function isGoalPromptText(text: string): boolean {
  const match = text.trim().match(GOAL_COMMAND_RE);
  return Boolean(match?.[1]?.trim());
}

/**
 * Identify the converged final Bot deliverable message IDs for `/goal` rounds.
 * A `/goal` human round converges only when it has no active (`queued`/`running`/`waiting`)
 * Bot replies and has at least one valid `completed` Bot reply; the last valid reply wins.
 */
export function detectGoalDeliverableIds(
  messages: readonly GroupTranscriptMessage[],
): Set<string> {
  const deliverableIds = new Set<string>();
  let inGoalRound = false;
  let hasActive = false;
  let lastCompletedId: string | null = null;

  const flushRound = () => {
    if (inGoalRound && !hasActive && lastCompletedId !== null) {
      deliverableIds.add(lastCompletedId);
    }
  };

  for (const message of messages) {
    if (message.agentId === null) {
      flushRound();
      inGoalRound = isGoalPromptText(message.text);
      hasActive = false;
      lastCompletedId = null;
      continue;
    }

    if (!inGoalRound) continue;
    if (
      message.status === "queued" ||
      message.status === "running" ||
      message.status === "waiting"
    ) {
      hasActive = true;
    } else if (
      message.status === "completed" &&
      !message.consent &&
      message.text.trim().length > 0
    ) {
      lastCompletedId = message.id;
    }
  }

  flushRound();
  return deliverableIds;
}

const MARKDOWN_STATUS_LABEL: Record<GroupMessageStatus, string> = {
  queued: "排队中",
  running: "生成中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "执行失败",
};

/** Format a group transcript (including `/goal` deliverable markers) as Markdown. */
export function formatGroupTranscriptMarkdown(
  channelName: string,
  messages: readonly GroupTranscriptMessage[],
  botNameMap: ReadonlyMap<string, string> = new Map(),
): string {
  const title = channelName.trim() || "多 Bot 群聊";
  const deliverableIds = detectGoalDeliverableIds(messages);
  const blocks = messages.map((message) => {
    const speaker =
      message.agentId === null
        ? "你"
        : (botNameMap.get(message.agentId) ?? message.agentId);
    const answeredBy = message.answeredBy
      ? `（代答 · ${botNameMap.get(message.answeredBy) ?? message.answeredBy}）`
      : "";
    const statusSuffix =
      message.agentId !== null && message.status !== "completed"
        ? ` · [${MARKDOWN_STATUS_LABEL[message.status]}]`
        : "";
    const deliverableSuffix = deliverableIds.has(message.id)
      ? " · [目标结论]"
      : "";
    const bodyParts = [message.text.trim()].filter(Boolean);
    if (message.reason?.trim()) {
      bodyParts.push(`> ${message.reason.trim()}`);
    }
    const body = bodyParts.join("\n\n") || "（暂无正文内容）";
    return `## ${speaker}${answeredBy} · ${message.createdAt}${statusSuffix}${deliverableSuffix}\n\n${body}`;
  });

  if (blocks.length === 0) {
    return `# ${title}\n\n（暂无群聊记录）`;
  }
  return `# ${title}\n\n${blocks.join("\n\n---\n\n")}`;
}

export async function fetchGroupDetail(
  channelId: string,
  signal?: AbortSignal,
): Promise<GroupConversationDetail> {
  const response = await client(
    `/api/groups/${encodeURIComponent(channelId)}`,
    {
      signal,
      fallback: "无法加载群聊内容",
    },
  );
  const parsed = parseGroupDetail(await response.json().catch(() => null));
  if (!parsed) {
    throw new Error("无法加载群聊内容");
  }
  return parsed;
}

/**
 * Non-throwing probe for whether the current member can view this group via `/api/groups/:id`.
 * Uses `tryClient` so 403/404 refusals return as typed status answers rather than exceptions.
 */
export async function checkGroupAccess(
  channelId: string,
  signal?: AbortSignal,
): Promise<GroupAccessProbe> {
  const response = await tryClient(
    `/api/groups/${encodeURIComponent(channelId)}`,
    { signal },
  );
  if (!response.ok) {
    return { available: false, status: response.status };
  }
  const parsed = parseGroupDetail(await response.json().catch(() => null));
  if (!parsed) {
    return { available: false, status: 500 };
  }
  return { available: true, detail: parsed };
}

export function groupDetailQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: ({ signal }): Promise<GroupConversationDetail> =>
      fetchGroupDetail(channelId, signal),
  });
}

export function groupMembersQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.members(channelId),
    queryFn: async ({ signal }): Promise<GroupMembersSummary> => {
      const detail = await fetchGroupDetail(channelId, signal);
      return { bots: detail.bots, people: detail.people };
    },
  });
}

export async function sendGroupMessage(
  input: SendGroupMessageInput,
): Promise<SendGroupMessageResult> {
  const formattedText = formatGroupMessagePayload({
    text: input.text,
    goalMode: input.goalMode,
  });
  const response = await client(
    `/api/groups/${encodeURIComponent(input.channelId)}`,
    {
      method: "POST",
      body: {
        id: input.id,
        text: formattedText,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      },
      fallback: FALLBACK,
    },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (isRecord(body) && typeof body.id === "string") {
    return { id: body.id, queued: body.queued === true };
  }
  return { id: input.id, queued: true };
}

function invalidateGroup(queryClient: QueryClient, channelId: string) {
  void queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) });
  void queryClient.invalidateQueries({
    queryKey: groupKeys.members(channelId),
  });
}

export function sendGroupMessageMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      input: SendGroupMessageInput,
    ): Promise<SendGroupMessageResult> => sendGroupMessage(input),
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}

export function addGroupMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      email: string;
    }): Promise<{ userId: string }> => {
      const response = await client(
        `/api/groups/${encodeURIComponent(variables.channelId)}/members`,
        {
          method: "POST",
          body: { email: variables.email },
          fallback: FALLBACK,
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (isRecord(body) && typeof body.userId === "string") {
        return { userId: body.userId };
      }
      throw new Error(FALLBACK);
    },
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}

export function removeGroupMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      userId: string;
    }): Promise<void> => {
      await client(
        `/api/groups/${encodeURIComponent(variables.channelId)}/members/${encodeURIComponent(variables.userId)}`,
        {
          method: "DELETE",
          fallback: FALLBACK,
        },
      );
    },
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}
