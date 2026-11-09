import { BaseEventSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

export function agUiTextEvents(input: RunAgentInput, text: string): BaseEvent[] {
  return [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId: "fixture-answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "fixture-answer", delta: text },
    { type: "TEXT_MESSAGE_END", messageId: "fixture-answer" },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ] as BaseEvent[];
}

/** Real loopback HTTP with the official AG-UI request/event schemas at its wire boundary. */
export function createAgUiFixture() {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const fixture = {
    events: [] as BaseEvent[],
    respond: undefined as ((input: RunAgentInput) => BaseEvent[]) | undefined,
    async start() {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const input = RunAgentInputSchema.parse(await request.json()) as RunAgentInput;
        const events = (fixture.respond?.(input) ?? fixture.events).map(event => BaseEventSchema.parse(
          event.type === "RUN_STARTED" || event.type === "RUN_FINISHED" ? { ...event, threadId: input.threadId, runId: input.runId } : event,
        ));
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
      return server.url.href;
    },
    async stop() { await server?.stop(true); server = undefined; },
  };
  return fixture;
}
