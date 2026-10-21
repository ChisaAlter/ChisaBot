import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { of, type Observable } from "rxjs";
import { applyInboxState, inboxState, queueMessage, queuedFor, restoreQueue, sendPausedMessage, takeQueued, withdrawMessage, type InboxState } from "../src/lib/copilot/thread-inbox";
import { useThreadInbox } from "../src/lib/copilot/use-thread-inbox";

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
let impl: typeof fetch;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const body = (status: string, id = "held"): InboxState => ({ running: false, paused: status === "paused", items: [{ id, status, kind: "message", message: { content: "Keep original operation stopped" } }] });
beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => impl(...args), { preconnect: originalFetch.preconnect });
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = originalFetch; GlobalRegistrator.unregister(); });
class Empty extends AbstractAgent {
  run(input: RunAgentInput) {
    return of({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }, { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId }) as Observable<BaseEvent>;
  }
}
function mount(threadId: string, agent: Empty, run: () => Promise<unknown>) {
  const client = new QueryClient();
  function Inbox() {
    useThreadInbox(threadId, agent as never, run, { pullServerTurns: false });
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
  return { close: () => { view.unmount(); client.clear(); } };
}

test("fresh mounts on this browser and a different device restore paused rows without runs", async () => {
  for (const own of [true, false]) {
    const threadId = crypto.randomUUID();
    const id = crypto.randomUUID();
    if (own) {
      impl = (async () => NativeResponse.json({ queued: true, status: "queued" })) as unknown as typeof fetch;
      await queueMessage(threadId, "Hold", id);
      takeQueued(threadId); // browser module state gone, ownership survives in localStorage
    }
    impl = (async () => NativeResponse.json(body("paused", id))) as unknown as typeof fetch;
    let runs = 0;
    const agent = new Empty({ threadId });
    const first = mount(threadId, agent, async () => { runs++; });
    await waitFor(() => expect(queuedFor(threadId)[0]?.status).toBe("paused"));
    expect(queuedFor(threadId)[0]?.remote).toBe(own ? undefined : true);
    first.close();
    const second = mount(threadId, new Empty({ threadId }), async () => { runs++; });
    await act(async () => { await pause(350); });
    expect(runs).toBe(0);
    expect(takeQueued(threadId)).toEqual([]);
    second.close();
  }
});

test("server pause downgrades an already local queued row; stale read transcript cannot erase it", async () => {
  const threadId = crypto.randomUUID();
  impl = (async () => NativeResponse.json({ queued: true, status: "queued" })) as unknown as typeof fetch;
  await queueMessage(threadId, "Keep", "held");
  applyInboxState(threadId, body("paused"));
  const agent = new Empty({ threadId, initialMessages: [{ id: "held", role: "user", content: "Keep" }] });
  let runs = 0;
  impl = (async () => NativeResponse.json(body("paused"))) as unknown as typeof fetch;
  const view = mount(threadId, agent, async () => { runs++; });
  await act(async () => { await agent.runAgent(); await pause(350); });
  expect(runs).toBe(0);
  expect(queuedFor(threadId).map((item) => item.status)).toEqual(["paused"]);
  view.close();
});

test("deadline abort, malformed JSON and invalid state preserve the queue and permit a later read", async () => {
  const threadId = crypto.randomUUID();
  applyInboxState(threadId, body("paused"));
  impl = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as unknown as typeof fetch;
  expect(await inboxState(threadId, { timeoutMs: 15 })).toBeNull();
  expect(await withdrawMessage(threadId, "held", { timeoutMs: 15 })).toBe(false);
  expect(queuedFor(threadId)[0]?.status).toBe("paused");
  impl = (async () => new NativeResponse("not json")) as unknown as typeof fetch;
  expect(await restoreQueue(threadId)).toBeNull();
  expect(await withdrawMessage(threadId, "held")).toBe(false);
  impl = (async () => NativeResponse.json({ running: false, items: [null] })) as unknown as typeof fetch;
  expect(await inboxState(threadId)).toBeNull();
  impl = (async () => NativeResponse.json(body("paused"))) as unknown as typeof fetch;
  expect(await restoreQueue(threadId)).not.toBeNull();
  expect(queuedFor(threadId)[0]?.status).toBe("paused");
});

test("a POST committed before its lost response is not locally withdrawn until DELETE is confirmed", async () => {
  const threadId = crypto.randomUUID();
  let serverStatus = "absent";
  let posts = 0;
  let deletes = 0;
  impl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.method === "POST") { posts++; serverStatus = "queued"; throw new TypeError("response lost after commit"); }
    if (init?.method === "DELETE") { deletes++; throw new TypeError("withdraw response unavailable"); }
    throw new Error("unexpected request");
  }) as unknown as typeof fetch;
  expect(await queueMessage(threadId, "Do not execute", "lost-response")).toBe("failed");
  expect(serverStatus).toBe("queued");
  expect(await withdrawMessage(threadId, "lost-response")).toBe(false);
  expect(queuedFor(threadId)[0]?.status).toBe("failed");
  expect(takeQueued(threadId)).toEqual([]);
  expect(posts).toBe(1);
  expect(deletes).toBe(1);
  impl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(init?.method).toBe("DELETE");
    deletes++; serverStatus = "withdrawn";
    return NativeResponse.json({ withdrawn: true });
  }) as unknown as typeof fetch;
  expect(await withdrawMessage(threadId, "lost-response")).toBe(true);
  expect(serverStatus).toBe("withdrawn");
  expect(queuedFor(threadId)).toEqual([]);
  expect(posts).toBe(1);
});

test("a late original POST response cannot ask its caller to resend after confirmed withdrawal", async () => {
  const threadId = crypto.randomUUID();
  let finishPost!: (response: Response) => void;
  impl = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => init?.method === "POST"
    ? new Promise<Response>((resolve) => { finishPost = resolve; })
    : Promise.resolve(NativeResponse.json({ withdrawn: true }))) as unknown as typeof fetch;
  const sending = queueMessage(threadId, "Do not deliver late", "late-response");
  await waitFor(() => expect(typeof finishPost).toBe("function"));
  expect(await withdrawMessage(threadId, "late-response")).toBe(true);
  finishPost(NativeResponse.json({ queued: false }));
  expect(await sending).toBe("queued");
  expect(queuedFor(threadId)).toEqual([]);
});

test("paused worker results expose a safe summary and explicit send, without leaking protocol markers", () => {
  const threadId = crypto.randomUUID();
  applyInboxState(threadId, { running: false, paused: true, items: [{ id: "worker", status: "paused", kind: "worker_result", message: { content: "⟦chisabot:worker-result:worker:done⟧\n后台任务「调查」已完成。\n\nPRIVATE-LONG-RESULT" } }] });
  expect(queuedFor(threadId).map((item) => [item.text, item.kind, item.status])).toEqual([["后台任务「调查」已完成。", "worker_result", "paused"]]);
  expect(JSON.stringify(queuedFor(threadId))).not.toContain("PRIVATE-LONG-RESULT");
  expect(takeQueued(threadId)).toEqual([]);
});

test("the explicit per-row action requires a mounted handler and never auto-promotes another row", async () => {
  const threadId = crypto.randomUUID();
  applyInboxState(threadId, { running: false, paused: true, items: [...body("paused", "one").items, ...body("paused", "two").items] });
  await expect(sendPausedMessage(threadId, "one")).rejects.toThrow("请先打开");
  let requests = 0;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ threadId: string; id: string; accept: (run: () => Promise<unknown>) => void }>).detail;
    expect(detail.threadId).toBe(threadId);
    expect(detail.id).toBe("one");
    detail.accept(async () => { requests++; });
    detail.accept(async () => { requests++; }); // a hidden duplicate mount must not send twice
  };
  window.addEventListener("chisabot-send-paused", handler);
  try {
    await sendPausedMessage(threadId, "one");
    expect(requests).toBe(1);
    expect(queuedFor(threadId).map((item) => [item.id, item.status])).toEqual([["one", "paused"], ["two", "paused"]]);
  } finally { window.removeEventListener("chisabot-send-paused", handler); }
});
