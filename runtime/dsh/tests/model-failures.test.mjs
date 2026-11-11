import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

const LEAKY_400 = `Invalid input: messages[370].content SECRET-sk-qa510 Authorization: Bearer sk-live0123456789abcdefABCDEF via https://ops:pw0rdLEAK@10.1.2.3:8080/v1 ${"PADDING".repeat(400)}`;
const LEAKS = [
  "sk-qa510",
  "sk-live0123456789abcdefABCDEF",
  "pw0rdLEAK",
  "10.1.2.3",
  "PADDING".repeat(40),
];
async function filesUnder(dir) {
  let text = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += await filesUnder(path);
    else if (entry.isFile())
      text += await readFile(path, "utf8").catch(() => "");
  }
  return text;
}

test("real Host: invalid auth, stale catalog, missing model, bounded exhaustion, first-output timeout, rebinding and the action nudge", {
  timeout: 180_000,
}, async (t) => {
  const requests = [];
  const bodies = [];
  const NUDGE = "你刚才说要先查/先做";
  // Scripted replies: a promise to act, a report of work done, a question and a refusal.
  const scripted = {
    promiser: "我先查一下最新的价格。",
    reporter: "我已经查好了，价格是 42 元。",
    asker: "要我先查一下最新的价格吗？",
    refuser: "我不会去查这个。",
  };
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body.model);
    bodies.push(body);
    // No first byte; the owned client aborts the connection.
    if (body.model.startsWith("slow")) return;
    const status = {
      bad_request: 400,
      invalid: 401,
      missing: 404,
      missing_bound: 404,
      retired: 410,
      limited: 429,
      backup_limited: 429,
    }[body.model];
    if (body.model === "bad_request_leaky") {
      // QA510 P3: an upstream 400 that echoes request content and credentials, and is long.
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: LEAKY_400, type: "invalid_request_error" },
        }),
      );
      return;
    }
    if (status) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: `${body.model} HTTP ${status}`,
            type: status === 401 ? "authentication_error" : "api_error",
          },
        }),
      );
      return;
    }
    const nudged = JSON.stringify(body.messages.at(-1)).includes(NUDGE);
    const content =
      scripted[body.model] && !nudged
        ? scripted[body.model]
        : "verified answer";
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content }, null],
      [{}, "stop"],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "model-failures-"));
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const models = [
    "available",
    "available_b",
    "bad_request",
    ...Object.keys(scripted),
    "invalid",
    "missing",
    "missing_bound",
    "retired",
    "limited",
    "backup_limited",
    "slow",
    "slow_bound",
    "slow_dead",
    "slow_stop",
    "slow_both",
    "slow_both_b",
    "slow_alone",
    "bad_request_leaky",
  ].map((id) => ({
    id,
    contextWindow: 32000,
    maxTokens: 1024,
    input: ["text"],
  }));
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "model-test-owner",
      port: 0,
      providers: {
        fixture: {
          api: "openai-completions",
          baseURL,
          apiKeyEnv: "CHISABOT_FAILURE_FIXTURE_KEY",
          models,
        },
      },
    }),
  );
  const host = spawn(process.execPath, ["src/start.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      CHISABOT_DSH_HOME: home,
      CHISABOT_FAILURE_FIXTURE_KEY: "isolated-fixture",
      // Short enough for the half-open probe below; the other cases use distinct model ids.
      CHISABOT_MODEL_BREAKER_COOLDOWN_S: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "",
    client;
  host.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  host.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  t.after(async () => {
    await client?.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exit = once(host, "exit");
      host.kill();
      await exit;
    }
  });
  for (let n = 0; n < 1200 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (host.exitCode !== null) throw Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  const { endpoint } = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
  client = await DshHostClient.connect(endpoint);
  const tool = (name) => ({
    name,
    description: `Fixture tool ${name}.`,
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    },
  });
  const toolNames = (body) =>
    (body.tools ?? []).map((entry) => entry.function?.name ?? entry.name);
  async function run(
    id,
    primary,
    fallback,
    firstOutputMs = 0,
    { tools = [], prompt = "Answer briefly.", revision = 1 } = {},
  ) {
    const start = requests.length;
    await client.bind({
      sessionId: id,
      threadId: id,
      runId: `${id}-${revision}`,
      actorId: "model-test-owner",
      botId: "bot",
      revision,
      prompt,
      tools,
      model: {
        primary: { provider: "fixture", model: primary },
        ...(fallback
          ? { fallbacks: [{ provider: "fixture", model: fallback }] }
          : {}),
        firstOutputMs,
      },
    });
    await client.prompt({
      sessionId: id,
      requestId: `${id}-${revision}`,
      mode: "queue",
      content: [{ type: "text", text: "Answer now." }],
    });
    assert.equal((await client.wait(id, { timeoutMs: 20_000 })).reason, "idle");
    const events = (await client.events(id)).records.map((row) => row.event);
    return {
      events,
      calls: requests.slice(start),
      bodies: bodies.slice(start),
      text: JSON.stringify(events),
    };
  }
  /** Every request a fallback path sends still carries the bound tools and system prompt. */
  function assertBound(result, names, prompt) {
    assert.ok(result.bodies.length > 0);
    for (const body of result.bodies) {
      assert.deepEqual(toolNames(body), names, `tools on ${body.model}`);
      assert.match(JSON.stringify(body.messages), new RegExp(prompt));
    }
  }
  await t.test(
    "invalid shared credential stops without trying another model",
    async () => {
      const result = await run("auth", "invalid", "available");
      assert.deepEqual(result.calls, ["invalid"]);
      assert.match(result.text, /主模型「invalid」请求失败/);
      assert.doesNotMatch(result.text, /verified answer/);
    },
  );
  for (const primary of ["missing", "retired"])
    await t.test(
      `HTTP ${primary} advances to a configured backup`,
      async () => {
        const result = await run(primary, primary, "available");
        assert.deepEqual(result.calls, [primary, "available"]);
        assert.match(result.text, /UNKNOWN_MODEL/);
        assert.match(result.text, /verified answer/);
      },
    );
  await t.test("stale catalog entry is skipped before transport", async () => {
    const result = await run("stale", "not_in_catalog", "available");
    assert.deepEqual(result.calls, ["available"]);
    assert.match(result.text, /not_in_catalog/);
    assert.match(result.text, /verified answer/);
  });
  await t.test(
    "429 exhaustion is bounded and identifies the failing backup",
    async () => {
      const result = await run("exhausted", "limited", "backup_limited");
      assert.deepEqual(result.calls, ["limited", "backup_limited"]);
      assert.match(result.text, /备用模型「backup_limited」请求失败/);
      assert.doesNotMatch(result.text, /verified answer/);
    },
  );
  await t.test(
    "fully stale catalog identifies the last candidate without transport",
    async () => {
      const result = await run(
        "stale-exhausted",
        "not_in_catalog",
        "also_not_in_catalog",
      );
      assert.deepEqual(result.calls, []);
      assert.match(result.text, /备用模型「also_not_in_catalog」请求失败/);
      assert.doesNotMatch(result.text, /verified answer/);
    },
  );
  await t.test(
    "first-output timeout switches straight to the backup, without retrying the same model",
    async () => {
      const result = await run("timeout", "slow", "available", 200);
      assert.deepEqual(result.calls, ["slow", "available"]);
      assert.match(result.text, /TIMEOUT/);
      assert.match(result.text, /verified answer/);
    },
  );
  await t.test(
    "tools and prompt stay bound across every fallback path",
    async () => {
      const bound = { tools: [tool("lookup")], prompt: "Bound prompt A7." };
      const missing = await run(
        "bound-missing",
        "missing_bound",
        "available",
        0,
        bound,
      );
      assert.deepEqual(missing.calls, ["missing_bound", "available"]);
      assertBound(missing, ["lookup"], "Bound prompt A7");
      const stale = await run(
        "bound-stale",
        "not_in_catalog",
        "available",
        0,
        bound,
      );
      assert.deepEqual(stale.calls, ["available"]);
      assertBound(stale, ["lookup"], "Bound prompt A7");
      const slow = await run(
        "bound-timeout",
        "slow_bound",
        "available",
        200,
        bound,
      );
      assert.deepEqual(slow.calls, ["slow_bound", "available"]);
      assertBound(slow, ["lookup"], "Bound prompt A7");
      assert.match(slow.text, /verified answer/);
    },
  );
  await t.test(
    "HTTP 400 advances to the backup with the same tools and prompt",
    async () => {
      const result = await run("bad-request", "bad_request", "available", 0, {
        tools: [tool("lookup")],
        prompt: "Bound prompt A7.",
      });
      assert.deepEqual(result.calls, ["bad_request", "available"]);
      assertBound(result, ["lookup"], "Bound prompt A7");
      assert.match(result.text, /INVALID_REQUEST/);
      assert.match(result.text, /verified answer/);
      // The breaker keeps the rejecting primary out of the next turn.
      const next = await run("bad-request-2", "bad_request", "available", 0, {
        tools: [tool("lookup")],
        prompt: "Bound prompt A7.",
      });
      assert.deepEqual(next.calls, ["available"]);
      assertBound(next, ["lookup"], "Bound prompt A7");
    },
  );
  await t.test(
    "an upstream 400 body is redacted and capped before the session stores it",
    async () => {
      const result = await run("leaky-400", "bad_request_leaky", "available");
      assert.deepEqual(result.calls, ["bad_request_leaky", "available"]);
      assert.match(result.text, /INVALID_REQUEST/);
      assert.match(result.text, /verified answer/);
      const stored = `${result.text}\n${await filesUnder(home)}\n${logs}`;
      for (const leak of LEAKS)
        assert.ok(!stored.includes(leak), `stored ${leak.slice(0, 24)}`);
    },
  );
  await t.test(
    "primary and backup both silent: the turn ends with a clear error instead of hanging",
    async () => {
      const started = Date.now();
      const result = await run("both-dead", "slow_both", "slow_both_b", 200);
      assert.deepEqual(result.calls, ["slow_both", "slow_both_b"]);
      assert.match(result.text, /备用模型「slow_both_b」请求失败/);
      // The sentence names the real wait: both deadlines (0.2 s + 0.2 s), and the per-model cap.
      assert.match(
        result.text,
        /共等了约 0\.4 秒仍没有任何输出（主模型和备用模型都没有回应，每个模型最多等 0\.2 秒）。这一轮已结束/,
      );
      assert.ok(Date.now() - started < 10_000);
      // Both breakers are open now: the next turn still tries (primary first) and still ends.
      const next = await run("both-dead-2", "slow_both", "slow_both_b", 200);
      assert.ok(next.calls.length >= 1);
      assert.match(next.text, /这一轮已结束/);
    },
  );
  await t.test(
    "a single silent model ends the turn after its longer deadline",
    async () => {
      const started = Date.now();
      const result = await run("alone-dead", "slow_alone", undefined, 200);
      assert.deepEqual(result.calls, ["slow_alone"]);
      assert.match(result.text, /共等了约 0\.8 秒仍没有任何输出。这一轮已结束/);
      assert.ok(Date.now() - started >= 700);
    },
  );
  await t.test(
    "a dead primary is skipped while its breaker cools, then probed once",
    async () => {
      const bound = { tools: [tool("lookup")], prompt: "Breaker prompt B3." };
      const first = await run(
        "breaker-1",
        "slow_dead",
        "available",
        200,
        bound,
      );
      assert.deepEqual(first.calls, ["slow_dead", "available"]);
      const second = await run(
        "breaker-2",
        "slow_dead",
        "available",
        200,
        bound,
      );
      assert.deepEqual(second.calls, ["available"]);
      assert.match(second.text, /MODEL_COOLING/);
      assertBound(second, ["lookup"], "Breaker prompt B3");
      assert.match(second.text, /verified answer/);
      await delay(3_200);
      const probe = await run(
        "breaker-3",
        "slow_dead",
        "available",
        200,
        bound,
      );
      assert.deepEqual(probe.calls, ["slow_dead", "available"]);
      // The failed probe reopens it for longer.
      const after = await run(
        "breaker-4",
        "slow_dead",
        "available",
        200,
        bound,
      );
      assert.deepEqual(after.calls, ["available"]);
    },
  );
  await t.test(
    "a model switch rebinds the new tools and prompt, dropping the old ones",
    async () => {
      const first = await run("rebind", "available", undefined, 0, {
        tools: [tool("lookup")],
        prompt: "Old prompt Q1.",
      });
      assertBound(first, ["lookup"], "Old prompt Q1");
      const second = await run("rebind", "available_b", undefined, 0, {
        tools: [tool("lookup_two")],
        prompt: "New prompt Q2.",
        revision: 2,
      });
      assert.deepEqual(second.calls, ["available_b"]);
      assertBound(second, ["lookup_two"], "New prompt Q2");
      assert.doesNotMatch(JSON.stringify(second.bodies), /Old prompt Q1/);
    },
  );
  await t.test(
    "a promise to act with tools and no tool call is nudged exactly once",
    async () => {
      const result = await run("nudge", "promiser", undefined, 0, {
        tools: [tool("lookup")],
      });
      assert.deepEqual(result.calls, ["promiser", "promiser"]);
      assert.doesNotMatch(
        JSON.stringify(result.bodies[0].messages),
        new RegExp(NUDGE),
      );
      assert.match(
        JSON.stringify(result.bodies[1].messages.at(-1)),
        new RegExp(NUDGE),
      );
      assert.match(result.text, /verified answer/);
    },
  );
  for (const [id, model, tools] of [
    ["no-nudge-past", "reporter", [tool("lookup")]],
    ["no-nudge-question", "asker", [tool("lookup")]],
    ["no-nudge-negation", "refuser", [tool("lookup")]],
    ["no-nudge-no-tools", "promiser", []],
  ])
    await t.test(`no nudge: ${id}`, async () => {
      const result = await run(id, model, undefined, 0, { tools });
      assert.deepEqual(result.calls, [model]);
      assert.doesNotMatch(JSON.stringify(result.bodies), new RegExp(NUDGE));
    });
  await t.test(
    "Stop remains cancellation, not timeout or fallback",
    async () => {
      await client.bind({
        sessionId: "stop",
        threadId: "stop",
        runId: "stop",
        actorId: "model-test-owner",
        botId: "bot",
        revision: 1,
        prompt: "Answer.",
        tools: [],
        model: {
          primary: { provider: "fixture", model: "slow_stop" },
          fallbacks: [{ provider: "fixture", model: "available" }],
          firstOutputMs: 10000,
        },
      });
      const start = requests.length;
      await client.prompt({
        sessionId: "stop",
        requestId: "stop",
        mode: "queue",
        content: [{ type: "text", text: "Stop this." }],
      });
      for (let n = 0; n < 100 && requests.length === start; n++)
        await delay(20);
      await client.stop("stop", "stop");
      await client.wait("stop", { timeoutMs: 10000 });
      assert.deepEqual(requests.slice(start), ["slow_stop"]);
      assert.doesNotMatch(
        JSON.stringify((await client.events("stop")).records),
        /MODEL_FIRST_OUTPUT_TIMEOUT|TIMEOUT/,
      );
    },
  );
});
