import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

// A model that never stops calling the same tool (the 2026-11-09 "infinite loop" report shape).
test("real Host: a runaway tool loop is capped, repeats are detected, and the turn ends with an honest answer", {
  timeout: 180_000,
}, async (t) => {
  const executed = [];
  const requests = [];
  let callSeq = 0;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (request.url === "/execute") {
      executed.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: "no rows yet" }));
      return;
    }
    if (request.url === "/steer") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [] }));
      return;
    }
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "loop", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const lastTool = body.messages?.filter((x) => x.role === "tool").at(-1);
    const told = JSON.stringify(lastTool ?? "").includes("TOOL_LOOP_STOPPED");
    if (body.model === "obedient" && told) {
      emit({
        role: "assistant",
        content:
          "我查了两次都没有结果，ima 还没有连接，所以没法读到你的数据库。",
      });
      emit({}, "stop");
    } else {
      callSeq += 1;
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${callSeq}`,
            type: "function",
            function: {
              name: "ima_search",
              arguments: '{"query":"我的数据库"}',
            },
          },
        ],
      });
      emit({}, "tool_calls");
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
  const home = await mkdtemp(join(root, "tool-loop-"));
  const model = (id) => ({
    id,
    contextWindow: 32000,
    maxTokens: 1024,
    input: ["text"],
  });
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "test-owner",
      port: 0,
      gatewayUrl: upstreamUrl,
      gatewayTokenEnv: "CHISABOT_TEST_TOOL_TOKEN",
      toolLoop: { maxCalls: 10, maxRepeats: 3, grace: 2 },
      providers: {
        fixture: {
          api: "openai-completions",
          baseURL: `${upstreamUrl}/v1`,
          apiKeyEnv: "CHISABOT_TEST_MODEL_KEY",
          models: [model("stubborn"), model("obedient")],
        },
      },
    }),
  );
  const child = spawn(process.execPath, ["src/start.mjs"], {
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
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  for (let n = 0; n < 600 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (child.exitCode !== null) throw new Error(`Host exited: ${logs}`);
    await delay(100);
  }
  assert.match(logs, /chisabot-runtime-ready/, logs);
  const { endpoint } = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
  const client = await DshHostClient.connect(endpoint);
  t.after(async () => {
    await client.close();
    if (child.exitCode === null) {
      const exiting = once(child, "exit");
      child.kill("SIGTERM");
      await exiting;
    }
  });
  const run = async (sessionId, modelId) => {
    executed.length = 0;
    requests.length = 0;
    await client.bind({
      sessionId,
      runId: `${sessionId}-run`,
      threadId: `thread-${sessionId}`,
      botId: "bot",
      actorId: "test-owner",
      revision: 1,
      prompt: "Use tools when needed.",
      model: { primary: { provider: "fixture", model: modelId } },
      tools: [
        {
          name: "ima_search",
          description: "Search the ima knowledge base",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });
    await client.prompt({
      sessionId,
      requestId: `${sessionId}-command`,
      mode: "queue",
      content: [{ type: "text", text: "看看我的ima数据库" }],
    });
    const finished = await client.wait(sessionId, { timeoutMs: 30_000 });
    assert.equal(finished.reason, "idle", JSON.stringify({ finished, logs }));
    return (await client.events(sessionId)).records.map(
      (record) => record.event,
    );
  };

  // The model ignores the stop notice: the third identical call is refused, two more are
  // refused, and the next one ends the turn with a plain account for the person.
  const stubborn = await run("stubborn-session", "stubborn");
  assert.equal(executed.length, 2, "identical calls run maxRepeats-1 times");
  assert.equal(
    requests.length,
    6,
    "bounded: 2 executed, 3 refused, 1 concluded",
  );
  const stop = stubborn.filter(
    (event) => event.type === "plugin:chisabot/loop-stop",
  );
  assert.equal(stop.length, 1);
  assert.match(stop[0].data.text, /ima_search/);
  assert.match(stop[0].data.text, /没有继续空转/);
  const refused = stubborn.filter(
    (event) =>
      event.type === "tool/result" &&
      JSON.stringify(event.data).includes("TOOL_LOOP_STOPPED"),
  );
  assert.equal(refused.length, 3);
  const end = stubborn.findLast((event) => event.type === "turn/end");
  assert.ok(end, "the turn closed");
  assert.notEqual(end.data.reason?.kind, "error", JSON.stringify(end.data));
  assert.equal(
    stubborn.filter(
      (event) =>
        event.type === "user/message" &&
        JSON.stringify(event).includes("你刚才说要先查"),
    ).length,
    0,
    "the action nudge does not restart a stopped loop",
  );

  // A model that listens: one notice is enough and its own honest answer closes the turn.
  const obedient = await run("obedient-session", "obedient");
  assert.equal(executed.length, 2);
  assert.equal(requests.length, 4);
  assert.equal(
    obedient.filter((event) => event.type === "plugin:chisabot/loop-stop")
      .length,
    0,
  );
  const answer = obedient.findLast(
    (event) => event.type === "assistant/message",
  );
  assert.match(JSON.stringify(answer.data.message.content), /ima 还没有连接/);
});
