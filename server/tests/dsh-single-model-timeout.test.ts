// Server path: DshRuntimeAgent + conversation routes + DSH Host + delayed upstream.
// The former first-output deadline must not cut off a valid slow answer.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseEvent, Message } from "@ag-ui/client";
import { HttpAgent } from "@ag-ui/client";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConversationRoutes } from "../src/conversations/routes";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const run = address ? test : test.skip;
const resources: (() => unknown | Promise<unknown>)[] = [];
afterAll(async () => {
  for (const close of resources.reverse()) await close();
}, 30_000);

run(
  "server path: silent model answers past the former first-output deadline",
  async () => {
    const firstOutputMs = 250;
    const previous = process.env.CHISABOT_DSH_FIRST_OUTPUT_MS;
    process.env.CHISABOT_DSH_FIRST_OUTPUT_MS = String(firstOutputMs);
    resources.push(() => {
      if (previous === undefined)
        delete process.env.CHISABOT_DSH_FIRST_OUTPUT_MS;
      else process.env.CHISABOT_DSH_FIRST_OUTPUT_MS = previous;
    });
    const database = createDatabase(address!, { max: 4 });
    resources.push(() => database.$client.close());
    const bindings = createConversationBindings(database);
    const operations = createToolOperationStore(database);
    const journal = createDshRunJournal(database);
    await journal.ensure();
    await bindings.ensure();
    await operations.ensure();
    const backend = await createLocalConversations(database);
    const gateway = createDshToolGateway(operations, journal);
    const actorId = `dsh-to-${randomUUID()}`;
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (/^\/(execute|steer)/.test(url.pathname))
          return gateway.routes.fetch(request);
        await request.json();
        // Longer than the former 4 × 250ms single-model deadline.
        await Bun.sleep(1500);
        const chunk = {
          id: "slow-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "slow_s1",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Slow answer completed." },
              finish_reason: "stop",
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    resources.push(() => bridge.stop(true));
    const runtime = resolve("runtime/dsh");
    await mkdir(join(runtime, ".runtime"), { recursive: true });
    const home = await mkdtemp(join(runtime, ".runtime", "qa511-to-"));
    resources.push(async () => {
      expect(await realpath(home)).toBe(home);
      await rm(home, { recursive: true });
    });
    await writeFile(
      join(home, "chisabot.json"),
      JSON.stringify({
        ownerUserId: actorId,
        port: 0,
        providers: {},
        gatewayUrl: bridge.url.origin,
      }),
    );
    let hostLogs = "";
    const child = spawn("node", ["src/start.mjs"], {
      cwd: runtime,
      windowsHide: true,
      env: { ...process.env, CHISABOT_DSH_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (v) => (hostLogs += v));
    child.stderr.on("data", (v) => (hostLogs += v));
    resources.push(async () => {
      if (child.exitCode === null) {
        const done = once(child, "exit");
        child.kill();
        await done;
      }
    });
    for (
      let i = 0;
      i < 200 && !hostLogs.includes("chisabot-runtime-ready");
      i++
    )
      await Bun.sleep(100);
    expect(hostLogs).toContain("chisabot-runtime-ready");

    const agent = new DshRuntimeAgent({
      botId,
      binding: {
        bindings,
        gateway,
        journal,
        toolGatewayUrl: bridge.url.origin,
        targetFor: async () => ({
          id: "qa-to",
          ownerUserId: actorId,
          connectionFile: join(home, "connection.json"),
        }),
        readRun: (v) => JSON.parse(String(v)),
      },
      signRun: (v) =>
        JSON.stringify({
          actorId,
          botId,
          runId: v.runId,
          threadId: v.threadId,
        }),
      tools: [],
      prompt: () => "QA511 timeout prompt.",
      connection: {
        provider: "openai",
        baseUrl: `${bridge.url.origin}/v1`,
        apiKey: "isolated-fixture",
        model: "slow_s1",
      },
      modelInfo: async () => ({
        maxOutputTokens: 1024,
        contextWindow: 32000,
        supportsImages: false,
      }),
      fallbacks: async () => [],
    } as never);
    const routes = createConversationRoutes({
      backend,
      identifyActor: async () => ({ id: actorId, role: "user" }),
      resolver: {
        resolveAgentForActor: async () => agent.clone(),
        resolveAgentsForActor: async () => ({ [botId]: agent.clone() }),
      },
    } as never);
    const browser = new HttpAgent({
      agentId: botId,
      threadId,
      initialMessages: [{ id: "m1", role: "user", content: "hi" }] as Message[],
      url: `http://localhost/api/conversations/agent/${botId}/run`,
      fetch: (u, i) => routes.request(u, i),
    });
    const events: BaseEvent[] = [];
    const t0 = Date.now();
    await browser
      .runAgent({}, { onEvent: ({ event }) => events.push(event) })
      .catch((e) =>
        events.push({ type: "CLIENT_ERROR", message: String(e) } as never),
      );
    const ms = Date.now() - t0;
    const runError = events
      .filter((e) => e.type === "RUN_ERROR")
      .map((e) => (e as { message?: string }).message ?? "");
    expect(runError).toEqual([]);
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    expect(JSON.stringify(events)).toContain("Slow answer completed.");
    expect(ms).toBeGreaterThanOrEqual(1400);
  },
  30_000,
);
