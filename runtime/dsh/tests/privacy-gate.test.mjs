import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DshHostClient } from "../src/client.mjs";

const PRIVACY_GATE_MESSAGE =
  'privacy-gate: a content part of type "image_url" cannot be masked locally; extract it to text first (Settings -> Privacy masks text only). Nothing was sent.';

// Valid 1x1 PNG base64
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";

function bodyContainsImageUrl(body) {
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url" || part?.type === "image") return true;
    }
  }
  return false;
}

test("privacy-gate image refusal: skips backup loop, keeps primary breaker healthy, and unblocks follow-up text turns in the same session", {
  timeout: 120_000,
}, async (t) => {
  const requests = [];
  const bodies = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body.model);
    bodies.push(body);
    if (bodyContainsImageUrl(body)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: PRIVACY_GATE_MESSAGE,
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content: "verified text answer" }, null],
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
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  await mkdir(resolve(".runtime"), { recursive: true });
  const home = await mkdtemp(join(resolve(".runtime"), "privacy-gate-"));
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "privacy-test-owner",
      port: 0,
      providers: {
        fixture: {
          api: "openai-completions",
          baseURL,
          apiKeyEnv: "CHISABOT_PRIVACY_FIXTURE_KEY",
          models: ["vision_primary", "vision_backup"].map((id) => ({
            id,
            contextWindow: 32000,
            maxTokens: 1024,
            input: ["text", "image"],
          })),
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
      CHISABOT_PRIVACY_FIXTURE_KEY: "isolated-fixture",
      CHISABOT_MODEL_BREAKER_COOLDOWN_S: "60",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let client;
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
    await rm(home, { recursive: true, force: true });
  });

  for (let n = 0; n < 1200 && !logs.includes("chisabot-runtime-ready"); n++) {
    if (host.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  const { endpoint } = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
  client = await DshHostClient.connect(endpoint);

  const sessionId = "privacy-session";
  const bindTurn = (runId) =>
    client.bind({
      sessionId,
      threadId: "privacy-thread",
      runId,
      actorId: "privacy-test-owner",
      botId: "bot",
      revision: 1,
      prompt: "Answer clearly.",
      tools: [],
      model: {
        primary: { provider: "fixture", model: "vision_primary" },
        fallbacks: [{ provider: "fixture", model: "vision_backup" }],
        firstOutputMs: 0,
      },
    });

  // Turn 1: send an image -> gateway rejects with privacy-gate.
  // Must NOT try vision_backup on the same gateway, and must NOT trip vision_primary's breaker.
  await bindTurn("run-1");
  const after0 = (await client.events(sessionId)).cursor;
  await client.prompt({
    sessionId,
    requestId: "msg-1",
    mode: "queue",
    content: [
      { type: "text", text: "What is in this screenshot?" },
      { type: "image", mediaType: "image/png", data: PIXEL_PNG },
    ],
  });
  await client.wait(sessionId, { timeoutMs: 20_000, afterSeq: after0 });
  await client.release(sessionId, "run-1");
  assert.deepEqual(requests, ["vision_primary"]);
  const eventsAfterTurn1 = JSON.stringify(
    (await client.events(sessionId)).records,
  );
  assert.match(eventsAfterTurn1, /privacy-gate:/);

  // Turn 2: user sends plain text in the SAME session without clicking withdraw.
  // Primary model breaker is still closed (vision_primary is used, not MODEL_COOLING),
  // and the prior rejected image is replaced with a safe text placeholder so the turn succeeds!
  await bindTurn("run-2");
  const after1 = (await client.events(sessionId)).cursor;
  await client.prompt({
    sessionId,
    requestId: "msg-2",
    mode: "queue",
    content: [
      { type: "text", text: "Never mind the picture, answer in text." },
    ],
  });
  await client.wait(sessionId, { timeoutMs: 20_000, afterSeq: after1 });
  await client.release(sessionId, "run-2");
  assert.deepEqual(requests, ["vision_primary", "vision_primary"]);
  assert.equal(bodyContainsImageUrl(bodies[1]), false);
  const eventsAfterTurn2 = JSON.stringify(
    (await client.events(sessionId)).records,
  );
  assert.doesNotMatch(eventsAfterTurn2, /MODEL_COOLING/);
  assert.match(eventsAfterTurn2, /verified text answer/);

  // Turn 3: if the user explicitly sends a NEW image in the current turn, it is NOT silently swallowed;
  // the gateway still receives and rejects the new image honestly.
  await bindTurn("run-3");
  const after2 = (await client.events(sessionId)).cursor;
  await client.prompt({
    sessionId,
    requestId: "msg-3",
    mode: "queue",
    content: [
      { type: "text", text: "Trying another picture." },
      { type: "image", mediaType: "image/png", data: PIXEL_PNG },
    ],
  });
  await client.wait(sessionId, { timeoutMs: 20_000, afterSeq: after2 });
  await client.release(sessionId, "run-3");
  assert.deepEqual(requests, [
    "vision_primary",
    "vision_primary",
    "vision_primary",
  ]);
  assert.equal(bodyContainsImageUrl(bodies[2]), true);
});
