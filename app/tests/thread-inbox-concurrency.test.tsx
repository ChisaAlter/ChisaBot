import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Observable, of } from "rxjs";
import { z } from "zod/v4";
import { queueMessage, queuedFor, takeQueued } from "../src/lib/copilot/thread-inbox";
import { useThreadInbox } from "../src/lib/copilot/use-thread-inbox";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
let threadId: string;
let serverRunning = false;
let status = "queued";
let stateReads = 0;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST") return NativeResponse.json({ queued: true, status: "queued" });
    stateReads++;
    return NativeResponse.json({ running: serverRunning, items: queuedFor(threadId).map((item) => ({ id: item.id, kind: "message", status, message: { content: item.text } })) });
  }, { preconnect: originalFetch.preconnect });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  takeQueued(threadId);
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mount(agent: AbstractAgent, run: () => Promise<unknown>, running = false, canFlush: () => boolean = () => true) {
  const client = new QueryClient();
  clients.push(client);
  let setRunning!: (value: boolean) => void;
  function Inbox() {
    const [busy, update] = useState(running);
    setRunning = update;
    useThreadInbox(threadId, agent as never, run, { pullServerTurns: false, turnRunning: busy, canFlush });
    return null;
  }
  render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
  return { setRunning };
}

class EmptyAgent extends AbstractAgent {
  run(input: RunAgentInput) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ) as Observable<BaseEvent>;
  }
}

function reset() {
  threadId = crypto.randomUUID();
  serverRunning = false;
  status = "queued";
  stateReads = 0;
}

test("a server tool keeps supplements parked until its result is durably consumed", async () => {
  reset();
  const toolStarted = deferred();
  const finishTool = deferred();
  let executions = 0;
  class ToolAgent extends AbstractAgent {
    run(input: RunAgentInput) {
      return new Observable<BaseEvent>(subscriber => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        subscriber.next({ type: EventType.TOOL_CALL_START, parentMessageId: "command", toolCallId: "call-1", toolCallName: "computer_run_command" });
        subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"command":"run once"}' });
        subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" });
        serverRunning = true;
        executions++;
        toolStarted.resolve();
        void finishTool.promise.then(() => {
          status = "read";
          serverRunning = false;
          subscriber.next({ type: EventType.TOOL_CALL_RESULT, messageId: "result", toolCallId: "call-1", role: "tool", content: "ONCE_DONE" });
          subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
          subscriber.complete();
        });
      });
    }
  }
  const agent = new ToolAgent({ agentId: "bot", threadId });
  let fallbackRuns = 0;
  const view = mount(agent, async () => { fallbackRuns++; }, true);
  const turn = agent.runAgent();
  try {
    await toolStarted.promise;
    await queueMessage(threadId, "Keep the original command running", "followup");
    await act(async () => { await pause(400); });
    expect(fallbackRuns).toBe(0);
    expect(executions).toBe(1);
    expect(queuedFor(threadId)).toHaveLength(1);
    finishTool.resolve();
    await act(async () => { await turn; view.setRunning(false); });
    await waitFor(() => expect(queuedFor(threadId)).toHaveLength(0));
    expect(fallbackRuns).toBe(0);
    expect(executions).toBe(1);
  } finally { finishTool.resolve(); await turn; }
});

test("server relay and an unseen read claim prevent fallback even while the browser is idle", async () => {
  reset();
  serverRunning = true;
  const agent = new EmptyAgent({ threadId });
  let runs = 0;
  mount(agent, async () => { runs++; });
  await queueMessage(threadId, "Supplement", "queued");
  await act(async () => { await agent.runAgent(); await pause(350); });
  expect(runs).toBe(0);
  expect(queuedFor(threadId)).toHaveLength(1);
  serverRunning = false;
  status = "read";
  await act(async () => { await agent.runAgent(); await pause(350); });
  expect(runs).toBe(0);
  expect(queuedFor(threadId)).toHaveLength(0);
  expect(stateReads).toBeGreaterThan(0);
});

test.each(["failed", "stopped"])("%s turn keeps queued supplements without starting another run", async (outcome) => {
  reset();
  let allow = true;
  class FailedAgent extends AbstractAgent {
    run(input: RunAgentInput) {
      return of(
        { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
        outcome === "failed"
          ? { type: EventType.RUN_ERROR, message: "Tool failed" }
          : { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "cancelled" } },
      ) as Observable<BaseEvent>;
    }
  }
  const agent = new FailedAgent({ threadId });
  let runs = 0;
  const view = mount(agent, async () => { runs++; }, true, () => allow);
  await queueMessage(threadId, "Do not rerun", "queued");
  await act(async () => {
    await agent.runAgent().catch(() => {});
    allow = false;
    view.setRunning(false);
    await pause(350);
  });
  expect(runs).toBe(0);
  expect(queuedFor(threadId)).toHaveLength(1);
});
