import {
  type AbstractAgent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  createRunEventFinalizer,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject, Subject } from "rxjs";
import { capConnectMessages } from "../../shared/connect-snapshot";
import { fallbackNotice } from "./agents/model-fallback";
import { withConfirmTurn, withToolAbort } from "./confirmations/context";
import {
  estimateTokens,
  readingFromRunFinished,
  type ThreadContextReading,
} from "./context-usage";
import type { Database } from "./db/client";
import { imageDimsFor } from "./image-dims";
import {
  anchorsPresent,
  INBOX_TEXT_LIMIT,
  newSteerSession,
  ThreadInbox,
  type TranscriptInjection,
  weaveMessages,
  withSteering,
} from "./thread-inbox";
import {
  afterTruncate,
  dropTombstoned,
  ensureTruncationTable,
  TruncateError,
  tombstones,
  truncateThread,
  workersSince,
} from "./thread-truncate";

/**
 * 接入回放瘦身（DESIGN.md §83）。存下的每一轮 RUN_STARTED 都带着那一刻完整的 input：系统上下文（context）、
 * 工具定义（tools）和到那一刻为止的全部消息（messages）。n 轮就是 n 份，越聊越大——实测一段 35 轮的对话
 * 回放 3.4 MB（context 2.2 MB + tools 1 MB），打开 / 切换到它时浏览器要先下完这些。
 *
 * 客户端回放时只用 RUN_STARTED.input.messages 里「它还没有的那几条」（AG-UI `defaultApplyEvents`：按 id 找，
 * 有就跳过），context / tools 根本不看。所以：前面几轮 input 里已经出现过的消息不再重复发，context / tools 发空数组。
 * 客户端得到的消息列表和以前完全一样，只是少传了重复的部分。只改接入回放，不改存储，不改正在跑的那一轮的实时事件。
 */
export function slimReplay(events: readonly BaseEvent[]): BaseEvent[] {
  const seen = new Set<string>();
  return events.map((event) => {
    if (event.type !== EventType.RUN_STARTED) return event;
    const started = event as BaseEvent & {
      input?: {
        messages?: { id?: unknown }[];
        context?: unknown;
        tools?: unknown;
      };
    };
    const input = started.input;
    if (!input || typeof input !== "object") return event;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const fresh = messages.filter(
      (message) => typeof message?.id !== "string" || !seen.has(message.id),
    );
    for (const message of messages)
      if (typeof message?.id === "string") seen.add(message.id);
    return {
      ...started,
      input: { ...input, messages: fresh, context: [], tools: [] },
    } as BaseEvent;
  });
}

/**
 * Which user message opened a stopped run (DOG-friction 2026-10-19).
 *
 * RUN_STARTED.input.messages is the *new* messages for that run — often the latest user
 * turn, sometimes several (inbox claim + send). Walk from the *latest* id in that input
 * back to the nearest user row (same rule as fallbackTurns). Using Math.min here used to
 * pin 「已停止」 to an earlier turn's reply when the input carried more than one user message.
 */
export function userMessageIdForStoppedRun(
  inputMessageIds: readonly string[],
  messages: readonly { id: string; role: string }[],
): string | null {
  const position = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const indexes = inputMessageIds
    .map((id) => position.get(id))
    .filter((index): index is number => index !== undefined);
  if (!indexes.length) return null;
  for (let at = Math.max(...indexes); at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "user") return message.id;
  }
  return null;
}

/** Errors also satisfy the existing history reader's platform-error contract. */
export class LocalConversationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

export type LocalHistoryMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/** Headless turns use flat tools; HTTP keeps the canonical AG-UI message format. */
export function toLocalHistoryMessage(message: Message): LocalHistoryMessage {
  if (message.role !== "assistant") return { ...message };
  const { toolCalls, ...rest } = message;
  return {
    ...rest,
    ...(toolCalls
      ? {
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.function.name,
            args: call.function.arguments,
          })),
        }
      : {}),
  };
}

/** Saved history is authoritative: clients can append IDs but cannot rewrite old messages. */
export function mergeConversationMessages(
  stored: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const messages = [...stored];
  const known = new Set(stored.map((message) => message.id));
  for (const message of incoming) {
    if (known.has(message.id)) continue;
    known.add(message.id);
    messages.push(message);
  }
  return messages;
}

/** A handoff's full task goes to the model, while only its optional summary joins the transcript. */
export function prepareConversationMessages(
  stored: readonly Message[],
  input: readonly Message[],
  persistedInput?: readonly Message[],
) {
  const execution = mergeConversationMessages(stored, input);
  const visible = mergeConversationMessages(stored, persistedInput ?? input);
  const visibleById = new Map(visible.map((message) => [message.id, message]));
  const inputIds = new Set(execution.map((message) => message.id));
  const privateIds = new Set(
    execution
      .filter(
        (message) =>
          JSON.stringify(message) !==
          JSON.stringify(visibleById.get(message.id)),
      )
      .map((message) => message.id),
  );
  const privateTools = new Set(
    execution.flatMap((message) =>
      privateIds.has(message.id) && message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    ),
  );
  const project = (messages: readonly Message[]) =>
    mergeConversationMessages(
      visible,
      messages.filter((message) => !inputIds.has(message.id)),
    );
  // Snapshots also appear inside custom event/state payloads. Replace only known input message
  // objects; fresh outputs, tool results, and arbitrary domain state retain their original values.
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(sanitize).filter((item) => item !== undefined);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (
      typeof object.id === "string" &&
      typeof object.role === "string" &&
      privateIds.has(object.id)
    ) {
      return visibleById.get(object.id);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, sanitize(item)]),
    );
  };
  const event = (source: BaseEvent): BaseEvent | undefined => {
    const fields = source as BaseEvent & {
      messageId?: string;
      toolCallId?: string;
      messages?: Message[];
    };
    if (
      (fields.messageId && privateIds.has(fields.messageId)) ||
      (fields.toolCallId && privateTools.has(fields.toolCallId))
    )
      return undefined;
    if (source.type === EventType.MESSAGES_SNAPSHOT) {
      return {
        ...source,
        messages: project(fields.messages ?? []),
      } as BaseEvent;
    }
    return sanitize(source) as BaseEvent;
  };
  return { execution, visible, project, sanitize, event };
}

type ThreadRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  name: string | null;
  archived: boolean;
  messages: Message[];
  state: Record<string, unknown>;
  run_id: string | null;
  lock_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type EventRow = { sequence: string | number | bigint; event: BaseEvent };
type ThreadIdentity = { threadId: string; userId: string };
type ThreadCreation = ThreadIdentity & {
  agentId: string;
  learningContainerId?: string;
};
type ThreadLock = ThreadCreation & { runId: string; ttlSeconds?: number };
type LeaseIdentity = { threadId: string; runId: string };

function record(row: ThreadRow) {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    createdById: row.owner_user_id,
    organizationId: "",
    archived: row.archived,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function ttl(seconds = 120) {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new LocalConversationError("A positive lock TTL is required", 400);
  return Math.min(300, Math.max(1, seconds));
}

class ConversationStore {
  constructor(readonly database: Database) {}

  async thread(threadId: string): Promise<ThreadRow> {
    const rows = await this.database.$client.unsafe<ThreadRow[]>(
      "SELECT * FROM openbot_local_threads WHERE id = $1",
      [threadId],
    );
    if (!rows[0]) throw new LocalConversationError("Thread not found", 404);
    return rows[0];
  }

  async owned({ threadId, userId }: ThreadIdentity): Promise<ThreadRow> {
    const row = await this.thread(threadId);
    if (row.owner_user_id !== userId)
      throw new LocalConversationError("Thread not found", 404);
    return row;
  }

  async events(threadId: string): Promise<EventRow[]> {
    return await this.database.$client.unsafe<EventRow[]>(
      "SELECT sequence, event FROM openbot_local_events WHERE thread_id = $1 ORDER BY sequence",
      [threadId],
    );
  }

  /** 只要最大序号，接入时不必把整段事件日志读进内存（长对话可达数千条 / 上 MB）。 */
  async lastEventSequence(threadId: string): Promise<bigint> {
    const rows = await this.database.$client.unsafe<
      { sequence: string | number | bigint | null }[]
    >(
      "SELECT max(sequence) AS sequence FROM openbot_local_events WHERE thread_id = $1",
      [threadId],
    );
    const value = rows[0]?.sequence;
    return value == null ? 0n : BigInt(value);
  }

  async snapshot(
    threadId: string,
    runId: string,
    messages: readonly Message[],
    state: unknown,
  ) {
    const rows = await this.database.$client.unsafe(
      `UPDATE openbot_local_threads SET messages = $3::text::jsonb, state = $4::text::jsonb, updated_at = now()
       WHERE id = $1 AND run_id = $2 AND lock_expires_at > now() RETURNING id`,
      [threadId, runId, JSON.stringify(messages), JSON.stringify(state ?? {})],
    );
    if (rows.length === 0)
      throw new LocalConversationError(
        "Thread run no longer owns its lock",
        409,
      );
  }

  async append(
    threadId: string,
    runId: string,
    event: BaseEvent,
  ): Promise<bigint> {
    const rows = await this.database.$client.unsafe<
      { sequence: string | number | bigint }[]
    >(
      `INSERT INTO openbot_local_events (thread_id, run_id, event)
       SELECT id, $2, $3::text::jsonb FROM openbot_local_threads
       WHERE id = $1 AND run_id = $2 AND lock_expires_at > now() RETURNING sequence`,
      [threadId, runId, JSON.stringify(event)],
    );
    if (!rows[0])
      throw new LocalConversationError(
        "Thread run no longer owns its lock",
        409,
      );
    return BigInt(rows[0].sequence);
  }
}

/**
 * 服务重启（多半是更新部署）时还在跑的那一轮（DESIGN.md §89，2026-10-16「模型老断」）。
 *
 * 以前只把它标成 interrupted、放掉锁：存下的事件停在半截（最后一条常常是 TOOL_CALL_END，没有结果、没有
 * RUN_ERROR），重新打开对话时那张「正在操作你的设备」卡永远在转，报错条要么没有，要么说成「连不上模型服务」。
 * 现在按正常收尾的同一套规则（@copilotkit/shared finalizeRunEvents）把它补完：没结果的工具调用补一条
 * 「被打断」的结果，最后补一条说清原因的 RUN_ERROR；对话记录里也给这些调用补上同样的结果。
 * 只追加，不改不删已有的事件和消息。
 */
export const RESTART_INTERRUPTED_MESSAGE =
  "ChisaBot 服务刚才重启了（多半是在更新），这一轮做到一半被打断。再发一次，机器人会接着做。";

export async function closeInterruptedRun(
  database: Database,
  threadId: string,
  runId: string,
): Promise<boolean> {
  const rows = await database.$client.unsafe<{ event: BaseEvent }[]>(
    "SELECT event FROM openbot_local_events WHERE thread_id = $1 AND run_id = $2 ORDER BY sequence",
    [threadId, runId],
  );
  if (!rows.length) return false;
  const events = rows.map((row) => row.event);
  if (
    events.some(
      (event) =>
        event.type === EventType.RUN_FINISHED ||
        event.type === EventType.RUN_ERROR,
    )
  )
    return false;
  const finalizer = createRunEventFinalizer();
  for (const event of events) finalizer.observe(event);
  const appended = finalizer.finalize({
    interruptionMessage: RESTART_INTERRUPTED_MESSAGE,
  });
  if (!appended.length) return false;
  for (const event of appended) {
    await database.$client.unsafe(
      "INSERT INTO openbot_local_events (thread_id, run_id, event) VALUES ($1, $2, $3::text::jsonb)",
      [threadId, runId, JSON.stringify(event)],
    );
  }
  const results = appended.filter(
    (event) => event.type === EventType.TOOL_CALL_RESULT,
  ) as Array<
    BaseEvent & { toolCallId: string; messageId: string; content: string }
  >;
  if (results.length) {
    const thread = await database.$client.unsafe<{ messages: Message[] }[]>(
      "SELECT messages FROM openbot_local_threads WHERE id = $1",
      [threadId],
    );
    const messages = thread[0]?.messages;
    if (Array.isArray(messages)) {
      const answered = new Set(
        messages
          .filter((m) => m.role === "tool")
          .map((m) => (m as { toolCallId?: string }).toolCallId),
      );
      let next = messages;
      for (const result of results) {
        if (answered.has(result.toolCallId)) continue;
        const at = next.findIndex(
          (m) =>
            m.role === "assistant" &&
            ((m as { toolCalls?: { id: string }[] }).toolCalls ?? []).some(
              (call) => call.id === result.toolCallId,
            ),
        );
        if (at < 0) continue;
        let insertAt = at + 1;
        while (insertAt < next.length && next[insertAt]?.role === "tool")
          insertAt++;
        next = [
          ...next.slice(0, insertAt),
          {
            id: result.messageId,
            role: "tool",
            toolCallId: result.toolCallId,
            content: result.content,
          } as Message,
          ...next.slice(insertAt),
        ];
      }
      if (next !== messages) {
        await database.$client.unsafe(
          "UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1",
          [threadId, JSON.stringify(next)],
        );
      }
    }
  }
  return true;
}

export class LocalConversationClient {
  constructor(private readonly store: ConversationStore) {}

  async getThread(identity: ThreadIdentity) {
    return record(await this.store.owned(identity));
  }

  async getOrCreateThread(identity: ThreadCreation) {
    if (!identity.threadId || !identity.userId || !identity.agentId)
      throw new LocalConversationError(
        "Thread, user, and agent are required",
        400,
      );
    await this.store.database.$client.unsafe(
      `INSERT INTO openbot_local_threads (id, owner_user_id, agent_id) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [identity.threadId, identity.userId, identity.agentId],
    );
    const row = await this.store.owned(identity);
    if (row.agent_id !== identity.agentId)
      throw new LocalConversationError(
        "Thread belongs to a different agent",
        409,
      );
    return record(row);
  }

  async getThreadMessages(
    identity: ThreadIdentity,
  ): Promise<{ messages: LocalHistoryMessage[] }> {
    return {
      messages: (await this.store.owned(identity)).messages.map(
        toLocalHistoryMessage,
      ),
    };
  }

  async ɵacquireThreadLock(identity: ThreadLock) {
    await this.getOrCreateThread(identity);
    const rows = await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET run_id = $2,
       lock_expires_at = now() + $5 * interval '1 second', updated_at = now()
       WHERE id = $1 AND owner_user_id = $3 AND agent_id = $4
       AND (run_id IS NULL OR lock_expires_at <= now() OR run_id = $2) RETURNING id`,
      [
        identity.threadId,
        identity.runId,
        identity.userId,
        identity.agentId,
        ttl(identity.ttlSeconds),
      ],
    );
    if (rows.length === 0)
      throw new LocalConversationError("Thread already running", 409);
    return { threadId: identity.threadId, runId: identity.runId };
  }

  async ɵrenewThreadLock(identity: LeaseIdentity & { ttlSeconds: number }) {
    const rows = await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET lock_expires_at = now() + $3 * interval '1 second'
       WHERE id = $1 AND run_id = $2 AND lock_expires_at > now() RETURNING id`,
      [identity.threadId, identity.runId, ttl(identity.ttlSeconds)],
    );
    if (rows.length === 0)
      throw new LocalConversationError("Thread lock expired or changed", 409);
    return { threadId: identity.threadId, runId: identity.runId };
  }

  /**
   * 进程启动时调用：本进程还没跑任何一轮，库里残留的线程锁都来自已经退出的进程（容器重启、更新换镜像、崩溃）。
   * 不清掉的话，被打断的那个对话要等锁的 120 秒到期才能再发消息，期间每次发送都是 409「Thread already running」，
   * 用户看到的就是「发消息没反应」。一个数据库只跑一个 ChisaBot 进程（compose 先停旧容器再起新的）；
   * 多副本部署设 CHISABOT_RELEASE_LOCKS_ON_START=0 关掉。
   */
  async ɵreleaseOrphanedLocks(): Promise<{
    threads: number;
    runs: number;
    closed: number;
  }> {
    const runs = await this.store.database.$client.unsafe<
      { thread_id: string; run_id: string }[]
    >(
      `UPDATE openbot_local_runs SET status = 'interrupted', finished_at = now()
       WHERE status = 'running' RETURNING thread_id, run_id`,
    );
    const threads = await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET run_id = NULL, lock_expires_at = NULL
       WHERE run_id IS NOT NULL RETURNING id`,
    );
    let closed = 0;
    for (const run of runs) {
      try {
        if (
          await closeInterruptedRun(
            this.store.database,
            run.thread_id,
            run.run_id,
          )
        )
          closed++;
      } catch (error) {
        console.warn("closing interrupted run failed", run.run_id, error);
      }
    }
    return { threads: threads.length, runs: runs.length, closed };
  }

  /** 这个进程里没有对应的运行（上一个进程留下的锁）：按停止时直接释放，用户不用干等锁到期。 */
  async ɵreleaseOrphanedLock(
    threadId: string,
    runId?: string,
  ): Promise<boolean> {
    const rows = await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET run_id = NULL, lock_expires_at = NULL
       WHERE id = $1 AND run_id IS NOT NULL AND ($2::text IS NULL OR run_id = $2) RETURNING run_id`,
      [threadId, runId ?? null],
    );
    if (rows.length === 0) return false;
    await this.store.database.$client.unsafe(
      `UPDATE openbot_local_runs SET status = 'interrupted', finished_at = now()
       WHERE thread_id = $1 AND status = 'running'`,
      [threadId],
    );
    return true;
  }

  async ɵcleanupThreadLock(identity: LeaseIdentity): Promise<void> {
    await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET run_id = NULL, lock_expires_at = NULL
       WHERE id = $1 AND run_id = $2`,
      [identity.threadId, identity.runId],
    );
  }

  /**
   * Track B：进程存活期间周期性清「已过期仍占着 run_id」的锁，以及把对应 running 标成 interrupted。
   * 启动时的 ɵreleaseOrphanedLocks 管重启；这里管运行中 renewal 停了却没走到 finally 的边角。
   */
  async ɵsweepExpiredLocks(): Promise<{ threads: number; runs: number }> {
    const runs = await this.store.database.$client.unsafe<
      { thread_id: string; run_id: string }[]
    >(
      `UPDATE openbot_local_runs r SET status = 'interrupted', finished_at = now()
       FROM openbot_local_threads t
       WHERE r.thread_id = t.id AND r.run_id = t.run_id AND r.status = 'running'
         AND (t.lock_expires_at IS NULL OR t.lock_expires_at <= now())
       RETURNING r.thread_id, r.run_id`,
    );
    const threads = await this.store.database.$client.unsafe(
      `UPDATE openbot_local_threads SET run_id = NULL, lock_expires_at = NULL
       WHERE run_id IS NOT NULL AND (lock_expires_at IS NULL OR lock_expires_at <= now())
       RETURNING id`,
    );
    return { threads: threads.length, runs: runs.length };
  }
}

type LiveEvent = { sequence: bigint; event: BaseEvent };
type ActiveRun = {
  runId: string;
  agent: AbstractAgent;
  stream: ReplaySubject<BaseEvent>;
  live: Subject<LiveEvent>;
  stopped: boolean;
  done: Promise<void>;
  /** 用户按停止时 abort：工具（web_search 等）通过 currentToolAbort 收到（FIX-04）。 */
  abort: AbortController;
  /** 这一轮里读进来的插话（排队消息 / 后台任务结果），存档和推给界面前织进消息列表。 */
  injections: TranscriptInjection[];
};

/** 一次运行最多接着跑几段（每段 = 一次完整的模型循环；段与段之间读进新排队的消息）。 */
const MAX_SEGMENTS = 8;

/**
 * Track B：交互回合墙钟上限。锁心跳每 30s 续 120s，挂死的 agent 会一直占着锁 → 永久 busy。
 * 到期强制 stop（与 headless turnTimeout 同思路，略宽于常见长工具回合）。
 */
const MAX_RUN_WALL_MS = 25 * 60_000;

/** 到期锁 / 无内存条目的残留 run_id 多久扫一次。 */
const STALE_LOCK_SWEEP_MS = 60_000;

/** 对话还不存在时这些只读接口回的空结果（和存在但什么都没有时一样）。 */
const EMPTY_THREAD_READS: Record<string, unknown> = {
  context: { context: null },
  stopped: { userMessageIds: [] },
  fallbacks: { turns: [] },
  inbox: { running: false, items: [] },
  workers: { workers: [] },
  "sent-at": { userMessageId: null, at: null, now: null },
};

/** Public OSS runner with our own PostgreSQL transcript and per-thread lease. */
class PostgresAgentRunner extends AgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly observers = new Map<
    string,
    Set<(event: BaseEvent) => void>
  >();
  constructor(
    private readonly store: ConversationStore,
    private readonly client: LocalConversationClient,
    readonly inbox: ThreadInbox,
  ) {
    super();
  }

  /** 这个进程里这个对话是不是正在跑。 */
  isActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** 在进程内旁听一个对话的事件（后台任务卡片读它的步骤）。返回取消函数。 */
  observe(threadId: string, listener: (event: BaseEvent) => void): () => void {
    let set = this.observers.get(threadId);
    if (!set) {
      set = new Set();
      this.observers.set(threadId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size && this.observers.get(threadId) === set)
        this.observers.delete(threadId);
    };
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (request.input.threadId !== request.threadId || !request.input.runId)
      throw new LocalConversationError(
        "Run thread and runId are required",
        400,
      );
    const running = this.active.get(request.threadId);
    // 正在回答时又发来消息：不拒绝、不打断。新的用户消息进收件箱（下一步读进去），这个请求接上正在跑的那一轮。
    if (running) return this.join(request, running);
    const entry: ActiveRun = {
      runId: request.input.runId,
      agent: request.agent,
      stream: new ReplaySubject<BaseEvent>(),
      live: new Subject<LiveEvent>(),
      stopped: false,
      abort: new AbortController(),
      done: Promise.resolve(),
      injections: [],
    };
    this.active.set(request.threadId, entry);
    entry.done = this.execute(request, entry);
    return entry.stream.asObservable();
  }

  private join(
    request: AgentRunnerRunRequest,
    running: ActiveRun,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let subscription: { unsubscribe(): void } | undefined;
      let closed = false;
      void (async () => {
        const row = await this.store.thread(request.threadId);
        const known = new Set([
          ...row.messages.map((message) => message.id),
          ...running.injections.map((item) => item.message.id),
        ]);
        // 截断过的消息（旧设备还拿着）不进收件箱（DESIGN.md §67）。
        const dead = await tombstones(this.store.database, request.threadId);
        for (const message of dropTombstoned(request.input.messages, dead)) {
          if (known.has(message.id) || message.role !== "user") continue;
          await this.inbox.enqueue({
            threadId: request.threadId,
            ownerUserId: row.owner_user_id,
            message,
          });
        }
        if (closed) return;
        subscription = running.stream.subscribe(subscriber);
      })().catch((error) => subscriber.error(error));
      return () => {
        closed = true;
        subscription?.unsubscribe();
      };
    });
  }

  private async execute(
    request: AgentRunnerRunRequest,
    entry: ActiveRun,
  ): Promise<void> {
    const { threadId, agent, input } = request;
    let started = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let persistenceError: unknown;
    let terminal = false;
    let runStarted = false;
    let failed = false;
    let durableWrites = Promise.resolve();
    const finalizer = createRunEventFinalizer();
    const newMessages: Message[] = [];
    let prepared = prepareConversationMessages([], [], []);
    /** 段与段之间扣下的 RUN_FINISHED：还要接着跑就丢掉，最后一段的才发出去。 */
    let heldFinish: BaseEvent | undefined;
    let segmenting = false;
    /** 智能体最近一次报告的消息列表（不含插话）。 */
    let latest: Message[] = [];
    /** 已读进来、但它紧跟的工具结果还没到消息列表里的插话：等到了再推快照。 */
    let pendingNotices: string[][] = [];
    const woven = (messages: readonly Message[]) =>
      weaveMessages(messages, entry.injections);
    const notify = (event: BaseEvent) => {
      for (const listener of this.observers.get(threadId) ?? []) {
        try {
          listener(event);
        } catch {
          /* 旁听者出错不影响这一轮。 */
        }
      }
    };
    const emit = async (source: BaseEvent) => {
      let event = source;
      if (event.type === EventType.RUN_STARTED) {
        // 第二段起的 RUN_STARTED 不发：对用户来说这还是同一次回复。
        if (runStarted) return;
        event = {
          ...event,
          threadId,
          runId: entry.runId,
          input: { ...input, messages: newMessages },
        } as BaseEvent;
      } else if (event.type === EventType.RUN_FINISHED) {
        event = { ...event, threadId, runId: entry.runId } as BaseEvent;
        if (segmenting) {
          heldFinish = event;
          return;
        }
      }
      const published = prepared.event(event);
      if (!published) return;
      const sequence = await this.store.append(
        threadId,
        entry.runId,
        published,
      );
      finalizer.observe(published);
      runStarted ||= published.type === EventType.RUN_STARTED;
      terminal ||=
        published.type === EventType.RUN_FINISHED ||
        published.type === EventType.RUN_ERROR;
      failed ||= published.type === EventType.RUN_ERROR;
      entry.stream.next(published);
      entry.live.next({ sequence, event: published });
      notify(published);
    };
    // AG-UI catches subscriber exceptions. Remember failed writes and stop the producer ourselves.
    const guarded = (action: () => Promise<unknown>): Promise<void> => {
      durableWrites = durableWrites.then(async () => {
        if (persistenceError) return;
        try {
          await action();
        } catch (error) {
          persistenceError = error;
          try {
            agent.abortRun();
          } catch {
            /* Finalization reports the original write failure. */
          }
          void agent.detachActiveRun();
        }
      });
      return durableWrites;
    };
    /** 推一张带插话的完整快照给界面（幂等：同 id 的消息替换，不会重复）。 */
    const pushSnapshot = (messages: readonly Message[]) => {
      const snapshot = structuredClone(woven(messages)) as Message[];
      return guarded(() =>
        emit({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: snapshot,
        } as BaseEvent),
      );
    };
    // AG-UI invokes these callbacks without awaiting them. Freeze each snapshot and queue it
    // with event writes so an earlier partial snapshot cannot overwrite the completed transcript.
    const capture = (
      messages: readonly Readonly<Message>[],
      state: unknown,
    ) => {
      latest = structuredClone(messages) as Message[];
      const savedMessages = prepared.project(woven(latest));
      const savedState = prepared.sanitize(structuredClone(state));
      const write = guarded(() =>
        this.store.snapshot(threadId, entry.runId, savedMessages, savedState),
      );
      if (
        pendingNotices.length &&
        pendingNotices.every((anchors) => anchorsPresent(latest, anchors))
      ) {
        pendingNotices = [];
        void pushSnapshot(latest);
      }
      return write;
    };
    const steering = () =>
      newSteerSession(
        async () => {
          if (entry.stopped) return [];
          return (await this.inbox.claim(threadId, entry.runId)).map(
            (claimed) => claimed.message,
          );
        },
        (messages, anchors) => {
          for (const message of messages)
            entry.injections.push({ message, anchors });
          if (anchorsPresent(latest, anchors)) void pushSnapshot(latest);
          else pendingNotices.push(anchors);
        },
      );
    const finalize = async (interruptionMessage?: string) => {
      if (heldFinish && !terminal) {
        const finish = heldFinish;
        heldFinish = undefined;
        await emit(finish);
      }
      if (!runStarted && !terminal)
        await emit({
          type: EventType.RUN_STARTED,
          threadId,
          runId: entry.runId,
        } as BaseEvent);
      for (const event of finalizer.finalize({
        stopRequested: entry.stopped,
        protocolVersion: input.protocolVersion,
        ...(interruptionMessage ? { interruptionMessage } : {}),
      })) {
        // Synthetic results answer interrupted tools in both the transcript and replay stream.
        if (event.type === EventType.TOOL_CALL_RESULT) {
          const result = event as BaseEvent & {
            messageId: string;
            toolCallId: string;
            content: string;
          };
          agent.setMessages(
            mergeConversationMessages(agent.messages, [
              {
                id: result.messageId,
                role: "tool",
                content: result.content,
                toolCallId: result.toolCallId,
              },
            ]),
          );
        }
        await emit(event);
      }
      await durableWrites;
      await this.store.snapshot(
        threadId,
        entry.runId,
        prepared.project(woven(agent.messages)),
        prepared.sanitize(agent.state),
      );
    };
    try {
      const identity = await this.store.thread(threadId);
      if (agent.agentId && agent.agentId !== identity.agent_id)
        throw new LocalConversationError(
          "Thread belongs to a different agent",
          409,
        );
      // Claim and run-record creation are atomic. A duplicate ID never releases the existing lease.
      await this.store.database.$client.begin(async (transaction) => {
        const claimed = await transaction.unsafe(
          `UPDATE openbot_local_threads SET run_id = $2,
           lock_expires_at = now() + interval '120 seconds', updated_at = now()
           WHERE id = $1 AND (run_id IS NULL OR lock_expires_at <= now() OR run_id = $2) RETURNING id`,
          [threadId, entry.runId],
        );
        if (claimed.length === 0)
          throw new LocalConversationError("Thread already running", 409);
        const inserted = await transaction.unsafe(
          `INSERT INTO openbot_local_runs (thread_id, run_id, status) VALUES ($1, $2, 'running')
           ON CONFLICT (thread_id, run_id) DO NOTHING RETURNING run_id`,
          [threadId, entry.runId],
        );
        if (inserted.length === 0)
          throw new LocalConversationError("Run ID was already used", 409);
      });
      started = true;
      // Read after claiming so a prior run finishing during acquisition cannot leave stale history.
      const row = await this.store.thread(threadId);
      // 重新生成 / 编辑后重发截掉的消息（DESIGN.md §67）：还没收到截断的旧设备会把它们一起发上来，滤掉，不让它们复活。
      const dead = await tombstones(this.store.database, threadId);
      prepared = prepareConversationMessages(
        row.messages,
        dropTombstoned(input.messages, dead),
        request.persistedInputMessages
          ? dropTombstoned(request.persistedInputMessages, dead)
          : undefined,
      );
      const oldIds = new Set(row.messages.map((message) => message.id));
      newMessages.push(
        ...prepared.visible.filter((message) => !oldIds.has(message.id)),
      );
      // 排队过、后来被客户端当普通消息发出来的：由这一轮负责回答。
      await this.inbox.merge(
        threadId,
        entry.runId,
        newMessages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      );
      // 欠回答的（上一轮出错 / 服务重启）和还在排队的，跟着这一轮一起读进去。
      await this.inbox.requeueOwed(threadId);
      const early = await this.inbox.claim(threadId, entry.runId);
      const execution = [...prepared.execution];
      for (const claimed of early) {
        if (execution.some((message) => message.id === claimed.message.id))
          continue;
        execution.push(claimed.message);
        newMessages.push(claimed.message);
        entry.injections.push({
          message: claimed.message,
          anchors: [],
          afterId: execution[execution.length - 2]?.id,
        });
      }
      agent.threadId = threadId;
      agent.setMessages(execution);
      latest = execution;
      agent.setState(
        Object.keys(row.state ?? {}).length > 0
          ? row.state
          : (input.state ?? {}),
      );
      await this.store.snapshot(
        threadId,
        entry.runId,
        prepared.project(woven(prepared.visible)),
        prepared.sanitize(agent.state),
      );
      let renewing = false;
      const runStartedAt = Date.now();
      heartbeat = setInterval(() => {
        // Track B：墙钟到期 → 强制 stop，避免挂死 agent 靠续锁永久占频道。
        if (!entry.stopped && Date.now() - runStartedAt >= MAX_RUN_WALL_MS) {
          console.warn(
            JSON.stringify({
              type: "conversation-run-wall-clock",
              thread: threadId,
              run: entry.runId,
              wallMs: MAX_RUN_WALL_MS,
            }),
          );
          entry.stopped = true;
          try {
            entry.abort.abort();
          } catch {
            /* ignore */
          }
          try {
            entry.agent.abortRun();
          } catch {
            /* ignore */
          }
          void entry.agent.detachActiveRun().catch(() => undefined);
          return;
        }
        if (renewing) return;
        renewing = true;
        void guarded(() =>
          this.client.ɵrenewThreadLock({
            threadId,
            runId: entry.runId,
            ttlSeconds: 120,
          }),
        ).finally(() => {
          renewing = false;
        });
      }, 30_000);
      for (
        let segment = 0;
        segment < MAX_SEGMENTS && !entry.stopped;
        segment++
      ) {
        segmenting = true;
        let finalized!: () => void;
        const finalization = new Promise<void>((resolve) => {
          finalized = resolve;
        });
        const segmentInput =
          segment === 0
            ? input
            : { ...input, runId: entry.runId, messages: agent.messages };
        await withConfirmTurn(
          { threadId, runId: entry.runId, stopped: () => entry.stopped },
          () =>
            withToolAbort(entry.abort.signal, () =>
              withSteering(steering(), () =>
                agent.runAgent(segmentInput, {
                  onEvent: ({ event }) =>
                    guarded(() => emit(structuredClone(event))),
                  onMessagesChanged: ({ messages, state }) =>
                    capture(messages, state),
                  onStateChanged: ({ messages, state }) =>
                    capture(messages, state),
                  onRunFinalized: () => {
                    finalized();
                  },
                }),
              ),
            ),
        );
        await finalization;
        await durableWrites;
        if (persistenceError || failed || entry.stopped || !heldFinish) break;
        // 这一段正常结束了，收件箱里还有没读的：同一次运行接着开下一段，把它们读进去。
        const more =
          segment + 1 < MAX_SEGMENTS
            ? await this.inbox.claim(threadId, entry.runId)
            : [];
        if (!more.length) break;
        const base = woven(agent.messages);
        for (const claimed of more) {
          entry.injections.push({
            message: claimed.message,
            anchors: [],
            afterId: base[base.length - 1]?.id,
          });
          base.push(claimed.message);
        }
        agent.setMessages(base);
        latest = base;
        heldFinish = undefined;
        await pushSnapshot(base);
        await guarded(() =>
          this.store.snapshot(
            threadId,
            entry.runId,
            prepared.project(base),
            prepared.sanitize(agent.state),
          ),
        );
      }
      segmenting = false;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await durableWrites;
      if (persistenceError) throw persistenceError;
      await finalize();
    } catch (error) {
      failed = true;
      segmenting = false;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await durableWrites;
      if (started && !persistenceError) {
        try {
          await finalize(
            error instanceof Error ? error.message : "Local agent run failed",
          );
        } catch (writeError) {
          persistenceError = writeError;
        }
      }
      if (!started || persistenceError) {
        entry.stream.error(persistenceError ?? error);
        entry.live.error(persistenceError ?? error);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (started) {
        try {
          await this.store.database.$client.unsafe(
            "UPDATE openbot_local_runs SET status = $3, finished_at = now() WHERE thread_id = $1 AND run_id = $2",
            [
              threadId,
              entry.runId,
              entry.stopped ? "stopped" : failed ? "error" : "finished",
            ],
          );
          await this.inbox.settle(
            threadId,
            entry.runId,
            entry.stopped ? "stopped" : failed ? "owed" : "answered",
          );
          await this.client.ɵcleanupThreadLock({
            threadId,
            runId: entry.runId,
          });
        } catch (error) {
          entry.stream.error(error);
          entry.live.error(error);
        }
      }
      if (this.active.get(threadId) === entry) this.active.delete(threadId);
      entry.stream.complete();
      entry.live.complete();
    }
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const entry = this.active.get(request.threadId);
      const pending: LiveEvent[] = [];
      let ready = false;
      let completed = !entry;
      let liveError: unknown;
      let lastSequence = 0n;
      // Subscribe before reading; sequence IDs remove overlap without losing a live event.
      const live = entry?.live.subscribe({
        next: (item) => {
          if (!ready) pending.push(item);
          else if (item.sequence > lastSequence) {
            lastSequence = item.sequence;
            subscriber.next(item.event);
          }
        },
        error: (error) => {
          liveError = error;
          if (ready) subscriber.error(error);
        },
        complete: () => {
          completed = true;
          if (ready) subscriber.complete();
        },
      });
      void (async () => {
        /*
         * DOG-01 follow-up（2026-10-18）：长对话的事件日志可达数千条 / ~1MB。旧逻辑把 slimReplay 后的
         * 全量事件回放给浏览器——实测 星灵 一条对话 connect 仍 ~825KB、3882 条事件。浏览器主线程解析 /
         * apply 这些事件时，发消息的 `/run` 被拖住（busy/activity 已发出、/run 迟迟不到 nginx），乐观气泡
         * 干等几十秒；sync 仍 200，v0.1.18 的「连不上」路径也不会触发。
         *
         * 存档消息列才是权威快照（和 GET .../messages 同源）。接入时发一条 MESSAGES_SNAPSHOT + STATE，
         * 再接上正在跑的那一轮的 live 事件即可；历史事件日志不再整段下发。仍保留 events() 给调试接口。
         */
        const row = await this.store.thread(request.threadId);
        if (request.agentId && row.agent_id !== request.agentId)
          throw new LocalConversationError("Thread not found", 404);
        lastSequence = await this.store.lastEventSequence(request.threadId);
        const dims = imageDimsFor(this.store.database);
        /*
         * Track B：长对话压力——全量 annotate 上千条再一次塞进浏览器仍会拖住 `/run`。
         * 先按条数/体积封顶，只给最近一段标宽高；完整历史仍走 GET .../messages。
         */
        const capped = capConnectMessages(row.messages ?? []);
        if (capped.truncated) {
          console.info(
            JSON.stringify({
              type: "connect-snapshot-capped",
              thread: request.threadId,
              kept: capped.messages.length,
              dropped: capped.dropped,
            }),
          );
        }
        const messages = await dims.annotateMessages(capped.messages);
        subscriber.next({
          type: EventType.MESSAGES_SNAPSHOT,
          messages,
        } as BaseEvent);
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: row.state ?? {},
        } as BaseEvent);
        ready = true;
        for (const item of pending)
          if (item.sequence > lastSequence) {
            lastSequence = item.sequence;
            subscriber.next(item.event);
          }
        if (liveError) subscriber.error(liveError);
        else if (completed) subscriber.complete();
      })().catch((error) => subscriber.error(error));
      return () => live?.unsubscribe();
    });
  }

  async isRunning({ threadId }: { threadId: string }): Promise<boolean> {
    if (this.active.has(threadId)) return true;
    const rows = await this.store.database.$client.unsafe(
      "SELECT id FROM openbot_local_threads WHERE id = $1 AND run_id IS NOT NULL AND lock_expires_at > now()",
      [threadId],
    );
    return rows.length > 0;
  }

  async stop({ threadId, runId }: AgentRunnerStopRequest): Promise<boolean> {
    const entry = this.active.get(threadId);
    // 不在本进程里跑、库里却锁着：是重启前留下的孤儿锁，停止 = 释放它。
    if (!entry) return await this.client.ɵreleaseOrphanedLock(threadId, runId);
    if (entry.stopped || (runId !== undefined && entry.runId !== runId))
      return false;
    entry.stopped = true;
    entry.abort.abort();
    entry.agent.abortRun();
    await entry.agent.detachActiveRun();
    return true;
  }
}

/** 后台任务（workers/service.ts）挂到对话接口上的那部分：列出、补充说明、停止。 */
export type ThreadWorkerRoutes = {
  list(threadId: string, actorId: string): Promise<unknown[]>;
  steer(
    threadId: string,
    workerId: string,
    actorId: string,
    text: string,
  ): Promise<void>;
  /** `quiet`：机器人自己用工具停的（它这一轮里自己会说）；不给 = 用户在卡片上点的，停完往对话里补一条「已停止」。 */
  cancel(
    threadId: string,
    workerId: string,
    actorId: string,
    options?: { quiet?: boolean },
  ): Promise<void>;
};

/** 进程内能直接问运行器的事（后台任务用）。 */
export type LocalRunControl = {
  isActive(threadId: string): boolean;
  observe(threadId: string, listener: (event: BaseEvent) => void): () => void;
  stop(request: AgentRunnerStopRequest): Promise<boolean>;
};

export type LocalConversationBackend = {
  client: LocalConversationClient;
  runner: AgentRunner;
  control: LocalRunControl;
  inbox: ThreadInbox;
  /** 后台任务服务建好以后挂上来（index.ts）。 */
  setWorkers(routes: ThreadWorkerRoutes): void;
  handle(request: Request, actorId: string): Promise<Response | undefined>;
};

export async function createLocalConversations(
  database: Database,
): Promise<LocalConversationBackend> {
  // Independent tables avoid any dependency on a hosted migration service.
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS openbot_local_threads (
    id text PRIMARY KEY, owner_user_id text NOT NULL, agent_id text NOT NULL,
    name text, archived boolean NOT NULL DEFAULT false,
    messages jsonb NOT NULL DEFAULT '[]'::jsonb, state jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_id text, lock_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS openbot_local_runs (
    thread_id text NOT NULL REFERENCES openbot_local_threads(id) ON DELETE CASCADE,
    run_id text NOT NULL, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    PRIMARY KEY (thread_id, run_id)
  )`);
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS openbot_local_events (
    sequence bigserial PRIMARY KEY,
    thread_id text NOT NULL REFERENCES openbot_local_threads(id) ON DELETE CASCADE,
    run_id text NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await database.$client.unsafe(
    "CREATE INDEX IF NOT EXISTS openbot_local_events_thread_sequence ON openbot_local_events(thread_id, sequence)",
  );
  await database.$client.unsafe(
    "CREATE INDEX IF NOT EXISTS openbot_local_threads_owner_updated ON openbot_local_threads(owner_user_id, updated_at DESC)",
  );
  await ensureTruncationTable(database);
  const store = new ConversationStore(database);
  const client = new LocalConversationClient(store);
  const inbox = new ThreadInbox(database);
  await inbox.ensure();
  if (process.env.CHISABOT_RELEASE_LOCKS_ON_START !== "0") {
    try {
      const owed = await inbox.releaseInterrupted();
      if (owed)
        console.log(
          JSON.stringify({
            type: "thread-inbox-owed-after-restart",
            count: owed,
          }),
        );
    } catch (error) {
      console.warn("releasing interrupted inbox items failed", error);
    }
    try {
      const released = await client.ɵreleaseOrphanedLocks();
      if (released.threads || released.runs)
        console.log(
          JSON.stringify({ type: "conversation-locks-released", ...released }),
        );
    } catch (error) {
      console.warn("releasing orphaned conversation locks failed", error);
    }
  }
  // Track B：存活期间也扫过期锁（启动清锁管重启；这里管 renewal 停了却没 finally 的边角）。
  if (process.env.CHISABOT_RELEASE_LOCKS_ON_START !== "0") {
    const sweep = () => {
      void client
        .ɵsweepExpiredLocks()
        .then((report) => {
          if (report.threads || report.runs)
            console.info(
              JSON.stringify({ type: "conversation-locks-swept", ...report }),
            );
        })
        .catch((error) =>
          console.warn("sweeping expired conversation locks failed", error),
        );
    };
    const sweepTimer = setInterval(sweep, STALE_LOCK_SWEEP_MS);
    sweepTimer.unref?.();
  }
  /*
   * 输入框「上下文」读数（DESIGN.md §25）：最近一次带用量的 RUN_FINISHED；一条都没有就按消息文字粗估。
   * 只读一行（按 thread_id + sequence 索引倒序），不扫整张事件表。
   */
  const contextReading = async (
    threadId: string,
    messages: readonly unknown[],
  ): Promise<ThreadContextReading | null> => {
    const rows = await database.$client.unsafe<
      { event: Record<string, unknown>; created_at: Date }[]
    >(
      `SELECT event, created_at FROM openbot_local_events
       WHERE thread_id = $1 AND event->>'type' = 'RUN_FINISHED'
       AND (event ? 'usage' OR event->'metadata' ? 'contextUsage')
       ORDER BY sequence DESC LIMIT 1`,
      [threadId],
    );
    const measured = rows[0] ? readingFromRunFinished(rows[0]) : undefined;
    if (measured) return measured;
    if (!messages.length) return null;
    return { tokens: estimateTokens(messages), source: "estimate" };
  };

  /**
   * 「已停止」标记（2026-10-13 第四轮）：用户按停止的那些轮次，用开启那一轮的用户消息 id 表示。
   * 一轮里用到浏览器时会拆成好几次运行（前端工具要回到浏览器执行），被停的那次运行输入里可能只有工具
   * 结果，所以往回找它前面最近的一条用户消息。只读，不改历史；标记本身不进对话（不会发给模型）。
   */
  const stoppedTurns = async (
    threadId: string,
    messages: readonly Message[],
  ): Promise<string[]> => {
    // 一条 SQL 连表（Bun SQL 的 unsafe 不会把 JS 数组变成 text[] 参数）。
    const started = await database.$client.unsafe<
      { event: { input?: { messages?: { id?: string }[] } } }[]
    >(
      `SELECT e.event FROM openbot_local_events e
       JOIN openbot_local_runs r ON r.thread_id = e.thread_id AND r.run_id = e.run_id
       WHERE e.thread_id = $1 AND r.status = 'stopped' AND e.event->>'type' = 'RUN_STARTED'
       ORDER BY e.sequence DESC LIMIT 50`,
      [threadId],
    );
    if (!started.length) return [];
    const ids = new Set<string>();
    for (const { event } of started) {
      const inputIds = (event.input?.messages ?? [])
        .map((message) => message.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const userId = userMessageIdForStoppedRun(inputIds, messages);
      if (userId) ids.add(userId);
    }
    return [...ids];
  };
  /**
   * 「主模型额度用完，已改用 X」（DESIGN.md §61）：换过备用模型的那些轮次（RUN_FINISHED 的
   * metadata.modelFallback），同「已停止」一样用开启那一轮的用户消息 id 表示。只读，不进对话。
   */
  const fallbackTurns = async (
    threadId: string,
    messages: readonly Message[],
  ) => {
    const rows = await database.$client.unsafe<
      {
        fallback: { from?: unknown; to?: unknown; reason?: unknown };
        started: { input?: { messages?: { id?: string }[] } } | null;
      }[]
    >(
      `SELECT f.event->'metadata'->'modelFallback' AS fallback,
              (SELECT s.event FROM openbot_local_events s
                WHERE s.thread_id = f.thread_id AND s.run_id = f.run_id AND s.event->>'type' = 'RUN_STARTED'
                ORDER BY s.sequence ASC LIMIT 1) AS started
       FROM openbot_local_events f
       WHERE f.thread_id = $1 AND f.event->>'type' = 'RUN_FINISHED' AND f.event->'metadata' ? 'modelFallback'
       ORDER BY f.sequence DESC LIMIT 50`,
      [threadId],
    );
    if (!rows.length) return [];
    const position = new Map(
      messages.map((message, index) => [message.id, index]),
    );
    const turns = new Map<
      string,
      {
        userMessageId: string;
        from: string;
        to: string;
        reason: string;
        notice: string;
      }
    >();
    for (const { fallback, started } of rows) {
      if (typeof fallback?.to !== "string" || typeof fallback.from !== "string")
        continue;
      const indexes = (started?.input?.messages ?? [])
        .map((message) => position.get(String(message.id)))
        .filter((index): index is number => index !== undefined);
      if (!indexes.length) continue;
      // 输入里最后一条用户消息开启的这一轮（一轮拆成几次运行时，同一条用户消息只记一次）。
      for (let at = Math.max(...indexes); at >= 0; at--) {
        const message = messages[at];
        if (message?.role !== "user") continue;
        const reason =
          fallback.reason === "unavailable" ? "unavailable" : "quota";
        if (!turns.has(message.id))
          turns.set(message.id, {
            userMessageId: message.id,
            from: fallback.from,
            to: fallback.to,
            reason,
            notice: fallbackNotice({ to: fallback.to, reason }),
          });
        break;
      }
    }
    return [...turns.values()];
  };
  /**
   * 最新一条用户消息什么时候发的（DESIGN.md §94：5 分钟内连续发消息不翻页）：它第一次出现在某次运行的
   * RUN_STARTED 输入里的那一刻（存的 RUN_STARTED 只带这次新进来的消息，见 slimReplay 上面的说明，所以很小）。
   * 只看最近 40 次运行；找不到（太旧 / 还没跑过）回 null。同时回服务器的「现在」，浏览器用差值换算，不受两边时钟差影响。只读。
   */
  const lastSentAt = async (threadId: string, messages: readonly Message[]) => {
    const now = new Date().toISOString();
    const newest = messages.findLast((message) => message.role === "user");
    if (!newest) return { userMessageId: null, at: null, now };
    const rows = await database.$client.unsafe<
      {
        event: { input?: { messages?: { id?: unknown }[] } };
        created_at: Date;
      }[]
    >(
      `SELECT event, created_at FROM openbot_local_events
       WHERE thread_id = $1 AND event->>'type' = 'RUN_STARTED'
       ORDER BY sequence DESC LIMIT 40`,
      [threadId],
    );
    let at: Date | null = null;
    for (const row of rows) {
      if (
        (row.event.input?.messages ?? []).some(
          (message) => message?.id === newest.id,
        )
      )
        at = row.created_at;
    }
    return {
      userMessageId: newest.id,
      at: at ? new Date(at).toISOString() : null,
      now,
    };
  };
  const runner = new PostgresAgentRunner(store, client, inbox);
  let workers: ThreadWorkerRoutes | undefined;

  const handle = async (
    request: Request,
    actorId: string,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const matched = /^\/api\/copilotkit\/threads(?:\/(.*))?\/?$/.exec(
      url.pathname,
    );
    if (!matched) return undefined;
    try {
      if (!actorId)
        throw new LocalConversationError("A verified user is required", 401);
      const suffix = matched[1] ?? "";
      if (!suffix && request.method === "GET") {
        const rows = await database.$client.unsafe<ThreadRow[]>(
          `SELECT * FROM openbot_local_threads WHERE owner_user_id = $1
           AND ($2::text IS NULL OR agent_id = $2) AND ($3::boolean OR NOT archived)
           ORDER BY updated_at DESC LIMIT 100`,
          [
            actorId,
            url.searchParams.get("agentId"),
            url.searchParams.get("includeArchived") === "true",
          ],
        );
        return Response.json({ threads: rows.map(record), nextCursor: null });
      }
      if (suffix === "clear" && request.method === "POST") {
        await database.$client.begin(async (transaction) => {
          const rows = await transaction.unsafe<ThreadRow[]>(
            "SELECT * FROM openbot_local_threads WHERE owner_user_id = $1 FOR UPDATE",
            [actorId],
          );
          if (
            rows.some(
              (row) =>
                row.run_id &&
                row.lock_expires_at &&
                new Date(row.lock_expires_at).getTime() > Date.now(),
            )
          )
            throw new LocalConversationError(
              "Stop running threads before clearing history",
              409,
            );
          await transaction.unsafe(
            "DELETE FROM openbot_local_threads WHERE owner_user_id = $1",
            [actorId],
          );
        });
        return Response.json({ success: true });
      }
      const [encodedId, operation] = suffix.split("/");
      if (!encodedId)
        throw new LocalConversationError("Thread is required", 400);
      const threadId = decodeURIComponent(encodedId);
      // 新对话第一次打开时还没有这一行（第一条消息才建）：输入框读数、停止标记、收件箱、任务卡片这几个
      // 只读接口回空结果（200），不报 404 —— 浏览器控制台里每开一个新对话就是三条红字（实测 2026-10-13）。
      // 别人的对话也走这里，回的同样是空结果，看不出它存不存在。
      if (
        request.method === "GET" &&
        operation &&
        Object.hasOwn(EMPTY_THREAD_READS, operation)
      ) {
        const found = await database.$client.unsafe<
          { owner_user_id: string }[]
        >("SELECT owner_user_id FROM openbot_local_threads WHERE id = $1", [
          threadId,
        ]);
        if (!found[0] || found[0].owner_user_id !== actorId)
          return Response.json(EMPTY_THREAD_READS[operation]);
      }
      const row = await store.owned({ threadId, userId: actorId });
      const requestedAgent = url.searchParams.get("agentId");
      if (requestedAgent && requestedAgent !== row.agent_id)
        throw new LocalConversationError("Thread not found", 404);
      if (request.method === "GET") {
        // 图片带上宽高，网页先按比例留框（DESIGN.md §83.2）。只改回给浏览器的这份，不改存储。
        if (operation === "messages")
          return Response.json({
            messages: await imageDimsFor(database).annotateMessages(
              row.messages,
            ),
          });
        if (operation === "state") return Response.json({ state: row.state });
        if (operation === "context")
          return Response.json({
            context: await contextReading(threadId, row.messages),
          });
        if (operation === "stopped")
          return Response.json({
            userMessageIds: await stoppedTurns(threadId, row.messages),
          });
        if (operation === "fallbacks")
          return Response.json({
            turns: await fallbackTurns(threadId, row.messages),
          });
        if (operation === "sent-at")
          return Response.json(await lastSentAt(threadId, row.messages));
        if (operation === "events")
          return Response.json({
            events: compactEvents(
              (await store.events(threadId)).map((event) => event.event),
            ),
          });
        if (operation === "inbox")
          return Response.json({
            running: runner.isActive(threadId),
            items: await inbox.list(threadId),
          });
        if (operation === "workers")
          return Response.json({
            workers: workers ? await workers.list(threadId, actorId) : [],
          });
        if (!operation) return Response.json({ thread: record(row) });
      }
      if (operation === "truncate" && request.method === "POST") {
        // 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：从这条用户消息起截掉，客户端随后照常发新的一轮。
        const body = (await request.json()) as {
          fromMessageId?: unknown;
          mode?: unknown;
        };
        const fromMessageId =
          typeof body.fromMessageId === "string" ? body.fromMessageId : "";
        if (!fromMessageId || fromMessageId.length > 200)
          throw new LocalConversationError("Message id is required", 400);
        const mode =
          body.mode === "regenerate" || body.mode === "edit"
            ? body.mode
            : "resend";
        if (runner.isActive(threadId))
          throw new LocalConversationError(
            "机器人正在回答，等它说完（或先停止）再重发",
            409,
          );
        let result: Awaited<ReturnType<typeof truncateThread>>;
        try {
          result = await truncateThread(database, {
            threadId,
            ownerUserId: actorId,
            fromMessageId,
            mode,
          });
        } catch (error) {
          if (error instanceof TruncateError)
            throw new LocalConversationError(error.message, error.status);
          throw error;
        }
        await afterTruncate(database, {
          threadId,
          ownerUserId: actorId,
          removedToolCalls: result.removedToolCalls,
        });
        if (workers) {
          for (const workerId of await workersSince(
            database,
            threadId,
            actorId,
            result.cutAt,
          ))
            await workers
              .cancel(threadId, workerId, actorId, { quiet: true })
              .catch(() => {});
        }
        console.log(
          JSON.stringify({
            type: "thread-truncated",
            threadId,
            mode,
            removed: result.removed.length,
            revision: result.revision,
          }),
        );
        return Response.json({
          ok: true,
          removed: result.removed,
          kept: result.kept,
          revision: result.revision,
        });
      }
      if (operation === "inbox" && request.method === "POST") {
        // 正在回答时又发来的一条：进收件箱（这一轮的下一步读进去）。没在跑就告诉客户端照常发送。
        const body = (await request.json()) as { id?: unknown; text?: unknown };
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!id || id.length > 128)
          throw new LocalConversationError("Message id is required", 400);
        if (!text)
          throw new LocalConversationError("Message text is required", 400);
        if (text.length > INBOX_TEXT_LIMIT)
          throw new LocalConversationError("Message is too long", 413);
        if (!runner.isActive(threadId)) return Response.json({ queued: false });
        if (row.messages.some((message) => message.id === id))
          return Response.json({ queued: true, status: "read" });
        try {
          await inbox.enqueue({
            threadId,
            ownerUserId: actorId,
            message: { id, role: "user", content: text } as Message,
          });
        } catch (error) {
          throw new LocalConversationError(
            error instanceof Error ? error.message : "Queue is full",
            429,
          );
        }
        return Response.json({ queued: true, status: "queued" });
      }
      if (operation === "inbox" && request.method === "DELETE") {
        const id = url.searchParams.get("id") ?? "";
        return Response.json({
          withdrawn: id ? await inbox.withdraw(threadId, id) : false,
        });
      }
      if (operation === "workers" && request.method === "POST") {
        if (!workers)
          throw new LocalConversationError(
            "Background workers are not available",
            404,
          );
        const body = (await request.json()) as {
          workerId?: unknown;
          action?: unknown;
          text?: unknown;
        };
        const workerId = typeof body.workerId === "string" ? body.workerId : "";
        if (!workerId)
          throw new LocalConversationError("Worker is required", 400);
        if (body.action === "cancel")
          await workers.cancel(threadId, workerId, actorId);
        else if (body.action === "steer") {
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text)
            throw new LocalConversationError("Message text is required", 400);
          await workers.steer(
            threadId,
            workerId,
            actorId,
            text.slice(0, INBOX_TEXT_LIMIT),
          );
        } else throw new LocalConversationError("Unknown worker action", 400);
        return Response.json({ ok: true });
      }
      if (!operation && request.method === "DELETE") {
        const removed = await database.$client.unsafe(
          `DELETE FROM openbot_local_threads WHERE id = $1 AND owner_user_id = $2
           AND (run_id IS NULL OR lock_expires_at <= now()) RETURNING id`,
          [threadId, actorId],
        );
        if (!removed.length)
          throw new LocalConversationError(
            "Stop the running thread before deleting it",
            409,
          );
        return new Response(null, { status: 204 });
      }
      if (
        (!operation && request.method === "PATCH") ||
        (operation === "archive" && request.method === "POST")
      ) {
        const body = (await request.json()) as {
          name?: unknown;
          archived?: unknown;
          agentId?: unknown;
        };
        if (body.agentId !== undefined && body.agentId !== row.agent_id)
          throw new LocalConversationError("Thread not found", 404);
        if (
          body.name !== undefined &&
          typeof body.name !== "string" &&
          body.name !== null
        )
          throw new LocalConversationError("Thread name must be text", 400);
        if (body.archived !== undefined && typeof body.archived !== "boolean")
          throw new LocalConversationError("Archived must be boolean", 400);
        const changed = await database.$client.unsafe<ThreadRow[]>(
          `UPDATE openbot_local_threads SET name = $3, archived = $4, updated_at = now()
           WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
          [
            threadId,
            actorId,
            body.name === undefined ? row.name : body.name,
            operation === "archive"
              ? true
              : body.archived === undefined
                ? row.archived
                : body.archived,
          ],
        );
        if (!changed[0])
          throw new LocalConversationError("Thread not found", 404);
        return Response.json({ thread: record(changed[0]) });
      }
      /*
       * Track B：客户端看门狗 / 停止在「run 无内存条目但库里仍锁着」时调用。
       * 会 stop 进行中的本进程回合，并释放孤儿锁，避免频道永久 busy。
       */
      if (operation === "unlock" && request.method === "POST") {
        const stopped = await runner.stop({ threadId }).catch(() => false);
        const released = stopped
          ? true
          : await client.ɵreleaseOrphanedLock(threadId);
        console.info(
          JSON.stringify({
            type: "conversation-force-unlock",
            thread: threadId,
            stopped: Boolean(stopped),
            released: Boolean(released),
          }),
        );
        return Response.json({
          ok: true,
          stopped: Boolean(stopped),
          released: Boolean(released),
        });
      }
      throw new LocalConversationError(
        "Local thread operation is unsupported",
        405,
      );
    } catch (error) {
      if (error instanceof LocalConversationError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      if (error instanceof SyntaxError || error instanceof URIError)
        return Response.json(
          { error: "Invalid thread request" },
          { status: 400 },
        );
      throw error;
    }
  };
  const control: LocalRunControl = {
    isActive: (threadId) => runner.isActive(threadId),
    observe: (threadId, listener) => runner.observe(threadId, listener),
    stop: (request) => runner.stop(request),
  };
  return {
    client,
    runner,
    control,
    inbox,
    setWorkers: (routes) => {
      workers = routes;
    },
    handle,
  };
}
