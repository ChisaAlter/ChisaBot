import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { of } from "rxjs";
import { DEFAULT_CONNECT_MAX_MESSAGES } from "../../shared/connect-snapshot";
import { CHISABOT_WAITING_METADATA } from "../src/approvals/native-context";
import { eventStream } from "../src/conversations/routes";
import {
  capMessagesSnapshotEvent,
  sanitizeWireEvent,
  stripWaitingContinuationMessages,
} from "../src/conversations/wire-events";

function makeMessages(count: number, padding = ""): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg-${i}${padding}`,
  }));
}

describe("wire-events sanitization", () => {
  test("capMessagesSnapshotEvent caps oversized mid-run snapshots without mutating original event", () => {
    const messages = makeMessages(2273, "x".repeat(400));
    const original = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages,
    } as BaseEvent & { messages: Message[] };

    const capped = capMessagesSnapshotEvent(original);
    expect(capped).not.toBe(original);
    expect(capped.messages.length).toBeLessThanOrEqual(
      DEFAULT_CONNECT_MAX_MESSAGES,
    );
    expect(capped.messages.at(-1)?.id).toBe("m-2272");
    // Original in-memory array (used by server thread persistence) stays 100% intact.
    expect(original.messages).toHaveLength(2273);
    expect(original.messages[0]?.id).toBe("m-0");
  });

  test("capMessagesSnapshotEvent returns small snapshots and non-snapshot events unchanged", () => {
    const small = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: makeMessages(20),
    } as BaseEvent;
    expect(capMessagesSnapshotEvent(small)).toBe(small);

    const delta = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a1",
      delta: "hi",
    } as BaseEvent;
    expect(capMessagesSnapshotEvent(delta)).toBe(delta);
  });

  test("stripWaitingContinuationMessages removes continuation.messages from CUSTOM waiting events immutably", () => {
    const original = {
      type: EventType.CUSTOM,
      name: "chisabot.headless.waiting",
      value: {
        kind: "operation_unknown",
        requestId: "op-123",
        continuation: {
          threadId: "t1",
          runId: "r1",
          toolCallId: "tc-1",
          toolName: "computer_write_file",
          messages: makeMessages(500, "z".repeat(200)),
        },
      },
    } as unknown as BaseEvent & {
      value: {
        kind: string;
        requestId: string;
        continuation: Record<string, unknown>;
      };
    };

    const stripped = stripWaitingContinuationMessages(original);
    expect(stripped).not.toBe(original);
    expect(stripped.value.kind).toBe("operation_unknown");
    expect(stripped.value.requestId).toBe("op-123");
    expect(stripped.value.continuation.toolCallId).toBe("tc-1");
    expect(stripped.value.continuation.toolName).toBe("computer_write_file");
    expect("messages" in stripped.value.continuation).toBe(false);
    // Original in-process event keeps continuation.messages for headless callers (run-turn.ts).
    expect(Array.isArray(original.value.continuation.messages)).toBe(true);
    expect((original.value.continuation.messages as unknown[]).length).toBe(
      500,
    );
  });

  test("stripWaitingContinuationMessages removes continuation.messages from RUN_FINISHED interrupts immutably", () => {
    const original = {
      type: EventType.RUN_FINISHED,
      threadId: "t1",
      runId: "r1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "tc-1",
            reason: "human_input",
            message: "这一步可能已经执行，但结果尚待核对。",
            metadata: {
              [CHISABOT_WAITING_METADATA]: {
                kind: "operation_unknown",
                requestId: "op-9",
                continuation: {
                  threadId: "t1",
                  runId: "r1",
                  toolCallId: "tc-1",
                  messages: makeMessages(300, "a".repeat(200)),
                },
              },
            },
          },
        ],
      },
    } as unknown as BaseEvent & {
      outcome: {
        interrupts: {
          metadata: Record<
            string,
            {
              kind: string;
              requestId: string;
              continuation: Record<string, unknown>;
            }
          >;
        }[];
      };
    };

    const stripped = stripWaitingContinuationMessages(original);
    expect(stripped).not.toBe(original);
    const waiting =
      stripped.outcome.interrupts[0]?.metadata[CHISABOT_WAITING_METADATA];
    expect(waiting?.kind).toBe("operation_unknown");
    expect(waiting?.requestId).toBe("op-9");
    expect(waiting?.continuation.toolCallId).toBe("tc-1");
    expect("messages" in (waiting?.continuation ?? {})).toBe(false);

    const originalWaiting =
      original.outcome.interrupts[0]?.metadata[CHISABOT_WAITING_METADATA];
    expect(Array.isArray(originalWaiting?.continuation.messages)).toBe(true);
    expect(
      (originalWaiting?.continuation.messages as unknown[] | undefined)?.length,
    ).toBe(300);
  });

  test("eventStream sanitizes oversized MESSAGES_SNAPSHOT and waiting interrupts on the SSE wire", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: makeMessages(600, "m".repeat(400)),
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "tc-1",
              reason: "human_input",
              message: "核对",
              metadata: {
                [CHISABOT_WAITING_METADATA]: {
                  kind: "operation_unknown",
                  continuation: {
                    toolCallId: "tc-1",
                    messages: makeMessages(50, "q".repeat(100)),
                  },
                },
              },
            },
          ],
        },
      } as unknown as BaseEvent,
    ];

    const response = eventStream(of(...events));
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)));

    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe(EventType.MESSAGES_SNAPSHOT);
    expect(frames[0].messages.length).toBeLessThanOrEqual(
      DEFAULT_CONNECT_MAX_MESSAGES,
    );
    expect(frames[0].messages.at(-1).id).toBe("m-599");

    const wireWaiting =
      frames[1].outcome.interrupts[0].metadata[CHISABOT_WAITING_METADATA];
    expect(wireWaiting.kind).toBe("operation_unknown");
    expect(wireWaiting.continuation.toolCallId).toBe("tc-1");
    expect("messages" in wireWaiting.continuation).toBe(false);
    expect(sanitizeWireEvent(events[1] as BaseEvent)).toEqual(frames[1]);
  });
});
