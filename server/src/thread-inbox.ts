import { AsyncLocalStorage } from "node:async_hooks";
import type { Message } from "@ag-ui/client";
import type { Database } from "./db/client";

/**
 * 对话收件箱（DESIGN.md §38）：机器人正在回答时用户又发来的消息、后台任务交回来的结果，都先进这里，
 * 不打断正在跑的那一轮，也不被拒绝（以前是 409「Thread already running」）。
 *
 * - 正在跑的那一轮在**每一步之间**（上一步的工具结果回来、下一次调模型之前）把排队的消息读进上下文：
 *   `steerLanguageModel` 包住语言模型，下一次 doStream 的 prompt 末尾插进这些用户消息，并且之后每一步
 *   都插在同一个位置（AI SDK 每步按自己的消息重建 prompt，不插就丢）。
 * - 这一轮结束时还有没读的，同一次运行接着开下一段（local-conversations.ts 的分段循环），用户看到的是
 *   一次连续的回复；客户端那边如果运行已经结束才发现还有排队的，就按普通消息发出去（兜底）。
 * - 每条都有状态：queued（排队）→ read（已读进上下文）→ answered（那一轮正常结束）/ stopped（用户按了
 *   停止）/ owed（那一轮出错或服务重启，还欠一个回答）。withdrawn = 用户撤回，merged = 客户端改成普通发送。
 *   没有一条会被悄悄丢掉。
 */
export type InboxKind = "message" | "worker_result";
export type InboxStatus = "queued" | "paused" | "read" | "answered" | "stopped" | "owed" | "withdrawn" | "merged";
export type InboxItem = {
  id: string;
  threadId: string;
  kind: InboxKind;
  message: Message;
  status: InboxStatus;
  runId: string | null;
  createdAt: string;
  readAt: string | null;
};

type InboxRow = {
  id: string; thread_id: string; owner_user_id: string; kind: InboxKind; message: Message;
  status: InboxStatus; run_id: string | null; created_at: Date | string; read_at: Date | string | null;
};

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const item = (row: InboxRow): InboxItem => ({
  id: row.id, threadId: row.thread_id, kind: row.kind, message: row.message, status: row.status,
  runId: row.run_id, createdAt: iso(row.created_at)!, readAt: iso(row.read_at),
});

/** 一条排队消息最多这么长（和普通输入框一样，太长的请走附件）。 */
export const INBOX_TEXT_LIMIT = 20_000;
/** 一个对话里同时排队的上限，防止刷屏把一轮撑爆。 */
export const INBOX_QUEUE_LIMIT = 20;

export class ThreadInbox {
  constructor(private readonly database: Database) {}

  async ensure() {
    await this.database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_thread_inbox (
      thread_id text NOT NULL, id text NOT NULL, owner_user_id text NOT NULL,
      kind text NOT NULL DEFAULT 'message', message jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued', run_id text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), read_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, id)
    )`);
    await this.database.$client.unsafe(
      "CREATE INDEX IF NOT EXISTS chisabot_thread_inbox_status ON chisabot_thread_inbox(thread_id, status, created_at)",
    );
    // Like inbox rows, control is also used by workers before the local thread is created.
    // Thread deletion and Bot purge remove it explicitly rather than imposing an FK here.
    await this.database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_thread_inbox_control (
      thread_id text PRIMARY KEY, paused boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  /** One durable row serializes pause, late enqueue, claim and explicit send across devices. */
  private async locked<T>(threadId: string, action: (sql: Database["$client"], paused: boolean) => Promise<T>): Promise<T> {
    return this.database.$client.begin(async (sql) => {
      await sql.unsafe("INSERT INTO chisabot_thread_inbox_control (thread_id) VALUES ($1) ON CONFLICT DO NOTHING", [threadId]);
      const [state] = await sql.unsafe<{ paused: boolean }[]>("SELECT paused FROM chisabot_thread_inbox_control WHERE thread_id = $1 FOR UPDATE", [threadId]);
      return action(sql as unknown as Database["$client"], Boolean(state?.paused));
    }) as Promise<T>;
  }

  async isPaused(threadId: string): Promise<boolean> {
    const [row] = await this.database.$client.unsafe<{ paused: boolean }[]>("SELECT paused FROM chisabot_thread_inbox_control WHERE thread_id = $1", [threadId]);
    return Boolean(row?.paused);
  }

  /** Stop/error holds unseen supplements, including enqueues that arrive after Stop. */
  async pause(threadId: string) {
    await this.locked(threadId, async (sql) => {
      await sql.unsafe("UPDATE chisabot_thread_inbox_control SET paused = true, updated_at = now() WHERE thread_id = $1", [threadId]);
      await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'paused', updated_at = now() WHERE thread_id = $1 AND status IN ('queued', 'owed', 'stopped')", [threadId]);
    });
  }

  /** A fresh explicit user turn permits future supplements, without resuming old paused rows. */
  async startExplicitTurn(threadId: string) {
    await this.locked(threadId, async (sql) => {
      await sql.unsafe("UPDATE chisabot_thread_inbox_control SET paused = false, updated_at = now() WHERE thread_id = $1", [threadId]);
    });
  }

  /** The user sends exactly one paused row again as a new message; no old tool call is replayed. */
  async resumeOne(threadId: string, sourceId: string, runId: string): Promise<Message | null> {
    return this.locked(threadId, async (sql) => {
      const [row] = await sql.unsafe<InboxRow[]>(`UPDATE chisabot_thread_inbox SET status = 'read', run_id = $3,
        read_at = now(), updated_at = now() WHERE thread_id = $1 AND id = $2 AND status IN ('paused', 'owed', 'stopped') RETURNING *`, [threadId, sourceId, runId]);
      return row?.message ?? null;
    });
  }

  async heldIds(threadId: string): Promise<Set<string>> {
    const rows = await this.database.$client.unsafe<{ id: string }[]>("SELECT id FROM chisabot_thread_inbox WHERE thread_id = $1 AND status IN ('paused', 'owed', 'stopped')", [threadId]);
    return new Set(rows.map((row) => row.id));
  }

  /** 同一个 id 的重试不改变暂停状态。 */
  async enqueue(input: { threadId: string; ownerUserId: string; message: Message; kind?: InboxKind }): Promise<boolean> {
    return this.locked(input.threadId, async (sql, paused) => {
      const existing = await sql.unsafe("SELECT id FROM chisabot_thread_inbox WHERE thread_id = $1 AND id = $2", [input.threadId, input.message.id]);
      if (existing.length) {
        // Older background-delivery fallbacks may have changed this row back to queued.
        if (paused) await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'paused', updated_at = now() WHERE thread_id = $1 AND id = $2 AND status IN ('queued', 'owed', 'stopped')", [input.threadId, input.message.id]);
        return false;
      }
      const [queued] = await sql.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM chisabot_thread_inbox WHERE thread_id = $1 AND status IN ('queued', 'paused', 'owed', 'stopped')", [input.threadId]);
      if ((queued?.n ?? 0) >= INBOX_QUEUE_LIMIT) throw new Error("排队的消息太多了，请先发送或撤回保留的消息。");
      const rows = await sql.unsafe(`INSERT INTO chisabot_thread_inbox (thread_id, id, owner_user_id, kind, message, status)
        VALUES ($1, $2, $3, $4, $5::text::jsonb, $6) ON CONFLICT (thread_id, id) DO NOTHING RETURNING id`,
        [input.threadId, input.message.id, input.ownerUserId, input.kind ?? "message", JSON.stringify(input.message), paused ? "paused" : "queued"]);
      return rows.length > 0;
    });
  }

  async queued(threadId: string): Promise<InboxItem[]> {
    const rows = await this.database.$client.unsafe<InboxRow[]>(
      "SELECT * FROM chisabot_thread_inbox WHERE thread_id = $1 AND status = 'queued' ORDER BY created_at, id", [threadId],
    );
    return rows.map(item);
  }

  /** 把排队的全部标成「已读」并归到这次运行，按进队顺序返回。 */
  async claim(threadId: string, runId: string): Promise<InboxItem[]> {
    return this.locked(threadId, async (sql, paused) => {
      if (paused) return [];
      const rows = await sql.unsafe<InboxRow[]>(
        `UPDATE chisabot_thread_inbox SET status = 'read', run_id = $2, read_at = now(), updated_at = now()
         WHERE thread_id = $1 AND status = 'queued' RETURNING *`, [threadId, runId],
      );
      return rows.map(item).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  /** 客户端把排队的消息改成普通发送了（运行刚好结束）：这些不再由收件箱负责。 */
  async merge(threadId: string, runId: string, ids: readonly string[]) {
    if (!ids.length) return;
    // Bun SQL 的 unsafe 不会把 JS 数组变成 text[]，用 jsonb 展开。
    await this.locked(threadId, async (sql, paused) => {
      if (paused) return;
      await sql.unsafe(
        `UPDATE chisabot_thread_inbox SET status = 'read', run_id = $2, read_at = coalesce(read_at, now()), updated_at = now()
         WHERE thread_id = $1 AND status = 'queued'
         AND id IN (SELECT jsonb_array_elements_text($3::text::jsonb))`, [threadId, runId, JSON.stringify(ids)],
      );
    });
  }

  /** 一次运行结束：它读过的消息按结局落定。 */
  async settle(threadId: string, runId: string, outcome: "answered" | "stopped" | "owed") {
    await this.locked(threadId, async (sql) => {
      if (outcome !== "answered") {
        await sql.unsafe("UPDATE chisabot_thread_inbox_control SET paused = true, updated_at = now() WHERE thread_id = $1", [threadId]);
        await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'paused', updated_at = now() WHERE thread_id = $1 AND status IN ('queued', 'owed', 'stopped')", [threadId]);
      }
      await sql.unsafe(
        `UPDATE chisabot_thread_inbox SET status = $3, updated_at = now()
         WHERE thread_id = $1 AND run_id = $2 AND status = 'read'`, [threadId, runId, outcome === "answered" ? outcome : "paused"],
      );
    });
  }

  async withdraw(threadId: string, id: string): Promise<boolean> {
    const rows = await this.database.$client.unsafe(
      `UPDATE chisabot_thread_inbox SET status = 'withdrawn', updated_at = now()
       WHERE thread_id = $1 AND id = $2 AND status IN ('queued', 'paused', 'owed', 'stopped') RETURNING id`, [threadId, id],
    );
    return rows.length > 0;
  }

  /** HTTP withdrawal also reserves absent IDs, so a timed-out POST cannot arrive after withdrawal. */
  async withdrawPending(threadId: string, id: string, ownerUserId: string): Promise<boolean> {
    return this.locked(threadId, async (sql) => {
      await sql.unsafe(`INSERT INTO chisabot_thread_inbox (thread_id, id, owner_user_id, message, status)
        VALUES ($1, $2, $3, $4::text::jsonb, 'withdrawn') ON CONFLICT (thread_id, id) DO NOTHING`,
        [threadId, id, ownerUserId, JSON.stringify({ id, role: "user", content: "" })]);
      const rows = await sql.unsafe(`UPDATE chisabot_thread_inbox SET status = 'withdrawn', updated_at = now()
        WHERE thread_id = $1 AND id = $2 AND status IN ('queued', 'paused', 'owed', 'stopped', 'withdrawn') RETURNING id`, [threadId, id]);
      return rows.length > 0;
    });
  }

  async get(threadId: string, id: string): Promise<InboxItem | null> {
    const [row] = await this.database.$client.unsafe<InboxRow[]>("SELECT * FROM chisabot_thread_inbox WHERE thread_id = $1 AND id = $2", [threadId, id]);
    return row ? item(row) : null;
  }

  /** 界面要看的：还在排队的、欠回答的，以及最近 10 分钟内状态变过的（「已读取」的淡出）。 */
  async list(threadId: string): Promise<InboxItem[]> {
    const rows = await this.database.$client.unsafe<InboxRow[]>(
      `SELECT * FROM (
         SELECT * FROM chisabot_thread_inbox WHERE thread_id = $1 AND status IN ('queued', 'paused', 'owed', 'stopped')
         UNION ALL
         (SELECT * FROM chisabot_thread_inbox WHERE thread_id = $1 AND status NOT IN ('queued', 'paused', 'owed', 'stopped')
          AND updated_at > now() - interval '10 minutes' ORDER BY updated_at DESC, id DESC LIMIT 100)
       ) visible ORDER BY created_at, id`, [threadId],
    );
    return rows.map(item);
  }

  /** After restart there is no live tool owner. Keep every unfinished row for an explicit send. */
  async releaseInterrupted(): Promise<number> {
    return this.database.$client.begin(async (sql) => {
      await sql.unsafe(`INSERT INTO chisabot_thread_inbox_control (thread_id, paused)
        SELECT DISTINCT thread_id, true FROM chisabot_thread_inbox WHERE status IN ('queued', 'read', 'owed', 'stopped', 'paused')
        ON CONFLICT (thread_id) DO UPDATE SET paused = true, updated_at = now()`);
      const rows = await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'paused', updated_at = now() WHERE status IN ('queued', 'read', 'owed', 'stopped') RETURNING id");
      return rows.length;
    }) as Promise<number>;
  }
}

/* ------------------------------------------------------------------ steering ------------------------------------------------------------------ */

/** 模型 prompt 里的一条消息（AI SDK LanguageModelV2/V3 的形状，这里只用到 role / content）。 */
type PromptMessage = { role: string; content: unknown };

/**
 * 一次运行（一段）里的「插话」会话。由运行器建立（AsyncLocalStorage），模型包装器在每一步开始时读它。
 */
export type SteerSession = {
  /** 把排队的消息领走（标成已读）。只在一步结束、上一条是工具结果时调用。 */
  claim: () => Promise<Message[]>;
  /** 读进去了：运行器据此把它们放进对话记录、推给界面。`anchors` = 这些消息紧跟在哪些工具结果后面。 */
  onInjected: (messages: Message[], anchors: string[]) => void;
  /** 已插进 prompt 的：插在不含插话的原始 prompt 的第几条之前。 */
  injections: { index: number; messages: PromptMessage[] }[];
  /** 已经在多长的 prompt 上领过（同一步的重试不再领）。 */
  claimedAt: number;
};

const sessions = new AsyncLocalStorage<SteerSession>();

export function newSteerSession(
  claim: SteerSession["claim"],
  onInjected: SteerSession["onInjected"],
): SteerSession {
  return { claim, onInjected, injections: [], claimedAt: 0 };
}

export function withSteering<T>(session: SteerSession, run: () => T): T {
  return sessions.run(session, run);
}

export function textOfMessage(message: Pick<Message, "content">): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** 后台任务结果消息的开头标记（界面据此画成一行结果卡，模型看到的也是同一段文字）。 */
export const WORKER_RESULT_MARKER = "⟦chisabot:worker-result:";
export function isWorkerResult(message: Pick<Message, "content">) {
  const text = textOfMessage(message);
  // 本地 agent 任务的结果（docs/local-agents.md）同样是自带说明的交付消息。
  return text.startsWith(WORKER_RESULT_MARKER) || text.startsWith("⟦chisabot:local-agent-result:");
}

/** 插进 prompt 时给模型看的样子：用户插话带一句说明，后台任务结果本身已经写清楚了。 */
export function promptMessageFor(message: Message): PromptMessage {
  const text = textOfMessage(message);
  const framed = isWorkerResult(message)
    ? text
    : `（你在处理上一条消息的过程中，用户又发来下面这条消息。把它当作对当前工作的补充或更正，接着做；结束时每条用户消息都要回应到。）\n${text}`;
  return { role: "user", content: [{ type: "text", text: framed }] };
}

/** 原始 prompt + 已插的话，按记录的位置插回去（位置是相对原始 prompt 的，逐个加偏移）。 */
export function weavePrompt(prompt: readonly PromptMessage[], injections: SteerSession["injections"]): PromptMessage[] {
  const sorted = [...injections].sort((a, b) => a.index - b.index);
  const out: PromptMessage[] = [];
  let next = 0;
  for (let index = 0; index <= prompt.length; index++) {
    while (next < sorted.length && sorted[next]!.index === index) out.push(...sorted[next++]!.messages);
    if (index < prompt.length) out.push(prompt[index]!);
  }
  // 位置超出（不该发生）就放在最后，宁可多给也不丢。
  while (next < sorted.length) out.push(...sorted[next++]!.messages);
  return out;
}

/** prompt 末尾连续的工具结果里的 toolCallId（插话紧跟在它们后面）。 */
export function trailingToolCallIds(prompt: readonly PromptMessage[]): string[] {
  const ids: string[] = [];
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]!;
    if (message.role !== "tool") break;
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const id = (part as { toolCallId?: unknown })?.toolCallId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

async function steer(options: unknown): Promise<unknown> {
  const session = sessions.getStore();
  if (!session || !options || typeof options !== "object") return options;
  const prompt = (options as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return options;
  const typed = prompt as PromptMessage[];
  const last = typed[typed.length - 1];
  // 只在「一步结束、工具结果刚回来」的边界插话：第一次调用之前运行器已经把排队的放进了输入。
  if (last?.role === "tool" && typed.length > session.claimedAt) {
    session.claimedAt = typed.length;
    let claimed: Message[] = [];
    try {
      claimed = await session.claim();
    } catch (error) {
      console.warn("thread inbox claim failed", error);
    }
    if (claimed.length) {
      session.injections.push({ index: typed.length, messages: claimed.map(promptMessageFor) });
      session.onInjected(claimed, trailingToolCallIds(typed));
    }
  }
  if (!session.injections.length) return options;
  return { ...(options as object), prompt: weavePrompt(typed, session.injections) };
}

type SteerableModel = {
  doStream?: (options: unknown) => PromiseLike<unknown>;
  doGenerate?: (options: unknown) => PromiseLike<unknown>;
};

/**
 * 同一个模型对象，只是每一步开始前看看收件箱：有新消息就插进这一步的 prompt。
 * 没有插话会话（不是本地对话的运行）时什么也不做。不是对象（网关字符串 id）就原样返回。
 */
export function steerLanguageModel<T>(model: T): T {
  if (!model || typeof model !== "object") return model;
  const target = model as unknown as SteerableModel;
  return new Proxy(model as unknown as object, {
    get(object, property) {
      if ((property === "doStream" || property === "doGenerate") && typeof target[property] === "function") {
        return async (options: unknown) => target[property]!.call(object, await steer(options));
      }
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as unknown as T;
}

/* ------------------------------------------------------------------ transcript ------------------------------------------------------------------ */

/** 插话在对话记录里的位置：紧跟在 anchors 这些工具结果后面；没有锚点就跟在 afterId 后面，再没有就放最后。 */
export type TranscriptInjection = { message: Message; anchors: string[]; afterId?: string };

/**
 * 把插话放进 AG-UI 的消息列表。智能体自己的消息列表里没有它们（不是它产生的事件），每次存档 / 推给界面
 * 之前都从头织一遍；已经在列表里的（同 id）不重复放。
 */
export function weaveMessages(base: readonly Message[], injections: readonly TranscriptInjection[]): Message[] {
  const out = [...base];
  const present = new Set(out.map((message) => message.id));
  const injected = new Set(injections.map((injection) => injection.message.id));
  for (const injection of injections) {
    if (present.has(injection.message.id)) continue;
    let at = -1;
    if (injection.anchors.length) {
      const anchors = new Set(injection.anchors);
      for (let index = out.length - 1; index >= 0; index--) {
        const message = out[index] as Message & { toolCallId?: string };
        if (message.role === "tool" && message.toolCallId && anchors.has(message.toolCallId)) { at = index + 1; break; }
      }
    }
    if (at < 0 && injection.afterId) {
      const index = out.findIndex((message) => message.id === injection.afterId);
      if (index >= 0) at = index + 1;
    }
    if (at < 0) at = out.length;
    // 排在之前插在同一个位置的插话后面（保持进队顺序）。
    while (at < out.length && injected.has(out[at]!.id)) at++;
    out.splice(at, 0, injection.message);
    present.add(injection.message.id);
  }
  return out;
}

/** 这些工具结果是不是都已经在消息列表里了（插话的位置定下来了，才推快照给界面）。 */
export function anchorsPresent(messages: readonly Message[], anchors: readonly string[]): boolean {
  if (!anchors.length) return true;
  const seen = new Set(
    messages.filter((message) => message.role === "tool").map((message) => (message as { toolCallId?: string }).toolCallId),
  );
  return anchors.every((anchor) => seen.has(anchor));
}
