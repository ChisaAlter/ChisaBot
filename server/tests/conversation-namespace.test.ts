import { expect, test } from "bun:test";
import { Hono } from "hono";
import { runtimeRun } from "../src/agents/runtime-path";
import {
  authenticationRequired,
  CONVERSATION_BASE,
  isConversationPath,
  runAssertionValue,
  withoutRunAssertion,
} from "../src/conversations/protocol";

test("canonical conversation URLs execute the guard while retired upstream paths are not mounted", async () => {
  const app = new Hono();
  let executions = 0;
  app.use(`${CONVERSATION_BASE}/*`, async (context, next) => {
    if (context.req.header("authorization") !== "fixture")
      return context.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.post(`${CONVERSATION_BASE}/agent/:agent/run`, async (context) => {
    executions++;
    return context.json({
      agent: context.req.param("agent"),
      body: await context.req.json(),
    });
  });

  expect(
    (await app.request("/api/conversations/agent/bot/run", { method: "POST" }))
      .status,
  ).toBe(401);
  const response = await app.request("/api/conversations/agent/bot/run", {
    method: "POST",
    headers: { authorization: "fixture", "content-type": "application/json" },
    body: JSON.stringify({ threadId: "original", commandId: "one" }),
  });
  expect(await response.json()).toEqual({
    agent: "bot",
    body: { threadId: "original", commandId: "one" },
  });
  expect(executions).toBe(1);
  expect(isConversationPath("/api/conversations")).toBe(true);
  expect(isConversationPath("/api/conversations/agent/bot/run")).toBe(true);
  expect(runtimeRun("/api/conversations/nested//agent/bot/run/")).toEqual({
    agentId: "bot",
    action: "run",
  });
});

test("canonical run assertions and auth markers carry only ChisaBot keys", () => {
  const forwarded = {
    chisabotRun: "signed-unchanged",
    chisabotBotId: "bot",
    custom: 3,
  };
  expect(runAssertionValue(forwarded)).toBe("signed-unchanged");
  expect(withoutRunAssertion(forwarded)).toEqual({
    chisabotBotId: "bot",
    custom: 3,
  });
  expect(authenticationRequired()).toEqual({
    chisabotAuthRequired: true,
  });
});
