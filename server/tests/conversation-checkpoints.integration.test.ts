import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, type Subscriber } from "rxjs";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDatabase } from "../src/db/client";
import {
  closeInterruptedRun,
  createLocalConversations,
  type LocalConversationBackend,
} from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Checkpoint observation timed out.");
    await Bun.sleep(5);
  }
}
function collect(source: Observable<BaseEvent>) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    source.subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}
class ControlledAgent extends AbstractAgent {
  private sink?: Subscriber<BaseEvent>;
  readonly ready = deferred();
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((sink) => {
      this.sink = sink;
      sink.next({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      this.ready.resolve();
    });
  }
  send(event: Record<string, unknown>) {
    this.sink!.next(event as BaseEvent);
  }
  finish(input: RunAgentInput, waiting = false) {
    this.send({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
      ...(waiting
        ? {
            outcome: {
              type: "interrupt",
              interrupts: [
                { id: "confirm", reason: "human_input", message: "Confirm" },
              ],
            },
          }
        : {}),
    });
    this.sink!.complete();
  }
}
class ReplayAgent extends AbstractAgent {
  constructor(private readonly source: Observable<BaseEvent>) {
    super();
  }
  run() {
    return this.source;
  }
}

suite("durable conversation checkpoints", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  let unsafe: ReturnType<typeof createDatabase>["$client"]["unsafe"];
  let intercept:
    | ((...args: Parameters<typeof unsafe>) => Promise<unknown>)
    | undefined;
  const owner = `checkpoint-${randomUUID()}`,
    bot = `${owner}-bot`;
  beforeAll(async () => {
    const real = createDatabase(testDatabaseUrl(), TEST_POOL);
    unsafe = real.$client.unsafe.bind(real.$client);
    const client = new Proxy(real.$client, {
      get(target, key) {
        return key === "unsafe"
          ? (intercept ?? unsafe)
          : Reflect.get(target, key, target);
      },
    });
    database = Object.create(real);
    Object.defineProperty(database, "$client", { value: client });
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    intercept = undefined;
    await unsafe("DELETE FROM chisabot_dsh_runs WHERE owner_user_id=$1", [
      owner,
    ]);
    await unsafe("DELETE FROM chisabot_local_threads WHERE owner_user_id=$1", [
      owner,
    ]);
    await database.$client.close();
  });
  async function fixture(history: Message[] = []) {
    const threadId = `${owner}-${randomUUID()}`,
      runId = randomUUID();
    await backend.client.getOrCreateThread({
      threadId,
      userId: owner,
      agentId: bot,
    });
    if (history.length)
      await unsafe(
        "UPDATE chisabot_local_threads SET messages=$2::text::jsonb WHERE id=$1",
        [threadId, JSON.stringify(history)],
      );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [
        { id: `${threadId}-question`, role: "user", content: "Continue" },
      ],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    return {
      threadId,
      input,
      agent: new ControlledAgent({ agentId: bot, threadId }),
    };
  }

  test("a long-history burst keeps every event but coalesces full transcript writes", async () => {
    const history = Array.from(
      { length: 300 },
      (_, index) =>
        ({
          id: `old-${index}`,
          role: index % 2 ? "assistant" : "user",
          content: "saved history ".repeat(30),
        }) as Message,
    );
    const { threadId, input, agent } = await fixture(history);
    let writes = 0,
      admitted = 0;
    intercept = async (query, params) => {
      const result = await unsafe(query, params);
      if (
        query.startsWith("UPDATE chisabot_local_threads SET messages") &&
        params?.[0] === threadId
      )
        writes++;
      return result;
    };
    const started = performance.now();
    const completed = collect(
      backend.runner.run({
        threadId,
        input,
        agent,
        onAdmitted: () => admitted++,
      }),
    );
    try {
      await agent.ready.promise;
      agent.send({
        type: "TEXT_MESSAGE_START",
        messageId: "answer",
        role: "assistant",
      });
      for (let index = 0; index < 120; index++)
        agent.send({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "answer",
          delta: `${index},`,
        });
      agent.send({ type: "TEXT_MESSAGE_END", messageId: "answer" });
      agent.send({ type: "STATE_SNAPSHOT", snapshot: { completed: 120 } });
      agent.finish(input);
      const events = await completed;
      const [saved] = await unsafe(
        "SELECT messages,state,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS event_sequence FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(
        saved.messages.filter((message: Message) =>
          message.id.startsWith("old-"),
        ),
      ).toEqual(history);
      expect(
        saved.messages.find((message: Message) => message.id === "answer")
          .content,
      ).toBe(Array.from({ length: 120 }, (_, index) => `${index},`).join(""));
      expect(saved.state).toEqual({ completed: 120 });
      expect(String(saved.snapshot_sequence)).toBe(
        String(saved.event_sequence),
      );
      expect(
        events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT"),
      ).toHaveLength(120);
      expect(writes).toBeLessThan(30);
      expect(admitted).toBe(0); // A real RUN_STARTED without a DSH input owner cannot hand off.
      console.info(
        JSON.stringify({
          checkpointBurst: {
            deltas: 120,
            historyMessages: 300,
            writes,
            elapsedMs: Math.round(performance.now() - started),
          },
        }),
      );
    } finally {
      intercept = undefined;
      await backend.runner.stop({ threadId });
    }
  }, 15000);

  test("a checkpoint behind a newer durable delta keeps its own watermark and reconnect applies the suffix once", async () => {
    const { threadId, input, agent } = await fixture();
    const deltaCommitted = deferred(),
      releaseDelta = deferred(),
      checkpointWritten = deferred();
    let blocked = false,
      captured: Record<string, unknown> | undefined;
    intercept = async (query, params) => {
      const result = await unsafe(query, params);
      if (
        !blocked &&
        query.includes("INSERT INTO chisabot_local_events") &&
        params?.[0] === threadId &&
        String(params?.[2]).includes('"delta":"B"')
      ) {
        blocked = true;
        deltaCommitted.resolve();
        await releaseDelta.promise;
      } else if (
        blocked &&
        !captured &&
        query.startsWith("UPDATE chisabot_local_threads SET messages") &&
        params?.[0] === threadId
      ) {
        [captured] = await unsafe(
          "SELECT messages,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS newest FROM chisabot_local_threads WHERE id=$1",
          [threadId],
        );
        checkpointWritten.resolve();
      }
      return result;
    };
    const completed = collect(backend.runner.run({ threadId, input, agent }));
    try {
      await agent.ready.promise;
      agent.send({
        type: "TEXT_MESSAGE_START",
        messageId: "answer",
        role: "assistant",
      });
      agent.send({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer",
        delta: "A",
      });
      await until(() =>
        agent.messages.some(
          (message) => message.id === "answer" && message.content === "A",
        ),
      );
      agent.send({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer",
        delta: "B",
      });
      await deltaCommitted.promise;
      await Bun.sleep(300); // Let the older checkpoint queue behind the blocked event acknowledgment.
      releaseDelta.resolve();
      await checkpointWritten.promise;
      expect(
        (captured!.messages as Message[]).find(
          (message) => message.id === "answer",
        )?.content,
      ).toBe("A");
      expect(BigInt(String(captured!.snapshot_sequence))).toBeLessThan(
        BigInt(String(captured!.newest)),
      );
      const replay = new ReplayAgent(
        backend.runner.connect({ threadId, agentId: bot }),
      );
      const replayed = replay.runAgent();
      await until(() =>
        replay.messages.some(
          (message) => message.id === "answer" && message.content === "AB",
        ),
      );
      agent.send({ type: "TEXT_MESSAGE_END", messageId: "answer" });
      agent.finish(input);
      await Promise.all([completed, replayed]);
      expect(
        replay.messages.filter((message) => message.id === "answer"),
      ).toEqual([{ id: "answer", role: "assistant", content: "AB" }]);
    } finally {
      releaseDelta.resolve();
      intercept = undefined;
      await backend.runner.stop({ threadId });
    }
  }, 15000);

  test.each([false, true])(
    "a crash restores uncheckpointed text/state and is idempotent (terminal already saved: %s)",
    async (terminal) => {
      const { threadId, input } = await fixture();
      await unsafe(
        "INSERT INTO chisabot_local_runs(thread_id,run_id,status) VALUES($1,$2,'running')",
        [threadId, input.runId],
      );
      const prefix: BaseEvent[] = [
        { type: "RUN_STARTED", threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Before " },
      ] as BaseEvent[];
      let sequence = "0";
      for (const event of prefix) {
        const [saved] = await unsafe(
          "INSERT INTO chisabot_local_events(thread_id,run_id,event) VALUES($1,$2,$3::text::jsonb) RETURNING sequence",
          [threadId, input.runId, JSON.stringify(event)],
        );
        sequence = String(saved.sequence);
      }
      await unsafe(
        "UPDATE chisabot_local_threads SET messages=$2::text::jsonb,state=$3::text::jsonb,snapshot_sequence=$4::bigint WHERE id=$1",
        [
          threadId,
          JSON.stringify([
            ...input.messages,
            { id: "answer", role: "assistant", content: "Before " },
          ]),
          JSON.stringify({ stage: "before" }),
          sequence,
        ],
      );
      const suffix = [
        { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "crash" },
        { type: "STATE_SNAPSHOT", snapshot: { stage: "after" } },
        ...(terminal
          ? [
              { type: "TEXT_MESSAGE_END", messageId: "answer" },
              { type: "RUN_FINISHED", threadId, runId: input.runId },
            ]
          : []),
      ];
      for (const event of suffix)
        await unsafe(
          "INSERT INTO chisabot_local_events(thread_id,run_id,event) VALUES($1,$2,$3::text::jsonb)",
          [threadId, input.runId, JSON.stringify(event)],
        );
      expect(await closeInterruptedRun(database, threadId, input.runId)).toBe(
        !terminal,
      );
      const [saved] = await unsafe(
        "SELECT messages,state,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS newest FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(
        saved.messages.find((message: Message) => message.id === "answer")
          .content,
      ).toBe("Before crash");
      expect(saved.state).toEqual({ stage: "after" });
      expect(String(saved.snapshot_sequence)).toBe(String(saved.newest));
      expect(await closeInterruptedRun(database, threadId, input.runId)).toBe(
        false,
      );
      const [again] = await unsafe(
        "SELECT messages,state FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(again).toEqual({ messages: saved.messages, state: saved.state });
    },
  );

  test.each(["waiting", "stopped"])(
    "%s saves the latest content before releasing its lease",
    async (ending) => {
      const { threadId, input, agent } = await fixture();
      const completed = collect(backend.runner.run({ threadId, input, agent }));
      await agent.ready.promise;
      agent.send({
        type: "TEXT_MESSAGE_START",
        messageId: "partial",
        role: "assistant",
      });
      agent.send({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "partial",
        delta: "Latest",
      });
      await until(() =>
        agent.messages.some(
          (message) => message.id === "partial" && message.content === "Latest",
        ),
      );
      if (ending === "stopped")
        await backend.runner.stop({ threadId, runId: input.runId });
      else {
        agent.send({ type: "TEXT_MESSAGE_END", messageId: "partial" });
        agent.finish(input, true);
      }
      const events = await completed;
      const [saved] = await unsafe(
        "SELECT messages,run_id,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS newest FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(
        saved.messages.find((message: Message) => message.id === "partial")
          .content,
      ).toBe("Latest");
      expect(saved.run_id).toBeNull();
      expect(String(saved.snapshot_sequence)).toBe(String(saved.newest));
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    },
    10000,
  );

  test("killing an API process after durable output restores its exact tail on boot", async () => {
    const threadId = `${owner}-crash-${randomUUID()}`,
      runId = randomUUID();
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "support/checkpoint-crash-runner.ts"),
        owner,
        bot,
        threadId,
        runId,
      ],
      {
        env: {
          ...process.env,
          TEST_DATABASE_URL: testDatabaseUrl(),
          CHISABOT_RELEASE_LOCKS_ON_START: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    const stderr = new Response(child.stderr).text();
    const ready = (async () => {
      const reader = child.stdout.getReader(),
        decoder = new TextDecoder();
      let output = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done)
            throw new Error(
              `Crash runner exited before its durable write: ${output} ${await stderr}`,
            );
          output += decoder.decode(value);
          if (output.includes("DURABLE_TAIL_READY")) return;
        }
      } finally {
        reader.releaseLock();
      }
    })();
    try {
      await ready;
      const [before] = await unsafe(
        "SELECT messages,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS newest FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(
        before.messages.find(
          (message: Message) => message.id === "crash-answer",
        ).content,
      ).toBe("Before ");
      expect(BigInt(String(before.snapshot_sequence))).toBeLessThan(
        BigInt(String(before.newest)),
      );
      child.kill("SIGKILL");
      await child.exited;
      await backend.client.releaseOrphanedLocks();
      const [after] = await unsafe(
        "SELECT messages,run_id,snapshot_sequence,(SELECT max(sequence) FROM chisabot_local_events WHERE thread_id=$1) AS newest FROM chisabot_local_threads WHERE id=$1",
        [threadId],
      );
      expect(
        after.messages.find((message: Message) => message.id === "crash-answer")
          .content,
      ).toBe("Before crash-tail");
      expect(after.run_id).toBeNull();
      expect(String(after.snapshot_sequence)).toBe(String(after.newest));
      expect(await closeInterruptedRun(database, threadId, runId)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15000);

  test("background input is admitted once before execution and a foreground DSH receipt is durable before admission", async () => {
    for (const background of [true, false]) {
      const { threadId, input, agent } = await fixture();
      let admitted = 0;
      const admission = deferred();
      if (!background)
        await createDshRunJournal(database).accept({
          thread_id: threadId,
          run_id: input.runId,
          owner_user_id: owner,
          bot_id: bot,
          session_id: `session-${threadId}`,
          binding_revision: 1,
          generation: "fixture",
          baseline: -1,
          input,
          initiator: { kind: "person" },
          request_id: input.messages[0]!.id,
        });
      const completed = collect(
        backend.runner.run({
          threadId,
          input,
          agent,
          ...(background
            ? {
                execution: {
                  kind: "background" as const,
                  initiator: { kind: "routine" as const, id: "checkpoint" },
                },
              }
            : {}),
          onAdmitted: () => {
            admitted++;
            admission.resolve();
          },
        }),
      );
      try {
        await admission.promise;
        const [saved] = await unsafe(
          "SELECT execution FROM chisabot_local_runs WHERE thread_id=$1 AND run_id=$2",
          [threadId, input.runId],
        );
        if (background) expect(saved.execution.input).toEqual(input);
        else
          expect(
            (await createDshRunJournal(database).get(threadId, input.runId))
              ?.input,
          ).toEqual(input);
        await agent.ready.promise;
        agent.finish(input);
        await completed;
        expect(admitted).toBe(1);
      } finally {
        await backend.runner.stop({ threadId });
      }
    }
  }, 15000);
});
