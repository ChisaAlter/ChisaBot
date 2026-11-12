import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

/**
 * QA511 P2: the production server path always binds with `connection`, which used to default
 * the provider request timeout to 90s — shorter than the single-model first-output deadline
 * (30s×4=120s). That path must end on the Chinese deadline copy, not "Request timed out."
 * after a same-model retry.
 */
test("binding.connection: single silent model ends on the first-output deadline, not a request-timeout retry", {
  timeout: 60_000,
}, async (t) => {
  const requests = [];
  const upstream = createServer(async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).model);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "conn-timeout-"));
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "conn-timeout-owner",
      port: 0,
      providers: {},
    }),
  );
  const host = spawn(process.execPath, ["src/start.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, CHISABOT_DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  host.stdout.on("data", (c) => (logs += c));
  host.stderr.on("data", (c) => (logs += c));
  let client;
  t.after(async () => {
    await client?.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exit = once(host, "exit");
      host.kill();
      await exit;
    }
  });
  for (let n = 0; n < 1200 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (host.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  client = await DshHostClient.connect(
    JSON.parse(await readFile(join(home, "connection.json"), "utf8")).endpoint,
  );

  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const firstOutputMs = 250;
  const started = Date.now();
  await client.bind({
    sessionId: "alone-conn",
    threadId: "alone-conn",
    runId: "alone-conn-1",
    actorId: "conn-timeout-owner",
    botId: "bot",
    revision: 1,
    prompt: "Answer briefly.",
    tools: [],
    model: {
      primary: { provider: "x", model: "slow_alone" },
      firstOutputMs,
    },
    // No timeoutMs: exercises the default that must outlast firstOutputMs×4.
    connection: {
      api: "openai-completions",
      baseURL,
      apiKey: "isolated-fixture",
      models: [
        {
          id: "slow_alone",
          contextWindow: 32000,
          maxTokens: 1024,
          input: ["text"],
        },
      ],
    },
  });
  await client.prompt({
    sessionId: "alone-conn",
    requestId: "alone-conn-1",
    mode: "queue",
    content: [{ type: "text", text: "hi" }],
  });
  assert.equal(
    (await client.wait("alone-conn", { timeoutMs: 20_000 })).reason,
    "idle",
  );
  const ms = Date.now() - started;
  const text = JSON.stringify((await client.events("alone-conn")).records);
  assert.deepEqual(requests, ["slow_alone"]);
  // Single model: firstOutputMs × 4 ≈ 1000ms. Must not double via same-model retry.
  assert.ok(ms >= 900, `too fast: ${ms}ms`);
  assert.ok(ms < 2500, `too slow (likely request-timeout retry): ${ms}ms`);
  assert.match(text, /共等了约 1 秒仍没有任何输出。这一轮已结束/);
  assert.doesNotMatch(text, /Request timed out/i);
});

test("binding.connection: an explicit short request timeout on the last model does not same-model-retry", {
  timeout: 30_000,
}, async (t) => {
  const requests = [];
  const upstream = createServer(async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).model);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "conn-short-to-"));
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({ ownerUserId: "conn-short-owner", port: 0, providers: {} }),
  );
  const host = spawn(process.execPath, ["src/start.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, CHISABOT_DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  host.stdout.on("data", (c) => (logs += c));
  host.stderr.on("data", (c) => (logs += c));
  let client;
  t.after(async () => {
    await client?.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exit = once(host, "exit");
      host.kill();
      await exit;
    }
  });
  for (let n = 0; n < 1200 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (host.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  client = await DshHostClient.connect(
    JSON.parse(await readFile(join(home, "connection.json"), "utf8")).endpoint,
  );

  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  // firstOutput wait (4×400=1600) is longer than the 300ms request timeout, so the SDK
  // times out first. Without the QA511 fix that used to same-model-retry (~600ms+).
  const started = Date.now();
  await client.bind({
    sessionId: "short-to",
    threadId: "short-to",
    runId: "short-to-1",
    actorId: "conn-short-owner",
    botId: "bot",
    revision: 1,
    prompt: "Answer briefly.",
    tools: [],
    model: {
      primary: { provider: "x", model: "slow_short" },
      firstOutputMs: 400,
    },
    connection: {
      api: "openai-completions",
      baseURL,
      apiKey: "isolated-fixture",
      timeoutMs: 300,
      models: [
        {
          id: "slow_short",
          contextWindow: 32000,
          maxTokens: 1024,
          input: ["text"],
        },
      ],
    },
  });
  await client.prompt({
    sessionId: "short-to",
    requestId: "short-to-1",
    mode: "queue",
    content: [{ type: "text", text: "hi" }],
  });
  await client.wait("short-to", { timeoutMs: 10_000 });
  const ms = Date.now() - started;
  assert.deepEqual(requests, ["slow_short"]);
  assert.ok(ms < 900, `same-model retry suspected: ${ms}ms`);
});
