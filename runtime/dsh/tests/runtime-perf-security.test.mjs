import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Session } from "@deepseek-ai/dsh-session";
import { DshHostClient } from "../src/client.mjs";
import { ChisaModelRouter } from "../src/model-router.mjs";

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function startFixtureHost(t, envOverrides = {}) {
  const receivedAuth = [];
  const receivedMessages = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    receivedAuth.push(request.headers.authorization ?? "");
    receivedMessages.push(body.messages ?? []);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const reply = `ok:${receivedAuth.length}`;
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content: reply }, null],
      [{}, "stop"],
    ]) {
      response.write(
        `data: ${JSON.stringify({
          id: `fixture-${receivedAuth.length}`,
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
  const home = await mkdtemp(join(resolve(".runtime"), "perf-sec-"));
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  await writeFile(
    join(home, "chisabot.json"),
    JSON.stringify({
      ownerUserId: "perf-test-owner",
      port: 0,
      providers: {},
    }),
  );

  const host = spawn(process.execPath, ["src/start.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      CHISABOT_DSH_HOME: home,
      ...envOverrides,
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
  return { home, baseURL, client, receivedAuth, receivedMessages };
}

async function runTurn(client, { sessionId, threadId, runId, baseURL, apiKey, promptText }) {
  await client.bind({
    sessionId,
    threadId,
    runId,
    actorId: "perf-test-owner",
    botId: "bot",
    revision: 1,
    prompt: "Be concise.",
    tools: [],
    connection: {
      api: "openai-completions",
      baseURL,
      apiKey,
      models: [{ id: "m1", contextWindow: 32000, maxTokens: 512, input: ["text"] }],
    },
    model: {
      primary: { provider: "dynamic", model: "m1" },
      fallbacks: [],
      firstOutputMs: 0,
    },
  });
  const after = (await client.events(sessionId)).cursor;
  await client.prompt({
    sessionId,
    requestId: `req-${runId}`,
    mode: "queue",
    content: [{ type: "text", text: promptText }],
  });
  await client.wait(sessionId, { timeoutMs: 20_000, afterSeq: after });
  const receipt = await client.receipt(sessionId, runId, `req-${runId}`);
  assert.equal(receipt.accepted, true);
}

test(
  "DSH temporary credentials stay strictly in memory (zero disk writes), rotate cleanly, and reuse Provider Fiber across turns",
  { timeout: 120_000 },
  async (t) => {
    const { home, baseURL, client, receivedAuth } = await startFixtureHost(t);
    const sessionId = "fiber-reuse-session";
    const credsPath = join(home, ".credentials.yaml");
    const credsBefore = (await fileExists(credsPath))
      ? await readFile(credsPath, "utf8")
      : null;

    for (let turn = 1; turn <= 5; turn++) {
      const secret = `ephemeral-secret-${turn}`;
      await runTurn(client, {
        sessionId,
        threadId: "fiber-reuse-thread",
        runId: `run-${turn}`,
        baseURL,
        apiKey: secret,
        promptText: `hello turn ${turn}`,
      });
      await client.release(sessionId, `run-${turn}`);

      const health = await client.health();
      assert.equal(
        health.stats.ephemeralKeys,
        0,
        "release() must purge turn secret from memory immediately",
      );
      assert.equal(
        health.stats.providerUpdates,
        1,
        "same connectionFingerprint across turns must reuse the single Provider Fiber",
      );
    }

    assert.deepEqual(receivedAuth, [
      "Bearer ephemeral-secret-1",
      "Bearer ephemeral-secret-2",
      "Bearer ephemeral-secret-3",
      "Bearer ephemeral-secret-4",
      "Bearer ephemeral-secret-5",
    ]);
    const credsAfter = (await fileExists(credsPath))
      ? await readFile(credsPath, "utf8")
      : null;
    assert.equal(
      credsAfter,
      credsBefore,
      ".credentials.yaml must not be written during turns when temporary credentials stay in memory",
    );
    if (credsAfter !== null) {
      assert.doesNotMatch(credsAfter, /CHISABOT_ROUTE_|ephemeral-secret-/);
    }
    assert.equal(
      await fileExists(join(home, "route-keys.json")),
      false,
      "route-keys.json must not be created when credentials stay in memory",
    );
  },
);

test(
  "DSH sessions Map safely evicts only released idle sessions (never unreleased ones) and resumes evicted sessions seamlessly",
  { timeout: 120_000 },
  async (t) => {
    const { baseURL, client, receivedMessages } = await startFixtureHost(t, {
      CHISABOT_DSH_MAX_SESSIONS: "2",
      CHISABOT_DSH_SESSION_IDLE_MS: "400",
    });

    // Session A: completed and released -> eligible for eviction.
    await runTurn(client, {
      sessionId: "sess-a",
      threadId: "thread-a",
      runId: "run-a-1",
      baseURL,
      apiKey: "key-a-1",
      promptText: "remember token ALPHA-42",
    });
    await client.release("sess-a", "run-a-1");

    // Session B: bound and NOT released -> must NEVER be evicted.
    await runTurn(client, {
      sessionId: "sess-b",
      threadId: "thread-b",
      runId: "run-b-1",
      baseURL,
      apiKey: "key-b-1",
      promptText: "unreleased session B",
    });

    // Session C & D: push over maxIdleSessions=2 and wait past TTL=400ms.
    await runTurn(client, {
      sessionId: "sess-c",
      threadId: "thread-c",
      runId: "run-c-1",
      baseURL,
      apiKey: "key-c-1",
      promptText: "session C",
    });
    await client.release("sess-c", "run-c-1");

    await delay(650);

    const health = await client.health();
    const liveIds = health.sessions.map((s) => s.sessionId);
    assert.ok(
      liveIds.includes("sess-b"),
      "unreleased session B must never be evicted",
    );
    assert.equal(
      liveIds.includes("sess-a"),
      false,
      "released idle session A must be evicted",
    );
    assert.ok(health.stats.evictedSessions >= 1);

    // Re-binding evicted session A must seamlessly resume its persisted history without double-read issues.
    const countBefore = receivedMessages.length;
    await runTurn(client, {
      sessionId: "sess-a",
      threadId: "thread-a",
      runId: "run-a-2",
      baseURL,
      apiKey: "key-a-2",
      promptText: "what was the token?",
    });
    const resumedPayload = JSON.stringify(receivedMessages[countBefore]);
    assert.match(
      resumedPayload,
      /ALPHA-42/,
      "resumed session must preserve prior conversation history",
    );
    await client.release("sess-a", "run-a-2");
    await client.release("sess-b", "run-b-1");
  },
);

test("ChisaModelRouter caches privacyCheckedSessions to avoid O(N) snapshotEvents scan on every step", async () => {
  let snapshotCalls = 0;
  const realSession = new Session("long-session");
  const originalSnapshot = realSession.snapshotEvents.bind(realSession);
  realSession.snapshotEvents = (...args) => {
    snapshotCalls += 1;
    return originalSnapshot(...args);
  };
  const ctx = {
    sessions: {
      get: (id) => (id === "long-session" ? realSession : undefined),
      flush: async () => {},
    },
    llm: {
      prepareCall: async () => ({
        config: {},
        stream: async function* () {
          yield { type: "text-delta", text: "ok" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      }),
    },
  };
  const router = new ChisaModelRouter(ctx);
  router.bind(
    "route-1",
    {
      primary: { provider: "mock", model: "m1" },
      fallbacks: [],
      firstOutputMs: 0,
    },
    "run-1",
  );
  const prepared = await router.prepareCall("chisabot", "route-1");

  for (let step = 0; step < 10; step++) {
    for await (const _chunk of prepared.stream({
      sessionId: "long-session",
      messages: [{ role: "user", content: "hi" }],
    })) {
      // drain
    }
  }
  assert.equal(
    snapshotCalls,
    1,
    "snapshotEvents should be scanned only once for an unblocked session across 10 steps",
  );

  // Eviction clears cached state so a subsequent resume re-checks once.
  router.clearSession("long-session");
  for await (const _chunk of prepared.stream({
    sessionId: "long-session",
    messages: [{ role: "user", content: "hi again" }],
  })) {
    // drain
  }
  assert.equal(snapshotCalls, 2);
});
