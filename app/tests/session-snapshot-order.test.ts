import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { of } from "rxjs";
import {
  applyMessagesSnapshot,
  ConversationSession,
} from "@/lib/chat/session-client";

function makeMessages(start: number, endInclusive: number): Message[] {
  const out: Message[] = [];
  for (let i = start; i <= endInclusive; i++) {
    out.push({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `content-${i}`,
    });
  }
  return out;
}

describe("applyMessagesSnapshot & ConversationSession snapshot ordering", () => {
  test("exact production repro: capped local tail [2069..2272] receiving uncapped [0..2272] stays chronological [0..2272]", () => {
    const local = makeMessages(2069, 2272);
    const full = makeMessages(0, 2272);
    const next = applyMessagesSnapshot(local, full);
    expect(next).toHaveLength(2273);
    expect(next[0]?.id).toBe("m-0");
    expect(next[2068]?.id).toBe("m-2068");
    expect(next[2069]?.id).toBe("m-2069");
    expect(next.at(-1)?.id).toBe("m-2272");
  });

  test("ConversationSession.apply overrides @ag-ui/client default push-to-end bug end-to-end", async () => {
    class TestSession extends ConversationSession {
      constructor() {
        super("bot-1", "thread-1", "agent-1");
      }
      override run() {
        return of(
          {
            type: EventType.RUN_STARTED,
            threadId: "thread-1",
            runId: "run-1",
          } as BaseEvent,
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: makeMessages(0, 250),
          } as BaseEvent,
          {
            type: EventType.RUN_FINISHED,
            threadId: "thread-1",
            runId: "run-1",
          } as BaseEvent,
        );
      }
    }

    const session = new TestSession();
    session.setMessages(makeMessages(200, 250));
    await session.runAgent({ runId: "run-1" });

    expect(session.messages).toHaveLength(251);
    expect(session.messages[0]?.id).toBe("m-0");
    expect(session.messages[199]?.id).toBe("m-199");
    expect(session.messages[200]?.id).toBe("m-200");
    expect(session.messages.at(-1)?.id).toBe("m-250");
  });

  test("capped mid-run tail snapshot preserves already-loaded older history prefix", () => {
    const local = makeMessages(1900, 2272);
    const cappedTail = [
      ...makeMessages(2073, 2272),
      { id: "m-2273", role: "user", content: "new steer" } as Message,
      { id: "m-2274", role: "assistant", content: "reply" } as Message,
    ];
    const next = applyMessagesSnapshot(local, cappedTail);
    expect(next).toHaveLength(375);
    expect(next[0]?.id).toBe("m-1900");
    expect(next[172]?.id).toBe("m-2072");
    expect(next[173]?.id).toBe("m-2073");
    expect(next.at(-1)?.id).toBe("m-2274");
  });

  test("edit/regenerate truncation drops deleted tail messages while preserving older prefix", () => {
    const local = makeMessages(1900, 2272);
    const truncatedTail = [
      ...makeMessages(2073, 2269),
      { id: "m-2270-edited", role: "user", content: "edited" } as Message,
    ];
    const next = applyMessagesSnapshot(local, truncatedTail);
    expect(next[0]?.id).toBe("m-1900");
    expect(next.at(-2)?.id).toBe("m-2269");
    expect(next.at(-1)?.id).toBe("m-2270-edited");
    expect(next.some((m) => m.id === "m-2271" || m.id === "m-2272")).toBe(
      false,
    );
  });

  test("reordered snapshot from server adopts canonical server order", () => {
    const local: Message[] = [
      { id: "u1", role: "user", content: "first" },
      { id: "u2", role: "user", content: "second" },
    ];
    const reordered: Message[] = [
      { id: "u2", role: "user", content: "second" },
      { id: "u1", role: "user", content: "first" },
    ];
    const next = applyMessagesSnapshot(local, reordered);
    expect(next.map((m) => m.id)).toEqual(["u2", "u1"]);
  });

  test("reordered tail snapshot on long loaded history preserves older prefix and reorders tail", () => {
    const local: Message[] = [
      { id: "old-0", role: "user", content: "0" },
      { id: "old-1", role: "assistant", content: "1" },
      { id: "a", role: "user", content: "A" },
      { id: "b", role: "user", content: "B" },
    ];
    const incoming: Message[] = [
      { id: "b", role: "user", content: "B" },
      { id: "a", role: "user", content: "A" },
    ];
    const next = applyMessagesSnapshot(local, incoming);
    expect(next.map((m) => m.id)).toEqual(["old-0", "old-1", "b", "a"]);
  });

  test("empty snapshot clears regular messages while keeping client-only activity/reasoning messages", () => {
    const activity = {
      id: "act-1",
      role: "activity",
      activityType: "progress",
      content: { step: 1 },
    } as unknown as Message;
    const local: Message[] = [
      { id: "u1", role: "user", content: "hi" },
      activity,
      { id: "a1", role: "assistant", content: "hello" },
    ];
    const next = applyMessagesSnapshot(local, []);
    expect(next.map((m) => m.id)).toEqual(["act-1"]);
  });

  test("preserves local-only activity/reasoning messages at their relative position and strips subagentRunId: null", () => {
    const activity = {
      id: "act-1",
      role: "activity",
      activityType: "plan",
      content: { ok: true },
    } as unknown as Message;
    const local: Message[] = [
      { id: "u1", role: "user", content: "hi" },
      activity,
      { id: "a1", role: "assistant", content: "old" },
    ];
    const incoming: Message[] = [
      {
        id: "u1",
        role: "user",
        content: "hi",
        subagentRunId: null,
      } as unknown as Message,
      { id: "a1", role: "assistant", content: "updated" },
    ];
    const next = applyMessagesSnapshot(local, incoming);
    expect(next.map((m) => m.id)).toEqual(["u1", "act-1", "a1"]);
    expect("subagentRunId" in (next[0] ?? {})).toBe(false);
    expect(next[2]?.content).toBe("updated");
  });

  test("subscriber returning stopPropagation: true before default (e.g. merge mode) still wins", async () => {
    class MergeTestSession extends ConversationSession {
      constructor() {
        super("bot-1", "thread-1", "agent-1");
      }
      override run() {
        return of(
          {
            type: EventType.RUN_STARTED,
            threadId: "thread-1",
            runId: "run-1",
          } as BaseEvent,
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [],
          } as BaseEvent,
          {
            type: EventType.RUN_FINISHED,
            threadId: "thread-1",
            runId: "run-1",
          } as BaseEvent,
        );
      }
    }

    const session = new MergeTestSession();
    session.setMessages([{ id: "keep-me", role: "user", content: "kept" }]);
    session.subscribe({
      onEvent: ({ event }) => {
        if (event.type === EventType.MESSAGES_SNAPSHOT) {
          return { stopPropagation: true };
        }
      },
    });
    await session.runAgent({ runId: "run-1" });
    expect(session.messages.map((m) => m.id)).toEqual(["keep-me"]);
  });
});
