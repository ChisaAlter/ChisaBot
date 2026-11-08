import { expect, test } from "bun:test";
import { createModelConnectionProxy } from "../src/conversations/model-connection-proxy";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { DshHostClient } from "../../runtime/dsh/src/client.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test.each(["openai", "anthropic"] as const)("keyless %s target receives the streaming model request without credentials", async provider => {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ url: request.url, headers: request.headers, body: await request.json() });
    return new Response('data: {"answer":"ready"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const run = new AbortController();
    const proxy = createModelConnectionProxy({ provider, baseUrl: target.url.toString(), useApiKey: false }, ["keyless-model"], ["read_value"], run.signal);
    const body = { model: "keyless-model", stream: true, messages: [{ role: "user", content: "Read one value." }],
      tools: provider === "openai" ? [{ type: "function", function: { name: "read_value", parameters: { type: "object" } } }] : [{ name: "read_value", input_schema: { type: "object" } }],
    };
    const reply = await proxy(body, new AbortController().signal);
    expect(reply.headers.get("content-type")).toBe("text/event-stream");
    expect(await reply.text()).toContain('data: {"answer":"ready"}');
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(provider === "openai" ? "/v1/chat/completions" : "/v1/messages");
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.headers.get("x-api-key")).toBeNull();
    expect(requests[0]!.body).toEqual(body);
    expect((await proxy({ ...body, model: "not-granted" }, run.signal)).status).toBe(403);
    expect((await proxy({ ...body, tools: [{ name: "not-granted", function: { name: "not-granted" } }] }, run.signal)).status).toBe(403);
    expect(requests).toHaveLength(1);
    run.abort();
    await expect(proxy(body, new AbortController().signal)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  } finally { target.stop(true); }
});

test("Anthropic proxy preserves a custom API prefix and configured key", async () => {
  let observed: { path: string; key: string | null; authorization: string | null } | undefined;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    observed = { path: new URL(request.url).pathname, key: request.headers.get("x-api-key"), authorization: request.headers.get("authorization") };
    return Response.json({ ok: true });
  } });
  try {
    const run = new AbortController();
    const proxy = createModelConnectionProxy({ provider: "anthropic", baseUrl: `${target.url.origin}/custom/prefix`, apiKey: "configured-fixture-key" }, ["model"], [], run.signal);
    expect((await proxy({ model: "model" }, run.signal)).status).toBe(200);
    expect(observed).toEqual({ path: "/custom/prefix/messages", key: "configured-fixture-key", authorization: null });
    const missing = createModelConnectionProxy({ provider: "anthropic", baseUrl: target.url.origin }, ["model"], [], run.signal);
    expect((await missing({ model: "model" }, run.signal)).status).toBe(401);
  } finally { target.stop(true); }
});

test("real DSH Host authenticates to the gateway while both keyless provider protocols receive no key", async () => {
  const requests: { path: string; authorization: string | null; apiKey: string | null }[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    const path = new URL(request.url).pathname;
    requests.push({ path, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key") });
    const data = path.endsWith("messages") ? [
      { type: "message_start", message: { id: "reply", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "keyless-ready" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : [
      { role: "assistant", content: "keyless-ready" }, {},
    ].map((delta, index) => `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(data, { headers: { "content-type": "text/event-stream" } });
  } });
  const gateway = createDshToolGateway({} as never);
  const gatewayPaths: string[] = [];
  const gatewayServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => { gatewayPaths.push(new URL(request.url).pathname); return gateway.routes.fetch(request); } });
  const cwd = resolve(import.meta.dir, "../../runtime/dsh");
  const root = join(cwd, ".runtime");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "keyless-"));
  await writeFile(join(home, "chisabot.json"), JSON.stringify({ ownerUserId: "keyless-owner", port: 0, providers: {}, gatewayUrl: gatewayServer.url.toString() }));
  const host = spawn("node", ["src/start.mjs"], { cwd, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  host.stdout.on("data", value => { output += value; }); host.stderr.on("data", value => { output += value; });
  let client: DshHostClient | undefined;
  try {
    for (let n = 0; n < 600 && !output.includes("chisabot-runtime-ready") && host.exitCode === null; n++) await delay(100);
    expect(output).toContain("chisabot-runtime-ready");
    client = await DshHostClient.connect(JSON.parse(await readFile(join(home, "connection.json"), "utf8")).endpoint);
    const health = await client.health();
    for (const provider of ["openai", "anthropic"] as const) {
      const identity = { sessionId: provider, threadId: provider, runId: provider, actorId: "keyless-owner", botId: "bot", revision: 1, generation: health.generation };
      const run = new AbortController();
      const registered = gateway.register({ bindingId: provider, identity, input: { threadId: provider, runId: provider, state: {}, tools: [], context: [], messages: [] }, signal: run.signal,
        tools: [], continuationMessages: async () => [], modelProxy: createModelConnectionProxy({ provider, baseUrl: target.url.toString(), useApiKey: false }, ["keyless-model"], [], run.signal) });
      await client.bind({ ...identity, prompt: "Answer briefly.", tools: [], model: { primary: { provider: "configured", model: "keyless-model" } },
        connection: { api: provider === "openai" ? "openai-completions" : "anthropic-messages", baseURL: `${gatewayServer.url.toString().replace(/\/$/, "")}/model${provider === "anthropic" ? "" : "/v1"}`, apiKey: registered.capability, modelProxy: true,
          models: [{ id: "keyless-model", contextWindow: 32000, maxTokens: 1024, input: ["text"] }] } });
      await client.prompt({ sessionId: provider, requestId: `ask-${provider}`, mode: "queue", content: [{ type: "text", text: "Reply." }] });
      expect((await client.wait(provider, { timeoutMs: 10000 })).reason).toBe("idle");
      const events = (await client.events(provider)).records.map(record => record.event);
      if (!events.some(event => event.type === "assistant/message")) throw new Error(`${provider}: ${JSON.stringify(events.at(-1))}; requests=${JSON.stringify(requests)}; paths=${gatewayPaths}; host=${output}`);
      expect(events.filter(event => event.type === "assistant/message")).toHaveLength(1);
      expect(JSON.stringify(events)).toContain("keyless-ready");
      registered.close();
    }
    expect(requests).toEqual([
      { path: "/v1/chat/completions", authorization: null, apiKey: null },
      { path: "/v1/messages", authorization: null, apiKey: null },
    ]);
  } finally {
    await client?.close();
    if (host.exitCode === null) { const stopped = once(host, "exit"); host.kill(); await stopped; }
    gatewayServer.stop(true); target.stop(true);
  }
}, 100000);
