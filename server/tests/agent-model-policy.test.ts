import { expect, test } from "bun:test";
import { ConversationSession } from "../../app/src/lib/chat/session-client";
import { runtimeRun } from "../src/agents/runtime-path";

test("the browser session sends the real Bot ID to the compatibility policy boundary", () => {
  const session = new ConversationSession("actual-bot/id", "thread", "channel:private-local-instance", "legacy");
  expect(session.agentId).toBe("channel:private-local-instance");
  expect(runtimeRun(new URL(session.url, "https://chisabot.example.test").pathname)).toEqual({
    agentId: "actual-bot/id", action: "run",
  });
});
