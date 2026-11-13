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

test("real Host: silent requests wait for the answer or user stop, not an automatic fallback", {
  timeout: 180_000,
}, async (t) => {
  const requests = [];
  const closed = new Set();
  const timers = new Set();
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { model } = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(model);
    response.on("close", () => closed.add(model));
    if (model === "stop") return;
    if (model === "invalid") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Invalid fixture key" } }),
      );
      return;
    }
    const reply = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "Long wait completed." }, null],
        [{}, "stop"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    };
    // Opt-in wall-clock regression reproduces the screenshot's old 120-second cutoff.
    const wait =
      model === "long" && process.env.CHISABOT_DSH_LONG_WAIT === "1"
        ? 125_000
        : 500;
    const timer = setTimeout(reply, wait);
    timers.add(timer);
    response.on("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "user-wait-"));
  let host;
  let client;
  t.after(async () => {
    await client?.close();
    if (host && host.exitCode === null && host.signalCode === null) {
      const exit = once(host, "exit");
      host.kill();
      await exit;
    }
    assert.equal(await realpath(home), home);
    await rm(home, { recursive: true });
  });
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "wait-owner",
      port: 0,
      providers: {},
    }),
  );
  host = spawn(process.execPath, ["src/start.mjs"], {
    windowsHide: true,
    env: { ...process.env, CHISABOT_DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  host.stdout.on("data", (data) => {
    logs += data;
  });
  host.stderr.on("data", (data) => {
    logs += data;
  });
  for (let n = 0; n < 1200 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (host.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  client = await DshHostClient.connect(
    JSON.parse(await readFile(join(home, "connection.json"), "utf8")).endpoint,
  );
  async function start(model, fallback = false) {
    await client.bind({
      sessionId: model,
      threadId: model,
      runId: model,
      actorId: "wait-owner",
      botId: "bot",
      revision: 1,
      prompt: "Answer briefly.",
      tools: [],
      model: {
        primary: { provider: "fixture", model },
        ...(fallback
          ? { fallbacks: [{ provider: "fixture", model: "backup" }] }
          : {}),
      },
      connection: {
        api: "openai-completions",
        baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: "fixture-not-a-real-key",
        models: [model, "backup"].map((id) => ({
          id,
          contextWindow: 32000,
          maxTokens: 1024,
          input: ["text"],
        })),
      },
    });
    await client.prompt({
      sessionId: model,
      requestId: model,
      mode: "queue",
      content: [{ type: "text", text: "hi" }],
    });
  }
  const records = async (id) =>
    JSON.stringify((await client.events(id)).records);
  await t.test(
    "no first-output or HTTP deadline: delayed primary answers without retry",
    async () => {
      await start("long");
      assert.equal(
        (await client.wait("long", { timeoutMs: 140_000 })).reason,
        "idle",
      );
      assert.match(await records("long"), /Long wait completed/);
      assert.doesNotMatch(await records("long"), /TIMEOUT|Request timed out/);
      assert.equal(requests.filter((model) => model === "long").length, 1);
    },
  );
  await t.test("a fallback does not turn silence into an error", async () => {
    await start("primary", true);
    assert.equal(
      (await client.wait("primary", { timeoutMs: 10_000 })).reason,
      "idle",
    );
    assert.match(await records("primary"), /Long wait completed/);
    assert.ok(!requests.includes("backup"));
  });
  await t.test(
    "user stop aborts the upstream connection without timeout or fallback",
    async () => {
      await start("stop", true);
      for (let n = 0; n < 100 && !requests.includes("stop"); n++)
        await delay(20);
      assert.ok(requests.includes("stop"));
      await client.stop("stop", "stop");
      assert.equal(
        (await client.wait("stop", { timeoutMs: 10_000 })).reason,
        "idle",
      );
      for (let n = 0; n < 100 && !closed.has("stop"); n++) await delay(20);
      assert.ok(closed.has("stop"));
      assert.doesNotMatch(
        await records("stop"),
        /TIMEOUT|MODEL_FIRST_OUTPUT_TIMEOUT/,
      );
      assert.ok(!requests.includes("backup"));
    },
  );
  await t.test("explicit upstream failure still ends the turn", async () => {
    await start("invalid");
    assert.equal(
      (await client.wait("invalid", { timeoutMs: 10_000 })).reason,
      "idle",
    );
    assert.match(await records("invalid"), /Invalid fixture key/);
  });
});
