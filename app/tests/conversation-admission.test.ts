import { afterEach, expect, test } from "bun:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationSession } from "../src/lib/chat/session-client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("an admission response cut off after its headers is recovered by the same command ID", async () => {
  const paths: string[] = [];
  const input = {
    threadId: "thread",
    runId: "client-run",
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [{ id: "user-1", role: "user" as const, content: "Do it once" }],
  };
  globalThis.fetch = (async (url: string) => {
    paths.push(url);
    if (url.endsWith("/commands"))
      return new Response('{"accepted":', {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/commands/user-1"))
      return Response.json({
        accepted: true,
        commandId: "user-1",
        runId: "stored-run",
      });
    if (url.endsWith("/events"))
      return new Response(
        [
          { type: "RUN_STARTED", threadId: "thread", runId: "stored-run" },
          { type: "RUN_ERROR", message: "Model unavailable" },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const agent = new ConversationSession("bot", "thread", "channel");
  const events = await lastValueFrom(agent.run(input).pipe(toArray()));
  expect(paths).toEqual([
    "/api/conversations/thread/commands",
    "/api/conversations/thread/commands/user-1",
    "/api/conversations/thread/events",
  ]);
  expect(agent.isCommandAccepted("user-1")).toBe(true);
  expect(events.filter((event) => event.type === "CUSTOM")).toMatchObject([
    { name: "chisabot.admission", value: { runId: "stored-run" } },
  ]);
});
