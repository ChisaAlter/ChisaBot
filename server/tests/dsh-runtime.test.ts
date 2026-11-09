import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseEvent, Message } from "@ag-ui/client";
import { HttpAgent } from "@ag-ui/client";
import { z } from "zod";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createConfirmations, digestOf } from "../src/confirmations/service";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConfirmationResumer } from "../src/conversations/confirmation-resume";
import { createConversationRoutes } from "../src/conversations/routes";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";
import { createTurnRunner } from "../src/turns/run-turn";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const run = address ? test : test.skip;
const resources: (() => unknown | Promise<unknown>)[] = [];
afterAll(async () => {
  for (const close of resources.reverse()) await close();
}, 30_000);

run(
  "DSH adapter resumes approval after a Host restart and preserves operation identity",
  async () => {
    const database = createDatabase(address!, { max: 4 });
    resources.push(() => database.$client.close());
    const bindings = createConversationBindings(database);
    const operations = createToolOperationStore(database);
    const confirmations = createConfirmations(database);
    const journal = createDshRunJournal(database);
    await journal.ensure();
    const backend = await createLocalConversations(database);
    await bindings.ensure();
    await operations.ensure();
    await confirmations.ensure();
    await database.$client.unsafe(
      `CREATE TABLE IF NOT EXISTS work_items(kind text NOT NULL,key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(kind,key))`,
    );
    const gateway = createDshToolGateway(operations, journal);
    const suffix = randomUUID();
    const actorId = `dsh-test-${suffix}`;
    const threadId = `thread-${suffix}`;
    const botId = `bot-${suffix}`;
    let executed = 0;
    let loseEffectReceipt = false;
    const requests: string[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (/^\/(execute|steer)/.test(url.pathname))
          return gateway.routes.fetch(request);
        const body = (await request.json()) as any;
        requests.push(body.model);
        if (body.model === "unavailable")
          return Response.json(
            { error: { message: "quota", type: "rate_limit_error" } },
            { status: 429 },
          );
        const hasTool = body.messages.some((x: any) => x.role === "tool");
        const entries = hasTool
          ? [
              {
                role: "assistant",
                content: "The approved operation completed.",
              },
            ]
          : [
              { role: "assistant", content: "Requesting approval. " },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "operation-1",
                    type: "function",
                    function: {
                      name: "approved_operation",
                      arguments: '{"value":"one"}',
                    },
                  },
                ],
              },
            ];
        const frames = entries.map(
          (delta) =>
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        frames.push(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
        return new Response(frames.join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    resources.push(() => bridge.stop(true));
    const runtime = resolve("runtime/dsh");
    await mkdir(join(runtime, ".runtime"), { recursive: true });
    const home = await mkdtemp(join(runtime, ".runtime", "adapter-"));
    await writeFile(
      join(home, "chisabot.json"),
      JSON.stringify({
        ownerUserId: actorId,
        port: 0,
        providers: {},
        gatewayUrl: bridge.url.origin,
      }),
    );
    let logs = "";
    const launch = () => {
      const child = spawn("node", ["src/start.mjs"], {
        cwd: runtime,
        windowsHide: true,
        env: { ...globalThis.process.env, CHISABOT_DSH_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (value) => {
        logs += value;
      });
      child.stderr.on("data", (value) => {
        logs += value;
      });
      return child;
    };
    let process = launch();
    const waitReady = async () => {
      for (
        let i = 0;
        i < 200 && !logs.includes("chisabot-runtime-ready");
        i++
      ) {
        if (process.exitCode !== null) throw new Error(logs);
        await Bun.sleep(100);
      }
      expect(logs).toContain("chisabot-runtime-ready");
    };
    resources.push(async () => {
      if (process.exitCode === null) {
        const done = once(process, "exit");
        process.kill();
        await done;
      }
    });
    await waitReady();
    let card: any;
    confirmations.setOnOpened((value) => {
      card = value;
    });
    const input = {
      threadId,
      runId: `run-${suffix}`,
      messages: [
        {
          id: `message-${suffix}`,
          role: "user",
          content: "Perform the approved operation once.",
        },
      ] as Message[],
      state: {},
      tools: [],
      context: [],
    };
    const agent = new DshRuntimeAgent({
      botId,
      binding: {
        bindings,
        gateway,
        journal,
        toolGatewayUrl: bridge.url.origin,
        targetFor: async () => ({
          id: "test-runtime",
          ownerUserId: actorId,
          connectionFile: join(home, "connection.json"),
        }),
        readRun: (value) => JSON.parse(String(value)),
      },
      signRun: (value) =>
        JSON.stringify({
          actorId,
          botId,
          runId: value.runId,
          threadId: value.threadId,
        }),
      tools: [
        {
          name: "approved_operation",
          description: "A harmless operation requiring the user's approval.",
          ref: "test/approved",
          parameters: z.object({ value: z.string() }),
          execute: async (args) => {
            const answer = await confirmations.check({
              ownerUserId: actorId,
              agentId: botId,
              category: "message",
              tool: "approved_operation",
              title: "Approve isolated operation",
              target: "test fixture",
              matchText: "test",
              digest: digestOf("approved_operation", args),
            });
            if (!answer.ok) return answer.message;
            executed++;
            if (loseEffectReceipt)
              throw new Error("Effect completed but receipt was lost.");
            return "approved-once";
          },
        },
      ],
      prompt: () =>
        "Call approved_operation exactly once, then report its result.",
      connection: {
        provider: "openai",
        baseUrl: `${bridge.url.origin}/v1`,
        apiKey: "isolated-fixture",
        model: "unavailable",
      },
      modelInfo: async () => ({
        maxOutputTokens: 1024,
        contextWindow: 32000,
        supportsImages: false,
      }),
      fallbacks: async () => ["available"],
    });
    const routes = createConversationRoutes({
      backend,
      identifyActor: async () => ({ id: actorId, role: "user" }),
      resolver: {
        resolveAgentForActor: async () => agent.clone(),
        resolveAgentsForActor: async () => ({ [botId]: agent.clone() }),
      },
    });
    const browser = new HttpAgent({
      agentId: botId,
      threadId,
      initialMessages: input.messages,
      url: `http://localhost/api/conversations/agent/${botId}/run`,
      fetch: (url, init) => routes.request(url, init),
    });
    const events: BaseEvent[] = [];
    const done = browser.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );
    for (
      let i = 0;
      i < 1800 &&
      !card &&
      !events.some((x) => x.type === "RUN_ERROR" || x.type === "RUN_FINISHED");
      i++
    )
      await Bun.sleep(50);
    expect(
      events.find((x) => x.type === "RUN_ERROR"),
      JSON.stringify({ events, logs }),
    ).toBeUndefined();
    expect(card, JSON.stringify({ events, requests, logs })).toBeDefined();
    expect(executed).toBe(0);
    expect(card.threadId).toBe(threadId);
    expect(card.toolCallId).toContain(":operation-1");
    await done;
    expect((events.at(-1) as any)?.outcome?.type).toBe("interrupt");
    // Waiting is persisted in the product ledger. Killing the entire Host must not lose the
    // pending decision or turn approval into another model-selected tool invocation.
    const oldConnection = JSON.parse(
      await readFile(join(home, "connection.json"), "utf8"),
    );
    const exited = once(process, "exit");
    process.kill("SIGKILL");
    await exited;
    logs = "";
    process = launch();
    await waitReady();
    const newConnection = JSON.parse(
      await readFile(join(home, "connection.json"), "utf8"),
    );
    expect(newConnection.generation).not.toBe(oldConnection.generation);
    // A new approval-service instance has no in-memory waiter. The same durable request must
    // still resume the exact original call, without another model-selected operation.
    const restartedConfirmations = createConfirmations(database);
    await expect(
      restartedConfirmations.decide("another-account", card.id, "approve"),
    ).rejects.toThrow("找不到");
    await restartedConfirmations.decide(actorId, card.id, "approve");
    const runTurn = createTurnRunner({
      intelligence: backend.client,
      runner: backend.runner,
      buildAgentFor: async () => agent.clone(),
    });
    const resume = createConfirmationResumer({
      database,
      backend,
      confirmations: restartedConfirmations,
      buildAgentFor: async () => agent.clone(),
      runTurn,
    });
    const priorRoot = globalThis.process.env.CHISABOT_DSH_ROOT;
    try {
      globalThis.process.env.CHISABOT_DSH_ROOT = home;
      await writeFile(join(home, ".maintenance"), "draining");
      await expect(resume(actorId, card.id)).rejects.toThrow("服务正在更新");
      expect(executed).toBe(0);
      await unlink(join(home, ".maintenance"));
    } finally {
      if (priorRoot === undefined)
        delete globalThis.process.env.CHISABOT_DSH_ROOT;
      else globalThis.process.env.CHISABOT_DSH_ROOT = priorRoot;
    }
    await resume(actorId, card.id);
    await resume(actorId, card.id);
    expect(
      events.find((x) => x.type === "RUN_ERROR"),
      JSON.stringify({ events, logs }),
    ).toBeUndefined();
    expect(executed).toBe(1);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(requests).toEqual([
      "unavailable",
      "available",
      "unavailable",
      "available",
    ]);
    const binding = await bindings.get(threadId);
    const [operation] = await database.$client.unsafe<
      { status: string; result: any }[]
    >(
      "SELECT status,result FROM chisabot_tool_operations WHERE binding_id=$1",
      [binding!.bindingId],
    );
    expect(operation?.status).toBe("completed");
    expect(operation?.result.content).toBe("approved-once");
    expect(binding?.ownerUserId).toBe(actorId);
    expect(
      events.filter((x: any) => x.type === "TOOL_CALL_RESULT").length,
    ).toBe(0);
    const stored = await backend.client.getThreadMessages({
      threadId,
      userId: actorId,
    });
    expect(
      stored.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content === "The approved operation completed.",
      ),
    ).toBe(true);
    const repeat = await routes.request(
      `http://localhost/api/conversations/agent/${botId}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    await repeat.text();
    expect(executed).toBe(1);
    expect(requests).toEqual([
      "unavailable",
      "available",
      "unavailable",
      "available",
    ]);
    expect(
      (await journal.pending()).some((record) => record.thread_id === threadId),
    ).toBe(false);

    const stoppedThread = `${threadId}-stopped`;
    const stoppedInput = {
      ...input,
      threadId: stoppedThread,
      messages: [
        {
          id: `stop-${suffix}`,
          role: "user",
          content: "Ask for another approval.",
        },
      ],
    };
    const accepted = await routes.request(
      `http://localhost/api/conversations/${stoppedThread}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: botId, input: stoppedInput }),
      },
    );
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    const observation = await routes.request(
      `http://localhost/api/conversations/${stoppedThread}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: receipt.commandId }),
      },
    );
    expect(await observation.text()).toContain('"type":"interrupt"');
    expect(card.threadId).toBe(stoppedThread);
    expect(
      await backend.runner.stop({
        threadId: stoppedThread,
        runId: receipt.runId,
      }),
    ).toBe(true);
    await expect(
      restartedConfirmations.decide(actorId, card.id, "approve"),
    ).rejects.toThrow("已被停止");
    expect(executed).toBe(1);
    const reopened = await routes.request(
      `http://localhost/api/conversations/${stoppedThread}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: receipt.commandId }),
      },
    );
    const stoppedEvents = await reopened.text();
    expect(stoppedEvents).toContain("DSH_RUN_CANCELLED");
    expect(stoppedEvents).not.toContain('"type":"interrupt"');

    // An approved executor may fail after creating its effect. Suspend that run so the model
    // cannot respond to an ordinary tool error by creating a new call identity and repeating it.
    const uncertainThread = `${threadId}-uncertain`;
    const uncertainInput = {
      ...input,
      threadId: uncertainThread,
      messages: [
        {
          id: `uncertain-${suffix}`,
          role: "user",
          content: "Perform the isolated operation.",
        },
      ],
    };
    const unknownAdmission = await routes.request(
      `http://localhost/api/conversations/${uncertainThread}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: botId, input: uncertainInput }),
      },
    );
    const unknownReceipt = await unknownAdmission.json();
    const unknownStream = await routes.request(
      `http://localhost/api/conversations/${uncertainThread}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: unknownReceipt.commandId }),
      },
    );
    expect(await unknownStream.text()).toContain('"type":"interrupt"');
    const unknownCard = card;
    await restartedConfirmations.decide(actorId, unknownCard.id, "approve");
    const requestsBefore = requests.length;
    loseEffectReceipt = true;
    await resume(actorId, unknownCard.id);
    await resume(actorId, unknownCard.id);
    expect(executed).toBe(2);
    expect(requests.length).toBe(requestsBefore);
    const [uncertain] = await database.$client.unsafe<{ status: string }[]>(
      "SELECT status FROM chisabot_tool_operations WHERE confirmation_id=$1",
      [unknownCard.id],
    );
    expect(uncertain?.status).toBe("outcome_unknown");
    const unknownReopened = await routes.request(
      `http://localhost/api/conversations/${uncertainThread}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: unknownReceipt.commandId }),
      },
    );
    const unknownEvents = await unknownReopened.text();
    expect(unknownEvents).toContain("operation_unknown");
    expect(unknownEvents).toContain("结果尚待核对");
  },
  180_000,
);
