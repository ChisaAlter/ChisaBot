import { expect, test } from "bun:test";
import { type BaseEvent, HttpAgent, type Message } from "@ag-ui/client";
import { EventSchema, MessageSchema } from "@ag-ui/core/schemas";
import { DshEventProjection } from "../src/conversations/dsh-events";

const durable = (seq: number, type: string, data: Record<string, unknown>) => ({
  seq,
  type,
  time: 1,
  data,
});
const call = (id: string) => ({
  type: "tool-call",
  id,
  name: "ima_search",
  arguments: '{"query":"我的数据库"}',
});
const STOP_TEXT =
  "这一轮我停下来了：模型反复用同样的参数调用「ima_search」，没有新进展，所以我中止了这一轮，没有继续空转。";

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

function stoppedLoop(projection: DshEventProjection, text: unknown) {
  let seq = 0;
  for (const step of [1, 2]) {
    projection.durable(
      durable(seq++, "assistant/message", {
        turn: 1,
        step,
        message: { content: [call(`c${step}`)] },
      }),
    );
    if (step === 2)
      projection.durable(
        durable(seq++, "plugin:chisabot/loop-stop", { turn: 1, step, text }),
      );
    projection.durable(
      durable(seq++, "tool/result", {
        turn: 1,
        step,
        message: {
          toolCallId: `c${step}`,
          content: [
            { type: "text", text: step === 1 ? "no rows" : "Not executed" },
          ],
        },
      }),
    );
  }
  projection.durable(
    durable(seq++, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  );
}

test("a stopped tool loop ends the turn with the runtime's honest account as the last message", async () => {
  const events: BaseEvent[] = [
    { type: "RUN_STARTED", threadId: "thread", runId: "run" } as BaseEvent,
  ];
  const projection = new DshEventProjection("session", (event) =>
    events.push(event),
  );
  stoppedLoop(projection, STOP_TEXT);
  events.push({
    type: "RUN_FINISHED",
    threadId: "thread",
    runId: "run",
  } as BaseEvent);
  const messages = await consume(events);
  expect(messages).toEqual(projection.snapshot());
  const last = messages.at(-1) as Message;
  expect(last.role).toBe("assistant");
  expect(last.content).toBe(STOP_TEXT);
  expect(last.id).toBe("session:loop-stop:3");
  // It comes after every tool result of the turn.
  const lastTool = messages.findLastIndex((message) => message.role === "tool");
  expect(lastTool).toBeLessThan(messages.length - 1);
  expect(projection.lastReason).toEqual({ kind: "completed" });
});

test("a loop-stop record without usable text adds nothing", () => {
  for (const text of [undefined, "", "   ", 42]) {
    const projection = new DshEventProjection("session", () => {});
    stoppedLoop(projection, text);
    expect(
      projection
        .snapshot()
        .some((message) => String(message.id).includes("loop-stop")),
    ).toBe(false);
  }
});

test("an over-long conclusion is bounded", () => {
  const projection = new DshEventProjection("session", () => {});
  stoppedLoop(projection, "停".repeat(5000));
  const stop = projection
    .snapshot()
    .find((message) => String(message.id).includes("loop-stop"));
  expect(typeof stop?.content === "string" && stop.content.length).toBe(2000);
});
