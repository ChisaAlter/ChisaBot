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
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";
import {
  detectLeakedToolCall,
  LEAKED_TOOL_CALL_ABORT_MESSAGE,
} from "../src/leaked-tool-call.mjs";

const TOOLS = [{ name: "computer_click" }, { name: "web_search" }];

test("detectLeakedToolCall catches common inference gateway markers followed by a registered tool", () => {
  const cases = [
    '<tool_call>\n{"name": "computer_click", "arguments": {"ref": "e1"}}</tool_call>',
    "<function=computer_click>{}</function>",
    '<|python_tag|>web_search(query="test")',
    '[TOOL_CALLS] [{"name": "web_search", "arguments": {}}]',
    "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>computer_click\n{}",
    '<invoke name="computer_click"></invoke>',
    "<tool_use><name>web_search</name></tool_use>",
  ];

  for (const text of cases) {
    const hit = detectLeakedToolCall(text, TOOLS);
    assert.ok(hit, `expected leak match for: ${text}`);
  }
});

test("detectLeakedToolCall ignores Q&A explanations and unregistered tool names", () => {
  assert.equal(
    detectLeakedToolCall(
      "某些推理框架会输出 <tool_call> 标签来表示调用，这和普通函数不同。",
      TOOLS,
    ),
    null,
  );
  assert.equal(
    detectLeakedToolCall(
      "这里演示 <tool_call> 的用法，另外你也可以用 computer_click 来点击。",
      TOOLS,
    ),
    null,
  );
  assert.equal(
    detectLeakedToolCall(
      '<tool_call>{"name": "computer_click_extra"}</tool_call>',
      TOOLS,
    ),
    null,
  );
  assert.equal(
    detectLeakedToolCall(
      '<tool_call>{"name": "unknown_tool"}</tool_call>',
      TOOLS,
    ),
    null,
  );
  assert.equal(
    detectLeakedToolCall(
      '<tool_call>{"name": "computer_click"}</tool_call>',
      [],
    ),
    null,
  );
});

test("real Host: 1st leaked tool call steers model to use tool API; 2nd consecutive leak aborts cleanly", {
  timeout: 120_000,
}, async (t) => {
  let mode = "recover";
  let modelStep = 0;
  let toolExecuted = 0;

  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};

    if (request.url === "/execute") {
      toolExecuted += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: "ok" }));
      return;
    }

    modelStep += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "recover") {
      if (modelStep === 1) {
        for (const [delta, finish_reason] of [
          [
            {
              role: "assistant",
              content:
                '<tool_call>{"name": "web_search", "arguments": {"q": "a"}}</tool_call>',
            },
            null,
          ],
          [{}, "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: "leak-1",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`,
          );
        }
      } else if (modelStep === 2) {
        for (const [delta, finish_reason] of [
          [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  index: 0,
                  id: "call_ok",
                  type: "function",
                  function: { name: "web_search", arguments: '{"q":"a"}' },
                },
              ],
            },
            null,
          ],
          [{}, "tool_calls"],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: "tool-1",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`,
          );
        }
      } else {
        for (const [delta, finish_reason] of [
          [{ role: "assistant", content: "检索完成。" }, null],
          [{}, "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: "done-1",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`,
          );
        }
      }
    } else {
      for (const [delta, finish_reason] of [
        [
          {
            role: "assistant",
            content: "<function=web_search>{}</function>",
          },
          null,
        ],
        [{}, "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: "leak-repeat",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      }
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "leaked-tool-"));
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
      ownerUserId: "leak-owner",
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
  for (let n = 0; n < 600; n += 1) {
    if (logs.includes("chisabot-runtime-ready")) break;
    if (host.exitCode !== null) throw new Error(`Host exited: ${logs}`);
    await delay(50);
  }
  const { endpoint } = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
  client = await DshHostClient.connect(endpoint);

  const makeBinding = (sessionId, runId) => ({
    sessionId,
    runId,
    threadId: `thread-${sessionId}`,
    botId: "bot",
    actorId: "leak-owner",
    revision: 1,
    prompt: "You are a helpful test assistant.",
    model: { primary: { provider: "fixture", model: "available" } },
    tools: [
      {
        name: "web_search",
        description: "search",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  });

  // Case 1: 1st leak steers model, then model invokes real tool.
  await client.bind(makeBinding("leak-recover-session", "run-1"));
  await client.prompt({
    sessionId: "leak-recover-session",
    requestId: "req-1",
    mode: "queue",
    content: [{ type: "text", text: "搜一下" }],
  });
  for (let i = 0; i < 60; i += 1) {
    const page = await client.events("leak-recover-session");
    if (page.records.some((r) => r.event?.type === "turn/end")) break;
    await delay(50);
  }
  assert.equal(toolExecuted, 1);
  const recoverPage = await client.events("leak-recover-session");
  assert.ok(
    recoverPage.records.some(
      (r) =>
        r.event?.type === "plugin:chisabot/leaked-tool-call" &&
        r.event?.data?.action === "steer",
    ),
  );

  // Case 2: 2nd consecutive leak aborts cleanly with Chinese error notice.
  mode = "always_leak";
  modelStep = 0;
  await client.bind(makeBinding("leak-abort-session", "run-2"));
  await client.prompt({
    sessionId: "leak-abort-session",
    requestId: "req-2",
    mode: "queue",
    content: [{ type: "text", text: "再来一次" }],
  });
  let abortPage;
  for (let i = 0; i < 60; i += 1) {
    abortPage = await client.events("leak-abort-session");
    if (abortPage.records.some((r) => r.event?.type === "turn/end")) break;
    await delay(50);
  }
  const loopStop = abortPage.records.find(
    (r) => r.event?.type === "plugin:chisabot/loop-stop",
  );
  assert.ok(loopStop, JSON.stringify(abortPage.records));
  assert.equal(loopStop.event.data.text, LEAKED_TOOL_CALL_ABORT_MESSAGE);
  assert.ok(
    abortPage.records.some(
      (r) =>
        r.event?.type === "plugin:chisabot/leaked-tool-call" &&
        r.event?.data?.action === "abort",
    ),
  );
});
