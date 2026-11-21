import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

test("real Host: phase-aware STEER_CUT cuts model stream & puts steer first, while tool phase queues next-step + steer-signal", {
  timeout: 120_000,
}, async (t) => {
  const requests = [];
  const steerSignals = [];
  let toolStartedResolve;
  const toolStarted = new Promise((resolveFn) => {
    toolStartedResolve = resolveFn;
  });
  let releaseTool;
  const toolGate = new Promise((resolveFn) => {
    releaseTool = resolveFn;
  });
  let firstModelStreamStartedResolve;
  const firstModelStreamStarted = new Promise((resolveFn) => {
    firstModelStreamStartedResolve = resolveFn;
  });
  const timers = new Set();

  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};

    if (request.url === "/steer") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [], instructions: [] }));
      return;
    }
    if (request.url === "/steer-signal") {
      steerSignals.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/execute") {
      toolStartedResolve();
      await toolGate;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: "slow_tool_finished" }));
      return;
    }

    const rawMessages = JSON.stringify(body.messages ?? []);
    requests.push({ model: body.model, messages: rawMessages });

    const sendSseText = (text) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: text }, null],
        [{}, "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    };

    if (
      rawMessages.includes("First slow task") &&
      !rawMessages.includes("Priority steer") &&
      !rawMessages.includes("Queued follow")
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "fixture-slow",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Partial intro " },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      firstModelStreamStartedResolve();
      const timer = setTimeout(() => {
        if (!response.writableEnded) {
          response.write(
            `data: ${JSON.stringify({
              id: "fixture-slow",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        }
      }, 4_000);
      timers.add(timer);
      response.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
      return;
    }

    if (
      rawMessages.includes("Priority steer") &&
      !rawMessages.includes("Queued follow")
    ) {
      sendSseText("Handled priority steer immediately.");
      return;
    }
    if (rawMessages.includes("Queued follow")) {
      sendSseText("Handled queued follow after steer.");
      return;
    }

    if (
      rawMessages.includes("Run slow tool") &&
      !rawMessages.includes("slow_tool_finished")
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                index: 0,
                id: "call_slow_1",
                type: "function",
                function: { name: "slow_tool", arguments: '{"q":"check"}' },
              },
            ],
          },
          null,
        ],
        [{}, "tool_calls"],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: "fixture-tool",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
      return;
    }

    if (rawMessages.includes("Edited queued text")) {
      sendSseText("Follow-up after slow tool and edit complete.");
      return;
    }

    sendSseText("Tool step complete.");
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "steer-cut-"));
  let host;
  let client;
  t.after(async () => {
    await client?.close();
    if (host && host.exitCode === null && host.signalCode === null) {
      const exit = once(host, "exit");
      host.kill("SIGTERM");
      await exit;
    }
    assert.equal(await realpath(home), home);
    await rm(home, { recursive: true });
  });

  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "steer-owner",
      port: 0,
      gatewayUrl: upstreamUrl,
      gatewayTokenEnv: "CHISABOT_TEST_TOOL_TOKEN",
      providers: {
        fixture: {
          api: "openai-completions",
          baseURL: `${upstreamUrl}/v1`,
          apiKeyEnv: "CHISABOT_TEST_MODEL_KEY",
          models: [
            {
              id: "available",
              contextWindow: 32000,
              maxTokens: 1024,
              input: ["text"],
            },
          ],
        },
      },
    }),
  );

  host = spawn(process.execPath, [resolve("src/start.mjs")], {
    windowsHide: true,
    env: {
      ...process.env,
      CHISABOT_DSH_HOME: home,
      CHISABOT_TEST_TOOL_TOKEN: "isolated-tool-fixture",
      CHISABOT_TEST_MODEL_KEY: "isolated-model-fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  host.stdout.on("data", (d) => {
    logs += d;
  });
  host.stderr.on("data", (d) => {
    logs += d;
  });
  for (let n = 0; n < 600; n++) {
    if (logs.includes("chisabot-runtime-ready")) break;
    if (host.exitCode !== null) throw new Error(`Host exited: ${logs}`);
    await delay(50);
  }
  const { endpoint } = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
  client = await DshHostClient.connect(endpoint);

  const makeBinding = (sessionId, runId, tools = []) => ({
    sessionId,
    runId,
    threadId: `thread-${sessionId}`,
    botId: "bot",
    actorId: "steer-owner",
    revision: 1,
    prompt: "You are a helpful test assistant.",
    model: { primary: { provider: "fixture", model: "available" } },
    tools,
  });

  // Case 1: Model phase STEER_CUT preserves partial turn and runs steer BEFORE existing queued item
  await client.bind(makeBinding("steer-model-session", "run-1"));
  await client.prompt({
    sessionId: "steer-model-session",
    requestId: "req-1",
    mode: "queue",
    content: [{ type: "text", text: "First slow task" }],
  });
  await firstModelStreamStarted;
  await delay(50);

  const midHealth = await client.health();
  const midSession = midHealth.sessions.find(
    (s) => s.sessionId === "steer-model-session",
  );
  assert.equal(midSession?.phase, "model");
  assert.equal(midSession?.inFlightTools, 0);

  await client.prompt({
    sessionId: "steer-model-session",
    requestId: "req-queued",
    mode: "queue",
    content: [{ type: "text", text: "Queued follow" }],
  });
  const steerRes = await client.steer({
    sessionId: "steer-model-session",
    runId: "run-1",
    requestId: "req-steer",
    content: [{ type: "text", text: "Priority steer" }],
  });
  assert.equal(steerRes.accepted, true);
  assert.equal(steerRes.action, "cut");
  assert.equal(steerRes.phase, "model");

  for (let i = 0; i < 10; i++) {
    const waitRes = await client.wait("steer-model-session", {
      timeoutMs: 20_000,
    });
    if (waitRes.reason === "idle") {
      const afterHealth = await client.health();
      const s = afterHealth.sessions.find(
        (x) => x.sessionId === "steer-model-session",
      );
      if (!s || s.state === "idle") break;
    }
    await delay(20);
  }

  const modelPage = await client.events("steer-model-session");
  const steerTurnEnd = modelPage.records.find(
    (r) =>
      r.event?.type === "turn/end" &&
      r.event?.data?.reason?.kind === "aborted" &&
      r.event?.data?.reason?.reason?.reason === "chisabot/steer",
  );
  assert.ok(steerTurnEnd, JSON.stringify(modelPage.records));
  const userRpcOrder = modelPage.records
    .filter(
      (r) =>
        r.event?.type === "user/message" &&
        r.event?.data?.source?.kind === "user",
    )
    .map((r) => r.event.data.source.rpcId);
  assert.deepEqual(userRpcOrder, ["req-1", "req-steer", "req-queued"]);

  // Case 2: Tools phase queues next-step + steer-signal & updateQueuedItem edits/steers
  await client.bind(
    makeBinding("steer-tool-session", "run-2", [
      {
        name: "slow_tool",
        description: "Slow read-only fixture tool",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
          additionalProperties: false,
        },
      },
    ]),
  );
  await client.prompt({
    sessionId: "steer-tool-session",
    requestId: "req-tool-1",
    mode: "queue",
    content: [{ type: "text", text: "Run slow tool" }],
  });
  await toolStarted;

  const toolHealth = await client.health();
  const toolSession = toolHealth.sessions.find(
    (s) => s.sessionId === "steer-tool-session",
  );
  assert.equal(toolSession?.phase, "tools");
  assert.equal(toolSession?.inFlightTools, 1);

  await client.prompt({
    sessionId: "steer-tool-session",
    requestId: "req-edit-me",
    mode: "queue",
    content: [{ type: "text", text: "Original queued text" }],
  });
  const edited = await client.updateQueuedItem({
    sessionId: "steer-tool-session",
    runId: "run-2",
    itemId: "req-edit-me",
    action: {
      kind: "edit",
      content: [{ type: "text", text: "Edited queued text" }],
    },
  });
  assert.equal(edited.accepted, true);

  const toolSteerRes = await client.steer({
    sessionId: "steer-tool-session",
    runId: "run-2",
    requestId: "req-tool-steer",
    content: [{ type: "text", text: "Follow up during tool" }],
  });
  assert.equal(toolSteerRes.accepted, true);
  assert.equal(toolSteerRes.action, "next-step");
  assert.equal(toolSteerRes.phase, "tools");

  for (let i = 0; i < 40 && steerSignals.length === 0; i++) await delay(25);
  assert.equal(steerSignals.length, 1);
  releaseTool();

  const waitTool = await client.wait("steer-tool-session", {
    timeoutMs: 20_000,
  });
  assert.equal(waitTool.reason, "idle");
  const toolPage = await client.events("steer-tool-session");
  assert.ok(
    JSON.stringify(toolPage.records).includes(
      "Follow-up after slow tool and edit complete.",
    ),
  );
});
