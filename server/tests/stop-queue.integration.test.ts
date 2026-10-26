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
});
