import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { clipTitle } from "../bot-threads";
import type { Database } from "../db/client";
import { publicErrorMessage } from "../public-error";
import { INBOX_TEXT_LIMIT } from "../thread-inbox";
import type { TurnRunner } from "../turns/types";

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ANCHOR_ID_MAX = 200;
const INBOX_ID_MAX = 128;
const DEFAULT_DIGEST_MAX_MESSAGES = 12;
const MAX_DIGEST_MESSAGE_CHARS = 400;
const MAX_DIGEST_TOTAL_CHARS = 4_000;
const DEFAULT_SIDE_THREAD_TITLE = "新侧边提问";

const DATA_URI_BASE64_PATTERN =
  /data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]{16,}/g;
const LONG_BASE64_BLOB_PATTERN =
  /(?<![A-Za-z0-9_/-])[A-Za-z0-9+/]{128,}={0,2}(?![A-Za-z0-9_/-])/g;

export class SideThreadNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "侧边问答会话不存在") {
    super(message);
    this.name = "SideThreadNotFoundError";
  }
}

export class SideThreadValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 = 400,
  ) {
    super(message);
    this.name = "SideThreadValidationError";
  }
}

export type SideThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

export type SideThreadSummary = {
  id: string;
  parentThreadId: string;
  anchorMessageId: string | null;
  agentId: string;
  title: string;
  messageCount: number;
  contextDigest: string;
  createdAt: string;
  updatedAt: string;
};

export type SideThreadRecord = SideThreadSummary & {
  messages: SideThreadMessage[];
};

export type SideQuestionInput = {
  ownerUserId: string;
  agentId: string;
  sideThreadId: string;
  parentThreadId: string;
  anchorMessageId: string | null;
  contextDigest: string;
  history: readonly SideThreadMessage[];
  question: string;
  instruction: string;
};

export type AskSideQuestion = (
  input: SideQuestionInput,
) => Promise<string | { replyText: string }>;

export type SideThreadStoreOptions = {
  askSideQuestion?: AskSideQuestion;
  runSideTurn?: AskSideQuestion;
  runTurn?: TurnRunner;
};

export type SteerInboxPayload = {
  id: string;
  text: string;
};

export type SteerParentThreadHandler = (input: {
  ownerUserId: string;
  parentThreadId: string;
  id: string;
  text: string;
}) => Promise<Record<string, unknown>>;

type SideThreadRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  name: string | null;
  messages: unknown;
  state: unknown;
  thread_kind: string | null;
  parent_thread_id: string | null;
  anchor_message_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const SIDE_COLUMNS =
  "id, owner_user_id, agent_id, name, messages, state, thread_kind, parent_thread_id, anchor_message_id, created_at, updated_at";

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function sanitizeDigestText(raw: string): string {
  const scrubbed = raw
    .replace(DATA_URI_BASE64_PATTERN, "[已省略 base64 数据]")
    .replace(LONG_BASE64_BLOB_PATTERN, "[已省略编码数据]")
    .replace(/\s+/g, " ")
    .trim();
  return clipWithEllipsis(scrubbed, MAX_DIGEST_MESSAGE_CHARS);
}

function extractDigestContent(content: unknown): string {
  if (typeof content === "string") return sanitizeDigestText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.length ? sanitizeDigestText(parts.join(" ")) : "";
}

export function buildSideContextDigest(
  messages: readonly unknown[],
  anchorMessageId?: string | null,
  maxMessages = DEFAULT_DIGEST_MAX_MESSAGES,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const limit = Number.isFinite(maxMessages) ? Math.floor(maxMessages) : 0;
  if (limit <= 0) return "";

  const normalizedAnchor =
    typeof anchorMessageId === "string" && anchorMessageId.trim()
      ? anchorMessageId.trim()
      : null;

  let windowEnd = messages.length;
  if (normalizedAnchor) {
    const anchorIndex = messages.findIndex(
      (item) => isPlainObject(item) && item.id === normalizedAnchor,
    );
    if (anchorIndex >= 0) {
      windowEnd = anchorIndex + 1;
    }
  }

  const lines: string[] = [];
  for (let index = 0; index < windowEnd; index += 1) {
    const entry = messages[index];
    if (!isPlainObject(entry)) continue;
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = extractDigestContent(entry.content);
    if (!text) continue;
    const speaker = entry.role === "user" ? "用户" : "助手";
    const anchorPrefix =
      normalizedAnchor && entry.id === normalizedAnchor ? "[锚点] " : "";
    lines.push(`${anchorPrefix}${speaker}: ${text}`);
  }

  if (lines.length === 0) return "";
  const recent = lines.slice(-limit);
  const kept: string[] = [];
  let total = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const line = recent[index];
    if (!line) continue;
    const extra = kept.length > 0 ? line.length + 1 : line.length;
    if (total + extra > MAX_DIGEST_TOTAL_CHARS) {
      if (kept.length === 0) {
        kept.unshift(clipWithEllipsis(line, MAX_DIGEST_TOTAL_CHARS));
      }
      break;
    }
    kept.unshift(line);
    total += extra;
  }
  return kept.join("\n");
}

/**
 * 裁掉末尾尚未闭合工具结果的悬挂 tool_call 轮次，保证侧边上下文落在完整边界。
 */
export function trimToolBoundary<
  T extends {
    role?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
    toolCallId?: unknown;
    tool_call_id?: unknown;
  },
>(messages: readonly T[]): T[] {
  let end = messages.length;
  while (end > 0) {
    let probe = end - 1;
    const answeredIds = new Set<string>();
    while (probe >= 0 && messages[probe]?.role === "tool") {
      const toolMsg = messages[probe];
      const id =
        typeof toolMsg?.toolCallId === "string"
          ? toolMsg.toolCallId
          : typeof toolMsg?.tool_call_id === "string"
            ? toolMsg.tool_call_id
            : undefined;
      if (id) answeredIds.add(id);
      probe -= 1;
    }
    const candidate = probe >= 0 ? messages[probe] : undefined;
    const rawCalls =
      candidate?.role === "assistant"
        ? Array.isArray(candidate.toolCalls)
          ? candidate.toolCalls
          : Array.isArray(candidate.tool_calls)
            ? candidate.tool_calls
            : []
        : [];
    const callIds = rawCalls
      .map((call) =>
        isPlainObject(call) && typeof call.id === "string"
          ? call.id
          : undefined,
      )
      .filter((id): id is string => Boolean(id));
    if (candidate?.role === "assistant" && callIds.length > 0) {
      const complete = callIds.every((id) => answeredIds.has(id));
      if (!complete) {
        end = probe;
        continue;
      }
      break;
    }
    if (probe < end - 1) {
      end = probe + 1;
      continue;
    }
    break;
  }
  return messages.slice(0, end);
}

export function buildSteerInboxPayload(
  id: string,
  text: string,
): SteerInboxPayload {
  const cleanId = typeof id === "string" ? id.trim() : "";
  if (!cleanId || cleanId.length > INBOX_ID_MAX) {
    throw new SideThreadValidationError("补充指令消息 id 无效", 400);
  }
  const cleanText = typeof text === "string" ? text.trim() : "";
  if (!cleanText) {
    throw new SideThreadValidationError("补充指令内容不能为空", 400);
  }
  if (cleanText.length > INBOX_TEXT_LIMIT) {
    throw new SideThreadValidationError("补充指令过长", 413);
  }
  return { id: cleanId, text: cleanText };
}

function normalizeQuestionText(text: string): string {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) {
    throw new SideThreadValidationError("提问内容不能为空", 400);
  }
  if (clean.length > INBOX_TEXT_LIMIT) {
    throw new SideThreadValidationError("提问内容过长", 413);
  }
  return clean;
}

function normalizeAnchorMessageId(
  anchorMessageId: string | null | undefined,
): string | null {
  if (anchorMessageId === undefined || anchorMessageId === null) return null;
  if (typeof anchorMessageId !== "string") {
    throw new SideThreadValidationError("anchorMessageId 无效", 400);
  }
  const clean = anchorMessageId.trim();
  if (!clean) return null;
  if (clean.length > ANCHOR_ID_MAX || /[\r\n\0]/.test(clean)) {
    throw new SideThreadValidationError("anchorMessageId 无效", 400);
  }
  return clean;
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseStoredMessages(raw: unknown): SideThreadMessage[] {
  const value = parseJsonValue(raw);
  if (!Array.isArray(value)) return [];
  const messages: SideThreadMessage[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (typeof item.id !== "string" || typeof item.content !== "string")
      continue;
    messages.push({
      id: item.id,
      role: item.role,
      content: item.content,
      ...(typeof item.createdAt === "string"
        ? { createdAt: item.createdAt }
        : {}),
    });
  }
  return messages;
}

function parseContextDigest(rawState: unknown): string {
  const value = parseJsonValue(rawState);
  if (!isPlainObject(value)) return "";
  return typeof value.contextDigest === "string" ? value.contextDigest : "";
}

function buildSideTurnInstruction(input: {
  contextDigest: string;
  history: readonly SideThreadMessage[];
  question: string;
}): string {
  const sections: string[] = [
    "你正在主对话之外的独立侧边问答（/side）中回答用户提问，回答不会写入主对话历史。",
  ];
  if (input.contextDigest) {
    sections.push(`【主对话只读背景摘要】\n${input.contextDigest}`);
  }
  if (input.history.length > 0) {
    const recentHistory = input.history
      .slice(-DEFAULT_DIGEST_MAX_MESSAGES)
      .map(
        (message) =>
          `${message.role === "user" ? "用户" : "助手"}: ${message.content}`,
      )
      .join("\n");
    sections.push(`【本侧边问答历史】\n${recentHistory}`);
  }
  sections.push(`【当前提问】\n${input.question}`);
  return sections.join("\n\n");
}

function toSideThreadSummary(
  row: SideThreadRow,
  messages: readonly SideThreadMessage[],
): SideThreadSummary {
  const firstUser = messages.find((message) => message.role === "user");
  const title =
    clipTitle(row.name) ||
    clipTitle(firstUser?.content) ||
    DEFAULT_SIDE_THREAD_TITLE;
  return {
    id: row.id,
    parentThreadId: row.parent_thread_id ?? "",
    anchorMessageId: row.anchor_message_id ?? null,
    agentId: row.agent_id,
    title,
    messageCount: messages.length,
    contextDigest: parseContextDigest(row.state),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSideThreadRecord(row: SideThreadRow): SideThreadRecord {
  const messages = parseStoredMessages(row.messages);
  return {
    ...toSideThreadSummary(row, messages),
    messages,
  };
}

function assertValidThreadId(value: string, label: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!THREAD_ID.test(clean)) {
    throw new SideThreadValidationError(`${label} 无效`, 400);
  }
  return clean;
}

function resolveSideRunner(
  options: SideThreadStoreOptions,
): ((input: SideQuestionInput) => Promise<string>) | undefined {
  const custom = options.askSideQuestion ?? options.runSideTurn;
  if (custom) {
    return async (input) => {
      const answer = await custom(input);
      return typeof answer === "string" ? answer : answer.replyText;
    };
  }
  const turnRunner = options.runTurn;
  if (!turnRunner) return undefined;
  return async (input) => {
    const result = await turnRunner({
      ownerUserId: input.ownerUserId,
      routineId: "side-thread",
      agentId: input.agentId,
      threadId: input.sideThreadId,
      instruction: input.instruction,
      userMessage: {
        id: `sm_${randomUUID()}`,
        role: "user",
        content: input.question,
      },
    });
    return result.replyText;
  };
}

export function createSideThreadStore(
  database: Database,
  options: SideThreadStoreOptions = {},
) {
  const sql = database.$client;
  const sideAnswerRunner = resolveSideRunner(options);

  async function loadOwnedSideRow(
    ownerUserId: string,
    sideThreadId: string,
  ): Promise<SideThreadRow> {
    const cleanSideId = assertValidThreadId(sideThreadId, "sideThreadId");
    const rows = await sql.unsafe<SideThreadRow[]>(
      `SELECT ${SIDE_COLUMNS}
       FROM chisabot_local_threads
       WHERE id = $1
         AND owner_user_id = $2
         AND thread_kind = 'side'`,
      [cleanSideId, ownerUserId],
    );
    const row = rows[0];
    if (!row) throw new SideThreadNotFoundError();
    return row;
  }

  async function create(input: {
    ownerUserId: string;
    parentThreadId: string;
    anchorMessageId?: string | null;
  }): Promise<SideThreadRecord> {
    const ownerUserId = input.ownerUserId.trim();
    if (!ownerUserId) {
      throw new SideThreadValidationError("ownerUserId 无效", 400);
    }
    const parentThreadId = assertValidThreadId(
      input.parentThreadId,
      "parentThreadId",
    );
    const anchorMessageId = normalizeAnchorMessageId(input.anchorMessageId);

    const parentRows = await sql.unsafe<SideThreadRow[]>(
      `SELECT ${SIDE_COLUMNS}
       FROM chisabot_local_threads
       WHERE id = $1`,
      [parentThreadId],
    );
    const parent = parentRows[0];
    if (!parent || parent.owner_user_id !== ownerUserId) {
      throw new SideThreadNotFoundError("主对话不存在");
    }
    if ((parent.thread_kind ?? "primary") === "side") {
      throw new SideThreadValidationError(
        "不允许在侧边问答会话中再嵌套侧边问答",
        400,
      );
    }

    const rawParentMessages = parseJsonValue(parent.messages);
    const parentMessages = Array.isArray(rawParentMessages)
      ? trimToolBoundary(rawParentMessages)
      : [];
    const contextDigest = buildSideContextDigest(
      parentMessages,
      anchorMessageId,
    );
    const sideThreadId = `side_${randomUUID()}`;
    const statePayload = JSON.stringify({ contextDigest });

    const inserted = await sql.unsafe<SideThreadRow[]>(
      `INSERT INTO chisabot_local_threads (
         id, owner_user_id, agent_id, name, messages, state, thread_kind, parent_thread_id, anchor_message_id
       ) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, 'side', $7, $8)
       RETURNING ${SIDE_COLUMNS}`,
      [
        sideThreadId,
        ownerUserId,
        parent.agent_id,
        null,
        "[]",
        statePayload,
        parentThreadId,
        anchorMessageId,
      ],
    );
    const created = inserted[0];
    if (!created) {
      throw new Error("创建侧边问答会话失败");
    }
    return toSideThreadRecord(created);
  }

  async function list(
    ownerUserId: string,
    parentThreadId: string,
  ): Promise<SideThreadSummary[]> {
    const cleanParentId = assertValidThreadId(parentThreadId, "parentThreadId");
    const rows = await sql.unsafe<SideThreadRow[]>(
      `SELECT ${SIDE_COLUMNS}
       FROM chisabot_local_threads
       WHERE owner_user_id = $1
         AND thread_kind = 'side'
         AND parent_thread_id = $2
       ORDER BY updated_at DESC, created_at DESC`,
      [ownerUserId, cleanParentId],
    );
    return rows.map((row) =>
      toSideThreadSummary(row, parseStoredMessages(row.messages)),
    );
  }

  async function get(
    ownerUserId: string,
    sideThreadId: string,
  ): Promise<SideThreadRecord> {
    const row = await loadOwnedSideRow(ownerUserId, sideThreadId);
    return toSideThreadRecord(row);
  }

  async function ask(
    ownerUserId: string,
    sideThreadId: string,
    text: string,
  ): Promise<{ thread: SideThreadRecord; reply: SideThreadMessage | null }> {
    const question = normalizeQuestionText(text);
    const row = await loadOwnedSideRow(ownerUserId, sideThreadId);
    const history = parseStoredMessages(row.messages);
    const contextDigest = parseContextDigest(row.state);
    const parentThreadId = row.parent_thread_id ?? "";

    const userMessage: SideThreadMessage = {
      id: `sm_${randomUUID()}`,
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
    };

    let replyMessage: SideThreadMessage | null = null;
    if (sideAnswerRunner) {
      const instruction = buildSideTurnInstruction({
        contextDigest,
        history,
        question,
      });
      const replyText = await sideAnswerRunner({
        ownerUserId,
        agentId: row.agent_id,
        sideThreadId: row.id,
        parentThreadId,
        anchorMessageId: row.anchor_message_id ?? null,
        contextDigest,
        history,
        question,
        instruction,
      });
      replyMessage = {
        id: `sm_${randomUUID()}`,
        role: "assistant",
        content: replyText,
        createdAt: new Date().toISOString(),
      };
    }

    const nextMessages = replyMessage
      ? [...history, userMessage, replyMessage]
      : [...history, userMessage];
    const autoTitle = clipTitle(question) || null;

    const updated = await sql.unsafe<SideThreadRow[]>(
      `UPDATE chisabot_local_threads
       SET name = COALESCE(name, $3),
           messages = $4::text::jsonb,
           updated_at = now()
       WHERE id = $1
         AND owner_user_id = $2
         AND thread_kind = 'side'
       RETURNING ${SIDE_COLUMNS}`,
      [row.id, ownerUserId, autoTitle, JSON.stringify(nextMessages)],
    );
    const updatedRow = updated[0];
    if (!updatedRow) throw new SideThreadNotFoundError();
    return {
      thread: toSideThreadRecord(updatedRow),
      reply: replyMessage,
    };
  }

  async function remove(
    ownerUserId: string,
    sideThreadId: string,
  ): Promise<void> {
    const cleanSideId = assertValidThreadId(sideThreadId, "sideThreadId");
    const removed = await sql.unsafe<{ id: string }[]>(
      `DELETE FROM chisabot_local_threads
       WHERE id = $1
         AND owner_user_id = $2
         AND thread_kind = 'side'
       RETURNING id`,
      [cleanSideId, ownerUserId],
    );
    if (!removed.length) throw new SideThreadNotFoundError();
  }

  return { create, list, get, ask, remove };
}

export type SideThreadStore = ReturnType<typeof createSideThreadStore>;

export function createSideThreadRoutes(
  store: SideThreadStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: { steerParentThread?: SteerParentThreadHandler } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  const errorResponse = (
    c: Context<{ Variables: AppVariables }>,
    error: unknown,
  ) => {
    if (error instanceof SideThreadNotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof SideThreadValidationError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: publicErrorMessage(error) }, 500);
  };

  app.get("/", async (c) => {
    try {
      const parentThreadId = c.req.query("parentThreadId") ?? "";
      const threads = await store.list(c.var.actor.id, parentThreadId);
      c.header("Cache-Control", "no-store");
      return c.json({ threads });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as unknown;
      if (!isPlainObject(body)) {
        throw new SideThreadValidationError("请求体必须是 JSON 对象", 400);
      }
      if (typeof body.parentThreadId !== "string") {
        throw new SideThreadValidationError("parentThreadId 是必填项", 400);
      }
      const anchorMessageId = body.anchorMessageId;
      if (
        anchorMessageId !== undefined &&
        anchorMessageId !== null &&
        typeof anchorMessageId !== "string"
      ) {
        throw new SideThreadValidationError("anchorMessageId 必须是文本", 400);
      }
      if (
        body.question !== undefined &&
        body.question !== null &&
        typeof body.question !== "string"
      ) {
        throw new SideThreadValidationError("question 必须是文本", 400);
      }
      const initialQuestion =
        typeof body.question === "string" && body.question.trim()
          ? normalizeQuestionText(body.question)
          : null;

      const created = await store.create({
        ownerUserId: c.var.actor.id,
        parentThreadId: body.parentThreadId,
        anchorMessageId,
      });

      if (initialQuestion) {
        const asked = await store.ask(
          c.var.actor.id,
          created.id,
          initialQuestion,
        );
        return c.json({ thread: asked.thread, reply: asked.reply }, 201);
      }
      return c.json({ thread: created }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  if (options.steerParentThread) {
    const steerParentThread = options.steerParentThread;
    app.post("/steer", async (c) => {
      try {
        const body = (await c.req.json().catch(() => null)) as unknown;
        if (!isPlainObject(body)) {
          throw new SideThreadValidationError("请求体必须是 JSON 对象", 400);
        }
        const parentThreadId = assertValidThreadId(
          typeof body.parentThreadId === "string" ? body.parentThreadId : "",
          "parentThreadId",
        );
        const messageId = typeof body.id === "string" ? body.id : randomUUID();
        const payload = buildSteerInboxPayload(
          messageId,
          typeof body.text === "string" ? body.text : "",
        );
        const result = await steerParentThread({
          ownerUserId: c.var.actor.id,
          parentThreadId,
          ...payload,
        });
        return c.json(result);
      } catch (error) {
        return errorResponse(c, error);
      }
    });
  }

  app.get("/:sideThreadId", async (c) => {
    try {
      const sideThreadId = c.req.param("sideThreadId");
      const thread = await store.get(c.var.actor.id, sideThreadId);
      c.header("Cache-Control", "no-store");
      return c.json({ thread });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/:sideThreadId/messages", async (c) => {
    try {
      const sideThreadId = c.req.param("sideThreadId");
      const body = (await c.req.json().catch(() => null)) as unknown;
      if (!isPlainObject(body) || typeof body.text !== "string") {
        throw new SideThreadValidationError("提问内容必须是文本", 400);
      }
      const { thread, reply } = await store.ask(
        c.var.actor.id,
        sideThreadId,
        body.text,
      );
      return c.json({ thread, reply });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete("/:sideThreadId", async (c) => {
    try {
      const sideThreadId = c.req.param("sideThreadId");
      await store.remove(c.var.actor.id, sideThreadId);
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}
