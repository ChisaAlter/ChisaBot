import { expect, test } from "bun:test";
import { type BaseEvent, HttpAgent, type Message } from "@ag-ui/client";
import { EventSchema, MessageSchema } from "@ag-ui/core/schemas";
import { DshEventProjection } from "../src/conversations/dsh-events";
import {
  createEventLifecycles,
  createRunEventFinalizer,
} from "../src/conversations/runner";

const start = {
  type: "RUN_STARTED",
  threadId: "thread",
  runId: "run",
} as BaseEvent;
const finish = {
  type: "RUN_FINISHED",
  threadId: "thread",
  runId: "run",
} as BaseEvent;
const finalContent = [
  { type: "reasoning", text: "Check the facts." },
  { type: "text", text: "Searching." },
  {
    type: "tool-call",
    id: "lookup",
    name: "search",
    arguments: '{"q":"hello"}',
  },
];
const durable = (seq: number, type: string, data: Record<string, unknown>) => ({
  seq,
  type,
  time: 1,
  data,
});
const textOf = (messages: Message[]) =>
  messages.map(({ id, role, content }) => ({ id, role, content }));

async function consume(events: BaseEvent[]) {
  for (const event of events) EventSchema.parse(event);
  const agent = new HttpAgent({
    url: "http://fixture/events",
    threadId: "thread",
    maxProtocolVersion: "1.0",
    fetch: async () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await agent.runAgent({ runId: "run" });
  for (const message of agent.messages) MessageSchema.parse(message);
  return agent.messages;
}

test("real AG-UI client parses reasoning, answer and tool stream with stable source identities", async () => {
  const events: BaseEvent[] = [start];
  const projection = new DshEventProjection("session", (event) =>
    events.push(event),
  );
  projection.live({
    type: "start",
    attemptId: "attempt",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  const chunks = [
    { type: "reasoning-delta", text: "Check " },
    { type: "reasoning-delta", text: "the facts." },
    { type: "text-delta", text: "Searching." },
    {
      type: "tool-call-delta",
      id: "lookup",
      name: "search",
      argumentsDelta: '{"q":',
    },
    { type: "tool-call-delta", id: "lookup", argumentsDelta: '"hello"}' },
  ];
  chunks.forEach((chunk, index) =>
    projection.live({ type: "chunk", attemptId: "attempt", index, chunk }),
  );
  projection.live({ type: "end", attemptId: "attempt", index: chunks.length });
  projection.durable(
    durable(0, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: finalContent },
    }),
  );
  projection.durable(
    durable(1, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        toolCallId: "lookup",
        content: [{ type: "text", text: "Found." }],
      },
    }),
  );
  events.push(finish);
  const messages = await consume(events);
  expect(messages).toEqual(projection.snapshot());
  expect(messages.map((message) => message.role)).toEqual([
    "reasoning",
    "assistant",
    "tool",
  ]);
  expect(messages[0]?.content).toBe("Check the facts.");
  expect(
    messages[1]?.role === "assistant" &&
      messages[1].toolCalls?.[0]?.function.arguments,
  ).toBe('{"q":"hello"}');
  const reasoningEvents = events.filter((event) =>
    event.type.startsWith("REASONING"),
  );
  expect(
    reasoningEvents.every(
      (event) =>
        (event as any).messageId === "session:assistant:1:1:1:reasoning",
    ),
  ).toBe(true);
});

test("durable-only reconstruction and closed-stream corrections retain reasoning before the answer", async () => {
  const replayEvents: BaseEvent[] = [start];
  const replay = new DshEventProjection("session", (event) =>
    replayEvents.push(event),
  );
  replay.durable(
    durable(0, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: finalContent },
    }),
  );
  replayEvents.push(finish);
  expect(await consume(replayEvents)).toEqual(replay.snapshot());
  expect(replay.snapshot().map((message) => message.role)).toEqual([
    "reasoning",
    "assistant",
  ]);

  const correctedEvents: BaseEvent[] = [start];
  const corrected = new DshEventProjection("session", (event) =>
    correctedEvents.push(event),
  );
  corrected.live({
    type: "start",
    attemptId: "attempt",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  corrected.live({
    type: "chunk",
    attemptId: "attempt",
    index: 0,
    chunk: { type: "reasoning-delta", text: "A temporary thought." },
  });
  corrected.live({
    type: "chunk",
    attemptId: "attempt",
    index: 1,
    chunk: { type: "text-delta", text: "Partial" },
  });
  corrected.live({ type: "end", attemptId: "attempt", index: 2 });
  corrected.durable(
    durable(0, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: finalContent },
    }),
  );
  correctedEvents.push(finish);
  const messages = await consume(correctedEvents);
  expect(messages).toEqual(replay.snapshot());
  expect(
    correctedEvents.some((event) => event.type === "MESSAGES_SNAPSHOT"),
  ).toBe(true);
});

test("snapshot reconnect and interruption close the original reasoning identity without losing its prefix", async () => {
  const liveEvents: BaseEvent[] = [];
  const projection = new DshEventProjection("session", (event) =>
    liveEvents.push(event),
  );
  projection.live({
    type: "start",
    attemptId: "attempt",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  projection.live({
    type: "chunk",
    attemptId: "attempt",
    index: 0,
    chunk: { type: "reasoning-delta", text: "Check " },
  });
  const lifecycles = createEventLifecycles();
  for (const event of liveEvents) lifecycles.accept(event);
  const reconnect: BaseEvent[] = [
    start,
    { type: "MESSAGES_SNAPSHOT", messages: projection.snapshot() } as BaseEvent,
    ...lifecycles.openings(),
  ];
  const offset = liveEvents.length;
  projection.live({
    type: "chunk",
    attemptId: "attempt",
    index: 1,
    chunk: { type: "reasoning-delta", text: "the facts." },
  });
  reconnect.push(...liveEvents.slice(offset));
  const finalizer = createRunEventFinalizer();
  for (const event of reconnect) finalizer.observe(event);
  const ending = finalizer.finalize({ stopRequested: true });
  expect(ending.find((event) => event.type === "REASONING_END")).toMatchObject({
    messageId: "session:assistant:1:1:1:reasoning",
  });
  const messages = await consume([...reconnect, ...ending]);
  expect(textOf(messages)).toEqual([
    {
      id: "session:assistant:1:1:1:reasoning",
      role: "reasoning",
      content: "Check the facts.",
    },
  ]);
  for (const event of lifecycles.closeStreams()) EventSchema.parse(event);
});

test("DSH active-attempt baseline restores reasoning chunks before the live suffix", async () => {
  const events: BaseEvent[] = [start];
  const projection = new DshEventProjection("session", (event) =>
    events.push(event),
  );
  projection.restoreLive({
    activeAttempt: {
      attemptId: "active",
      turn: 1,
      step: 1,
      startedAfterSeq: -1,
      nextIndex: 2,
      stream: [
        {
          type: "reasoning-chunks",
          time0: 1,
          index: 0,
          dt: [1],
          texts: ["Check ", "the facts."],
        },
      ],
    },
  });
  projection.live({
    type: "chunk",
    attemptId: "active",
    index: 2,
    chunk: { type: "text-delta", text: "Searching." },
  });
  projection.durable(
    durable(0, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: finalContent.slice(0, 2) },
    }),
  );
  events.push(finish);
  const messages = await consume(events);
  expect(messages).toEqual(projection.snapshot());
  expect(messages.map((message) => message.content)).toEqual([
    "Check the facts.",
    "Searching.",
  ]);
});

test("durable settlement before late live frames keeps one tool call with one JSON argument", async () => {
  const events: BaseEvent[] = [start];
  const projection = new DshEventProjection("session", (event) =>
    events.push(event),
  );
  const content = [finalContent[2]!];
  projection.durable(
    durable(0, "assistant/message", { turn: 1, step: 1, message: { content } }),
  );
  const afterSettlement = events.length;
  projection.live({
    type: "start",
    attemptId: "session:1",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  projection.live({
    type: "chunk",
    attemptId: "session:1",
    index: 0,
    chunk: {
      type: "tool-call-delta",
      id: "lookup",
      name: "search",
      argumentsDelta: '{"q":"hello"}',
    },
  });
  projection.live({
    type: "end",
    attemptId: "session:1",
    index: 1,
    outcome: { kind: "committed", eventType: "assistant/message", seq: 0 },
  });
  projection.restoreLive({
    activeAttempt: {
      attemptId: "session:1",
      turn: 1,
      step: 1,
      startedAfterSeq: -1,
      nextIndex: 1,
      stream: [
        {
          type: "tool-call-chunks",
          time0: 1,
          index: 0,
          dt: [],
          id: "lookup",
          name: "search",
          args: ['{"q":"hello"}'],
        },
      ],
    },
  });
  expect(events.length).toBe(afterSettlement);
  events.push(finish);
  const messages = await consume(events);
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ q: "hello" });
  expect(messages).toEqual(projection.snapshot());
});

test("retry after a failed durable attempt retains a separate ordinal and ignores late predecessor frames", async () => {
  const events: BaseEvent[] = [start];
  const projection = new DshEventProjection("session", (event) =>
    events.push(event),
  );
  projection.live({
    type: "start",
    attemptId: "session:1",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  projection.live({
    type: "chunk",
    attemptId: "session:1",
    index: 0,
    chunk: { type: "reasoning-delta", text: "First attempt." },
  });
  projection.durable(
    durable(0, "assistant/attempt", { turn: 1, step: 1, stream: [] }),
  );
  projection.live({
    type: "start",
    attemptId: "session:2",
    turn: 1,
    step: 1,
    startedAfterSeq: 0,
  });
  projection.live({
    type: "chunk",
    attemptId: "session:2",
    index: 0,
    chunk: { type: "text-delta", text: "Retry completed." },
  });
  projection.live({
    type: "chunk",
    attemptId: "session:1",
    index: 1,
    chunk: { type: "reasoning-delta", text: "Late content must not return." },
  });
  projection.durable(
    durable(1, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "Retry completed." }] },
    }),
  );
  events.push(finish);
  const messages = await consume(events);
  expect(messages.map((message) => message.id)).toEqual([
    "session:assistant:1:1:1:reasoning",
    "session:assistant:1:1:2",
  ]);
  expect(messages.map((message) => message.content)).toEqual([
    "First attempt.",
    "Retry completed.",
  ]);
});

test("historical baseline suppresses replayed live attempts while allowing the next real attempt", async () => {
  const history = durable(0, "assistant/message", {
    turn: 1,
    step: 1,
    message: { content: [{ type: "text", text: "Saved." }] },
  });
  const original = [
    { id: "session:assistant:1:1:1", role: "assistant", content: "Saved." },
  ] as Message[];
  const events: BaseEvent[] = [
    start,
    { type: "MESSAGES_SNAPSHOT", messages: original } as BaseEvent,
  ];
  const projection = new DshEventProjection(
    "session",
    (event) => events.push(event),
    original,
  );
  projection.baseline([{ event: history }], 0);
  projection.live({
    type: "start",
    attemptId: "old",
    turn: 1,
    step: 1,
    startedAfterSeq: -1,
  });
  projection.live({
    type: "chunk",
    attemptId: "old",
    index: 0,
    chunk: { type: "text-delta", text: "Saved." },
  });
  projection.live({
    type: "start",
    attemptId: "new",
    turn: 1,
    step: 1,
    startedAfterSeq: 0,
  });
  projection.live({
    type: "chunk",
    attemptId: "new",
    index: 0,
    chunk: { type: "text-delta", text: "New." },
  });
  projection.durable(
    durable(1, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "New." }] },
    }),
  );
  events.push(finish);
  expect((await consume(events)).map((message) => message.content)).toEqual([
    "Saved.",
    "New.",
  ]);
});
