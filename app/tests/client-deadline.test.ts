import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { client, tryClient } from "../src/lib/client";

// Real fetch rather than a mock: the deadline must remain attached to a response after headers.
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls++;
      const path = new URL(request.url).pathname;
      if (path === "/headers") {
        await Bun.sleep(200);
        return Response.json({ value: "late" });
      }
      if (path === "/body") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"value":'));
            setTimeout(() => { try { controller.enqueue(new TextEncoder().encode('"late"}')); controller.close(); } catch {} }, 200);
          },
        }), { headers: { "content-type": "application/json" } });
      }
      return Response.json({ value: "ok" });
    },
  });
});
afterAll(() => server.stop(true));
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

describe("request lifetime", () => {
  test("a cancellation-only query signal still has a deadline", async () => {
    const owner = new AbortController();
    await expect(client(url("/headers"), "value", { signal: owner.signal, timeoutMs: 30 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(owner.signal.aborted).toBe(false);
  });

  test("body reading has the same deadline after tryClient returns headers", async () => {
    const response = await tryClient(url("/body"), { signal: new AbortController().signal, timeoutMs: 40 });
    await expect(response.json()).rejects.toBeDefined();
  });

  test("caller cancellation wins immediately without changing its reason", async () => {
    const owner = new AbortController();
    const reason = new Error("user stopped");
    const pending = client(url("/headers"), { signal: owner.signal, timeoutMs: 1000 });
    owner.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("query callers cannot silently remove the default deadline", async () => {
    const realFetch = globalThis.fetch;
    const realTimeout = AbortSignal.timeout;
    const budgets: number[] = [];
    AbortSignal.timeout = ((milliseconds: number) => {
      budgets.push(milliseconds);
      return realTimeout(milliseconds === 30_000 ? 20 : milliseconds);
    }) as typeof AbortSignal.timeout;
    try {
      await expect(client(url("/headers"), { signal: new AbortController().signal })).rejects.toBeDefined();
      expect(budgets).toEqual([30_000]);
    } finally {
      AbortSignal.timeout = realTimeout;
      globalThis.fetch = realFetch;
    }
  });

  test("an explicit long-action budget completes without an ordinary read cutoff", async () => {
    await expect(client(url("/headers"), "value", { signal: new AbortController().signal, timeoutMs: 1000 })).resolves.toBe("late");
  });

  test("no retry replays a timed-out write", async () => {
    const before = calls;
    await expect(client(url("/headers"), { method: "POST", body: { write: true }, timeoutMs: 30 })).rejects.toBeDefined();
    await Bun.sleep(50);
    expect(calls - before).toBe(1);
  });

  test("explicit no-deadline mode still respects caller cancellation", async () => {
    const owner = new AbortController();
    const pending = tryClient(url("/headers"), { signal: owner.signal, timeoutMs: 0 });
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
