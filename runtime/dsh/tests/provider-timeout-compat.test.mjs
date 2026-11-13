import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// Use short transport defaults to detect both hidden header and body deadlines.
const previousDispatcher = getGlobalDispatcher();
const dispatcher = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
setGlobalDispatcher(dispatcher);
await import("../src/provider-timeout-compat.mjs");
after(async () => {
  setGlobalDispatcher(previousDispatcher);
  await dispatcher.close();
});

test("native fetch preserves the dispatcher but disables header and body idle deadlines", async (t) => {
  const server = createServer(async (_request, response) => {
    await delay(1500);
    response.writeHead(200);
    response.write("first");
    await delay(1500);
    response.end("last");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), "firstlast");
});

for (const [name, module] of [
  ["OpenAI", "openai"],
  ["Anthropic", "@anthropic-ai/sdk"],
]) {
  test(`${name}: zero disables the SDK deadline, positive deadlines and caller stop still work`, async () => {
    const { default: Sdk } = await import(module);
    const call = (client, signal) =>
      name === "OpenAI"
        ? client.chat.completions.create(
            { model: "fixture", messages: [] },
            { signal },
          )
        : client.messages.create(
            { model: "fixture", messages: [], max_tokens: 16 },
            { signal },
          );
    const make = (timeout, fetch) =>
      new Sdk({
        apiKey: "fixture-not-a-real-key",
        baseURL: "http://127.0.0.1:1",
        maxRetries: 0,
        timeout,
        fetch,
      });
    await call(
      make(0, async (_url, init) => {
        await delay(60);
        assert.equal(init.signal.aborted, false);
        return Response.json({ id: "fixture", content: [], choices: [] });
      }),
    );
    const hang = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    await assert.rejects(call(make(20, hang)), /timed out/i);
    const controller = new AbortController();
    const stopped = call(make(0, hang), controller.signal);
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(stopped, /abort/i);
    } finally {
      clearTimeout(timer);
    }
  });
}
