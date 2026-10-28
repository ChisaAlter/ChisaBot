import type { Message } from "@ag-ui/core";
import { MessageSchema } from "@ag-ui/core/schemas";
import { tryClient } from "@/lib/client";
import { applyStoredAnswer, type StoredSync } from "./thread-sync";

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * A plain fail-closed function rather than a query. Nothing caches it — the transcript this seeds is
 * then owned by the running agent, so a cached copy would be a second version of the same
 * conversation — and an unreadable history is not a reason to keep somebody from typing. Every
 * failure returns nothing and lets the composer open.
 *
 * WHAT ARRIVES HERE IS NOT TRUSTED. This used to end `stored as Message[]`, which is a cast rather
 * than a check: whatever the history store held was handed to `setMessages` and then to every
 * projection that reads a transcript. A turn shaped differently reached a renderer that dereferenced
 * `toolCall.function.arguments` and took the whole conversation down with it. One bad turn made a
 * thread unreadable.
 *
 * So each turn is parsed against the schema AG-UI ships, and one that does not parse is left out.
 * Checked here rather than in a projection because there are several projections and one history:
 * fixing it in the reader that is closest to the wire is what makes every consumer safe at once.
 *
 * BUT `{id, name, args}` IS NOT A CORRUPTION, AND TREATING IT AS ONE DELETED REAL WORK. That shape
 * was read as damage from an interrupted run and dropped. It is how the runtime persists every tool
 * call it stores, so dropping it meant every turn in which a Bot used a tool vanished on reload: the
 * transcript kept the sentence the Bot wrote and lost the browsing that produced it, the inline
 * screen went with it, and the footer said some messages could not be read. Observed against a live
 * thread, where every browsing turn was counted unreadable and every one of them was well formed in
 * the store's own dialect.
 *
 * So it is translated rather than refused. The check stays for turns that really are malformed; a
 * reader is entitled to insist on one shape, but not to throw away the history because the writer
 * spells it another way.
 */

/**
 * What a read gives back: the turns that parsed, and how many did not.
 *
 * The count is returned rather than logged. A turn quietly missing from a record people read back is
 * worse than a visible failure — it is a conversation that reads as though it never had that message,
 * with nothing to say otherwise. The caller is expected to say so on screen.
 */
export type StoredThread = {
  messages: Message[];
  /** Zero on every ordinary read. Above zero means the history store holds something unreadable. */
  unreadable: number;
  /**
   * `"unavailable"` means the history endpoint failed or could not be read. It is not evidence that
   * the thread is empty or belongs to another project.
   */
  availability: "ready" | "unavailable";
};

const UNAVAILABLE_THREAD: StoredThread = {
  messages: [],
  unreadable: 0,
  availability: "unavailable",
};

/*
 * 首次读取的期限。以前是 1.5 秒：服务器稍慢（冷启动、长会话）就判定「无法加载」，于是聊天框上方出现
 * 「较早的消息暂时无法加载」，可实际上再等一两秒就读到了。首次读取完成前，第一条消息会排队等它，
 * 所以这里不能无限等：4 秒后先放行，读取失败再由 HISTORY_RETRY_DELAYS_MS 在后台继续重试。
 */
const THREAD_MESSAGES_DEADLINE_MS = 4000;
/** 后台重试与「重试」按钮用的期限：不挡住任何操作，可以等久一点。 */
export const THREAD_MESSAGES_RETRY_DEADLINE_MS = 15000;
/** 首次读取失败后，后台再试的间隔（毫秒）。全部失败、且会话里什么也没恢复出来时才提示。 */
export const HISTORY_RETRY_DELAYS_MS = [1500, 4000, 10000] as const;

type ReadThreadMessagesOptions = {
  /** Shorter only in tests; production uses the mount/send ordering deadline. */
  deadlineMs?: number;
};

/**
 * The turns that parse, kept in order, and a count of the ones that did not.
 *
 * Exported so it can be tested against real stored shapes without a server. Takes `unknown[]`
 * because that is honestly what the wire gives.
 *
 * THE ORIGINAL OBJECT IS KEPT, not `parsed.data`. Zod strips keys a schema does not name, so
 * returning the parsed copy would quietly drop anything the runtime carries and this file has not
 * heard of — turning a validation step into a silent rewrite of every message that passed. The parse
 * is asked whether the turn is well formed; it is not asked to decide what the turn contains.
 */
export function readableTurns(stored: readonly unknown[]): StoredThread {
  const messages: Message[] = [];
  let unreadable = 0;

  for (const turn of stored) {
    const candidate = withNormalisedToolCalls(
      withoutNullAssistantContent(turn),
    );
    if (MessageSchema.safeParse(candidate).success) {
      messages.push(candidate as Message);
    } else {
      unreadable += 1;
    }
  }

  return { messages, unreadable, availability: "ready" };
}

/**
 * An assistant turn whose content is `null`, read as one that simply has no content.
 *
 * The schema makes an assistant's content optional and does not allow it to be null, so the two say
 * the same thing and only one parses. A turn that called a tool and said nothing alongside it is
 * written exactly that way, so this dropped the browsing and kept nothing in its place: the same
 * loss the tool-call dialect caused, arriving by a different route.
 *
 * ASSISTANT ONLY. A user turn's content is required, and `content: null` there is not a message
 * somebody sent; it used to reach a projection and draw as a blank line, which is why it is refused
 * and counted rather than quietly shown. That decision stands.
 */
function withoutNullAssistantContent(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const record = turn as Record<string, unknown>;
  if (record.role !== "assistant" || record.content !== null) return turn;
  const { content: _dropped, ...rest } = record;
  return rest;
}

/** A tool call as the history store writes one. */
type StoredToolCall = { id?: unknown; name?: unknown; args?: unknown };

/**
 * The store's dialect for a tool call, in the shape AG-UI describes.
 *
 * `{id, name, args}` becomes `{id, type: "function", function: {name, arguments}}`. Only the array is
 * rebuilt and only when every entry is in that dialect: a turn already in AG-UI's shape is returned
 * untouched, and a mixed or unrecognised array is left exactly as it came so the parse below still
 * refuses it rather than this quietly inventing something.
 *
 * The rest of the message is spread through unchanged, for the same reason `parsed.data` is not used
 * anywhere here: a reader that rewrites what it does not recognise is worse than one that refuses it.
 */
function withNormalisedToolCalls(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const calls = (turn as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return turn;

  const isStoredDialect = (call: unknown): call is StoredToolCall =>
    typeof call === "object" &&
    call !== null &&
    "name" in call &&
    "args" in call &&
    !("function" in call);
  if (!calls.every(isStoredDialect)) return turn;

  return {
    ...(turn as Record<string, unknown>),
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: argumentsOf(call.args) },
    })),
  };
}

/**
 * The arguments, as a string, because that is what the protocol says they are.
 *
 * AG-UI types `arguments` as a string and the store is under no such obligation: it holds whatever
 * the run put there, which for a tool called with structured input is an object. Passing that through
 * produced a call that looked translated and still failed validation, so the turn was dropped anyway.
 * That is this whole function's bug one layer down, which is a good reason to be explicit here rather
 * than to trust the shapes to line up.
 *
 * A string is already right and is left exactly as it is, down to its whitespace: it may be a
 * fragment of a stream that was never valid JSON, and re-encoding it would change what the model
 * actually said. Anything else is encoded. `undefined` becomes `"{}"`, which is what a call with no
 * arguments means and what every reader of this field expects to parse.
 */
function argumentsOf(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    // Circular, or something else that cannot be encoded. An empty object is a call the reader can
    // parse; a throw here would lose the whole conversation over one malformed argument list.
    return "{}";
  }
}

/*
 * 增量读存储（配合服务器 `…/messages?since=&cursor=`，见 server/src/thread-messages-delta.ts）。
 *
 * 每条对话在内存里记下服务器上次发来的原始行和它的 version / cursor（最多几条对话），下次读时带上：
 * 没变，服务器只回 `unchanged`，这里直接复用上次的结果（同一个数组，调用方的合并原样返回、不 setMessages）；
 * 只变了尾部，就只传尾部。调用方拿到的仍是整份，所以编辑 / 删除（服务器对不上前缀会回整份）、读失败、
 * 旧服务器（不回 version）的行为都和以前一样；回答对不上基准时丢掉基准、再整份读一次。
 */
const storedSyncs = new Map<string, StoredSync>();
const STORED_SYNC_LIMIT = 8;
const parsedRows = new WeakMap<readonly unknown[], StoredThread>();

/** 测试用：清掉所有对话的增量基准。 */
export function resetStoredSyncs(): void {
  storedSyncs.clear();
}

/**
 * 读一条对话存储里的原始行（整份，未解析）。`request` 由调用方给：恢复历史走 `tryClient`，
 * 顺序核对沿用它原来的 `fetch`（401 等处理不变）。非 2xx 返回 null；网络 / JSON 错误照常抛出。
 */
export async function readStoredRows(
  threadId: string,
  agentId: string | undefined,
  request: (path: string) => Promise<Response>,
): Promise<readonly unknown[] | null> {
  const key = `${agentId ?? ""}\n${threadId}`;
  let base = storedSyncs.get(key) ?? null;
  for (;;) {
    const params = new URLSearchParams();
    if (agentId !== undefined) params.set("agentId", agentId);
    params.set("since", base?.version ?? "");
    if (base) params.set("cursor", base.cursor);
    const response = await request(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?${params}`,
    );
    if (!response.ok) {
      storedSyncs.delete(key);
      return null;
    }
    const answer = applyStoredAnswer(base, await response.json());
    storedSyncs.delete(key);
    if (!answer) {
      if (!base) return null;
      base = null;
      continue;
    }
    if (answer.version && answer.cursor) {
      storedSyncs.set(key, {
        version: answer.version,
        cursor: answer.cursor,
        rows: answer.rows,
      });
      if (storedSyncs.size > STORED_SYNC_LIMIT) {
        const oldest = storedSyncs.keys().next().value;
        if (oldest !== undefined) storedSyncs.delete(oldest);
      }
    }
    return answer.rows;
  }
}
export async function readThreadMessages(
  threadId: string,
  agentId: string,
  options: ReadThreadMessagesOptions = {},
): Promise<StoredThread> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineMs = options.deadlineMs ?? THREAD_MESSAGES_DEADLINE_MS;

  try {
    const read = async () => {
      const rows = await readStoredRows(threadId, agentId, (path) =>
        tryClient(path, { signal: controller.signal }),
      );
      if (!rows) return UNAVAILABLE_THREAD;
      // 服务器回 unchanged 时 rows 是上次那同一个数组：直接给上次的结果（同一批消息对象）。
      const known = parsedRows.get(rows);
      if (known) return known;
      const parsed = readableTurns(rows);
      parsedRows.set(rows, parsed);
      return parsed;
    };

    const deadline = new Promise<StoredThread>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(UNAVAILABLE_THREAD);
      }, deadlineMs);
    });

    return await Promise.race([read(), deadline]);
  } catch {
    return UNAVAILABLE_THREAD;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
