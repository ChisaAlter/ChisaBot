import { expect, test } from "bun:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { of } from "rxjs";
import { spyOn } from "bun:test";
import { buildAgents, setAgentKernel } from "../src/copilot";

function kernel() {
  setAgentKernel({ kind: "hermes", url: "http://bridge/ag-ui", binding: { toolGatewayUrl: "http://host/api/internal/runtime-tools", readRun: () => ({ actorId: "owner", botId: "star", threadId: "thread", runId: "run" }) } });
}

test("Hermes sees authoritative memory, standing instructions, per-Bot model and one resolved tool result", async () => {
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    return of({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId }, { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
  });
  kernel();
  try {
    const args: Parameters<typeof buildAgents> = [[{ id: "star", name: "星灵", type: "built_in", systemPrompt: "Assist this person." }], { provider: "openai", defaultModel: "deployment-default" }, null];
    args[5] = () => "signed";
    args[11] = async () => "Write in Chinese.";
    args[16] = async () => "User prefers concise factual answers. Fresh memory.";
    args[17] = async () => ({ model: { provider: "openai", defaultModel: "bot-model" }, apiKey: "host-secret-not-forwarded" });
    const agent = (await buildAgents(...args)).star!;
    agent.threadId = "thread";
    agent.messages = [
      { id: "user", role: "user", content: "Write once" },
      { id: "call", role: "assistant", toolCalls: [{ id: "approved-call", type: "function", function: { name: "write", arguments: "{}" } }] },
    ];
    await agent.runAgent({ runId: "run", resume: [{ interruptId: "approved-call", status: "resolved", payload: "written already" }] });
    const input = requests[0]!;
    expect(input.messages.filter((message) => message.role === "tool")).toEqual([{ id: "hermes-resume:approved-call", role: "tool", toolCallId: "approved-call", content: "written already" }]);
    expect(JSON.stringify(input.messages)).toContain("Write in Chinese.");
    expect(JSON.stringify(input.messages)).toContain("Fresh memory.");
    expect(input.forwardedProps.chisabotHermes).toMatchObject({ model: { id: "bot-model" } });
    expect(JSON.stringify(input)).not.toContain("host-secret-not-forwarded");
  } finally {
    run.mockRestore();
    setAgentKernel({ kind: "builtin" });
  }
});
