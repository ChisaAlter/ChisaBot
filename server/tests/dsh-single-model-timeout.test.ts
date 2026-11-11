// QA511 P2: real server path (DshRuntimeAgent + conversation routes + DSH Host + hanging
// upstream). A single silent model must end on the Chinese first-output deadline (~4×
// CHISABOT_DSH_FIRST_OUTPUT_MS), not after a provider request-timeout same-model retry.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  "server path: single silent model ends ~4× firstOutputMs with Chinese deadline copy",
  async () => {
    const firstOutputMs = 250;
    process.env.CHISABOT_DSH_FIRST_OUTPUT_MS = String(firstOutputMs);
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
        // Hang forever — first-output deadline must win over the provider request timeout.
        await request.json();
        return new Promise<Response>(() => {});
      },
    });
    resources.push(() => bridge.stop(true));
    const runtime = resolve("runtime/dsh");
    await mkdir(join(runtime, ".runtime"), { recursive: true });
    const home = await mkdtemp(join(runtime, ".runtime", "qa511-to-"));
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
    const joined = runError.join("\n");
    expect(joined).toMatch(/共等了约 1 秒仍没有任何输出/);
    expect(joined).not.toMatch(/Request timed out/i);
    // 4 × 250ms = 1000ms; allow scheduler slack, forbid a second ~90s-class retry.
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(4000);
  },
  30_000,
);
