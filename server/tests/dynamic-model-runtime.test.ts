import { expect, test } from "bun:test";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { builtInAgentConfiguration } from "../src/conversation-runtime";
import { createModelCompleter } from "../src/routing/model";

function endpoint() {
  const seen: { path: string; key: string | null; model: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("authorization"),
        model: body.model,
      });
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
  return { server, seen };
}

const agent = {
  id: "bot",
  name: "Bot",
  type: "built_in" as const,
  systemPrompt: "Work.",
};

async function generate(model: unknown) {
  expect(typeof model).toBe("object");
  return (
    model as { doGenerate: (input: unknown) => Promise<unknown> }
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
}

test("built-in models use a request-scoped endpoint and explicit no-key mode", async () => {
  const { server, seen } = endpoint();
  try {
    const config = builtInAgentConfiguration(
      agent,
      {
        provider: "openai",
        defaultModel: "local-model",
        baseUrl: `${server.url.origin}/custom/v1`,
        useApiKey: false,
      },
      null,
    );
    await generate((config as { model?: unknown }).model);
    expect(seen).toEqual([
      { path: "/custom/v1/chat/completions", key: null, model: "local-model" },
    ]);
  } finally {
    server.stop(true);
  }
});

test("actor resolution picks up complete model snapshots without mixing keys or changing environment", async () => {
  const { server, seen } = endpoint();
  const prior = process.env.OPENAI_BASE_URL;
  let revision = 0;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [agent],
    model: { provider: "openai", defaultModel: "old" },
    resolveModelApiKey: async () => {
      throw new Error("must use snapshot key");
    },
    resolveConnection: async () => {
      const id = ++revision;
      return {
        model: {
          provider: "openai" as const,
          defaultModel: `model-${id}`,
          baseUrl: `${server.url.origin}/revision-${id}/v1`,
        },
        apiKey: `key-${id}`,
      };
    },
  });
  try {
    const first = await resolver.resolveAgentForActor(
      { id: "owner", role: "admin" },
      "bot",
    );
    const second = await resolver.resolveAgentForActor(
      { id: "owner", role: "admin" },
      "bot",
    );
    await Promise.all(
      [first, second].map((a) =>
        generate((a as unknown as { config: { model: unknown } }).config.model),
      ),
    );
    expect(seen.sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      {
        path: "/revision-1/v1/chat/completions",
        key: "Bearer key-1",
        model: "model-1",
      },
      {
        path: "/revision-2/v1/chat/completions",
        key: "Bearer key-2",
        model: "model-2",
      },
    ]);
    expect(process.env.OPENAI_BASE_URL).toBe(prior);
    expect(revision).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("routing and skill completion follow each saved snapshot including exact gateway paths", async () => {
  const { server, seen } = endpoint();
  let revision = 0;
  const complete = createModelCompleter({
    model: { provider: "openai", defaultModel: "old" },
    resolveApiKey: async () => null,
    resolveConnection: async () => ({
      model: {
        provider: "openai",
        defaultModel: `route-${++revision}`,
        baseUrl: `${server.url.origin}/gateway/custom`,
        useApiKey: false,
      },
      apiKey: null,
    }),
  });
  try {
    expect(await complete("hello")).toBe("ok");
    expect(await complete("again")).toBe("ok");
    expect(seen.map((r) => r.model)).toEqual(["route-1", "route-2"]);
    expect(
      seen.every(
        (r) => r.path === "/gateway/custom/chat/completions" && r.key === null,
      ),
    ).toBe(true);
  } finally {
    server.stop(true);
  }
});
