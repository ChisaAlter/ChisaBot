import { expect, test } from "bun:test";
import { createPlanModelProxy } from "../src/conversations/plan-model-proxy";
import type { WireBody } from "./support/wire-types";

test("DSH plan transport preserves the owned harness and returns tool arguments without executing them", async () => {
  const requests: WireBody[] = [];
  const harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("x-chisabot-agent-token")).toBe(
        "isolated-plan-token",
      );
      const body = await request.json();
      requests.push(body);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "answer",
          delta: "Using the owned plan.",
        },
        { type: "TEXT_MESSAGE_END", messageId: "answer" },
        {
          type: "TOOL_CALL_START",
          toolCallId: "plan-call",
          toolCallName: "read_value",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "plan-call",
          delta: '{"value":"one"}',
        },
        { type: "TOOL_CALL_END", toolCallId: "plan-call" },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const proxy = createPlanModelProxy(
      {
        provider: "chatgpt",
        endpoint: harness.url,
        token: "isolated-plan-token",
      },
      "bot",
      {
        threadId: "thread",
        runId: "run",
        state: {},
        messages: [],
        tools: [],
        context: [],
      },
      ["read_value"],
      new AbortController().signal,
    );
    const body = {
      messages: [
        { role: "system", content: "Keep the user's instructions." },
        { role: "user", content: "Read a value." },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read_value", parameters: { type: "object" } },
        },
      ],
    };
    const response = await proxy(body, new AbortController().signal);
    const events = (await response.text())
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      events.some(
        (event) => event.choices[0].delta.content === "Using the owned plan.",
      ),
    ).toBe(true);
    expect(
      events
        .flatMap((event) => event.choices[0].delta.tool_calls ?? [])
        .map((call) => call.function.arguments)
        .join(""),
    ).toBe('{"value":"one"}');
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(requests).toHaveLength(1);
    expect(requests[0].forwardedProps.chisabotModelOnly).toBe(true);
    expect(requests[0].context).toContainEqual({
      description: "Built-in Bot instructions",
      value: "Keep the user's instructions.",
    });
    await expect(
      proxy(
        {
          ...body,
          tools: [{ type: "function", function: { name: "not_granted" } }],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("ungranted");
    expect(requests).toHaveLength(1);
  } finally {
    harness.stop(true);
  }
});
