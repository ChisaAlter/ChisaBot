import { expect, test } from "bun:test";
import {
  type BaseEvent,
  defaultApplyEvents,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { slimReplay } from "../src/local-conversations";

/**
 * 接入回放瘦身（DESIGN.md §83）：每一轮 RUN_STARTED 不再重复带 context / tools 和前面已经出现过的消息。
 * 锁住两件事：客户端按 AG-UI 回放出来的消息列表和瘦身前一模一样；传的东西少了很多。
 */
const user = (id: string, text: string): Message => ({
  id,
  role: "user",
  content: text,
});
const context = [{ description: "系统上下文", value: "x".repeat(5000) }];
const tools = [
  { name: "search", description: "搜索".repeat(500), parameters: {} },
];

function run(
  runId: string,
  history: Message[],
  answerId: string,
  answer: string,
): BaseEvent[] {
  const input = {
    threadId: "t",
    runId,
    state: {},
    messages: history,
    tools,
    context,
    forwardedProps: {},
  };
  return [
    { type: EventType.RUN_STARTED, threadId: "t", runId, input } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: answerId,
      role: "assistant",
    } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: answerId,
      delta: answer,
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: answerId } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId } as BaseEvent,
  ];
}

function history(): BaseEvent[] {
  const u1 = user("u1", "第一句");
  const a1: Message = { id: "a1", role: "assistant", content: "回答一" };
  const u2 = user("u2", "第二句");
  const a2: Message = { id: "a2", role: "assistant", content: "回答二" };
  const u3 = user("u3", "第三句");
  return [
    ...run("r1", [u1], "a1", "回答一"),
    ...run("r2", [u1, a1, u2], "a2", "回答二"),
    ...run("r3", [u1, a1, u2, a2, u3], "a3", "回答三"),
  ];
}

async function replay(events: BaseEvent[]): Promise<Message[]> {
  const input: RunAgentInput = {
    threadId: "t",
    runId: "connect",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const agent = { state: {}, messages: [] } as never;
  const updates = await lastValueFrom(
    defaultApplyEvents(input, from(events), agent, []).pipe(toArray()),
  );
  let messages: Message[] = [];
  for (const update of updates)
    if (update.messages) messages = update.messages as Message[];
  return messages;
}

test("瘦身后回放出来的消息和原来一模一样", async () => {
  const full = history();
  const before = await replay(full);
  const after = await replay(slimReplay(full));
  expect(after).toEqual(before);
  expect(after.map((message) => message.id)).toEqual([
    "u1",
    "a1",
    "u2",
    "a2",
    "u3",
    "a3",
  ]);
});

test("每一轮只带新出现的消息，context / tools 是空的，其余事件原样", () => {
  const full = history();
  const slim = slimReplay(full);
  const inputs = slim
    .filter((event) => event.type === EventType.RUN_STARTED)
    .map((event) => (event as BaseEvent & { input: RunAgentInput }).input);
  expect(
    inputs.map((input) => input.messages.map((message) => message.id)),
  ).toEqual([["u1"], ["a1", "u2"], ["a2", "u3"]]);
  for (const input of inputs) {
    expect(input.context).toEqual([]);
    expect(input.tools).toEqual([]);
    expect(input.threadId).toBe("t");
  }
  expect(slim.filter((event) => event.type !== EventType.RUN_STARTED)).toEqual(
    full.filter((event) => event.type !== EventType.RUN_STARTED),
  );
  expect(JSON.stringify(slim).length).toBeLessThan(
    JSON.stringify(full).length / 5,
  );
});
