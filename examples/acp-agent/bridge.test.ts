import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpBridge } from "./bridge.mjs";

/**
 * ACP 桥的契约：ChisaBot 发一条 AG-UI run，ACP agent 的 session/update 变成文本 / 工具 / 结束事件。
 *
 * 用 fake-acp.mjs 代替 `dsh acp` / `hermes acp`，所以测试不依赖模型、凭据或网络。真实链路只需要
 * 把 `command` 换成 `dsh acp` 或 `hermes acp`；ACP 的方法和事件形状见 @agentclientprotocol/sdk
 * 的 schema（session/new、session/prompt、session/update、session/request_permission）。
 */

const fakeAcp = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const command = [process.execPath, fakeAcp];

function bridge(overrides = {}) {
  return createAcpBridge({
    command,
    cwd: process.cwd(),
    port: 0,
    approval: "allow",
    turnTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    ...overrides,
  });
}

async function run(url, input) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}

const running = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.close()));
});

describe("ACP AG-UI bridge", () => {
  test("maps ACP text, tool calls, permission and turn end to AG-UI", async () => {
    const created = bridge();
    running.push(created);
    const events = await run(`http://127.0.0.1:${created.server.port}/ag-ui`, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "u1", role: "user", content: "你好，ACP" }],
    });

    expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
    expect(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "收到：你好，ACP")).toBe(true);
    expect(events.some((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "运行 echo hi")).toBe(true);
    const args = events.find((event) => event.type === "TOOL_CALL_ARGS");
    expect(JSON.parse(args.delta)).toEqual({ command: "echo hi" });
    expect(events.some((event) => event.type === "TOOL_CALL_RESULT" && event.content === "hi")).toBe(true);
    // 桥替没有编辑器的 ChisaBot 回答了 permission：allow_once 被选中。
    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_CONTENT" &&
          event.delta.includes('"outcome":"selected"') &&
          event.delta.includes("allow-1"),
      ),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
  });

  test("reuses one ACP session for repeated runs on the same thread", async () => {
    const countFile = join(tmpdir(), `acp-sessions-${crypto.randomUUID()}.txt`);
    const previous = process.env.FAKE_ACP_SESSION_COUNT_FILE;
    process.env.FAKE_ACP_SESSION_COUNT_FILE = countFile;
    try {
      const created = bridge();
      running.push(created);
      const url = `http://127.0.0.1:${created.server.port}/ag-ui`;
      for (const runId of ["run-1", "run-2"]) {
        await run(url, {
          threadId: "thread-same",
          runId,
          messages: [{ id: runId, role: "user", content: runId }],
        });
      }
      expect(readFileSync(countFile, "utf8")).toBe("1");
    } finally {
      rmSync(countFile, { force: true });
      if (previous === undefined) delete process.env.FAKE_ACP_SESSION_COUNT_FILE;
      else process.env.FAKE_ACP_SESSION_COUNT_FILE = previous;
    }
  });

  test("seeds the host's system prompt once, then stops repeating it", async () => {
    const promptFile = join(tmpdir(), `acp-prompt-${crypto.randomUUID()}.json`);
    const previous = process.env.FAKE_ACP_PROMPT_FILE;
    process.env.FAKE_ACP_PROMPT_FILE = promptFile;
    try {
      const created = bridge();
      running.push(created);
      const url = `http://127.0.0.1:${created.server.port}/ag-ui`;
      const messages = [
        { id: "s", role: "system", content: "你是星灵，用户的私人助手。" },
        { id: "u", role: "user", content: "你好" },
      ];
      await run(url, { threadId: "thread-seed", runId: "seed-1", messages });
      const first = JSON.parse(readFileSync(promptFile, "utf8"));
      expect(first).toHaveLength(2);
      expect(first[0].text).toContain("宿主设定");
      expect(first[0].text).toContain("星灵");

      await run(url, { threadId: "thread-seed", runId: "seed-2", messages });
      const second = JSON.parse(readFileSync(promptFile, "utf8"));
      expect(second).toHaveLength(1);
      expect(second[0].text).toBe("你好");
    } finally {
      rmSync(promptFile, { force: true });
      if (previous === undefined) delete process.env.FAKE_ACP_PROMPT_FILE;
      else process.env.FAKE_ACP_PROMPT_FILE = previous;
    }
  });

  test("a refusal is RUN_ERROR, not a successful empty answer", async () => {
    const previous = process.env.FAKE_ACP_ERROR;
    process.env.FAKE_ACP_ERROR = "1";
    try {
      const created = bridge();
      running.push(created);
      const events = await run(`http://127.0.0.1:${created.server.port}/ag-ui`, {
        threadId: "thread-refusal",
        runId: "run-refusal",
        messages: [{ id: "u", role: "user", content: "拒绝我" }],
      });
      expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR" });
      expect(events.at(-1).message).toContain("拒绝");
    } finally {
      if (previous === undefined) delete process.env.FAKE_ACP_ERROR;
      else process.env.FAKE_ACP_ERROR = previous;
    }
  });

  test("refuses a run with no user text", async () => {
    const created = bridge();
    running.push(created);
    const events = await run(`http://127.0.0.1:${created.server.port}/ag-ui`, {
      threadId: "thread-empty",
      runId: "run-empty",
      messages: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("RUN_ERROR");
  });

  test("health names the agent command and session count", async () => {
    const created = bridge();
    running.push(created);
    const response = await fetch(`http://127.0.0.1:${created.server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      initialized: false,
      sessions: 0,
      command: command.join(" "),
    });
  });

  test("an optional token guards /ag-ui but not /health", async () => {
    const created = bridge({ token: "secret-token" });
    running.push(created);
    const base = `http://127.0.0.1:${created.server.port}`;

    const refused = await fetch(`${base}/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t", runId: "r", messages: [] }),
    });
    expect(refused.status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
