import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable, of } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) });
  });
}

class AnswerAgent extends AbstractAgent {
  protected run(input: RunAgentInput) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.TOOL_CALL_START, toolCallId: "call", toolCallName: "search", parentMessageId: "answer" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: '{"q":"hello"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call" },
      { type: EventType.TOOL_CALL_RESULT, messageId: "result", toolCallId: "call", content: "found", role: "tool" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "final", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "final", delta: "Local answer" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "final" },
      { type: EventType.STATE_SNAPSHOT, snapshot: { count: 1 } },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
    ) as Observable<BaseEvent>;
  }
}

class PausedAgent extends AbstractAgent {
  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "partial", role: "assistant" } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "partial", delta: "Still working" } as BaseEvent);
      subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId: "paused-call", toolCallName: "search", parentMessageId: "paused-tools" } as BaseEvent);
      subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: "paused-call", delta: '{"q":"later"}' } as BaseEvent);
    });
  }
}

suite("local conversations on a dedicated PostgreSQL database", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `local-test-${randomUUID()}`;
  const thread = `${owner}-thread`;
  const bot = `${owner}-bot`;

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
    await backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: bot });
  });

  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });

  test("serialized JSON crosses the Bun SQL boundary as text", async () => {
    const [types] = await database.$client.unsafe(
      `SELECT jsonb_typeof($1::jsonb) AS direct,
       jsonb_typeof($2::text::jsonb) AS via_text,
       jsonb_typeof($3::text::jsonb) AS object_via_text`,
      [JSON.stringify([]), JSON.stringify([]), JSON.stringify({ type: EventType.RUN_STARTED })],
    );
    console.info("Local JSON parameter types:", types);
    expect(types?.via_text).toBe("array");
    expect(types?.object_via_text).toBe("object");
  });

  test("thread ownership hides histories from another user and fixes the agent", async () => {
    await expect(backend.client.getThread({ threadId: thread, userId: "someone-else" })).rejects.toMatchObject({ status: 404 });
    await expect(backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: "another-bot" })).rejects.toMatchObject({ status: 409 });
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${thread}/messages`), "someone-else");
    expect(response?.status).toBe(404);
  });

  test("a stale cleanup or stop cannot release a newer run", async () => {
    await backend.client.ɵacquireThreadLock({ threadId: thread, runId: "first", userId: owner, agentId: bot });
    await expect(backend.client.ɵacquireThreadLock({ threadId: thread, runId: "second", userId: owner, agentId: bot })).rejects.toMatchObject({ status: 409 });
    await backend.client.ɵcleanupThreadLock({ threadId: thread, runId: "unrelated" });
    expect(await backend.runner.stop({ threadId: thread, runId: "unrelated" })).toBe(false);
    expect(await backend.runner.isRunning({ threadId: thread })).toBe(true);
    await backend.client.ɵcleanupThreadLock({ threadId: thread, runId: "first" });
  });

  test("completed text, tool results, state, and input survive a recreated backend", async () => {
    const input = { threadId: thread, runId: randomUUID(), messages: [{ id: "question", role: "user", content: "Search hello" }], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
    const agent = new AnswerAgent({ agentId: bot, threadId: thread, initialMessages: input.messages });
    const events = await collect(backend.runner.run({ threadId: thread, agent, input }));
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
    const [types] = await database.$client.unsafe(
      `SELECT jsonb_typeof(messages) AS messages, jsonb_typeof(state) AS state,
       (SELECT jsonb_typeof(event) FROM openbot_local_events WHERE thread_id = $1 ORDER BY sequence LIMIT 1) AS event
       FROM openbot_local_threads WHERE id = $1`, [thread],
    );
    expect(types).toMatchObject({ messages: "array", state: "object", event: "object" });
    backend = await createLocalConversations(database);
    const history = await backend.client.getThreadMessages({ threadId: thread, userId: owner });
    expect(history.messages.find((message) => message.id === "question")?.content).toBe("Search hello");
    expect(history.messages.find((message) => message.id === "final")?.content).toBe("Local answer");
    expect(history.messages.find((message) => message.id === "answer")?.toolCalls).toEqual([{ id: "call", name: "search", args: '{"q":"hello"}' }]);
    expect(history.messages.find((message) => message.id === "result")?.toolCallId).toBe("call");
    const restored = await collect(backend.runner.connect({ threadId: thread, agentId: bot }));
    // DOG-01 follow-up：接入发消息快照，不再回放 TOOL_CALL_* 事件；工具结果在快照消息里。
    expect(restored.some((event) => event.type === EventType.MESSAGES_SNAPSHOT)).toBe(true);
    expect(restored.some((event) => event.type === EventType.STATE_SNAPSHOT)).toBe(true);
    const snap = restored.find((event) => event.type === EventType.MESSAGES_SNAPSHOT) as { messages?: { id: string; toolCallId?: string }[] };
    expect(snap.messages?.find((message) => message.id === "result")?.toolCallId).toBe("call");
    const state = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${thread}/state`), owner);
    expect(await state?.json()).toEqual({ state: { count: 1 } });
  });

  test("clear is scoped to the verified owner", async () => {
    const response = await backend.handle(new Request("http://localhost/api/copilotkit/threads/clear", { method: "POST" }), "someone-else");
    expect(response?.status).toBe(200);
    expect((await backend.client.getThreadMessages({ threadId: thread, userId: owner })).messages.length).toBeGreaterThan(0);
  });

  test("a later turn receives canonical history and restored state", async () => {
    let prepared: RunAgentInput | undefined;
    class NextAgent extends AbstractAgent {
      protected run(input: RunAgentInput) {
        prepared = input;
        return of(
          { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
          { type: EventType.TEXT_MESSAGE_START, messageId: "next-answer", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "next-answer", delta: "History restored" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "next-answer" },
          { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
        ) as Observable<BaseEvent>;
      }
    }
    const input = { threadId: thread, runId: randomUUID(), messages: [
      { id: "question", role: "user", content: "Tampered old question" },
      { id: "next-question", role: "user", content: "Remember the first turn" },
    ], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
    const agent = new NextAgent({ agentId: bot, threadId: thread });
    await collect(backend.runner.run({ threadId: thread, agent, input }));
    expect(prepared?.messages.find((message) => message.id === "question")?.content).toBe("Search hello");
    expect(prepared?.messages.find((message) => message.id === "result")?.role).toBe("tool");
    expect(prepared?.messages.find((message) => message.id === "next-question")?.content).toBe("Remember the first turn");
    expect(prepared?.state).toEqual({ count: 1 });
    const saved = await backend.client.getThreadMessages({ threadId: thread, userId: owner });
    expect(saved.messages.filter((message) => message.id === "question")).toHaveLength(1);
    expect(saved.messages.find((message) => message.id === "next-answer")?.content).toBe("History restored");
  });

  test("handoff executes its full task and persists only its visible summary and outputs", async () => {
    for (const showSummary of [true, false]) {
      const handoffThread = `${thread}-handoff-${showSummary}`;
      await backend.client.getOrCreateThread({ threadId: handoffThread, userId: owner, agentId: bot });
      const privateTask = { id: "handoff-task", role: "user" as const, content: "Private report 42" };
      const visible = { ...privateTask, content: "Bot joined" };
      let seenTask = "";
      class HandoffAgent extends AbstractAgent {
        protected run(input: RunAgentInput) {
          seenTask = String(input.messages.find((message) => message.id === privateTask.id)?.content);
          return of(
            { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, input },
            { type: EventType.MESSAGES_SNAPSHOT, messages: [...input.messages, { id: "handoff-answer", role: "assistant", content: "42" }] },
            { type: EventType.STATE_SNAPSHOT, snapshot: { nested: { messages: input.messages } } },
            { type: EventType.CUSTOM, name: "context", value: { messages: input.messages } },
            { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
          ) as Observable<BaseEvent>;
        }
      }
      const input = { threadId: handoffThread, runId: randomUUID(), messages: [privateTask], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
      const agent = new HandoffAgent({ agentId: bot, threadId: handoffThread });
      const streamed = await collect(backend.runner.run({ threadId: handoffThread, agent, input, persistedInputMessages: showSummary ? [visible] : [] }));
      expect(seenTask).toBe(privateTask.content);
      const saved = await backend.client.getThreadMessages({ threadId: handoffThread, userId: owner });
      expect(saved.messages.find((message) => message.id === "handoff-answer")?.content).toBe("42");
      expect(saved.messages.find((message) => message.id === privateTask.id)?.content).toBe(showSummary ? visible.content : undefined);
      const replay = await collect(backend.runner.connect({ threadId: handoffThread, agentId: bot }));
      const state = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${handoffThread}/state`), owner);
      expect(JSON.stringify(saved)).not.toContain(privateTask.content);
      expect(JSON.stringify(streamed)).not.toContain(privateTask.content);
      expect(JSON.stringify(replay)).not.toContain(privateTask.content);
      expect(JSON.stringify(await state?.json())).not.toContain(privateTask.content);
    }
  });

  test("live reconnect joins without duplicate events and exact stop closes partial tools", async () => {
    const pausedThread = `${thread}-paused`;
    await backend.client.getOrCreateThread({ threadId: pausedThread, userId: owner, agentId: bot });
    const input = { threadId: pausedThread, runId: randomUUID(), protocolVersion: "1.0.0", messages: [{ id: "pause-question", role: "user", content: "Wait" }], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
    const agent = new PausedAgent({ agentId: bot, threadId: pausedThread });
    let argsSeen!: () => void;
    const reachedTool = new Promise<void>((resolve) => { argsSeen = resolve; });
    const stream = backend.runner.run({ threadId: pausedThread, agent, input });
    stream.subscribe({ next: (event) => { if (event.type === EventType.TOOL_CALL_ARGS) argsSeen(); } });
    const completed = collect(stream);
    await reachedTool;
    expect(() => backend.runner.run({ threadId: pausedThread, agent, input: { ...input, runId: randomUUID() } })).toThrow("Thread already running");
    expect(await backend.runner.stop({ threadId: pausedThread, runId: "stale-run" })).toBe(false);
    const joined = collect(backend.runner.connect({ threadId: pausedThread, agentId: bot }));
    expect(await backend.runner.stop({ threadId: pausedThread, runId: input.runId })).toBe(true);
    const stopped = await completed;
    const restored = await joined;
    expect(stopped.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(restored.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(stopped.some((event) => event.type === EventType.TEXT_MESSAGE_END)).toBe(true);
    expect(stopped.some((event) => event.type === EventType.TOOL_CALL_END)).toBe(true);
    expect(stopped.some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
    expect(stopped.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } });
    const saved = await backend.client.getThreadMessages({ threadId: pausedThread, userId: owner });
    expect(saved.messages.find((message) => message.id === "partial")?.content).toBe("Still working");
    expect(saved.messages.find((message) => message.toolCallId === "paused-call")?.content).toContain('"status":"stopped"');
    expect(await backend.runner.isRunning({ threadId: pausedThread })).toBe(false);
    await expect(collect(backend.runner.run({ threadId: pausedThread, agent, input }))).rejects.toMatchObject({ status: 409 });
    expect(await backend.runner.isRunning({ threadId: pausedThread })).toBe(false);
  });
});
