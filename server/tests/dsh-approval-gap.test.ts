import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { HttpAgent, type BaseEvent, type Message } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { DshHostClient } from "../../runtime/dsh/src/client.mjs";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createConfirmations, digestOf } from "../src/confirmations/service";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConfirmationResumer } from "../src/conversations/confirmation-resume";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createConversationRoutes } from "../src/conversations/routes";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";
import { createTurnRunner } from "../src/turns/run-turn";
import { backgroundCount, executionClass } from "../src/conversations/capacity";
import type { AuditInitiator } from "../src/audit";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;

async function until<T>(read: () => Promise<T | undefined | false>, detail: string): Promise<T> {
  for (let i = 0; i < 1000; i++) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${detail}`);
}

(address ? test : test.skip)("lost waiting 202 retains one card through transport retry and actual Host restart", async () => {
  const resources: (() => unknown | Promise<unknown>)[] = [];
  const suffix = randomUUID();
  const actorId = `approval-gap-${suffix}`, botId = `${actorId}-bot`;
  const database = createDatabase(address!, { max: 4 });
  const sql = database.$client;
  resources.push(() => sql.close());
  const bindings = createConversationBindings(database), operations = createToolOperationStore(database), journal = createDshRunJournal(database);
  let backend = await createLocalConversations(database);
  await bindings.ensure(); await operations.ensure(); await journal.ensure();
  await sql.unsafe("CREATE TABLE IF NOT EXISTS work_items(kind text NOT NULL,key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(kind,key))");
  let confirmations = createConfirmations(database);
  await confirmations.ensure();
  let gateway = createDshToolGateway(operations, journal);
  let effects = 0, modelRequests = 0, gatewayRequests = 0;
  const providerInputs: any[] = [];
  const bridgeErrors: string[] = [];
  let interception: "none" | "drop-once" | "hold" = "none";
  let committedWaiting: { requestId: string; body: any } | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/execute" || request.url === "/steer") {
        if (request.url === "/execute") gatewayRequests++;
        const result = await gateway.routes.fetch(new Request(`${origin}${request.url}`, { method: "POST", headers: request.headers as HeadersInit, body }));
        const text = await result.text();
        if (result.status === 202) {
          committedWaiting = { requestId: JSON.parse(text).waiting.requestId, body: JSON.parse(body) };
          if (interception === "drop-once") {
            interception = "none";
            // The gateway finished and committed WAITING, but no HTTP headers reach the Host.
            response.destroy();
            return;
          }
          if (interception === "hold") return;
        }
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(text);
        return;
      }
      const input = JSON.parse(body);
      modelRequests++;
      providerInputs.push(input);
      const finished = input.messages.some((message: any) => message.role === "tool");
      const deltas = finished ? [{ role: "assistant", content: "The approved effect completed once." }]
        : [{ role: "assistant", content: "Waiting for your decision. " }, { tool_calls: [{ index: 0, id: "effect-call", type: "function", function: { name: "approved_effect", arguments: '{"value":"one"}' } }] }];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of deltas) response.write(`data: ${JSON.stringify({ id: "gap", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: "gap", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      bridgeErrors.push(`${request.url}: ${error instanceof Error ? error.stack : String(error)}`);
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resources.push(() => { server.closeAllConnections(); server.close(); });
  const runtime = resolve("runtime/dsh");
  await mkdir(join(runtime, ".runtime"), { recursive: true });
  const home = await mkdtemp(join(runtime, ".runtime", "approval-gap-"));
  await writeFile(join(home, "chisabot.json"), JSON.stringify({ ownerUserId: actorId, port: 0, providers: {}, gatewayUrl: origin }));
  let child: ChildProcess | undefined, logs = "";
  const boot = async () => {
    logs = "";
    child = spawn("node", ["src/start.mjs"], { cwd: runtime, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", value => { logs += value; }); child.stderr!.on("data", value => { logs += value; });
    await until(async () => {
      if (child!.exitCode !== null) throw new Error(logs);
      return logs.includes("chisabot-runtime-ready");
    }, "Host start");
    return JSON.parse(await readFile(join(home, "connection.json"), "utf8"));
  };
  const kill = async () => {
    if (child?.exitCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
  };
  resources.push(kill);
  const agent = (initiator: AuditInitiator = { kind: "person" }) => new DshRuntimeAgent({ botId,
    binding: { bindings, gateway, journal, toolGatewayUrl: origin, targetFor: async () => ({ id: "gap-runtime", ownerUserId: actorId, connectionFile: join(home, "connection.json") }), readRun: value => JSON.parse(String(value)) },
    signRun: value => JSON.stringify({ actorId, botId, threadId: value.threadId, runId: value.runId, initiator }),
    tools: [{ name: "approved_effect", ref: "fixture/approved", description: "An isolated approval-protected counter.", parameters: z.object({ value: z.string() }), execute: async args => {
      const decision = await confirmations.check({ ownerUserId: actorId, agentId: botId, category: "message", tool: "approved_effect", title: "Approve isolated counter", target: "test-only", matchText: "fixture", digest: digestOf("approved_effect", args) });
      if (!decision.ok) return decision.message;
      effects++; return "effect-once";
    } }],
    prompt: () => "Call approved_effect once, then report its actual receipt.",
    connection: { provider: "openai", baseUrl: `${origin}/v1`, apiKey: "isolated-fixture", model: "fixture" },
    modelInfo: async () => ({ maxOutputTokens: 1024, contextWindow: 32000 }), fallbacks: async () => [],
  });
  const routes = () => createConversationRoutes({ backend, identifyActor: async () => ({ id: actorId, role: "user" }), resolver: { resolveAgentForActor: async () => agent(), resolveAgentsForActor: async () => ({ [botId]: agent() }) } });
  const start = (threadId: string) => {
    const api = routes();
    const input = { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: "user", content: "Perform the approved counter once." }] as Message[], state: {}, tools: [], context: [] };
    const browser = new HttpAgent({ agentId: botId, threadId, initialMessages: input.messages, url: `http://localhost/api/copilotkit/agent/${botId}/run`, fetch: (url, init) => api.request(url, init) });
    const events: BaseEvent[] = [];
    const done = browser.runAgent({ runId: input.runId }, { onEvent: ({ event }) => { events.push(event); } });
    return { input, browser, events, done };
  };
  const resume = () => createConfirmationResumer({ database, backend, confirmations, buildAgentFor: async () => agent(), runTurn: createTurnRunner({ intelligence: backend.client, runner: backend.runner, buildAgentFor: async () => agent() }) });
  const countCards = async (threadId: string) => (await sql.unsafe<{ count: number }[]>("SELECT count(*)::int AS count FROM chisabot_confirm_requests WHERE owner_user_id=$1 AND thread_id=$2", [actorId, threadId]))[0]!.count;
  try {
    const fixture = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", messages: [{ role: "tool" }] }) }).catch(error => { throw new Error(JSON.stringify({ bridgeErrors, error: String(error) })); });
    expect(await fixture.text()).toContain("The approved effect completed once.");
    modelRequests = 0;
    await boot();
    interception = "drop-once";
    const retried = start(`${actorId}-retried`);
    await retried.done;
    expect(retried.events.find(event => event.type === "RUN_ERROR"), JSON.stringify({ events: retried.events, bridgeErrors, logs })).toBeUndefined();
    expect((retried.events.at(-1) as any)?.outcome?.type).toBe("interrupt");
    expect(gatewayRequests).toBe(2);
    expect(effects).toBe(0);
    expect(await countCards(retried.input.threadId)).toBe(1);
    const retryCard = committedWaiting!.requestId;
    expect((await confirmations.list(actorId, { threadId: retried.input.threadId }))[0]?.id).toBe(retryCard);
    await confirmations.decide(actorId, retryCard, "approve");
    await resume()(actorId, retryCard); await resume()(actorId, retryCard);
    expect(effects).toBe(1);

    interception = "hold"; committedWaiting = undefined;
    const crashed = start(`${actorId}-crashed`);
    const gap = await until(async () => committedWaiting, "WAITING committed before 202 is exposed");
    const [operationBefore] = await sql.unsafe<any[]>("SELECT id,status FROM chisabot_tool_operations WHERE confirmation_id=$1", [gap.requestId]);
    expect(operationBefore.status).toBe("waiting_approval");
    const binding = (await bindings.get(crashed.input.threadId))!;
    const oldConnection = JSON.parse(await readFile(join(home, "connection.json"), "utf8"));
    const client = await DshHostClient.connect(oldConnection.endpoint);
    const before = await client.eventsAfter(binding.sessionId, -1);
    expect(before.records.some(record => record.event.type === "plugin:chisabot/waiting")).toBe(false);
    expect(before.records.some(record => record.event.type === "tool/call")).toBe(true);
    expect(effects).toBe(1);
    const supplement = { id: randomUUID(), role: "user" as const, content: "A paused supplement must not run during approval recovery." };
    await backend.inbox.enqueue({ threadId: crashed.input.threadId, ownerUserId: actorId, message: supplement });
    await client.close();
    await kill();
    const newConnection = await boot();
    expect(newConnection.generation).not.toBe(oldConnection.generation);
    await crashed.done;
    expect(crashed.events.some(event => event.type === "RUN_ERROR")).toBe(true);
    const requestsBeforeResume = modelRequests;
    backend = await createLocalConversations(database);
    gateway = createDshToolGateway(operations, journal);
    confirmations = createConfirmations(database);
    await confirmations.ensure();
    expect(await backend.inbox.isPaused(crashed.input.threadId)).toBe(true);
    expect((await backend.inbox.list(crashed.input.threadId)).find(item => item.id === supplement.id)?.status).toBe("paused");
    const historyBeforeRefusal = await backend.client.getThreadMessages({ userId: actorId, threadId: crashed.input.threadId });
    const forged = await routes().request(`/api/copilotkit/agent/${botId}/run`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...crashed.input, runId: randomUUID(), messages: [supplement],
        resume: [{ interruptId: "forged", status: "resolved", payload: "not a durable decision" }],
        persistedInputMessages: [], continuationRunId: gap.body.binding.runId,
      }),
    });
    expect(await forged.text()).toContain("保留的消息已暂停");
    const stoppedSource = `stopped:${randomUUID()}`;
    await sql.unsafe("INSERT INTO openbot_local_runs(thread_id,run_id,status) VALUES($1,$2,'stopped')", [crashed.input.threadId, stoppedSource]);
    const late = await lastValueFrom(backend.runner.run({ threadId: crashed.input.threadId, agent: agent(), join: false,
      input: { ...crashed.input, runId: randomUUID(), resume: [{ interruptId: "late", status: "resolved", payload: "late server receipt" }] },
      persistedInputMessages: [], continuationRunId: stoppedSource,
    }).pipe(toArray()));
    expect(late.some(event => event.type === "RUN_ERROR" && "message" in event && String(event.message).includes("保留的消息已暂停"))).toBe(true);
    expect(await backend.client.getThreadMessages({ userId: actorId, threadId: crashed.input.threadId })).toEqual(historyBeforeRefusal);
    const cards = await confirmations.list(actorId, { threadId: crashed.input.threadId });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: gap.requestId, status: "pending" });
    expect(await countCards(crashed.input.threadId)).toBe(1);
    expect(modelRequests).toBe(requestsBeforeResume);
    interception = "none";
    await confirmations.decide(actorId, gap.requestId, "approve");
    await resume()(actorId, gap.requestId); await resume()(actorId, gap.requestId);
    expect(effects).toBe(2);
    expect(modelRequests).toBe(requestsBeforeResume + 1);
    const [operationAfter] = await sql.unsafe<any[]>("SELECT id,status,result FROM chisabot_tool_operations WHERE confirmation_id=$1", [gap.requestId]);
    expect(operationAfter).toMatchObject({ id: operationBefore.id, status: "completed", result: { content: "effect-once" } });
    const source = await DshHostClient.connect(newConnection.endpoint);
    const after = await source.eventsAfter(binding.sessionId, -1);
    await source.close();
    expect(after.records.slice(0, before.records.length)).toEqual(before.records);
    const history = await backend.client.getThreadMessages({ userId: actorId, threadId: crashed.input.threadId });
    expect(history.messages.some(message => message.role === "assistant" && message.content === "The approved effect completed once.")).toBe(true);
    expect(await countCards(crashed.input.threadId)).toBe(1);
    expect(await backend.inbox.isPaused(crashed.input.threadId)).toBe(true);
    expect((await backend.inbox.list(crashed.input.threadId)).find(item => item.id === supplement.id)?.status).toBe("paused");
    expect(JSON.stringify(providerInputs.at(-1))).not.toContain(supplement.content);

    // Autonomous approval gaps release their slot. A durable decision must re-enter the same
    // account budget before executing the original effect, including Stop/Edit during that wait.
    const autonomous = createTurnRunner({ intelligence: backend.client, runner: backend.runner, buildAgentFor: async input => agent(input.initiator) });
    const autonomousResume = createConfirmationResumer({ database, backend, confirmations, buildAgentFor: async input => agent(input.initiator), runTurn: autonomous });
    const waiting: { threadId: string; requestId: string }[] = [];
    for (const suffix of ["continue", "stop", "edit"]) {
      const threadId = `${actorId}-capacity-${suffix}`;
      const suspension = await autonomous({ ownerUserId: actorId, agentId: botId, threadId, routineId: `capacity:${suffix}`, instruction: "Perform the approved counter once." }).catch(error => error);
      expect(suspension?.name, JSON.stringify({ error: String(suspension), logs, bridgeErrors })).toBe("HeadlessToolSuspension");
      const cards = await confirmations.list(actorId, { threadId });
      expect(cards).toHaveLength(1);
      waiting.push({ threadId, requestId: cards[0]!.id });
      expect(await backgroundCount(sql, actorId)).toBe(0);
    }
    const release: (() => Promise<void>)[] = [];
    for (const suffix of ["a", "b"]) {
      const threadId = `${actorId}-occupied-${suffix}`, runId = `occupied:${suffix}`;
      await backend.client.getOrCreateThread({ threadId, userId: actorId, agentId: botId });
      await backend.capacity.enqueue(threadId, runId, { ...executionClass({ kind: "routine", id: `occupied:${suffix}` }), input: { threadId, runId, messages: [], state: {}, tools: [], context: [] } });
      expect(await backend.capacity.claim(actorId, threadId, runId)).toBe("claimed");
      release.push(async () => { await backend.capacity.releaseReservation(threadId, runId); await backend.capacity.stop(threadId, runId); });
    }
    for (const item of waiting) await confirmations.decide(actorId, item.requestId, "approve");
    const resumed = autonomousResume(actorId, waiting[0]!.requestId);
    const stopped = autonomousResume(actorId, waiting[1]!.requestId).catch(error => error);
    const edited = autonomousResume(actorId, waiting[2]!.requestId).catch(error => error);
    await Bun.sleep(80);
    expect(effects).toBe(2); expect(await backgroundCount(sql, actorId)).toBe(2);
    await backend.runner.stop({ threadId: waiting[1]!.threadId });
    const editedBinding = (await bindings.get(waiting[2]!.threadId))!;
    await bindings.getOrCreate({ threadId: waiting[2]!.threadId, ownerUserId: actorId, botId, runtimeId: editedBinding.runtimeId, revision: editedBinding.revision + 1 });
    expect(String(await stopped)).toContain("停止"); expect(String(await edited)).toContain("编辑");
    expect(effects).toBe(2);
    await release[0]!(); await resumed; await autonomousResume(actorId, waiting[0]!.requestId);
    expect(effects).toBe(3); await release[1]!();
    expect(await backgroundCount(sql, actorId)).toBe(0);
  } finally {
    for (const close of resources.reverse()) await close();
  }
}, 120_000);
