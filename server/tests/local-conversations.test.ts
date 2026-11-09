import { expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { lastValueFrom, Observable, of, throwError, toArray } from "rxjs";
import {
  mergeConversationMessages,
  prepareConversationMessages,
  toLocalHistoryMessage,
  withRunStartedAck,
} from "../src/local-conversations";

test("tool call arguments and result identifiers survive the history boundary", () => {
  expect(
    toLocalHistoryMessage({
      id: "assistant-1",
      role: "assistant",
      content: "Searching",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"q":"hello"}' },
        },
      ],
    }),
  ).toEqual({
    id: "assistant-1",
    role: "assistant",
    content: "Searching",
    toolCalls: [{ id: "call-1", name: "search", args: '{"q":"hello"}' }],
  });
  expect(
    toLocalHistoryMessage({
      id: "result-1",
      role: "tool",
      content: "found",
      toolCallId: "call-1",
    }),
  ).toEqual({
    id: "result-1",
    role: "tool",
    content: "found",
    toolCallId: "call-1",
  });
});

test("a private handoff task executes while its visible summary is the saved input", () => {
  const saved = [{ id: "prior", role: "user" as const, content: "Saved" }];
  const task = {
    id: "handoff",
    role: "user" as const,
    content: "Private report 42",
  };
  const shown = { id: "handoff", role: "user" as const, content: "Bot joined" };
  const prepared = prepareConversationMessages(saved, [task], [shown]);
  expect(prepared.execution).toEqual([...saved, task]);
  expect(prepared.visible).toEqual([...saved, shown]);
  expect(
    prepared.project([
      ...saved,
      task,
      { id: "answer", role: "assistant", content: "42" },
    ]),
  ).toEqual([
    ...saved,
    shown,
    { id: "answer", role: "assistant", content: "42" },
  ]);
  const hidden = prepareConversationMessages(saved, [task], []);
  expect(
    hidden.project([
      ...saved,
      task,
      { id: "answer", role: "assistant", content: "42" },
    ]),
  ).toEqual([...saved, { id: "answer", role: "assistant", content: "42" }]);
  expect(
    prepared.event({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [task, { id: "answer", role: "assistant", content: "42" }],
    } as BaseEvent),
  ).toEqual({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [
      ...saved,
      shown,
      { id: "answer", role: "assistant", content: "42" },
    ],
  });
  expect(hidden.sanitize({ nested: { messages: [task] } })).toEqual({
    nested: { messages: [] },
  });
  expect(
    prepared.event({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: task.id,
      delta: task.content,
    } as BaseEvent),
  ).toBeUndefined();
  expect(
    prepared.event({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "fresh-result",
      toolCallId: "fresh-call",
      role: "tool",
      content: "42",
    } as BaseEvent),
  ).toEqual({
    type: EventType.TOOL_CALL_RESULT,
    messageId: "fresh-result",
    toolCallId: "fresh-call",
    role: "tool",
    content: "42",
  });
});

test("a caller cannot overwrite canonical history by reusing a message id", () => {
  expect(
    mergeConversationMessages(
      [{ id: "old", role: "user", content: "Original" }],
      [
        { id: "old", role: "user", content: "Changed" },
        { id: "new", role: "user", content: "Next" },
      ],
    ),
  ).toEqual([
    { id: "old", role: "user", content: "Original" },
    { id: "new", role: "user", content: "Next" },
  ]);
});

/*
 * 「明明 AI 都输出了」误报修复（受理回执）：服务端受理到开跑之间有静默前置
 * （等上一轮收尾 / 前端接力 settle / 抢锁落库），浏览器 12 秒看门狗把这段误判成「没发出去」。
 * 订阅一建立就先发 RUN_STARTED，真正的 RUN_STARTED 下游去重，订阅者从头到尾只见一条。
 */
const runStarted = (threadId: string, runId: string) =>
  ({ type: EventType.RUN_STARTED, threadId, runId }) as BaseEvent;

test("withRunStartedAck: the receipt is the first event, emitted synchronously at subscribe", () => {
  const seen: BaseEvent[] = [];
  const never = new Observable<BaseEvent>(() => {});
  withRunStartedAck({ threadId: "t1" }, "r1", never).subscribe((event) =>
    seen.push(event),
  );
  expect(seen).toEqual([runStarted("t1", "r1")]);
});

test("withRunStartedAck: the real RUN_STARTED is deduplicated, everything else passes through", async () => {
  const text = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "m1",
    delta: "hi",
  } as BaseEvent;
  const finished = {
    type: EventType.RUN_FINISHED,
    threadId: "t1",
    runId: "r1",
  } as BaseEvent;
  const events = await lastValueFrom(
    withRunStartedAck(
      { threadId: "t1" },
      "r1",
      of(runStarted("t1", "r1"), text, finished),
    ).pipe(toArray()),
  );
  expect(events).toEqual([runStarted("t1", "r1"), text, finished]);
  expect(
    events.filter((event) => event.type === EventType.RUN_STARTED),
  ).toHaveLength(1);
});

test("withRunStartedAck: a source error still terminates the stream after the receipt", async () => {
  const events: BaseEvent[] = [];
  let failure: unknown;
  await new Promise<void>((resolve) => {
    withRunStartedAck(
      { threadId: "t1" },
      "r1",
      throwError(() => new Error("busy")),
    ).subscribe({
      next: (event) => events.push(event),
      error: (error) => {
        failure = error;
        resolve();
      },
    });
  });
  expect(events).toEqual([runStarted("t1", "r1")]);
  expect(failure).toBeInstanceOf(Error);
});
