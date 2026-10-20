import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { Observable } from "rxjs";
import { z } from "zod/v4";
import { sanitizeSeededHistory } from "../src/agents/history-sanitize";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function collect(stream: Observable<BaseEvent>) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) });
  });
}

suite("queued supplements across frontend wire runs", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `inbox-test-${randomUUID()}`;
  const bot = `${owner}-bot`;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.unsafe("DELETE FROM chisabot_thread_inbox WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });
  async function post(threadId: string, operation: string, body: unknown) {
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), owner);
    expect(response?.status).toBe(200);
    return response!.json();
  }
  async function fixture(failTool = false) {
    const threadId = `${owner}-${randomUUID()}`;
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const generated = deferred();
    const finishGeneration = deferred();
    const toolStarted = deferred();
    const finishTool = deferred();
    let modelRuns = 0;
    let executions = 0;
    const inputs: Message[][] = [];
    class ProbeModel extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          void (async () => {
            modelRuns++;
            const messages = sanitizeSeededHistory(input.messages);
            inputs.push(structuredClone(messages));
            subscriber.next({ type: EventType.RUN_STARTED, threadId, runId: input.runId } as BaseEvent);
            if (!messages.some((message) => message.role === "tool" && message.toolCallId === "probe-call")) {
              subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}`, toolCallName: "computer_run_command", parentMessageId: `command-${modelRuns}` } as BaseEvent);
              subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}`, delta: JSON.stringify({ command: `append log; sleep ${modelRuns === 1 ? 10 : 11}` }) } as BaseEvent);
              subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}` } as BaseEvent);
              generated.resolve();
              await finishGeneration.promise;
            } else {
              subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
              subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "ONCE_FOLLOWUP_OK" } as BaseEvent);
              subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
            }
            subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId: input.runId } as BaseEvent);
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        });
      }
    }
    class BrowserAgent extends AbstractAgent {
      run(input: RunAgentInput) {
        return backend.runner.run({ threadId, agent: new ProbeModel({ agentId: bot, threadId }), input });
      }
    }
    const agent = new BrowserAgent({ agentId: bot, threadId, initialMessages: [{ id: "primary", role: "user", content: "Run the probe exactly once" }] });
    const core = new CopilotKitCore({ agents__unsafe_dev_only: { [bot]: agent }, tools: [{
      name: "computer_run_command", description: "Probe", parameters: z.object({ command: z.string() }),
      handler: async () => { executions++; toolStarted.resolve(); await finishTool.promise; if (failTool) throw new Error("command failed"); return "ONCE_DONE; log_lines=1"; },
    }] });
    return { threadId, agent, core, generated, finishGeneration, toolStarted, finishTool, inputs,
      counts: () => ({ modelRuns, executions }) };
  }

  test("early and tool-time supplements wait for the original result; the SDK executes one call", async () => {
    const f = await fixture();
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      await post(f.threadId, "inbox", { id: "early", text: "Keep the original command; do not rerun" });
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
      expect(f.agent.isRunning).toBe(false);
      expect(backend.control.isActive(f.threadId)).toBe(true);
      expect(await backend.runner.isRunning({ threadId: f.threadId })).toBe(true);
      expect(await post(f.threadId, "inbox", { id: "during-tool", text: "Add ONCE_FOLLOWUP_OK after it completes" })).toEqual({ queued: true, status: "queued" });
      const parked = await collect(backend.runner.run({ threadId: f.threadId, agent: new class extends AbstractAgent {
        run(): Observable<BaseEvent> { throw new Error("A parked send must not run a model"); }
      }({ agentId: bot }), input: { threadId: f.threadId, runId: randomUUID(), messages: [{ id: "other-device", role: "user", content: "Another supplement" }], state: {}, tools: [], context: [], forwardedProps: {} } }));
      expect(parked.filter((event) => event.type === EventType.TOOL_CALL_START)).toHaveLength(0);
      expect((await backend.inbox.queued(f.threadId)).map((item) => item.id)).toEqual(["early", "during-tool", "other-device"]);
      f.finishTool.resolve();
      await turn;
      expect(f.counts()).toEqual({ modelRuns: 2, executions: 1 });
      expect(backend.control.isActive(f.threadId)).toBe(false);
      const input = f.inputs[1]!;
      const resultAt = input.findIndex((message) => message.role === "tool" && message.toolCallId === "probe-call");
      expect(resultAt).toBeGreaterThan(0);
      for (const id of ["early", "during-tool", "other-device"]) expect(input.findIndex((message) => message.id === id)).toBeGreaterThan(resultAt);
      const history = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(history.messages.flatMap((message) => message.toolCalls ?? [])).toHaveLength(1);
      expect((await backend.inbox.list(f.threadId)).every((item) => item.status === "answered")).toBe(true);
    } finally {
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test("Stop during lease cleanup removes the relay before active is deleted", async () => {
    const f = await fixture();
    const cleanupReached = deferred();
    const releaseCleanup = deferred();
    const cleanup = backend.client.ɵcleanupThreadLock.bind(backend.client);
    backend.client.ɵcleanupThreadLock = async (identity) => {
      if (identity.threadId === f.threadId) {
        cleanupReached.resolve();
        await releaseCleanup.promise;
      }
      await cleanup(identity);
    };
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await cleanupReached.promise;
      // Both active and relay exist here, and the browser has not received RUN_FINISHED.
      await post(f.threadId, "inbox", { id: "cleanup-queued", text: "Stay queued after Stop" });
      const [run] = await database.$client.unsafe<{ run_id: string }[]>(
        "SELECT run_id FROM openbot_local_threads WHERE id = $1", [f.threadId],
      );
      expect(await backend.runner.stop({ threadId: f.threadId, runId: "stale" })).toBe(false);
      f.core.stopAgent({ agent: f.agent });
      expect(await backend.runner.stop({ threadId: f.threadId, runId: run!.run_id })).toBe(true);
      releaseCleanup.resolve();
      await turn;
      // Stop detaches the browser before server cleanup completes, so wait for that cleanup
      // explicitly rather than using the already-resolved browser promise as a completion signal.
      for (let attempt = 0; attempt < 100 && backend.control.isActive(f.threadId); attempt++) await Bun.sleep(5);
      expect(backend.control.isActive(f.threadId)).toBe(false);
      expect(await backend.runner.isRunning({ threadId: f.threadId })).toBe(false);
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 0 });
      expect((await backend.inbox.queued(f.threadId)).map((item) => item.id)).toEqual(["cleanup-queued"]);
      const [saved] = await database.$client.unsafe<{ status: string }[]>(
        "SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2", [f.threadId, run!.run_id],
      );
      expect(saved?.status).toBe("stopped");
    } finally {
      backend.client.ɵcleanupThreadLock = cleanup;
      releaseCleanup.resolve(); f.finishGeneration.resolve(); f.finishTool.resolve();
      await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test.each(["snapshot", "newer-run"])("frontend result compare-and-set refuses a changed %s", async (changed) => {
    const f = await fixture(true);
    const turn = f.core.runAgent({ agent: f.agent });
    const updateReached = deferred();
    const releaseUpdate = deferred();
    const unsafe = database.$client.unsafe.bind(database.$client);
    let intercepted = false;
    let completing: Promise<unknown> | undefined;
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      f.finishTool.resolve();
      await turn;
      const results = f.agent.messages.filter((message) => message.role === "tool");
      database.$client.unsafe = (async (...args: Parameters<typeof unsafe>) => {
        if (!intercepted && String(args[0]).includes("UPDATE openbot_local_threads t SET messages")) {
          intercepted = true;
          updateReached.resolve();
          await releaseUpdate.promise;
        }
        return unsafe(...args);
      }) as typeof database.$client.unsafe;
      completing = post(f.threadId, "frontend-finished", { results });
      await updateReached.promise;
      if (changed === "snapshot") {
        await unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [f.threadId, JSON.stringify([{ id: "revised", role: "user", content: "New canonical snapshot" }])]);
      } else {
        // Even identical history must not authorize an older relay after a newer run finished.
        await unsafe("INSERT INTO openbot_local_runs (thread_id, run_id, status, created_at) VALUES ($1, $2, 'finished', clock_timestamp())", [f.threadId, randomUUID()]);
      }
      releaseUpdate.resolve();
      expect(await completing).toEqual({ finished: false });
      expect(backend.control.isActive(f.threadId)).toBe(true);
      const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(saved.messages.some((message) => message.toolCallId === "probe-call")).toBe(false);
      if (changed === "snapshot") expect(saved.messages.map((message) => message.id)).toEqual(["revised"]);
    } finally {
      releaseUpdate.resolve();
      await completing;
      database.$client.unsafe = unsafe;
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test.each(["failed", "stopped"])("%s frontend completion releases relay but leaves supplements queued", async (outcome) => {
    const f = await fixture(outcome === "failed");
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      await post(f.threadId, "inbox", { id: "queued", text: "Never rerun the probe" });
      expect(await backend.runner.stop({ threadId: f.threadId, runId: "stale" })).toBe(false);
      if (outcome === "stopped") {
        f.core.stopAgent({ agent: f.agent });
        expect(await backend.runner.stop({ threadId: f.threadId })).toBe(true);
      } else {
        // Let the real SDK handler fail: it saves a result locally, without a follow-up /run.
        f.finishTool.resolve();
        await turn;
        expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
        expect(await post(f.threadId, "frontend-finished", { results: [{ id: "failed-result", role: "tool", toolCallId: "unrelated", content: "Error: no" }] })).toEqual({ finished: false });
        const results = f.agent.messages.filter((message) => message.role === "tool");
        expect(await post(f.threadId, "frontend-finished", { results })).toEqual({ finished: true });
      }
      f.finishTool.resolve();
      await turn;
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
      expect(backend.control.isActive(f.threadId)).toBe(false);
      expect((await backend.inbox.queued(f.threadId)).map((item) => item.id)).toEqual(["queued"]);
      const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(saved.messages.some((message) => message.id === "queued")).toBe(false);
      if (outcome === "failed") expect(saved.messages.find((message) => message.toolCallId === "probe-call")?.content).toBe("Error: command failed");
    } finally {
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });
});
