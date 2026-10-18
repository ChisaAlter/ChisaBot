import { expect, test } from "bun:test";
import { TOOL_STOPPED_ZH } from "../src/confirmations/context";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";

/**
 * FIX-04 residual: MCP / connector tools must honour Stop (ctx.signal) and must not
 * return a late vendor success after abort.
 */
test("grantedTools execute returns TOOL_STOPPED when signal already aborted", async () => {
  let called = false;
  const store = {
    listForAgent: async () => ({
      tools: [
        {
          toolName: "mcp__demo__ping",
          ref: "demo/ping",
          description: "ping",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      skills: [],
    }),
    callTool: async () => {
      called = true;
      return { text: "pong", isError: false };
    },
  };
  const tools = await grantedTools({
    store: store as never,
    botId: "bot",
    actorId: "user",
  });
  const controller = new AbortController();
  controller.abort();
  const out = await tools[0]!.execute({}, { signal: controller.signal });
  expect(out).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);
  expect(called).toBe(false);
});

test("grantedTools execute returns TOOL_STOPPED when vendor throws AbortError", async () => {
  const store = {
    listForAgent: async () => ({
      tools: [
        {
          toolName: "mcp__demo__slow",
          ref: "demo/slow",
          description: "slow",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      skills: [],
    }),
    callTool: async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  };
  const tools = await grantedTools({
    store: store as never,
    botId: "bot",
    actorId: "user",
  });
  const out = await tools[0]!.execute(
    {},
    { signal: new AbortController().signal },
  );
  expect(out).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);
});

test("grantedTools does not present success after signal aborts mid-await", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store = {
    listForAgent: async () => ({
      tools: [
        {
          toolName: "mcp__demo__late",
          ref: "demo/late",
          description: "late",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      skills: [],
    }),
    callTool: async () => {
      await gate;
      return { text: "late success", isError: false };
    },
  };
  const tools = await grantedTools({
    store: store as never,
    botId: "bot",
    actorId: "user",
  });
  const controller = new AbortController();
  const pending = tools[0]!.execute({}, { signal: controller.signal });
  controller.abort();
  release();
  const out = await pending;
  expect(out).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);
  expect(out).not.toContain("late success");
});
