import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runtimeRun } from "../src/agents/runtime-path";

test("the browser SDK's channel proxy sends the real BOT ID to the policy boundary", async () => {
  // Resolve the exact SDK used by useAgent, including its transitive core dependency.
  const appRequire = createRequire(
    new URL("../../app/package.json", import.meta.url),
  );
  const reactRequire = createRequire(
    appRequire.resolve("@copilotkit/react-core"),
  );
  const { ProxiedCopilotRuntimeAgent } = await import(
    reactRequire.resolve("@copilotkit/core")
  );
  const proxy = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: "https://chisabot.example.test/api/copilotkit",
    agentId: "channel:private-local-instance",
    runtimeAgentId: "actual-bot/id",
    threadId: "thread",
    transport: "sse",
    runtimeMode: "sse",
  });
  expect(proxy.agentId).toBe("channel:private-local-instance");
  expect(runtimeRun(new URL(proxy.url).pathname)).toEqual({
    agentId: "actual-bot/id",
    action: "run",
  });
});
