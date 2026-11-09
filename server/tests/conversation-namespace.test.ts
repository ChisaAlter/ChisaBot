import { expect, test } from "bun:test";
import { Hono } from "hono";
import { runtimeRun } from "../src/agents/runtime-path";
import {
  assertConversationNamespace,
  authenticationRequired,
  mountPreviousConversationRoutes,
  normalizeConversationEvent,
  normalizeRunInput,
  runAssertionValue,
  withoutRunAssertion,
} from "../src/legacy/protocol";

test("installed URLs execute the same canonical guard and preserve the request body", async () => {
  const app = new Hono();
  mountPreviousConversationRoutes(app);
  let executions = 0;
  app.use("/api/conversations/*", async (context, next) => {
    if (context.req.header("authorization") !== "fixture")
      return context.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.post("/api/conversations/agent/:agent/run", async (context) => {
    executions++;
    return context.json({
      agent: context.req.param("agent"),
      body: await context.req.json(),
    });
  });
  for (const base of ["/api/conversations", "/api/copilotkit"]) {
    expect(
      (await app.request(`${base}/agent/bot/run`, { method: "POST" })).status,
    ).toBe(401);
    const response = await app.request(`${base}/agent/bot/run`, {
      method: "POST",
      headers: { authorization: "fixture", "content-type": "application/json" },
      body: JSON.stringify({ threadId: "original", commandId: "one" }),
    });
    expect(await response.json()).toEqual({
      agent: "bot",
      body: { threadId: "original", commandId: "one" },
    });
  }
  expect(executions).toBe(2);
  expect(runtimeRun("/api/copilotkit/nested//agent/bot/run/")).toEqual({
    agentId: "bot",
    action: "run",
  });
});

test("old SSE clients retain waiting metadata without changing canonical events", async () => {
  const app = new Hono();
  mountPreviousConversationRoutes(app);
  const waiting = { kind: "operation_unknown", requestId: "original" };
  const events = [
    { type: "CUSTOM", name: "chisabot.headless.waiting", value: waiting },
    {
      type: "RUN_FINISHED",
      threadId: "thread",
      runId: "run",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "call", metadata: { chisabotWaiting: waiting } }],
      },
    },
  ];
  app.get(
    "/api/conversations/events",
    () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-accel-buffering": "no",
          },
        },
      ),
  );
  const canonical = await (
    await app.request("/api/conversations/events")
  ).text();
  const previousResponse = await app.request("/api/copilotkit/events");
  const previous = await previousResponse.text();
  expect(canonical).toContain("chisabot.headless.waiting");
  expect(canonical).not.toContain("openbotWaiting");
  expect(previous).toContain("openbot.headless.waiting");
  expect(previous).toContain("openbotWaiting");
  expect(previousResponse.headers.get("x-accel-buffering")).toBe("no");
});

test("saved assertions and waiting effects normalize without mutation or replay", () => {
  const input: any = {
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {
      openbotRun: "signed-unchanged",
      openbotBotId: "bot",
      custom: 3,
    },
  };
  const normalized = normalizeRunInput(input);
  expect(normalized.forwardedProps).toEqual({
    chisabotRun: "signed-unchanged",
    chisabotBotId: "bot",
    custom: 3,
  });
  expect(input.forwardedProps.openbotRun).toBe("signed-unchanged");
  expect(runAssertionValue(input.forwardedProps)).toBe("signed-unchanged");
  expect(
    withoutRunAssertion({ openbotRun: "old", chisabotRun: "new", custom: 3 }),
  ).toEqual({ custom: 3 });
  const event: any = {
    type: "RUN_FINISHED",
    runId: "r",
    threadId: "t",
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: "call",
          metadata: { openbotWaiting: { kind: "operation_unknown" } },
        },
      ],
    },
  };
  const next: any = normalizeConversationEvent(event);
  expect(next.outcome.interrupts[0].metadata).toEqual({
    chisabotWaiting: { kind: "operation_unknown" },
  });
  expect(event.outcome.interrupts[0].metadata.openbotWaiting).toEqual({
    kind: "operation_unknown",
  });
  expect(authenticationRequired()).toEqual({
    chisabotAuthRequired: true,
    openbotAuthRequired: true,
  });
});

test("a skipped table migration is refused before an empty replacement store can be created", async () => {
  const error = await assertConversationNamespace({
    unsafe: async () => [{ requires_migration: true }],
  }).catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("migration 0067");
  await assertConversationNamespace({
    unsafe: async () => [{ requires_migration: false }],
  });
});
