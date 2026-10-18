import { expect, test } from "bun:test";
import { EventType, type BaseEvent, type Message } from "@ag-ui/client";

/**
 * 接入改发消息快照（DOG-01 follow-up）：不再把整段事件日志 slimReplay 后塞给浏览器。
 * 这里锁住「快照形态」——一条 MESSAGES_SNAPSHOT + 一条 STATE_SNAPSHOT——体积远小于逐事件回放。
 */
function connectSnapshot(messages: Message[], state: Record<string, unknown>): BaseEvent[] {
  return [
    { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent,
    { type: EventType.STATE_SNAPSHOT, snapshot: state } as BaseEvent,
  ];
}

test("connect snapshot is two events regardless of how long the thread is", () => {
  const messages: Message[] = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `消息 ${i} `.repeat(20),
  }));
  const snap = connectSnapshot(messages, { ok: true });
  expect(snap).toHaveLength(2);
  expect(snap[0]!.type).toBe(EventType.MESSAGES_SNAPSHOT);
  expect(snap[1]!.type).toBe(EventType.STATE_SNAPSHOT);
  const eventLogStyle = messages.flatMap((message, i) => [
    { type: EventType.RUN_STARTED, runId: `r${i}`, input: { messages: messages.slice(0, i + 1), context: [{ v: "x".repeat(200) }], tools: [] } },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: String(message.content) },
    { type: EventType.RUN_FINISHED, runId: `r${i}` },
  ]);
  expect(JSON.stringify(snap).length).toBeLessThan(JSON.stringify(eventLogStyle).length / 3);
});
