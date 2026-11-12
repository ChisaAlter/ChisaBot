import { afterEach, expect, test } from "bun:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationSession } from "../src/lib/chat/session-client";
import { SendDeliveryUnknownError } from "../src/lib/conversations/connection-drop";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input = {
  threadId: "thread",
  runId: "client-run",
  state: {},
  tools: [],
  context: [],
  messages: [{ id: "user-1", role: "user" as const, content: "Do it once" }],
};
const receipt = () =>
  Response.json({ commandId: "user-1", runId: "stored-run" });
const events = () =>
  new Response(
    [
      { type: "RUN_STARTED", threadId: "thread", runId: "stored-run" },
      { type: "RUN_FINISHED", threadId: "thread", runId: "stored-run" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

function transport(
  submit: () => Response | Promise<Response>,
  lookup: () => Response | Promise<Response>,
  stream: () => Response = events,
) {
  const calls: { path: string; method: string }[] = [];
  globalThis.fetch = (async (url, options) => {
    const path = String(url);
    calls.push({ path, method: options?.method ?? "GET" });
    if (path.endsWith("/commands")) return submit();
    if (path.endsWith("/commands/user-1")) return lookup();
    if (path.endsWith("/events")) return stream();
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  return calls;
}

for (const scenario of [
  {
    name: "a 503 after admission",
    submit: () =>
      Response.json({ error: "Service unavailable" }, { status: 503 }),
  },
  {
    name: "a success missing its run id",
    submit: () => Response.json({ commandId: "user-1" }, { status: 202 }),
  },
  {
    name: "a success naming another command",
    submit: () =>
      Response.json(
        { commandId: "another", runId: "wrong-run" },
        { status: 202 },
      ),
  },
]) {
  test(`${scenario.name} reads the immutable receipt and never posts twice`, async () => {
    const calls = transport(scenario.submit, receipt);
    const agent = new ConversationSession("bot", "thread", "channel");
    const result = await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(calls).toEqual([
      { path: "/api/conversations/thread/commands", method: "POST" },
      { path: "/api/conversations/thread/commands/user-1", method: "GET" },
      { path: "/api/conversations/thread/events", method: "POST" },
    ]);
    expect(agent.isCommandAccepted("user-1")).toBe(true);
    expect(result.some((event) => event.type === "RUN_FINISHED")).toBe(true);
  });
}

test("a definitive HTTP refusal remains an ordinary failure without looking up or resending", async () => {
  const calls = transport(
    () => Response.json({ error: "This message was refused" }, { status: 409 }),
    receipt,
  );
  const agent = new ConversationSession("bot", "thread", "channel");
  const failure = await lastValueFrom(agent.run(input).pipe(toArray())).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SendDeliveryUnknownError);
  expect(failure.message).toBe("This message was refused");
  expect(calls).toHaveLength(1);
  expect(agent.isCommandAccepted("user-1")).toBe(false);
});

for (const scenario of [
  {
    name: "lost response",
    submit: () => {
      throw new TypeError("Failed to fetch");
    },
  },
  {
    name: "server error",
    submit: () => Response.json({ error: "Admission failed" }, { status: 500 }),
  },
]) {
  test(`a missing receipt after ${scenario.name} is still unknown delivery`, async () => {
    const calls = transport(scenario.submit, () =>
      Response.json({ error: "Command not found" }, { status: 404 }),
    );
    const agent = new ConversationSession("bot", "thread", "channel");
    const failure = await lastValueFrom(agent.run(input).pipe(toArray())).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(SendDeliveryUnknownError);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(agent.isCommandAccepted("user-1")).toBe(false);
  });
}

for (const scenario of [
  {
    name: "transport failure",
    lookup: () => {
      throw new TypeError("Failed to fetch");
    },
  },
  { name: "503", lookup: () => new Response(null, { status: 503 }) },
  {
    name: "lost authorization",
    lookup: () => new Response(null, { status: 401 }),
  },
  { name: "malformed receipt", lookup: () => Response.json(null) },
  {
    name: "another command's receipt",
    lookup: () => Response.json({ commandId: "another", runId: "stored-run" }),
  },
]) {
  test(`receipt lookup ${scenario.name} preserves unknown delivery through runAgent`, async () => {
    const calls = transport(() => {
      throw new TypeError("Failed to fetch");
    }, scenario.lookup);
    const agent = new ConversationSession("bot", "thread", "channel");
    agent.setMessages(input.messages);
    const failure = await agent
      .runAgent({ runId: input.runId })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(SendDeliveryUnknownError);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(agent.isCommandAccepted("user-1")).toBe(false);
  });
}

test("an event subscription failure cannot erase durable acceptance", async () => {
  const calls = transport(
    receipt,
    receipt,
    () => new Response(null, { status: 503 }),
  );
  const agent = new ConversationSession("bot", "thread", "channel");
  const failure = await lastValueFrom(agent.run(input).pipe(toArray())).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SendDeliveryUnknownError);
  expect(agent.isCommandAccepted("user-1")).toBe(true);
  expect(calls.map((call) => call.path)).toEqual([
    "/api/conversations/thread/commands",
    "/api/conversations/thread/events",
  ]);
});

test("a lookup 404 while the original POST is preparing cannot authorize another send", async () => {
  let releasePreparation!: () => void;
  const preparing = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let admission: Promise<void> | undefined;
  let accepted = false;
  const calls = transport(
    () => {
      admission = preparing.then(() => {
        accepted = true;
      });
      throw new TypeError("Admission response connection lost");
    },
    () =>
      accepted
        ? receipt()
        : Response.json({ error: "Command not found" }, { status: 404 }),
  );
  const agent = new ConversationSession("bot", "thread", "channel");
  agent.setMessages(input.messages);
  try {
    const failure = await agent
      .runAgent({ runId: input.runId })
      .catch((error) => error);
    expect(accepted).toBe(false);
    expect(failure).toBeInstanceOf(SendDeliveryUnknownError);
    releasePreparation();
    await admission;
    const lateReceipt = await fetch(
      "/api/conversations/thread/commands/user-1",
    );
    expect(await lateReceipt.json()).toEqual({
      commandId: "user-1",
      runId: "stored-run",
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  } finally {
    releasePreparation();
    await admission;
  }
});

test("local validation before admission is an ordinary failure with no request", async () => {
  const calls = transport(receipt, receipt);
  const agent = new ConversationSession("bot", "thread", "channel");
  const failure = await lastValueFrom(
    agent.run({ ...input, messages: [] }).pipe(toArray()),
  ).catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SendDeliveryUnknownError);
  expect(calls).toEqual([]);
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
