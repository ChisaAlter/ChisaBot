// Isolated API process used by dsh-recovery.test.ts. Its parent owns the Host and model server.
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { DshRuntimeAgent } from "../../src/agents/dsh-runtime";
import { createConversationBindings } from "../../src/conversations/bindings";
import { recoverConversations } from "../../src/conversations/recovery";
import { createConversationRoutes } from "../../src/conversations/routes";
import { createDshRunJournal } from "../../src/conversations/run-journal";
import { createDshToolGateway } from "../../src/conversations/tool-gateway";
import { createToolOperationStore } from "../../src/conversations/tool-operations";
import { createDatabase } from "../../src/db/client";
import { createLocalConversations } from "../../src/local-conversations";
import { createTurnRunner } from "../../src/turns/run-turn";
import type { Initiator } from "./wire-types";

const config = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const database = createDatabase(process.env.CHISABOT_DSH_TEST_DATABASE_URL!, {
  max: 4,
});
const backend = await createLocalConversations(database);
const bindings = createConversationBindings(database),
  journal = createDshRunJournal(database),
  operations = createToolOperationStore(database);
await bindings.ensure();
await journal.ensure();
await operations.ensure();
const gateway = createDshToolGateway(operations, journal);
const build = (initiator: Initiator = { kind: "person" }) =>
  new DshRuntimeAgent({
    botId: config.botId,
    binding: {
      bindings,
      gateway,
      journal,
      toolGatewayUrl: config.modelUrl,
      targetFor: async () => ({
        id: "recovery",
        ownerUserId: config.actorId,
        connectionFile: config.connectionFile,
      }),
      readRun: (value) => JSON.parse(String(value)),
    },
    signRun: (input) =>
      JSON.stringify({
        actorId: config.actorId,
        botId: config.botId,
        threadId: input.threadId,
        runId: input.runId,
        initiator,
      }),
    tools: [],
    prompt: () => "Answer the user's request.",
    connection: {
      provider: "openai",
      model: "fixture",
      apiKey: "fixture",
      baseUrl: `${config.modelUrl}/v1`,
    },
    modelInfo: async () => ({ contextWindow: 32000, maxOutputTokens: 1024 }),
    fallbacks: async () => [],
  });
const app = new Hono();
const runTurn = createTurnRunner({
  intelligence: backend.client,
  runner: backend.runner,
  buildAgentFor: async (input) => build(input.initiator),
});
app.post("/fixture/background/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  const { content } = await c.req.json();
  void runTurn({
    ownerUserId: config.actorId,
    agentId: config.botId,
    threadId,
    runId: threadId,
    routineId: threadId,
    instruction: content,
  }).catch((error) =>
    console.warn(
      JSON.stringify({ background: threadId, error: String(error) }),
    ),
  );
  return c.json({ accepted: true });
});
app.route("/gateway", gateway.routes);
app.route(
  "/",
  createConversationRoutes({
    backend,
    identifyActor: async () => ({ id: config.actorId, role: "user" }),
    resolver: {
      resolveAgentForActor: async () => build(),
      resolveAgentsForActor: async () => ({ [config.botId]: build() }),
    },
  }),
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(JSON.stringify({ ready: true, origin: server.url.origin }));
if (config.recover)
  await recoverConversations({
    backend: {
      ...backend,
      capacity: {
        ...backend.capacity,
        queued: async () =>
          (await backend.capacity.queued()).filter(
            (row) => row.owner_user_id === config.actorId,
          ),
      },
    },
    journal: {
      ...journal,
      pending: async () =>
        (await journal.pending()).filter(
          (row) => row.owner_user_id === config.actorId,
        ),
    },
    buildAgentFor: async (input) => build(input.initiator),
  });
