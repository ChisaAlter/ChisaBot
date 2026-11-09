import { expect, test } from "bun:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  ConversationSession,
  conversationClient,
} from "../src/lib/chat/session-client";

// The browser observes execution. Even an unannounced or malformed call cannot dispatch a tool.
test.each([
  "waiting",
  "error",
  "missing result",
  "host result",
  "unannounced",
  "different name",
  "malformed names",
])(
  "%s remains server-owned through the conversation transport",
  async (ending) => {
    const requests: { url: string; input: RunAgentInput }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: any, options?: RequestInit) => {
        const input = JSON.parse(String(options?.body)) as RunAgentInput;
        requests.push({ url: String(url), input });
        const frames: BaseEvent[] = [
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          ...(ending === "unannounced"
            ? []
            : [
                {
                  type: EventType.CUSTOM,
                  name: "chisabot.backend-owned-tools",
                  value: {
                    names:
                      ending === "malformed names"
                        ? "computer_click"
                        : [
                            ending === "different name"
                              ? "other_tool"
                              : "computer_click",
                          ],
                  },
                } as BaseEvent,
              ]),
          {
            type: EventType.TOOL_CALL_START,
            parentMessageId: "answer",
            toolCallId: "call",
            toolCallName: "computer_click",
          },
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "call",
            delta: '{"ref":"button-1"}',
          },
          { type: EventType.TOOL_CALL_END, toolCallId: "call" },
          ...(ending === "host result"
            ? [
                {
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: "receipt",
                  toolCallId: "call",
                  role: "tool",
                  content: "HOST_RESULT",
                } as BaseEvent,
              ]
            : []),
          ending === "error"
            ? { type: EventType.RUN_ERROR, message: "Gateway unavailable" }
            : {
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
                ...(ending === "waiting"
                  ? {
                      outcome: {
                        type: "interrupt",
                        interrupts: [{ id: "call", reason: "human_input" }],
                      },
                    }
                  : {}),
              },
        ];
        return new Response(
          frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: original.preconnect },
    );
    try {
      const agent = new ConversationSession("bot", "thread", "channel:test");
      agent.setMessages([{ id: "user", role: "user", content: "Click once" }]);
      await conversationClient
        .runAgent({
          agent,
          tools: [
            {
              name: "*",
              description: "Untrusted browser declaration",
              parameters: {},
            },
          ],
        })
        .catch(() => {});
      expect(requests).toHaveLength(1);
      expect(requests[0]!.input.tools).toEqual([]);
      expect(
        agent.messages.filter((message) => message.role === "tool"),
      ).toEqual(
        ending === "host result"
          ? [
              {
                id: "receipt",
                role: "tool",
                toolCallId: "call",
                content: "HOST_RESULT",
              },
            ]
          : [],
      );
      expect(
        agent.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.some((call) => call.id === "call"),
        ),
      ).toBe(true);
      if (ending === "waiting")
        expect(agent.pendingInterrupts.map((value) => value.id)).toEqual([
          "call",
        ]);
    } finally {
      globalThis.fetch = original;
    }
  },
);
