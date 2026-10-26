import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { Observable, of } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { ThreadInbox } from "../src/thread-inbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function collect(stream: Observable<BaseEvent>) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) });
  });
}

suite("durably paused thread inbox", () => {
  let database: ReturnType<typeof createDatabase>;
  let unsafe: ReturnType<typeof createDatabase>["$client"]["unsafe"];
  let interceptUnsafe: ((...args: Parameters<typeof unsafe>) => Promise<unknown>) | undefined;
  let backend: LocalConversationBackend;
  const owner = `paused-test-${randomUUID()}`;
  const threads: string[] = [];
  beforeAll(async () => {
    const real = createDatabase(testDatabaseUrl(), TEST_POOL);
    unsafe = real.$client.unsafe.bind(real.$client);
    const client = new Proxy(real.$client, { get(target, key) {
      if (key === "unsafe") return interceptUnsafe ?? unsafe;
      return Reflect.get(target, key, target);
    } });
    database = Object.create(real);
    Object.defineProperty(database, "$client", { value: client });
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    for (const threadId of threads) {
      await database.$client.unsafe("DELETE FROM chisabot_thread_inbox WHERE thread_id = $1", [threadId]);
      await database.$client.unsafe("DELETE FROM chisabot_thread_inbox_control WHERE thread_id = $1", [threadId]);
      await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE id = $1", [threadId]);
    }
    await database.$client.close();
  });
  async function thread() {
    const threadId = `${owner}-${randomUUID()}`;
    threads.push(threadId);
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: "bot" });
    return threadId;
  }
  const message = (id: string, content = id) => ({ id, role: "user", content }) as Message;
  async function enqueue(threadId: string, id: string) {
    await backend.inbox.enqueue({ threadId, ownerUserId: owner, message: message(id) });
  }
  async function state(threadId: string, actor = owner) {
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox`), actor);
    expect(response?.status).toBe(200);
    return response!.json() as Promise<{ paused: boolean; running: boolean; items: { id: string; status: string }[] }>;
  }

  test("Stop and failed settle survive new stores, late devices and restart without any claim", async () => {
    for (const outcome of ["stopped", "owed"] as const) {
      const threadId = await thread();
      await enqueue(threadId, "read");
      expect(await backend.inbox.claim(threadId, "old-run")).toHaveLength(1);
      await enqueue(threadId, "unread");
      await backend.inbox.settle(threadId, "old-run", outcome);
      const anotherDevice = new ThreadInbox(database);
      expect(await anotherDevice.isPaused(threadId)).toBe(true);
      await anotherDevice.enqueue({ threadId, ownerUserId: owner, message: message("late") });
      expect(await anotherDevice.claim(threadId, "auto-reconnect")).toEqual([]);
      const before = await state(threadId);
      expect(before.paused).toBe(true);
      expect(before.items.map((item) => [item.id, item.status])).toEqual([["read", "paused"], ["unread", "paused"], ["late", "paused"]]);
      await anotherDevice.releaseInterrupted();
      const restarted = new ThreadInbox(database);
      expect(await restarted.claim(threadId, "after-restart")).toEqual([]);
      expect((await state(threadId)).items).toEqual(before.items);
      expect((await state(threadId, "other-owner")).items).toEqual([]);
    }
  });

  test("a new explicit turn opens only future queueing; single-row send is claimed once", async () => {
    const threadId = await thread();
    await enqueue(threadId, "one"); await enqueue(threadId, "two");
    await backend.inbox.pause(threadId);
    await backend.inbox.startExplicitTurn(threadId);
    await enqueue(threadId, "new-supplement");
    expect((await backend.inbox.claim(threadId, "fresh")).map((item) => item.id)).toEqual(["new-supplement"]);
    const other = new ThreadInbox(database);
    const picked = await Promise.all([backend.inbox.resumeOne(threadId, "one", "pick-1"), other.resumeOne(threadId, "one", "pick-2")]);
    expect(picked.filter(Boolean)).toHaveLength(1);
    expect((await backend.inbox.list(threadId)).find((item) => item.id === "two")?.status).toBe("paused");
    expect(await backend.inbox.withdraw(threadId, "two")).toBe(true);
    expect(await backend.inbox.resumeOne(threadId, "two", "late")).toBeNull();
  });

  test("confirmed HTTP withdrawal cancels a committed POST and also fences a late POST", async () => {
    const threadId = await thread();
    await backend.inbox.pause(threadId);
    const send = async (id: string) => {
      const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, text: "Must never execute after withdrawal" }),
      }), owner);
      expect(response?.status).toBe(200);
      return response!.json();
    };
    const withdraw = async (id: string) => {
      const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox?id=${id}`, { method: "DELETE" }), owner);
      expect(response?.status).toBe(200);
      expect(await response!.json()).toEqual({ withdrawn: true });
    };
    // Committed while held (POST landed during the turn), browser missed its response, then the user withdraws.
    await enqueue(threadId, "committed");
    expect(await send("committed")).toEqual({ queued: true, status: "paused" });
    await withdraw("committed");
    await withdraw("committed"); // lost DELETE response can safely be retried
    // DELETE overtakes the slow POST. An old tombstone must still block its ID after list expiry.
    await withdraw("late-post");
    await database.$client.unsafe("UPDATE chisabot_thread_inbox SET updated_at = now() - interval '11 minutes' WHERE thread_id = $1 AND id = 'late-post'", [threadId]);
    expect(await send("late-post")).toEqual({ queued: true, status: "withdrawn" });
    await backend.inbox.startExplicitTurn(threadId);
    expect(await backend.inbox.claim(threadId, "later-real-turn")).toEqual([]);
    expect((await backend.inbox.get(threadId, "committed"))?.status).toBe("withdrawn");
    expect((await backend.inbox.get(threadId, "late-post"))?.status).toBe("withdrawn");
    await enqueue(threadId, "already-read");
    await backend.inbox.claim(threadId, "in-flight");
    const consumed = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox?id=already-read`, { method: "DELETE" }), owner);
    expect(await consumed!.json()).toEqual({ withdrawn: false });
  });

  test("101 recent terminal rows cannot hide newer queued and paused supplements", async () => {
    const threadId = await thread();
    await database.$client.unsafe(`INSERT INTO chisabot_thread_inbox (thread_id, id, owner_user_id, message, status, created_at)
      SELECT $1, 'done-' || n, $2, jsonb_build_object('id', 'done-' || n, 'role', 'user', 'content', 'old'), 'answered', now() - interval '1 minute'
      FROM generate_series(1, 101) n`, [threadId, owner]);
    await enqueue(threadId, "held"); await backend.inbox.pause(threadId);
    await backend.inbox.startExplicitTurn(threadId); await enqueue(threadId, "newest");
    const visible = await state(threadId);
    expect(visible.items.filter((item) => ["queued", "paused"].includes(item.status)).map((item) => item.id)).toEqual(["held", "newest"]);
    expect(visible.items).toHaveLength(102);
  });

  test("a real background-delivery run cannot resume a paused thread, including an empty held queue", async () => {
    const threadId = await thread();
    await backend.inbox.pause(threadId);
    const result = message("worker-headless", "⟦chisabot:worker-result:w:done⟧\n后台任务「调查」已完成。\n\n实际结果");
    let modelRuns = 0;
    class NoWorkerModel extends AbstractAgent { run(): Observable<BaseEvent> { modelRuns++; throw new Error("paused worker delivery must not call model"); } }
    const input = { threadId, state: {}, tools: [], context: [], messages: [result], forwardedProps: { chisabotWorkerDelivery: { id: "w" } } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = await collect(backend.runner.run({ threadId, agent: new NoWorkerModel(), input: { ...input, runId: randomUUID() }, persistedInputMessages: [result] }));
      expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
      // Match the existing worker fallback's queued write followed by enqueue retry.
      await database.$client.unsafe("UPDATE chisabot_thread_inbox SET status = 'queued' WHERE thread_id = $1 AND id = $2", [threadId, result.id]);
      await backend.inbox.enqueue({ threadId, ownerUserId: owner, message: result, kind: "worker_result" });
      expect(await backend.inbox.isPaused(threadId)).toBe(true);
      expect(await backend.inbox.claim(threadId, "unexpected-auto")).toEqual([]);
      expect((await backend.inbox.list(threadId)).map((item) => [item.id, item.kind, item.status])).toEqual([[result.id, "worker_result", "paused"]]);
    }
    expect(modelRuns).toBe(0);
    expect((await backend.client.getThreadMessages({ threadId, userId: owner })).messages).toEqual([]);
  });

  test("worker results remain visible and resumable after a pause and thread deletion removes control state", async () => {
    const threadId = await thread();
    await backend.inbox.pause(threadId);
    await backend.inbox.enqueue({ threadId, ownerUserId: owner, kind: "worker_result", message: message("worker-result", "⟦chisabot:worker-result:w:done⟧\n后台任务「调查」已完成。\n\n结果") });
    expect((await state(threadId)).items.find((item) => item.id === "worker-result")?.status).toBe("paused");
    expect((await backend.inbox.resumeOne(threadId, "worker-result", "worker-resume"))?.content).toContain("后台任务");
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}`, { method: "DELETE" }), owner);
    expect(response?.status).toBe(204);
    expect(await database.$client.unsafe("SELECT thread_id FROM chisabot_thread_inbox_control WHERE thread_id = $1", [threadId])).toHaveLength(0);
    expect(await database.$client.unsafe("SELECT id FROM chisabot_thread_inbox WHERE thread_id = $1", [threadId])).toHaveLength(0);
  });

  test("a selected paused row returns to paused if persistence fails before the model runs", async () => {
    const threadId = await thread();
    await enqueue(threadId, "held-before-model"); await backend.inbox.pause(threadId);
    let injected = false;
    let modelRuns = 0;
    class MustNotRun extends AbstractAgent { run(): Observable<BaseEvent> { modelRuns++; throw new Error("model must not start"); } }
    interceptUnsafe = async (...args: Parameters<typeof unsafe>) => {
      if (!injected && String(args[0]).includes("UPDATE openbot_local_threads SET messages") && args[1]?.[0] === threadId) {
        injected = true;
        throw new Error("forced snapshot failure");
      }
      return unsafe(...args);
    };
    try {
      const events = await collect(backend.runner.run({ threadId, agent: new MustNotRun(), input: {
        threadId, runId: randomUUID(), messages: [message("explicit-retry")], state: {}, tools: [], context: [],
        forwardedProps: { chisabotInboxResume: { sourceId: "held-before-model", messageId: "explicit-retry" } },
      } }));
      expect(injected).toBe(true);
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
      expect(modelRuns).toBe(0);
      expect(await backend.inbox.isPaused(threadId)).toBe(true);
      expect((await backend.inbox.list(threadId)).find((item) => item.id === "held-before-model")?.status).toBe("paused");
    } finally { interceptUnsafe = undefined; }
  });

  test("already-read paused supplements stay visible but are isolated from new execution and only resume once under a new ID", async () => {
    const threadId = await thread();
    const held = message("read-before-stop", "Old supplement must wait for explicit per-row send");
    await backend.inbox.enqueue({ threadId, ownerUserId: owner, message: held });
    expect(await backend.inbox.claim(threadId, "failed-old-turn")).toHaveLength(1);
    const canonical = [
      message("original", "Original task"),
      { id: "prior-call", role: "assistant", toolCalls: [{ id: "done-call", type: "function", function: { name: "probe", arguments: "{}" } }] } as Message,
      { id: "prior-result", role: "tool", toolCallId: "done-call", content: "Completed once" } as Message,
      held,
    ];
    await database.$client.unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [threadId, JSON.stringify(canonical)]);
    await backend.inbox.settle(threadId, "failed-old-turn", "owed");
    const inputs: Message[][] = [];
    class CaptureReadPause extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        inputs.push(structuredClone(input.messages));
        const id = randomUUID();
        return of(
          { type: EventType.RUN_STARTED, threadId, runId: input.runId },
          { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: "Answer only the fresh message" },
          { type: EventType.TEXT_MESSAGE_END, messageId: id },
          { type: EventType.RUN_FINISHED, threadId, runId: input.runId },
        ) as Observable<BaseEvent>;
      }
    }
    const base = { threadId, state: {}, tools: [], context: [], forwardedProps: {} };
    await collect(backend.runner.run({ threadId, agent: new CaptureReadPause(), input: { ...base, runId: randomUUID(), messages: [...canonical, message("new-question", "Answer only this new question")] } }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.some((item) => item.id === held.id)).toBe(false);
    expect(inputs[0]?.filter((item) => item.id === "prior-call" || item.id === "prior-result").map((item) => item.id)).toEqual(["prior-call", "prior-result"]);
    let saved = await backend.client.getThreadMessages({ threadId, userId: owner });
    expect(saved.messages.find((item) => item.id === held.id)?.content).toBe(held.content);
    expect((await backend.inbox.get(threadId, held.id))?.status).toBe("paused");
    const retry = { sourceId: held.id, messageId: "explicit-read-resume" };
    await collect(backend.runner.run({ threadId, agent: new CaptureReadPause(), input: { ...base, runId: randomUUID(), messages: [message(retry.messageId)], forwardedProps: { chisabotInboxResume: retry } } }));
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.some((item) => item.id === held.id)).toBe(false);
    expect(inputs[1]?.find((item) => item.id === retry.messageId)?.content).toContain(String(held.content));
    expect((await backend.inbox.get(threadId, held.id))?.status).toBe("answered");
    saved = await backend.client.getThreadMessages({ threadId, userId: owner });
    expect(saved.messages.filter((item) => item.id === held.id || item.id === retry.messageId).map((item) => [item.id, item.content])).toEqual([[retry.messageId, held.content]]); // CB-104: shown once, as the resent copy
    const duplicate = await collect(backend.runner.run({ threadId, agent: new CaptureReadPause(), input: { ...base, runId: randomUUID(), messages: [message("duplicate-resume")], forwardedProps: { chisabotInboxResume: { ...retry, messageId: "duplicate-resume" } } } }));
    expect(duplicate.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
    expect(inputs).toHaveLength(2);
  });

  test("stale browser auto-run is rejected; explicit new text excludes old held rows; per-row send cannot replay the old command", async () => {
    const threadId = await thread();
    await enqueue(threadId, "held"); await backend.inbox.pause(threadId);
    const inputs: Message[][] = [];
    let modelRuns = 0;
    class Capture extends AbstractAgent {
      run(input: RunAgentInput) {
        modelRuns++;
        inputs.push(structuredClone(input.messages));
        const answerId = randomUUID();
        return of(
          { type: EventType.RUN_STARTED, threadId, runId: input.runId },
          { type: EventType.TEXT_MESSAGE_START, messageId: answerId, role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: answerId, delta: "Only the current supplement is answered" },
          { type: EventType.TEXT_MESSAGE_END, messageId: answerId },
          { type: EventType.RUN_FINISHED, threadId, runId: input.runId },
        ) as Observable<BaseEvent>;
      }
    }
    const base = { threadId, state: {}, tools: [], context: [], forwardedProps: {} };
    const rejected = await collect(backend.runner.run({ threadId, agent: new Capture(), input: { ...base, runId: randomUUID(), messages: [message("held")] } }));
    expect(rejected.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
    expect((rejected.find((event) => event.type === EventType.RUN_ERROR) as BaseEvent & { message: string }).message).toContain("已暂停");
    expect(modelRuns).toBe(0);
    expect((await backend.inbox.list(threadId)).find((item) => item.id === "held")?.status).toBe("paused");
    expect((await backend.client.getThreadMessages({ threadId, userId: owner })).messages.some((item) => item.id === "held")).toBe(false);
    await collect(backend.runner.run({ threadId, agent: new Capture(), input: { ...base, runId: randomUUID(), messages: [message("held"), message("fresh", "Only answer this new question")] } }));
    expect(inputs[0]?.some((item) => item.id === "held")).toBe(false);
    expect((await backend.inbox.list(threadId)).find((item) => item.id === "held")?.status).toBe("paused");
    await collect(backend.runner.run({ threadId, agent: new Capture(), input: { ...base, runId: randomUUID(), messages: [message("send-one", "stale UI text")], forwardedProps: { chisabotInboxResume: { sourceId: "held", messageId: "send-one" } } } }));
    expect(modelRuns).toBe(2);
    const resumed = inputs[1]?.find((item) => item.id === "send-one");
    expect(resumed?.content).toContain("不得自动重试");
    expect(resumed?.content).toContain("held");
    expect(resumed?.content).not.toContain("stale UI text");
    const saved = await backend.client.getThreadMessages({ threadId, userId: owner });
    expect(saved.messages.find((item) => item.id === "send-one")?.content).toBe("held");
    expect((await backend.inbox.list(threadId)).find((item) => item.id === "held")?.status).toBe("answered");
  });
});
