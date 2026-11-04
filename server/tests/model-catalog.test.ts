import { expect, test } from "bun:test";
import {
  createModelCatalogService,
  ModelCatalogError,
} from "../src/model-catalog";
import type { ModelConnectionRuntime } from "../src/model-settings";

const connection: ModelConnectionRuntime = {
  provider: "anthropic",
  model: "stepfun/main",
  baseUrl: "http://magpie:3425/v1",
  useApiKey: true,
  apiKey: "gateway-private-test-key",
};
function response(data: unknown) {
  return new Response(JSON.stringify(data));
}
function catalogWith(
  request: (url: string, init: RequestInit) => Promise<Response>,
) {
  return createModelCatalogService({
    resolveConnection: async () => connection,
    fetch: request as typeof fetch,
  });
}

test("exposes complete chat IDs and safe metadata across upstream protocols", async () => {
  let requested = "";
  const catalog = catalogWith(async (url, init) => {
    requested = url;
    expect(new Headers(init.headers).get("x-api-key")).toBe(
      "gateway-private-test-key",
    );
    expect(init.redirect).toBe("error");
    return response({
      object: "list",
      has_more: false,
      data: [
        {
          id: "claude/main",
          display_name: "Claude",
          owned_by: "vendor",
          context_window: 200000,
          max_output_tokens: 64000,
          native_endpoints: ["anthropic"],
          api_key: "upstream-secret",
        },
        {
          id: "gpt/main",
          magpie_label: "GPT",
          native_endpoints: ["openai"],
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        { id: "group/auto", owned_by: "gpt", display_name: "自动路由" },
        { id: "gpt/main", display_name: "Duplicate" },
        { id: "paint/image", kind: "image" },
        { id: "speech/only", modalities: { output: ["audio"] } },
        { id: "bad\nmodel" },
        { id: "embedding/model", kind: "embedding" },
      ],
    });
  });
  const result = await catalog.list();
  expect(requested).toBe("http://magpie:3425/v1/models");
  expect(result.models).toEqual([
    {
      id: "claude/main",
      label: "Claude",
      provider: "claude",
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
    {
      id: "gpt/main",
      label: "GPT",
      provider: "gpt",
      supportsImages: true,
      supportsFiles: false,
    },
    { id: "group/auto", label: "自动路由", provider: "group" },
  ]);
  expect(result.fetchedAt).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("coalesces concurrent reads, caches success and refreshes newly exposed models", async () => {
  let calls = 0;
  const catalog = catalogWith(async () =>
    response({ data: [{ id: `provider/model-${++calls}` }] }),
  );
  const reads = await Promise.all([
    catalog.list(),
    catalog.list(),
    catalog.list(),
  ]);
  expect(calls).toBe(1);
  expect(reads.map((x) => x.models[0]?.id)).toEqual([
    "provider/model-1",
    "provider/model-1",
    "provider/model-1",
  ]);
  expect((await catalog.list()).models[0]?.id).toBe("provider/model-1");
  expect((await catalog.list({ refresh: true })).models[0]?.id).toBe(
    "provider/model-2",
  );
});

test("changing credentials isolates cache from an older pending catalog", async () => {
  let current = connection;
  let finishOld!: (response: Response) => void;
  let calls = 0;
  const catalog = createModelCatalogService({
    resolveConnection: async () => current,
    fetch: (async (_url, init) => {
      calls++;
      if (new Headers(init?.headers).get("x-api-key") === "new-key")
        return response({ data: [{ id: "new/model" }] });
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    }) as typeof fetch,
  });
  const old = catalog.list();
  while (!finishOld) await Promise.resolve();
  current = { ...connection, apiKey: "new-key" };
  expect((await catalog.list()).models[0]?.id).toBe("new/model");
  finishOld(response({ data: [{ id: "old/model" }] }));
  await old;
  expect((await catalog.list()).models[0]?.id).toBe("new/model");
  expect(calls).toBe(2);
});

test("failed refresh preserves the last successful catalog without pretending refresh succeeded", async () => {
  let fail = false;
  const catalog = catalogWith(async () => {
    if (fail) return new Response("upstream-secret", { status: 403 });
    return response({ data: [{ id: "valid/model" }] });
  });
  await catalog.list();
  fail = true;
  await expect(catalog.list({ refresh: true })).rejects.toBeInstanceOf(
    ModelCatalogError,
  );
  expect((await catalog.list()).models[0]?.id).toBe("valid/model");
});

test.each([
  () => response({ private_key: "response-secret" }),
  () => new Response("broken-json-secret"),
  () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  () => response({ data: [], has_more: true }),
  () => new Response("response-secret", { status: 401 }),
])(
  "malformed, partial or oversized catalogs return only safe errors",
  async (makeResponse) => {
    const catalog = catalogWith(async () => makeResponse());
    let caught: unknown;
    try {
      await catalog.list();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelCatalogError);
    expect((caught as Error).message).not.toContain("secret");
  },
);

test("catalog rows missing context metadata fall back to the known-window table", async () => {
  const catalog = catalogWith(async () =>
    response({
      data: [
        { id: "devin/swe-2", owned_by: "devin", display_name: "SWE-2" },
        { id: "devin/swe-2-high-lightning" },
        { id: "vendor/other", context_length: 99999 },
        { id: "vendor/unlisted" },
      ],
    }),
  );
  const models = (await catalog.list()).models;
  expect(models.map((m) => m.contextWindow)).toEqual([
    262144,
    262144,
    99999,
    undefined,
  ]);
});

test("missing saved credentials do not issue a gateway request", async () => {
  let calls = 0;
  const catalog = createModelCatalogService({
    resolveConnection: async () => ({ ...connection, apiKey: null }),
    fetch: (async () => {
      calls++;
      return response({ data: [] });
    }) as typeof fetch,
  });
  await expect(catalog.list()).rejects.toBeInstanceOf(ModelCatalogError);
  expect(calls).toBe(0);
});
