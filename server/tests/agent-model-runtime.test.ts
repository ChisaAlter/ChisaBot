import { expect, test } from "bun:test";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { registeredAgentFromRow } from "../src/conversation-runtime";
import {
  resolveScopedAgentModelConnection,
  resolveScopedModelConnection,
  withModelConnectionScope,
} from "../src/model-connection-context";

const builtIn = (id: string, model: string) =>
  registeredAgentFromRow({
    id,
    name: id,
    type: "built_in",
    title: "Test",
    roleDescription: "Reply.",
    configuration: { systemPrompt: "Reply." },
    override: { model, untouched: true },
  } as Parameters<typeof registeredAgentFromRow>[0]);

async function requestedModel(agent: unknown) {
  const config = (agent as { config: { model: unknown } }).config;
  await (
    config.model as { doGenerate(input: unknown): Promise<unknown> }
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
}

test("different BOT selections send full independent model IDs through one shared gateway", async () => {
  const models: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      models.push(body.model);
      expect(request.headers.get("authorization")).toBe("Bearer gateway-key");
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      return Response.json({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const first = builtIn("first", "vendor-a/full/model-id")!;
  const second = builtIn("second", "vendor-b/other-model")!;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [first, second],
    model: { provider: "openai", defaultModel: "old-default" },
    resolveModelApiKey: async () => null,
    resolveConnection: async () => ({
      model: {
        provider: "openai",
        defaultModel: "gateway-default",
        baseUrl: `${server.url.origin}/v1`,
      },
      apiKey: "gateway-key",
    }),
  });
  try {
    const agents = await resolver.resolveAgentsForActor({
      id: "owner",
      role: "admin",
    });
    await requestedModel(agents.first);
    await requestedModel(agents.second);
    expect(models).toEqual(["vendor-a/full/model-id", "vendor-b/other-model"]);
  } finally {
    server.stop(true);
  }
});

test("BOT row conversion preserves a selection only on locally executed BOTs", () => {
  expect(builtIn("bot", "vendor/model")).toMatchObject({
    model: "vendor/model",
  });
  const legacy = registeredAgentFromRow({
    id: "old",
    name: "Old",
    type: "built_in",
    title: "Test",
    roleDescription: "Reply.",
    configuration: { systemPrompt: "Reply." },
  });
  expect(legacy).not.toHaveProperty("model");
  const remote = registeredAgentFromRow({
    id: "remote",
    name: "Remote",
    type: "remote_ag_ui",
    title: "Test",
    roleDescription: "Reply.",
    configuration: { endpoint: "https://remote.example.test/ag-ui" },
    override: { model: "ignored" },
  } as Parameters<typeof registeredAgentFromRow>[0]);
  expect(remote).not.toHaveProperty("model");
});

test("policy and execution retain one BOT choice while new turns and other BOTs use their own snapshots", async () => {
  const seen: { model: string; key: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { model } = (await request.json()) as { model: string };
      seen.push({ model, key: request.headers.get("authorization") });
      return Response.json({
        id: "test",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  let key = "original-key";
  const selections = new Map([
    ["first", "vendor/first"],
    ["second", "vendor/second"],
  ]);
  let globalReads = 0;
  const botReads: string[] = [];
  const globalConnection = () =>
    resolveScopedModelConnection(async () => {
      globalReads++;
      return {
        model: {
          provider: "openai" as const,
          defaultModel: "default",
          baseUrl: `${server.url.origin}/v1`,
        },
        apiKey: key,
      };
    });
  const resolveFor = (id: string) =>
    resolveScopedAgentModelConnection(id, async () => {
      botReads.push(id);
      const connection = await globalConnection();
      return {
        ...connection,
        model: { ...connection.model, defaultModel: selections.get(id)! },
      };
    });
  const resolveBuiltInModel = async (_: unknown, id: string) => {
    const { model } = await resolveFor(id);
    return `${model.provider}/${model.defaultModel}`;
  };
  const deps = undefined;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      builtIn("first", selections.get("first")!)!,
      builtIn("second", selections.get("second")!)!,
    ],
    model: { provider: "openai", defaultModel: "unused" },
    resolveModelApiKey: async () => null,
    resolveConnection: globalConnection,
    resolveConnectionForAgent: resolveFor,
  });
  const owner = { id: "owner", role: "admin" as const };
  try {
    await withModelConnectionScope(async () => {
      expect(await resolveBuiltInModel(deps, "first")).toBe(
        "openai/vendor/first",
      );
      selections.set("first", "vendor/new-first");
      key = "rotated-key";
      await requestedModel(await resolver.resolveAgentForActor(owner, "first"));
      await requestedModel(
        await resolver.resolveAgentForActor(owner, "second"),
      );
      expect((await globalConnection()).model.defaultModel).toBe("default");
    });
    await withModelConnectionScope(async () => {
      expect(await resolveBuiltInModel(deps, "first")).toBe(
        "openai/vendor/new-first",
      );
      await requestedModel(await resolver.resolveAgentForActor(owner, "first"));
    });
    expect(seen).toEqual([
      { model: "vendor/first", key: "Bearer original-key" },
      { model: "vendor/second", key: "Bearer original-key" },
      { model: "vendor/new-first", key: "Bearer rotated-key" },
    ]);
    expect(globalReads).toBe(2);
    expect(botReads).toEqual(["first", "second", "first"]);
  } finally {
    server.stop(true);
  }
});

test("a failed BOT snapshot is cached for that turn and a later turn retries without poisoning other BOTs", async () => {
  let reads = 0;
  const resolve = async () => {
    if (++reads === 1) throw new Error("unavailable");
    return {
      model: { provider: "openai" as const, defaultModel: "model" },
      apiKey: null,
    };
  };
  await withModelConnectionScope(async () => {
    await expect(
      resolveScopedAgentModelConnection("bot", resolve),
    ).rejects.toThrow("unavailable");
    await expect(
      resolveScopedAgentModelConnection("bot", resolve),
    ).rejects.toThrow("unavailable");
    expect(
      (await resolveScopedAgentModelConnection("other", resolve)).model
        .defaultModel,
    ).toBe("model");
  });
  expect(
    (
      await withModelConnectionScope(() =>
        resolveScopedAgentModelConnection("bot", resolve),
      )
    ).model.defaultModel,
  ).toBe("model");
  expect(reads).toBe(3);
});
