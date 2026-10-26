import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import {
  afterStopGrace,
  createLocalConversations,
  type LocalConversationBackend,
  STOP_GRACE_MS,
} from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// CB-104: Stop ends the turn promptly; a message sent after Stop is never parked.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** Streams forever and ignores abortRun, like a runtime that is slow to honour Stop. */
class Stubborn extends AbstractAgent {
  started?: () => void;
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      const id = randomUUID();
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: id,
        role: "assistant",
      } as BaseEvent);
      const timer = setInterval(
        () =>
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: id,
            delta: "…",
          } as BaseEvent),
        50,
      );
      this.started?.();
      return () => clearInterval(timer);
    });
  }
  override abortRun() {}
}

/** Ignores both abortRun and detach, then talks again a while after Stop: a runtime gone rogue. */
class Zombie extends AbstractAgent {
  started?: () => void;
  late?: (subscriber: {
    next: (event: BaseEvent) => void;
    complete: () => void;
  }) => void;
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "z-text",
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "z-text",
        delta: "EARLY",
      } as BaseEvent);
      this.late = (s) => {
        s.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "z-text",
          delta: "LATE-ZOMBIE-TEXT",
        } as BaseEvent);
        s.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId: "z-text",
        } as BaseEvent);
        s.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: "z-call",
          toolCallName: "probe",
          parentMessageId: "z-tool-msg",
        } as BaseEvent);
        s.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "z-call",
          delta: "{}",
        } as BaseEvent);
        s.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: "z-call",
        } as BaseEvent);
        s.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "z-result",
          toolCallId: "z-call",
          content: "LATE-ZOMBIE-TOOL",
        } as BaseEvent);
        s.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        s.complete();
      };
      this.lateSubscriber = subscriber;
      this.started?.();
    });
  }
  lateSubscriber?: { next: (event: BaseEvent) => void; complete: () => void };
  override abortRun() {}
  override async detachActiveRun() {}
}

/** Answers once, slowly, so a rogue runtime from the previous turn can talk during this one. */
class Replier extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      const timer = setTimeout(() => {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "fresh",
          role: "assistant",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "fresh",
          delta: "FRESH-ANSWER",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId: "fresh",
        } as BaseEvent);
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        subscriber.complete();
      }, 1_500);
      return () => clearTimeout(timer);
    });
  }
}

test("afterStopGrace only fires after the signal aborts, then after the grace", async () => {
  const controller = new AbortController();
  let fired = false;
  void afterStopGrace(controller.signal, 30).then(() => {
    fired = true;
  });
  await Bun.sleep(60);
  expect(fired).toBe(false);
  controller.abort();
  await Bun.sleep(10);
  expect(fired).toBe(false);
  await Bun.sleep(60);
  expect(fired).toBe(true);
});

suite("CB-104 stop and queue", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `cb104-${randomUUID()}`;
  const threads: string[] = [];
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    for (const threadId of threads) {
      await database.$client.unsafe(
        "DELETE FROM chisabot_thread_inbox WHERE thread_id = $1",
        [threadId],
      );
      await database.$client.unsafe(
        "DELETE FROM chisabot_thread_inbox_control WHERE thread_id = $1",
        [threadId],
      );
      await database.$client.unsafe(
        "DELETE FROM openbot_local_threads WHERE id = $1",
        [threadId],
      );
    }
    await database.$client.close();
  });
  async function thread() {
    const threadId = `${owner}-${randomUUID()}`;
    threads.push(threadId);
    await backend.client.getOrCreateThread({
      threadId,
      userId: owner,
      agentId: "bot",
    });
    return threadId;
  }
  const post = async (threadId: string, id: string, text = id) => {
    const response = await backend.handle(
      new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, text }),
      }),
      owner,
    );
    expect(response?.status).toBe(200);
    return response!.json();
  };

  test("a new message after Stop is sent as a fresh turn, not parked behind held items", async () => {
    const threadId = await thread();
    await backend.inbox.enqueue({
      threadId,
      ownerUserId: owner,
      message: { id: "held", role: "user", content: "held" } as Message,
    });
    await backend.inbox.pause(threadId);
    expect(await post(threadId, "after-stop")).toEqual({ queued: false });
    expect(await backend.inbox.get(threadId, "after-stop")).toBeFalsy();
    expect((await backend.inbox.get(threadId, "held"))?.status).toBe("paused");
  });

  test("Stop ends a run whose runtime ignores the abort within the grace, and a send while winding down is told to wait", async () => {
    const threadId = await thread();
    const agent = new Stubborn();
    const started = new Promise<void>((resolve) => {
      agent.started = resolve;
    });
    const runId = randomUUID();
    const events: BaseEvent[] = [];
    const done = new Promise<void>((resolve, reject) =>
      backend.runner
        .run({
          threadId,
          agent,
          input: {
            threadId,
            runId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [{ id: "q", role: "user", content: "LONG" } as Message],
          },
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        }),
    );
    await started;
    const queued = await post(threadId, "follow-up");
    expect(queued.queued).toBe(true);
    const stoppedAt = Date.now();
    const stopping = backend.runner.stop({ threadId, runId });
    expect(await post(threadId, "typed-while-stopping")).toEqual({
      queued: false,
      stopping: true,
    });
    expect(await stopping).toBe(true);
    await done;
    const elapsed = Date.now() - stoppedAt;
    expect(elapsed).toBeLessThan(STOP_GRACE_MS + 1_500);
    expect(
      events.some(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      ),
    ).toBe(true);
    expect(
      await backend.inbox.get(threadId, "typed-while-stopping"),
    ).toBeFalsy();
    expect((await backend.inbox.get(threadId, "follow-up"))?.status).toBe(
      "paused",
    );
    expect(await post(threadId, "after-stop")).toEqual({ queued: false });
  });

  test("output a detached runtime produces after Stop is dropped, logged, and never reaches the next turn", async () => {
    const threadId = await thread();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const run = (agent: AbstractAgent, runId: string, message: Message) => {
        const events: BaseEvent[] = [];
        const done = new Promise<BaseEvent[]>((resolve, reject) =>
          backend.runner
            .run({
              threadId,
              agent,
              input: {
                threadId,
                runId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [message],
              },
            })
            .subscribe({
              next: (event) => events.push(event),
              error: reject,
              complete: () => resolve(events),
            }),
        );
        return done;
      };
      const zombie = new Zombie();
      const started = new Promise<void>((resolve) => {
        zombie.started = resolve;
      });
      const first = randomUUID();
      const firstDone = run(zombie, first, {
        id: "q1",
        role: "user",
        content: "LONG",
      } as Message);
      await started;
      await Bun.sleep(100);
      expect(await backend.runner.stop({ threadId, runId: first })).toBe(true);
      // It also keeps talking inside the grace window, while the stopped turn is still closing.
      await Bun.sleep(300);
      zombie.lateSubscriber?.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "z-text",
        delta: "LATE-ZOMBIE-GRACE",
      } as BaseEvent);
      const firstEvents = await firstDone;
      // The next turn starts at once and is still running when the rogue runtime talks 3 s after Stop.
      const second = randomUUID();
      const secondDone = run(new Replier(), second, {
        id: "q2",
        role: "user",
        content: "again",
      } as Message);
      await Bun.sleep(Math.max(0, 3_000 - STOP_GRACE_MS));
      zombie.late?.(zombie.lateSubscriber!);
      const secondEvents = await secondDone;
      await Bun.sleep(200);
      const late = /LATE-ZOMBIE/;
      expect(JSON.stringify(firstEvents)).not.toMatch(late);
      expect(JSON.stringify(secondEvents)).not.toMatch(late);
      expect(JSON.stringify(secondEvents)).toContain("FRESH-ANSWER");
      const [row] = await database.$client.unsafe<{ messages: Message[] }[]>(
        "SELECT messages FROM openbot_local_threads WHERE id = $1",
        [threadId],
      );
      const transcript = JSON.stringify(row?.messages);
      expect(transcript).not.toMatch(late);
      expect(transcript).toContain("FRESH-ANSWER");
      const stored = await database.$client.unsafe<{ event: unknown }[]>(
        "SELECT event FROM openbot_local_events WHERE thread_id = $1",
        [threadId],
      );
      expect(JSON.stringify(stored)).not.toMatch(late);
      expect(
        warnings.some(
          (line) =>
            line.includes("local-run-late-output-dropped") &&
            line.includes(first),
        ),
      ).toBe(true);
    } finally {
      console.warn = warn;
    }
  }, 20_000);
});
