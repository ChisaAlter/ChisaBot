import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

test("real Host: stream, fallback, governed tool, duplicate admission, stop isolation and resume", {
  timeout: 180_000,
}, async (t) => {
  const requests = [];
  const tools = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (request.url === "/execute") {
      tools.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ content: `tool-receipt:${body.args.value}` }),
      );
      return;
    }
    requests.push(body);
    if (body.model === "unavailable") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Rate limit", type: "rate_limit_error" },
        }),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "response-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const question = body.messages
      ?.filter((x) => x.role === "user")
      .at(-1)?.content;
    if (JSON.stringify(question).includes("keep-running")) {
      emit({ role: "assistant", content: "started" });
      const timer = setInterval(() => emit({ content: "." }), 100);
      response.on("close", () => clearInterval(timer));
      return;
    }
    const hasResult = body.messages?.some((x) => x.role === "tool");
    if (body.tools?.length && !hasResult) {
      emit({ role: "assistant", content: "Calling tool. " });
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call-echo",
            type: "function",
            function: { name: "echo_value", arguments: '{"value":"once"}' },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "complete" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const root = resolve(".runtime");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "integration-"));
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "test-owner",
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
              id: "unavailable",
              contextWindow: 32000,
              maxTokens: 1024,
              input: ["text"],
            },
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
  let child;
  let client;
  let logs = "";
  const boot = async () => {
    child = spawn(process.execPath, ["src/start.mjs"], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        CHISABOT_DSH_HOME: home,
        CHISABOT_TEST_TOOL_TOKEN: "isolated-tool-fixture",
        CHISABOT_TEST_MODEL_KEY: "isolated-model-fixture",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    logs = "";
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    for (let n = 0; n < 600; n++) {
      if (logs.includes("chisabot-runtime-ready")) break;
      if (child.exitCode !== null) throw new Error(`Host exited: ${logs}`);
      await delay(100);
    }
    assert.match(logs, /chisabot-runtime-ready/, logs);
    const { endpoint } = JSON.parse(
      await readFile(join(home, "connection.json"), "utf8"),
    );
    client = await DshHostClient.connect(endpoint);
  };
  const stopHost = async () => {
    await client?.close();
    if (child && child.exitCode === null) {
      const exiting = once(child, "exit");
      child.kill("SIGTERM");
      await exiting;
    }
  };
  t.after(stopHost);
  await boot();
  const binding = (sessionId, runId, useTool = false) => ({
    sessionId,
    runId,
    threadId: `thread-${sessionId}`,
    botId: "bot",
    actorId: "test-owner",
    revision: 1,
    prompt: "Use the supplied tool when asked, then answer.",
    model: {
      primary: { provider: "fixture", model: "unavailable" },
      fallbacks: [{ provider: "fixture", model: "available" }],
    },
    tools: useTool
      ? [
          {
            name: "echo_value",
            description: "Echo one value",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ]
      : [],
  });
  await client.bind(binding("tool-session", "tool-run", true));
  const frames = [];
  const controller = new AbortController();
  const stream = client.follow("tool-session", controller.signal);
  const reading = (async () => {
    try {
      for await (const frame of stream) frames.push(frame);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  await client.prompt({
    sessionId: "tool-session",
    requestId: "command-once",
    mode: "queue",
    content: [{ type: "text", text: "Call echo_value then answer." }],
  });
  const finished = await client.wait("tool-session", { timeoutMs: 20_000 });
  assert.equal(finished.reason, "idle", JSON.stringify(finished));
  const page = await client.events("tool-session");
  assert.equal(tools.length, 1, JSON.stringify({ logs, page, requests }));
  assert.equal(tools[0].binding.runId, "tool-run");
  assert.equal(tools[0].args.value, "once");
  assert.ok(requests.some((x) => x.model === "unavailable"));
  assert.ok(requests.filter((x) => x.model === "available").length >= 2);
  assert.ok(page.records.some((x) => x.event?.type === "assistant/attempt"));
  assert.ok(
    page.records.some(
      (x) =>
        x.event?.type === "plugin:chisabot/model-route" &&
        x.event.data.model === "available",
    ),
  );
  await client.prompt({
    sessionId: "tool-session",
    requestId: "command-once",
    mode: "queue",
    content: [{ type: "text", text: "Call echo_value then answer." }],
  });
  assert.equal(tools.length, 1);
  controller.abort();
  await reading;
  assert.ok(frames.some((x) => x.type === "snapshot"));
  assert.ok(frames.some((x) => JSON.stringify(x).includes("assistant-stream")));

  await client.bind(binding("slow-session", "slow-run"));
  await client.prompt({
    sessionId: "slow-session",
    requestId: "slow-command",
    mode: "queue",
    content: [{ type: "text", text: "keep-running" }],
  });
  for (
    let n = 0;
    n < 100 &&
    !requests.some(
      (x) =>
        JSON.stringify(x.messages).includes("keep-running") &&
        x.model === "available",
    );
    n++
  )
    await delay(50);
  await client.bind(binding("parallel-session", "parallel-run"));
  await client.prompt({
    sessionId: "parallel-session",
    requestId: "parallel-command",
    mode: "queue",
    content: [{ type: "text", text: "Finish." }],
  });
  await client.stop("slow-session", "slow-run");
  assert.equal(
    (await client.wait("slow-session", { timeoutMs: 10_000 })).reason,
    "idle",
  );
  assert.equal(
    (await client.wait("parallel-session", { timeoutMs: 10_000 })).reason,
    "idle",
  );
  assert.equal((await client.health()).ok, true);
  const before = (await client.events("tool-session")).records.length;
  await stopHost();
  await boot();
  await client.bind(binding("tool-session", "resumed-run", true));
  assert.ok((await client.events("tool-session")).records.length >= before);
  assert.equal(tools.length, 1);

  // A prompt between the compaction pressure threshold (80%) and its actual 32k window
  // may continue normally. Merely allocating a new product run must not count as a model
  // switch, which has a stricter preflight and cannot compact this short retained history.
  const continuationBinding = (runId) => ({
    ...binding("continuation-session", runId),
    prompt: "P".repeat(105000),
    connection: {
      api: "openai-completions",
      baseURL: `${upstreamUrl}/v1`,
      apiKey: "isolated-key",
      models: [
        {
          id: "available",
          contextWindow: 32000,
          maxTokens: 1024,
          input: ["text"],
        },
      ],
    },
    model: {
      primary: { provider: "configured", model: "available", maxTokens: 1024 },
      contextWindow: 32000,
    },
  });
  const continuationRequests = requests.length;
  for (let turn = 1; turn <= 3; turn++) {
    if (turn === 3) {
      await stopHost();
      await boot();
    }
    const runId = `continuation-run-${turn}`;
    await client.bind(continuationBinding(runId));
    await client.prompt({
      sessionId: "continuation-session",
      requestId: `continuation-command-${turn}`,
      mode: "queue",
      content: [{ type: "text", text: `Continue ${turn}.` }],
    });
    assert.equal(
      (await client.wait("continuation-session", { timeoutMs: 10_000 })).reason,
      "idle",
    );
    const events = (await client.events("continuation-session")).records.map(
      (record) => record.event,
    );
    assert.equal(
      events.filter((event) => event.type === "assistant/message").length,
      turn,
      JSON.stringify(events.at(-1)),
    );
    assert.equal(
      events.filter((event) => event.type === "model/selection").length,
      1,
      "unchanged model retains its selection across runs and Host restarts",
    );
    await client.release("continuation-session", runId);
  }
  assert.equal(
    requests.length - continuationRequests,
    3,
    "one actual model request for each continuation",
  );
  assert.equal(
    requests.at(-1).messages.filter((message) => message.role === "assistant")
      .length,
    2,
  );
  const changed = continuationBinding("different-model");
  changed.connection.models.push({
    id: "unavailable",
    contextWindow: 32000,
    maxTokens: 1024,
    input: ["text"],
  });
  changed.model.primary.model = "unavailable";
  await client.bind(changed);
  await client.prompt({
    sessionId: "continuation-session",
    requestId: "changed-model-command",
    mode: "queue",
    content: [{ type: "text", text: "Continue after changing model." }],
  });
  await client.wait("continuation-session", { timeoutMs: 10_000 });
  const changedEvents = (
    await client.events("continuation-session")
  ).records.map((record) => record.event);
  assert.equal(
    changedEvents.filter((event) => event.type === "model/selection").length,
    2,
    "real model changes retain DSH model-switch semantics",
  );
  assert.match(
    JSON.stringify(changedEvents.at(-1)),
    /MODEL_SWITCH_COMPACTION_FAILED/,
  );
});
