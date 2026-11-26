import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, Subject } from "rxjs";
import type { DshHostClient } from "../../runtime/dsh/src/client.mjs";
import { DshClientPool } from "../src/conversations/dsh-client-pool";
import {
  createConversationRoutes,
  eventStream,
} from "../src/conversations/routes";
import { createLocalConversations } from "../src/local-conversations";

type FakeClient = DshHostClient & {
  closedCount: number;
  connectedState: boolean;
};

function makeFakeClient(connected = true): FakeClient {
  const client = {
    closedCount: 0,
    connectedState: connected,
    get isConnected() {
      return client.connectedState;
    },
    async close() {
      client.closedCount += 1;
      client.connectedState = false;
    },
  } as unknown as FakeClient;
  return client;
}

describe("DshClientPool", () => {
  test("reuses idle connected clients, skips disconnected ones, and respects maxIdle", async () => {
    const created: FakeClient[] = [];
    const pool = new DshClientPool({
      maxIdlePerEndpoint: 1,
      idleTtlMs: 60_000,
      connect: async () => {
        const c = makeFakeClient(true);
        created.push(c);
        return c;
      },
    });

    const first = (await pool.acquire("http://127.0.0.1:4100")) as FakeClient;
    expect(created).toHaveLength(1);
    pool.release("http://127.0.0.1:4100", first);
    expect(pool.idleCount("http://127.0.0.1:4100")).toBe(1);

    // Same connected client is reused without reconnect
    const reused = (await pool.acquire("http://127.0.0.1:4100")) as FakeClient;
    expect(reused).toBe(first);
    expect(created).toHaveLength(1);

    // Concurrent second acquire opens a fresh connection; releasing both trims to maxIdle=1
    const second = (await pool.acquire("http://127.0.0.1:4100")) as FakeClient;
    expect(created).toHaveLength(2);
    pool.release("http://127.0.0.1:4100", reused);
    pool.release("http://127.0.0.1:4100", second);
    expect(pool.idleCount("http://127.0.0.1:4100")).toBe(1);
    expect(second.closedCount).toBe(1);

    // Disconnected client in idle bucket is discarded automatically on next acquire
    reused.connectedState = false;
    const third = (await pool.acquire("http://127.0.0.1:4100")) as FakeClient;
    expect(third).not.toBe(reused);
    expect(reused.closedCount).toBe(1);
    expect(created).toHaveLength(3);

    pool.release("http://127.0.0.1:4100", third);
    await pool.closeAll();
    expect(pool.idleCount()).toBe(0);
    expect(third.closedCount).toBe(1);
  });

  test("evicts oldest idle clients globally via LRU when exceeding maxTotalIdle", async () => {
    const byEndpoint = new Map<string, FakeClient>();
    const pool = new DshClientPool({
      maxIdlePerEndpoint: 4,
      maxTotalIdle: 2,
      idleTtlMs: 60_000,
      connect: async (endpoint) => {
        const c = makeFakeClient(true);
        byEndpoint.set(endpoint, c);
        return c;
      },
    });

    const c1 = (await pool.acquire("http://127.0.0.1:4101")) as FakeClient;
    const c2 = (await pool.acquire("http://127.0.0.1:4102")) as FakeClient;
    const c3 = (await pool.acquire("http://127.0.0.1:4103")) as FakeClient;

    pool.release("http://127.0.0.1:4101", c1);
    pool.release("http://127.0.0.1:4102", c2);
    expect(pool.idleCount()).toBe(2);

    // Releasing a 3rd endpoint evicts c1 (oldest LRU) and closes it.
    pool.release("http://127.0.0.1:4103", c3);
    expect(pool.idleCount()).toBe(2);
    expect(pool.idleCount("http://127.0.0.1:4101")).toBe(0);
    expect(pool.idleCount("http://127.0.0.1:4102")).toBe(1);
    expect(pool.idleCount("http://127.0.0.1:4103")).toBe(1);
    expect(c1.closedCount).toBe(1);
    expect(c2.closedCount).toBe(0);
    expect(c3.closedCount).toBe(0);

    await pool.closeAll();
    expect(pool.idleCount()).toBe(0);
    expect(c2.closedCount).toBe(1);
    expect(c3.closedCount).toBe(1);
  });
});

describe("Conversation routes single-hop SSE & backpressure coalescing", () => {
  test("POST /commands with Accept: text/event-stream streams admission and run events in one request", async () => {
    const fakeBackend = {
      client: {
        getOrCreateThread: async () => {},
        getThread: async () => ({ agentId: "bot-1" }),
      },
      commands: {
        accept: async () => ({
          alreadyAccepted: false,
          record: {
            command_id: "cmd-1",
            run_id: "run-1",
            thread_id: "t-1",
            bot_id: "bot-1",
            owner_user_id: "user-1",
            status: "accepted",
            input: {
              threadId: "t-1",
              runId: "run-1",
              state: {},
              tools: [],
              context: [],
              messages: [{ id: "cmd-1", role: "user", content: "hello" }],
            },
          },
        }),
      },
      runner: {
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            subscriber.complete();
          }),
        connect: () =>
          new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
              type: EventType.RUN_STARTED,
              threadId: "t-1",
              runId: "run-1",
            } as BaseEvent);
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              messageId: "m-1",
              role: "assistant",
            } as BaseEvent);
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "m-1",
              delta: "hi",
            } as BaseEvent);
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              messageId: "m-1",
            } as BaseEvent);
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: "t-1",
              runId: "run-1",
            } as BaseEvent);
            subscriber.complete();
          }),
      },
    };
    const routes = createConversationRoutes({
      backend: fakeBackend as never,
      resolver: {
        resolveAgentForActor: async () => ({
          use: () => {},
          runAgent: async () => {},
        }),
        resolveAgentsForActor: async () => ({}),
      } as never,
      identifyActor: async () => ({ id: "user-1", role: "user" }) as never,
    });

    const sseRes = await routes.request(
      "http://localhost/api/conversations/t-1/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          agentId: "bot-1",
          deltaOnly: true,
          input: {
            threadId: "t-1",
            runId: "run-client",
            state: {},
            tools: [],
            context: [],
            messages: [{ id: "cmd-1", role: "user", content: "hello" }],
          },
        }),
      },
    );

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(sseRes.headers.get("x-chisabot-command-id")).toBe("cmd-1");
    expect(sseRes.headers.get("x-chisabot-run-id")).toBe("run-1");

    const raw = await sseRes.text();
    const events = raw
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map(
        (chunk) =>
          JSON.parse(chunk.slice(6)) as {
            type: string;
            name?: string;
            delta?: string;
          },
      );

    expect(events.map((e) => e.name ?? e.type)).toEqual([
      EventType.RUN_STARTED,
      "chisabot.admission",
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    // Legacy JSON callers remain unaffected
    const jsonRes = await routes.request(
      "http://localhost/api/conversations/t-1/commands",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bot-1",
          input: {
            threadId: "t-1",
            runId: "run-client",
            state: {},
            tools: [],
            context: [],
            messages: [{ id: "cmd-1", role: "user", content: "hello" }],
          },
        }),
      },
    );
    expect(jsonRes.status).toBe(202);
    expect(await jsonRes.json()).toMatchObject({
      accepted: true,
      commandId: "cmd-1",
      runId: "run-1",
    });
  });

  test("eventStream coalesces delta chunks under consumer backpressure before boundary events", async () => {
    const source = new Subject<BaseEvent>();
    const response = eventStream(source);

    // Push > highWaterMark while consumer has not started reading yet (desiredSize <= 0)
    source.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m-bp",
      role: "assistant",
    } as BaseEvent);
    for (let i = 0; i < 10; i++) {
      source.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m-bp",
        delta: `${i}`,
      } as BaseEvent);
    }
    source.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m-bp",
    } as BaseEvent);
    source.complete();

    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map(
        (chunk) =>
          JSON.parse(chunk.slice(6)) as { type: string; delta?: string },
      );

    expect(frames.some((f) => f.type === EventType.TEXT_MESSAGE_START)).toBe(
      true,
    );
    expect(frames.some((f) => f.type === EventType.TEXT_MESSAGE_END)).toBe(
      true,
    );
    const contentFrames = frames.filter(
      (f) => f.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(contentFrames.map((f) => f.delta).join("")).toBe("0123456789");
    expect(contentFrames.length).toBeLessThan(10);
  });
});

describe("PostgresAgentRunner non-blocking live deltas & 50ms DB coalescing", () => {
  test("delivers live SSE tokens immediately without waiting on slow PostgreSQL inserts and coalesces deltas", async () => {
    let seq = 0n;
    const insertedEvents: Array<{ type: string; delta?: string }> = [];
    const threadRow = {
      id: "t-coalesce",
      owner_user_id: "u-coalesce",
      agent_id: "bot-coalesce",
      name: "Coalesce",
      archived: false,
      messages: [],
      state: {},
      run_id: null as string | null,
      lock_expires_at: null as Date | null,
      created_at: new Date(),
      updated_at: new Date(),
      snapshot_sequence: "0",
    };

    const unsafe = async (sql: string, params: unknown[] = []) => {
      const q = sql.trim().replace(/\s+/g, " ");
      if (/^SELECT .+ FROM chisabot_local_threads WHERE id = \$1\b/.test(q)) {
        return [{ ...threadRow }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = $2")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "run-c") }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_events")) {
        await new Promise((r) => setTimeout(r, 15));
        seq += 1n;
        insertedEvents.push(
          JSON.parse(String(params[2])) as { type: string; delta?: string },
        );
        return [{ sequence: String(seq) }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET messages = $3")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = NULL")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("UPDATE chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "") }];
      }
      return [];
    };

    const dbClient = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        unsafe(strings.join("?"), values),
      {
        unsafe,
        begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
          fn({ unsafe }),
        close: async () => {},
      },
    );

    const backend = await createLocalConversations({
      $client: dbClient,
    } as never);

    class FastBurstAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId: "m-fast",
            role: "assistant",
          } as BaseEvent);
          for (let i = 0; i < 30; i++) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "m-fast",
              delta: `t${i}`,
            } as BaseEvent);
          }
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId: "m-fast",
          } as BaseEvent);
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.complete();
        });
      }
    }

    const t0 = performance.now();
    let firstDeltaMs = 0;
    let all30Ms = 0;
    let seenDeltas = 0;

    await new Promise<void>((resolve, reject) => {
      backend.runner
        .run({
          threadId: "t-coalesce",
          agent: new FastBurstAgent({ agentId: "bot-coalesce" }),
          input: {
            threadId: "t-coalesce",
            runId: "run-c",
            messages: [{ id: "u-1", role: "user", content: "go" }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          } as RunAgentInput,
        })
        .subscribe({
          next(event) {
            if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
              seenDeltas += 1;
              if (seenDeltas === 1) firstDeltaMs = performance.now() - t0;
              if (seenDeltas === 30) all30Ms = performance.now() - t0;
            }
          },
          error: reject,
          complete: resolve,
        });
    });

    // Live tokens bypass 30 * 15ms DB inserts and stream all 30 deltas immediately
    expect(seenDeltas).toBe(30);
    expect(all30Ms - firstDeltaMs).toBeLessThan(60);

    // 30 TEXT_MESSAGE_CONTENT deltas coalesce into far fewer DB rows before TEXT_MESSAGE_END
    const persistedContent = insertedEvents.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(persistedContent.length).toBeLessThanOrEqual(4);
    expect(persistedContent.map((e) => e.delta).join("")).toBe(
      Array.from({ length: 30 }, (_, i) => `t${i}`).join(""),
    );
    expect(insertedEvents.map((e) => e.type).slice(-2)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  test("connect() called immediately after run() waits for inputReady so first MESSAGES_SNAPSHOT includes the submitted user message", async () => {
    let seq = 0n;
    const threadRow = {
      id: "t-single-hop",
      owner_user_id: "u-single-hop",
      agent_id: "bot-single-hop",
      name: "SingleHop",
      archived: false,
      messages: [{ id: "u-old", role: "user", content: "old question" }],
      state: {},
      run_id: null as string | null,
      lock_expires_at: null as Date | null,
      created_at: new Date(),
      updated_at: new Date(),
      snapshot_sequence: "0",
    };

    const unsafe = async (sql: string, params: unknown[] = []) => {
      const q = sql.trim().replace(/\s+/g, " ");
      if (/^SELECT .+ FROM chisabot_local_threads WHERE id = \$1\b/.test(q)) {
        return [{ ...threadRow }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = $2")) {
        await new Promise((r) => setTimeout(r, 35));
        threadRow.run_id = String(params[1] ?? "run-sh");
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "run-sh") }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_events")) {
        seq += 1n;
        return [{ sequence: String(seq) }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET messages = $3")) {
        threadRow.messages = JSON.parse(String(params[2])) as typeof threadRow.messages;
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = NULL")) {
        threadRow.run_id = null;
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("SELECT status,run_id")) {
        return [{ status: "finished", run_id: "run-sh", execution_run_id: "run-sh" }];
      }
      if (q.startsWith("SELECT status FROM chisabot_local_runs")) {
        return [{ status: "finished" }];
      }
      if (q.startsWith("UPDATE chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "") }];
      }
      return [];
    };

    const dbClient = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        unsafe(strings.join("?"), values),
      {
        unsafe,
        begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
          fn({ unsafe }),
        close: async () => {},
      },
    );

    const backend = await createLocalConversations({
      $client: dbClient,
    } as never);

    class QuickReplyAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId: "m-sh",
            role: "assistant",
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "m-sh",
            delta: "ok",
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId: "m-sh",
          } as BaseEvent);
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.complete();
        });
      }
    }

    const input: RunAgentInput = {
      threadId: "t-single-hop",
      runId: "run-sh",
      messages: [
        { id: "u-old", role: "user", content: "old question" },
        { id: "u-new", role: "user", content: "new prompt" },
      ],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };

    backend.runner
      .run({
        threadId: "t-single-hop",
        agent: new QuickReplyAgent({ agentId: "bot-single-hop" }),
        input,
      })
      .subscribe({ error: () => {} });

    const snapshots: Array<{ id: string }[]> = [];
    await new Promise<void>((resolve, reject) => {
      backend.runner
        .connect({
          threadId: "t-single-hop",
          agentId: "bot-single-hop",
          commandId: "u-new",
        })
        .subscribe({
          next(event) {
            if (event.type === EventType.MESSAGES_SNAPSHOT) {
              snapshots.push(
                (event as BaseEvent & { messages: Array<{ id: string }> }).messages,
              );
            }
          },
          error: reject,
          complete: resolve,
        });
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const firstSnapshotIds = snapshots[0]?.map((m) => m.id) ?? [];
    expect(firstSnapshotIds).toEqual(["u-old", "u-new"]);
  });

  test("PATCH edit and DELETE withdraw sync with active DSH queue even after steerActive marks row read", async () => {
    const inboxRows = new Map<
      string,
      {
        thread_id: string;
        id: string;
        owner_user_id: string;
        kind: string;
        delivery_mode: string;
        message: { id: string; role: string; content: string };
        status: string;
        run_id: string | null;
        created_at: Date;
        read_at: Date | null;
        updated_at: Date;
      }
    >();
    const threadRow = {
      id: "t-inbox-sync",
      owner_user_id: "u-1",
      agent_id: "bot-1",
      name: "InboxSync",
      archived: false,
      messages: [],
      state: {},
      run_id: "run-sync" as string | null,
      lock_expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      snapshot_sequence: "0",
    };

    const unsafe = async (sql: string, params: unknown[] = []) => {
      const q = sql.trim().replace(/\s+/g, " ");
      if (/^SELECT .+ FROM chisabot_local_threads WHERE id = \$1\b/.test(q)) {
        return [{ ...threadRow }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = $2")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "run-sync") }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_events")) {
        return [{ sequence: "1" }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("SELECT paused FROM chisabot_thread_inbox_control")) {
        return [{ paused: false }];
      }
      if (q.startsWith("INSERT INTO chisabot_thread_inbox_control")) {
        return [];
      }
      if (
        q.startsWith(
          "SELECT * FROM chisabot_thread_inbox WHERE thread_id = $1 AND id = $2",
        )
      ) {
        const found = inboxRows.get(String(params[1]));
        return found ? [found] : [];
      }
      if (q.startsWith("UPDATE chisabot_thread_inbox SET delivery_mode =")) {
        const id = String(params[1]);
        const found = inboxRows.get(id);
        if (!found) return [];
        const allowRead = q.includes("status IN ('queued', 'read')");
        if (
          found.status !== "queued" &&
          !(allowRead && found.status === "read")
        )
          return [];
        if (params[3]) found.delivery_mode = String(params[3]);
        if (params[4]) found.message = JSON.parse(String(params[4]));
        found.updated_at = new Date();
        return [found];
      }
      if (
        q.startsWith(
          "INSERT INTO chisabot_thread_inbox (thread_id, id, owner_user_id, message, status)",
        )
      ) {
        return [];
      }
      if (
        q.startsWith(
          "UPDATE chisabot_thread_inbox SET status = 'withdrawn'",
        )
      ) {
        const id = String(params[1]);
        const found = inboxRows.get(id);
        if (!found) return [];
        const allowRead = q.includes("'read'");
        const allowed = allowRead
          ? ["queued", "read", "paused", "owed", "stopped", "withdrawn"]
          : ["queued", "paused", "owed", "stopped", "withdrawn"];
        if (!allowed.includes(found.status)) return [];
        found.status = "withdrawn";
        found.updated_at = new Date();
        return [{ id }];
      }
      return [];
    };

    const dbClient = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        unsafe(strings.join("?"), values),
      {
        unsafe,
        begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
          fn({ unsafe }),
        close: async () => {},
      },
    );

    const backend = await createLocalConversations({
      $client: dbClient,
    } as never);

    const queueOps: Array<{ itemId: string; kind: string; text?: string }> = [];
    const activeQueueIds = new Set(["m-pending-dsh"]);
    let releaseRun!: () => void;

    class SteerableTestAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          void new Promise<void>((resolve) => {
            releaseRun = resolve;
          }).then(() => {
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            subscriber.complete();
          });
        });
      }
      async updateMidTurnQueue(input: {
        itemId: string;
        action:
          | { kind: "steer" }
          | { kind: "remove" }
          | { kind: "edit"; text: string };
      }) {
        queueOps.push({
          itemId: input.itemId,
          kind: input.action.kind,
          ...(input.action.kind === "edit" ? { text: input.action.text } : {}),
        });
        if (!activeQueueIds.has(input.itemId)) return { updated: false };
        if (input.action.kind === "remove") activeQueueIds.delete(input.itemId);
        return { updated: true };
      }
    }

    const runSub = backend.runner
      .run({
        threadId: "t-inbox-sync",
        agent: new SteerableTestAgent({ agentId: "bot-1" }),
        input: {
          threadId: "t-inbox-sync",
          runId: "run-sync",
          messages: [{ id: "u-0", role: "user", content: "start" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      })
      .subscribe({ error: () => {} });

    await new Promise((r) => setTimeout(r, 20));
    try {
      inboxRows.set("m-pending-dsh", {
        thread_id: "t-inbox-sync",
        id: "m-pending-dsh",
        owner_user_id: "u-1",
        kind: "message",
        delivery_mode: "steer",
        message: { id: "m-pending-dsh", role: "user", content: "orig" },
        status: "read",
        run_id: "run-sync",
        created_at: new Date(),
        read_at: new Date(),
        updated_at: new Date(),
      });
      inboxRows.set("m-consumed", {
        thread_id: "t-inbox-sync",
        id: "m-consumed",
        owner_user_id: "u-1",
        kind: "message",
        delivery_mode: "steer",
        message: { id: "m-consumed", role: "user", content: "done" },
        status: "read",
        run_id: "run-sync",
        created_at: new Date(),
        read_at: new Date(),
        updated_at: new Date(),
      });

      // Editing a steered-but-still-pending DSH item succeeds
      const editOk = await backend.handle(
        new Request(
          "http://localhost/api/conversations/threads/t-inbox-sync/inbox",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "m-pending-dsh",
              action: "edit",
              text: "edited text",
            }),
          },
        ),
        "u-1",
      );
      expect(editOk.status).toBe(200);
      expect(inboxRows.get("m-pending-dsh")?.message.content).toBe(
        "edited text",
      );

      // Editing an already-consumed item returns 409
      const editGone = await backend.handle(
        new Request(
          "http://localhost/api/conversations/threads/t-inbox-sync/inbox",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "m-consumed",
              action: "edit",
              text: "too late",
            }),
          },
        ),
        "u-1",
      );
      expect(editGone.status).toBe(409);

      // DELETE withdraws a still-pending DSH item and notifies DSH queue
      const delOk = await backend.handle(
        new Request(
          "http://localhost/api/conversations/threads/t-inbox-sync/inbox?id=m-pending-dsh",
          { method: "DELETE" },
        ),
        "u-1",
      );
      expect(delOk.status).toBe(200);
      expect(await delOk.json()).toEqual({ withdrawn: true });
      expect(inboxRows.get("m-pending-dsh")?.status).toBe("withdrawn");

      // DELETE on an already-consumed item returns withdrawn: false
      const delGone = await backend.handle(
        new Request(
          "http://localhost/api/conversations/threads/t-inbox-sync/inbox?id=m-consumed",
          { method: "DELETE" },
        ),
        "u-1",
      );
      expect(delGone.status).toBe(200);
      expect(await delGone.json()).toEqual({ withdrawn: false });

      expect(queueOps).toEqual([
        { itemId: "m-pending-dsh", kind: "edit", text: "edited text" },
        { itemId: "m-consumed", kind: "edit", text: "too late" },
        { itemId: "m-pending-dsh", kind: "remove" },
        { itemId: "m-consumed", kind: "remove" },
      ]);
    } finally {
      releaseRun?.();
      runSub.unsubscribe();
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  test("connect() on an empty thread emits synthetic RUN_STARTED -> snapshots -> RUN_FINISHED without chisabot.execution", async () => {
    const threadRow = {
      id: "t-empty",
      owner_user_id: "u-empty",
      agent_id: "bot-empty",
      name: "Empty",
      archived: false,
      messages: [],
      state: {},
      run_id: null as string | null,
      lock_expires_at: null as Date | null,
      created_at: new Date(),
      updated_at: new Date(),
      snapshot_sequence: "0",
    };
    const unsafe = async (sql: string) => {
      const q = sql.trim().replace(/\s+/g, " ");
      if (/^SELECT .+ FROM chisabot_local_threads WHERE id = \$1\b/.test(q)) {
        return [{ ...threadRow }];
      }
      return [];
    };
    const dbClient = Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) =>
        unsafe(strings.join("?")),
      {
        unsafe,
        begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
          fn({ unsafe }),
        close: async () => {},
      },
    );
    const backend = await createLocalConversations({
      $client: dbClient,
    } as never);

    const events: Array<BaseEvent & { runId?: string; name?: string }> = [];
    await new Promise<void>((resolve, reject) => {
      backend.runner
        .connect({ threadId: "t-empty", agentId: "bot-empty" })
        .subscribe({
          next(event) {
            events.push(
              event as BaseEvent & { runId?: string; name?: string },
            );
          },
          error: reject,
          complete: resolve,
        });
    });

    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    const startedRunId = events[0]?.runId ?? "";
    expect(startedRunId.startsWith("connect:t-empty:")).toBe(true);
    expect(events[3]?.runId).toBe(startedRunId);
    expect(events.some((e) => e.name === "chisabot.execution")).toBe(false);
  });

  test("persisted RUN_STARTED strips context/tools and stopped RUN_ERROR flushes pending delta before buildStopSummaryFromDb without duplicate RUN_ERROR", async () => {
    let seq = 0n;
    const insertedEvents: Array<
      Record<string, unknown> & { type: string; message?: string }
    > = [];
    let summarySawDelta = false;
    const threadRow = {
      id: "t-stop-race",
      owner_user_id: "u-stop",
      agent_id: "bot-stop",
      name: "StopRace",
      archived: false,
      messages: [],
      state: {},
      run_id: null as string | null,
      lock_expires_at: null as Date | null,
      created_at: new Date(),
      updated_at: new Date(),
      snapshot_sequence: "0",
    };

    const unsafe = async (sql: string, params: unknown[] = []) => {
      const q = sql.trim().replace(/\s+/g, " ");
      if (/^SELECT .+ FROM chisabot_local_threads WHERE id = \$1\b/.test(q)) {
        return [{ ...threadRow }];
      }
      if (q.startsWith("UPDATE chisabot_local_threads SET run_id = $2")) {
        threadRow.run_id = String(params[1] ?? "run-stop");
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "run-stop") }];
      }
      if (q.startsWith("INSERT INTO chisabot_local_events")) {
        seq += 1n;
        insertedEvents.push(
          JSON.parse(String(params[2])) as Record<string, unknown> & {
            type: string;
            message?: string;
          },
        );
        return [{ sequence: String(seq) }];
      }
      if (
        q.startsWith(
          "SELECT event FROM chisabot_local_events WHERE thread_id = $1 AND run_id = $2",
        )
      ) {
        // Simulate slow DB read for buildStopSummaryFromDb; verify pending delta was already persisted.
        await new Promise((r) => setTimeout(r, 25));
        summarySawDelta = insertedEvents.some(
          (e) =>
            e.type === EventType.TEXT_MESSAGE_CONTENT &&
            String(e.delta ?? "").includes("buffered-tail"),
        );
        return insertedEvents.map((event) => ({ event }));
      }
      if (q.startsWith("SELECT call_id, tool_name, args, status, result")) {
        return [];
      }
      if (q.startsWith("UPDATE chisabot_local_threads")) {
        return [{ id: threadRow.id }];
      }
      if (q.startsWith("UPDATE chisabot_local_runs")) {
        return [{ run_id: String(params[1] ?? "") }];
      }
      return [];
    };

    const dbClient = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        unsafe(strings.join("?"), values),
      {
        unsafe,
        begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
          fn({ unsafe }),
        close: async () => {},
      },
    );

    const backend = await createLocalConversations({
      $client: dbClient,
    } as never);

    let emitCancelled!: () => void;
    class StopRaceAgent extends AbstractAgent {
      acknowledgesStop = true;
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId: "m-sr",
            role: "assistant",
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "m-sr",
            delta: "first-",
          } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "m-sr",
            delta: "buffered-tail",
          } as BaseEvent);
          emitCancelled = () => {
            subscriber.next({
              type: EventType.RUN_ERROR,
              code: "DSH_RUN_CANCELLED",
              message: "用户已停止这一轮。",
            } as BaseEvent);
            subscriber.complete();
          };
        });
      }
      override abortRun() {
        emitCancelled?.();
      }
    }

    const streamed: BaseEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      backend.runner
        .run({
          threadId: "t-stop-race",
          agent: new StopRaceAgent({ agentId: "bot-stop" }),
          input: {
            threadId: "t-stop-race",
            runId: "run-stop",
            messages: [{ id: "u-sr", role: "user", content: "hi" }],
            tools: [
              {
                name: "big_tool",
                description: "should not be persisted in RUN_STARTED",
                parameters: {},
              },
            ],
            context: [{ description: "big-ctx", value: "should be stripped" }],
            state: {},
            forwardedProps: {},
          } as RunAgentInput,
        })
        .subscribe({
          next(event) {
            streamed.push(event);
          },
          error: reject,
          complete: resolve,
        });
    });

    await new Promise((r) => setTimeout(r, 15));
    await backend.runner.stop({ threadId: "t-stop-race" });
    await done;

    // P1-2: persisted RUN_STARTED strips context & tools while keeping messages
    const startedEvent = insertedEvents.find(
      (e) => e.type === EventType.RUN_STARTED,
    ) as
      | { input?: { context?: unknown[]; tools?: unknown[]; messages?: unknown[] } }
      | undefined;
    expect(startedEvent?.input?.context).toEqual([]);
    expect(startedEvent?.input?.tools).toEqual([]);
    expect(startedEvent?.input?.messages).toHaveLength(1);

    // P0-5: buffered delta flushed before buildStopSummaryFromDb, and exactly 1 terminal event emitted/persisted
    expect(summarySawDelta).toBe(true);
    const isTerminal = (e: { type: string }) =>
      e.type === EventType.RUN_ERROR || e.type === EventType.RUN_FINISHED;
    expect(insertedEvents.filter(isTerminal)).toHaveLength(1);
    expect(streamed.filter(isTerminal)).toHaveLength(1);
  });
});
