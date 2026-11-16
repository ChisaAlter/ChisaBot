import { describe, expect, test } from "bun:test";
import { createModelKeyPool } from "../src/conversations/key-pool";
import { decryptSecret } from "../src/credentials";
import {
  createModelSettingsService,
  type ModelSettingsSnapshot,
  type ModelSettingsStore,
  ModelSettingsValidationError,
  modelPoolId,
  parseModelConnectionInput,
} from "../src/model-settings";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const initial = {
  provider: "openai" as const,
  model: "existing-model",
  baseUrl: "https://existing.test/v1",
  useApiKey: true,
};

function memoryStore() {
  let value: ModelSettingsSnapshot | null = null;
  let refuseWrite = false;
  const store: ModelSettingsStore = {
    read: async () => structuredClone(value),
    update: async (change) => {
      const next = await change(structuredClone(value));
      if (refuseWrite) throw new Error("storage unavailable");
      value = structuredClone(next);
      return structuredClone(value);
    },
  };
  return {
    store,
    refuse: () => {
      refuseWrite = true;
    },
  };
}

function setup(
  options: {
    fetch?: typeof fetch;
    fallbackKey?: string | null;
    keyPool?: ReturnType<typeof createModelKeyPool>;
    now?: () => number;
  } = {},
) {
  const backing = memoryStore();
  const service = createModelSettingsService({
    store: backing.store,
    encryptionKey,
    fallback: initial,
    fallbackApiKey: async () =>
      options.fallbackKey === undefined
        ? "environment-secret"
        : options.fallbackKey,
    fetch: options.fetch,
    keyPool: options.keyPool,
    now: options.now,
  });
  return { ...backing, service };
}

describe("model connection validation", () => {
  test.each([
    ["openai", "api.stepfun.com"],
    ["anthropic", "api.stepfun.com"],
    ["openai", "api.stepfun.ai"],
    ["anthropic", "api.stepfun.ai"],
  ] as const)(
    "accepts the official Step Plan base for %s on %s",
    (provider, host) => {
      for (const suffix of ["", "/", "/v1", "/v1/"]) {
        expect(
          parseModelConnectionInput({
            ...initial,
            provider,
            baseUrl: `https://${host}/step_plan${suffix}`,
          }).baseUrl,
        ).toBe(`https://${host}/step_plan/v1`);
      }
    },
  );

  test.each([
    "https://gateway.test/step_plan",
    "https://api.stepfun.com.evil.test/step_plan",
    "https://api.stepfun.com/custom/step_plan",
    "https://api.stepfun.com/step_plan/custom",
  ])("preserves an unrelated custom endpoint %s", (baseUrl) => {
    expect(
      parseModelConnectionInput({ ...initial, provider: "anthropic", baseUrl })
        .baseUrl,
    ).toBe(baseUrl);
  });

  test("normalizes a bare endpoint and preserves custom API prefixes", () => {
    expect(
      parseModelConnectionInput({
        ...initial,
        baseUrl: " https://models.test/ ",
      }),
    ).toEqual({
      ...initial,
      baseUrl: "https://models.test/v1",
    });
    expect(
      parseModelConnectionInput({
        ...initial,
        baseUrl: "http://127.0.0.1:11434/custom/v1/",
      }).baseUrl,
    ).toBe("http://127.0.0.1:11434/custom/v1");
  });

  test.each([
    { ...initial, provider: "unrecognized" },
    { ...initial, model: "   " },
    { ...initial, model: "model\nsecret" },
    { ...initial, baseUrl: "file:///private/config" },
    { ...initial, baseUrl: "https://user:password@models.test/v1" },
    { ...initial, baseUrl: "https://models.test/v1?api_key=secret" },
    { ...initial, baseUrl: "https://models.test/v1#secret" },
    { ...initial, apiKey: { invalid: true } },
    { ...initial, useApiKey: "false" },
  ])(
    "rejects malformed configuration without returning its contents",
    (input) => {
      try {
        parseModelConnectionInput(input);
        throw new Error("invalid configuration was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelSettingsValidationError);
        expect((error as ModelSettingsValidationError).status).toBe(400);
        expect((error as Error).message).not.toContain("password");
        expect((error as Error).message).not.toContain("secret");
      }
    },
  );
});

describe("saved model connections", () => {
  test.each(["openai", "anthropic"] as const)(
    "an existing %s Step Plan connection retains its saved key across canonical addresses",
    async (provider) => {
      const { service, store } = setup();
      await service.save({
        ...initial,
        provider,
        model: "step-5-preview",
        baseUrl: "https://api.stepfun.com/step_plan",
        apiKey: "step-plan-secret",
      });
      await service.save({
        ...initial,
        provider,
        model: "step-5-preview",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
      });
      expect((await service.resolve()).baseUrl).toBe(
        "https://api.stepfun.com/step_plan/v1",
      );
      expect((await service.resolve()).apiKey).toBe("step-plan-secret");
      expect((await store.read())!.connection.baseUrl).toBe(
        "https://api.stepfun.com/step_plan/v1",
      );
    },
  );

  test("a legacy persisted Step Plan base is projected and resolved canonically without a replacement key", async () => {
    const { service: seed, store } = setup();
    await seed.save({
      ...initial,
      provider: "anthropic",
      model: "step-5-preview",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      apiKey: "legacy-step-secret",
    });
    let snapshot = {
      ...(await store.read())!,
      connection: {
        ...initial,
        provider: "anthropic" as const,
        model: "step-5-preview",
        baseUrl: "https://api.stepfun.com/step_plan",
      },
    };
    const legacy = createModelSettingsService({
      store: {
        read: async () => structuredClone(snapshot),
        update: async (change) =>
          (snapshot = await change(structuredClone(snapshot))),
      },
      encryptionKey,
      fallback: initial,
      fallbackApiKey: async () => {
        throw new Error("obsolete fallback must not be read");
      },
    });
    expect((await legacy.get()).baseUrl).toBe(
      "https://api.stepfun.com/step_plan/v1",
    );
    expect((await legacy.resolve()).baseUrl).toBe(
      "https://api.stepfun.com/step_plan/v1",
    );
    await legacy.save({
      ...initial,
      provider: "anthropic",
      model: "step-5-preview",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
    });
    expect((await legacy.resolve()).apiKey).toBe("legacy-step-secret");
    await expect(
      legacy.save({
        ...initial,
        provider: "anthropic",
        baseUrl: "https://api.stepfun.ai/step_plan",
      }),
    ).rejects.toBeInstanceOf(ModelSettingsValidationError);
    await expect(
      legacy.save({
        ...initial,
        provider: "anthropic",
        baseUrl: "https://api.stepfun.com/custom",
      }),
    ).rejects.toBeInstanceOf(ModelSettingsValidationError);
  });

  test("exposes current deployment fallback without exposing its API key", async () => {
    const { service } = setup();
    expect(await service.get()).toEqual({
      ...initial,
      source: "environment",
      hasApiKey: true,
    });
    expect(await service.resolve()).toEqual({
      ...initial,
      apiKey: "environment-secret",
      source: "environment",
    });
  });

  test("saves encrypted keys, reopens persisted state and applies it to the next resolution", async () => {
    const { service, store } = setup();
    const result = await service.save({
      ...initial,
      model: "new-model",
      apiKey: "new-api-secret",
    });
    expect(result).toEqual({
      ...initial,
      model: "new-model",
      source: "saved",
      hasApiKey: true,
    });
    const stored = await store.read();
    expect(JSON.stringify(stored)).not.toContain("new-api-secret");
    expect(JSON.stringify(result)).not.toContain("new-api-secret");
    expect(await decryptSecret(encryptionKey, stored!.encryptedApiKey!)).toBe(
      "new-api-secret",
    );
    const reopened = createModelSettingsService({
      store,
      encryptionKey,
      fallback: initial,
      fallbackApiKey: async () => "different-env-secret",
    });
    expect(await reopened.resolve()).toEqual({
      ...initial,
      model: "new-model",
      apiKey: "new-api-secret",
      source: "saved",
    });
  });

  test("a blank key keeps the active key while changing the model on the same endpoint", async () => {
    const { service } = setup();
    await service.save({ ...initial, apiKey: "first-secret" });
    await service.save({ ...initial, model: "second-model", apiKey: "   " });
    expect((await service.resolve()).apiKey).toBe("first-secret");
    expect((await service.resolve()).model).toBe("second-model");
  });

  test("copies the deployment key once when the initial connection is saved without a new key", async () => {
    const { service, store } = setup();
    await service.save({ ...initial, model: "saved-model" });
    const reopened = createModelSettingsService({
      store,
      encryptionKey,
      fallback: initial,
      fallbackApiKey: async () => "later-env-secret",
    });
    expect((await reopened.resolve()).apiKey).toBe("environment-secret");
  });

  test("saving an existing connection does not depend on the obsolete deployment credential", async () => {
    const { service, store } = setup();
    await service.save({ ...initial, apiKey: "saved-secret" });
    const savedOnly = createModelSettingsService({
      store,
      encryptionKey,
      fallback: initial,
      fallbackApiKey: async () => {
        throw new Error("obsolete fallback is unavailable");
      },
    });
    await savedOnly.save({ ...initial, model: "updated-model" });
    expect(await savedOnly.resolve()).toEqual({
      ...initial,
      model: "updated-model",
      apiKey: "saved-secret",
      source: "saved",
    });
  });

  test.each([
    { ...initial, provider: "anthropic" as const },
    { ...initial, baseUrl: "https://another.test/v1" },
  ])(
    "refuses to send the old key to a different protocol or endpoint",
    async (input) => {
      const { service, store } = setup();
      await expect(service.save(input)).rejects.toBeInstanceOf(
        ModelSettingsValidationError,
      );
      expect(await store.read()).toBeNull();
    },
  );

  test("an explicit no-key endpoint never falls back to the server environment key", async () => {
    const { service } = setup();
    await service.save({
      provider: "openai",
      model: "local-model",
      baseUrl: "http://127.0.0.1:11434",
      useApiKey: false,
    });
    expect(await service.resolve()).toEqual({
      provider: "openai",
      model: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      useApiKey: false,
      apiKey: null,
      source: "saved",
    });
    expect((await service.get()).hasApiKey).toBe(false);
  });

  test("no-key and a replacement key cannot both be requested", async () => {
    const { service } = setup();
    await expect(
      service.save({ ...initial, useApiKey: false, apiKey: "secret" }),
    ).rejects.toBeInstanceOf(ModelSettingsValidationError);
  });

  test("a failed atomic write leaves both the existing model and existing key usable", async () => {
    const { service, refuse } = setup();
    await service.save({ ...initial, apiKey: "old-secret" });
    refuse();
    await expect(
      service.save({
        ...initial,
        model: "failed-model",
        apiKey: "failed-secret",
      }),
    ).rejects.toThrow();
    expect(await service.resolve()).toEqual({
      ...initial,
      apiKey: "old-secret",
      source: "saved",
    });
  });

  test("a deployment without a key must provide one or explicitly disable authentication", async () => {
    const { service } = setup({ fallbackKey: null });
    expect((await service.get()).hasApiKey).toBe(false);
    await expect(service.save(initial)).rejects.toBeInstanceOf(
      ModelSettingsValidationError,
    );
  });
});

describe("unsaved model connection probes", () => {
  test.each(["openai", "anthropic"] as const)(
    "probes the versioned Step Plan %s endpoint with the saved key",
    async (provider) => {
      let address = "";
      let headers: Headers | undefined;
      const { service } = setup({
        fetch: (async (url, init) => {
          address = String(url);
          headers = new Headers(init!.headers);
          return Response.json(
            provider === "anthropic"
              ? { type: "message", content: [{ type: "text", text: "OK" }] }
              : { choices: [{ message: { content: "OK" } }] },
          );
        }) as typeof fetch,
      });
      await service.save({
        ...initial,
        provider,
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        apiKey: "saved-step-key",
      });
      expect(
        (
          await service.test({
            ...initial,
            provider,
            baseUrl: "https://api.stepfun.com/step_plan",
          })
        ).ok,
      ).toBe(true);
      expect(address).toBe(
        `https://api.stepfun.com/step_plan/v1/${provider === "anthropic" ? "messages" : "chat/completions"}`,
      );
      expect(
        headers!.get(provider === "anthropic" ? "x-api-key" : "authorization"),
      ).toBe(
        provider === "anthropic" ? "saved-step-key" : "Bearer saved-step-key",
      );
    },
  );

  test.each([
    "gpt-5",
    "gpt-5.1",
    "gpt-5-mini",
    "o1",
    "o1-preview",
    "o3",
    "o3-mini",
    "o4-mini",
  ])(
    "uses the reasoning-model token parameter when probing %s",
    async (model) => {
      let sent: Record<string, unknown> | undefined;
      const { service } = setup({
        fetch: (async (_url, init) => {
          sent = JSON.parse(init!.body as string) as Record<string, unknown>;
          if ("max_tokens" in sent || sent.max_completion_tokens !== 128) {
            return Response.json(
              { error: { code: "unsupported_parameter" } },
              { status: 400 },
            );
          }
          return Response.json({ choices: [{ message: { content: "OK" } }] });
        }) as typeof fetch,
      });
      expect((await service.test({ ...initial, model })).ok).toBe(true);
      expect(sent!.max_completion_tokens).toBe(128);
      expect(sent).not.toHaveProperty("max_tokens");
    },
  );

  test.each([
    "gpt-4.1",
    "gpt-4o",
    "deepseek-chat",
    "MiniMax-M3.1-Flash-Preview",
  ])("preserves compatible max_tokens for ordinary model %s", async (model) => {
    const { service } = setup({
      fetch: (async (_url, init) => {
        const sent = JSON.parse(init!.body as string) as Record<
          string,
          unknown
        >;
        if ("max_completion_tokens" in sent || sent.max_tokens !== 32) {
          return Response.json(
            { error: { code: "unsupported_parameter" } },
            { status: 400 },
          );
        }
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      }) as typeof fetch,
    });
    expect((await service.test({ ...initial, model })).ok).toBe(true);
  });

  test("performs a real HTTP probe against a self-hosted endpoint", async () => {
    let receivedModel = "";
    let receivedKey: string | null = null;
    const endpoint = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        expect(request.method).toBe("POST");
        receivedModel = ((await request.json()) as { model: string }).model;
        receivedKey = request.headers.get("Authorization");
        return Response.json({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        });
      },
    });
    try {
      const { service, store } = setup();
      const result = await service.test({
        ...initial,
        model: "self-hosted-model",
        baseUrl: endpoint.url.origin,
        apiKey: "local-test-key",
      });
      expect(result.ok).toBe(true);
      expect(receivedModel).toBe("self-hosted-model");
      expect(receivedKey).toBe("Bearer local-test-key");
      expect(await store.read()).toBeNull();
    } finally {
      endpoint.stop(true);
    }
  });

  test("a real HTTP redirect cannot forward the probe credential", async () => {
    let forwarded = 0;
    const endpoint = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.startsWith("/redirect/")) {
          return new Response(null, {
            status: 307,
            headers: { Location: `${endpoint.url.origin}/destination` },
          });
        }
        forwarded++;
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    });
    try {
      const { service } = setup();
      const result = await service.test({
        ...initial,
        baseUrl: `${endpoint.url.origin}/redirect`,
        apiKey: "private-key",
      });
      expect(result.ok).toBe(false);
      expect(forwarded).toBe(0);
      expect(JSON.stringify(result)).not.toContain("private-key");
    } finally {
      endpoint.stop(true);
    }
  });

  test("tests the unsaved OpenAI protocol, then leaves the active connection untouched", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { service, store } = setup({
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        });
      }) as typeof fetch,
    });
    const result = await service.test({
      provider: "openai",
      model: "draft-model",
      baseUrl: "https://draft.test/v1",
      apiKey: "draft-secret",
    });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.url).toBe("https://draft.test/v1/chat/completions");
    expect(new Headers(calls[0]!.init!.headers).get("Authorization")).toBe(
      "Bearer draft-secret",
    );
    expect(calls[0]!.init!.redirect).toBe("error");
    expect(JSON.parse(calls[0]!.init!.body as string).model).toBe(
      "draft-model",
    );
    expect(JSON.stringify(result)).not.toContain("draft-secret");
    expect(await store.read()).toBeNull();
    expect((await service.resolve()).model).toBe("existing-model");
  });

  test("uses Anthropic messages and required headers for an unsaved Anthropic connection", async () => {
    let request: RequestInit | undefined;
    let address = "";
    const { service } = setup({
      fetch: (async (url, init) => {
        address = String(url);
        request = init;
        return Response.json({
          type: "message",
          content: [{ type: "text", text: "OK" }],
        });
      }) as typeof fetch,
    });
    const result = await service.test({
      provider: "anthropic",
      model: "custom-claude",
      baseUrl: "https://anthropic.test",
      apiKey: "anthropic-secret",
    });
    expect(result.ok).toBe(true);
    expect(address).toBe("https://anthropic.test/v1/messages");
    expect(new Headers(request!.headers).get("x-api-key")).toBe(
      "anthropic-secret",
    );
    expect(new Headers(request!.headers).get("anthropic-version")).toBe(
      "2023-06-01",
    );
    expect(new Headers(request!.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(request!.body as string).max_tokens).toBeGreaterThan(0);
  });

  test("a no-key probe emits no authorization or API-key header", async () => {
    let headers: Headers | undefined;
    const { service } = setup({
      fetch: (async (_url, init) => {
        headers = new Headers(init!.headers);
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      }) as typeof fetch,
    });
    expect((await service.test({ ...initial, useApiKey: false })).ok).toBe(
      true,
    );
    expect(headers!.has("Authorization")).toBe(false);
    expect(headers!.has("x-api-key")).toBe(false);
  });

  test.each([401, 403, 404, 429, 500])(
    "returns a safe error for HTTP %i without reflecting response secrets",
    async (status) => {
      const { service } = setup({
        fetch: (async () =>
          Response.json(
            {
              error: {
                message:
                  "request failed; API key=environment-secret; internal=secret",
              },
            },
            { status },
          )) as typeof fetch,
      });
      const result = await service.test(initial);
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("secret");
      expect(result.message.length).toBeGreaterThan(0);
    },
  );

  test.each([
    {
      error: { code: "real_name_required", message: "private-upstream-secret" },
    },
    { code: "real_name_required", message: "private-upstream-secret" },
    {
      type: "error",
      error: { type: "real_name_required", message: "private-upstream-secret" },
    },
    { type: "real_name_required", message: "private-upstream-secret" },
  ])(
    "identifies the exact real-name requirement without reflecting provider text",
    async (body) => {
      const { service } = setup({
        fetch: (async () =>
          Response.json(body, { status: 403 })) as typeof fetch,
      });
      const result = await service.test(initial);
      expect(result.ok).toBe(false);
      expect(result.message).toBe(
        "模型服务要求账号完成实名认证，请在服务商平台完成认证后重试。（real_name_required）",
      );
      expect(JSON.stringify(result)).not.toContain("private-upstream-secret");
    },
  );

  test.each([
    () => new Response("{ malformed private-upstream-secret", { status: 403 }),
    () =>
      Response.json(
        {
          error: {
            code: "REAL_NAME_REQUIRED",
            message: "real_name_required private-upstream-secret",
          },
        },
        { status: 403 },
      ),
    () =>
      Response.json(
        {
          error: {
            code: "unknown",
            message: "real_name_required private-upstream-secret",
          },
        },
        { status: 403 },
      ),
    () =>
      Response.json(
        {
          type: "error",
          error: {
            type: "unknown",
            message: "real_name_required private-upstream-secret",
          },
        },
        { status: 403 },
      ),
    () =>
      Response.json(
        {
          error: {
            type: "REAL_NAME_REQUIRED",
            message: "real_name_required private-upstream-secret",
          },
        },
        { status: 403 },
      ),
    () =>
      Response.json(
        {
          error: {
            code: "real_name_required",
            message: "private-upstream-secret".repeat(100_000),
          },
        },
        { status: 403 },
      ),
  ])(
    "keeps the safe HTTP classification for malformed, oversized or unrecognized errors",
    async (response) => {
      const { service } = setup({
        fetch: (async () => response()) as typeof fetch,
      });
      const result = await service.test(initial);
      expect(result.ok).toBe(false);
      expect(result.message).toBe("认证失败，请检查 API Key 及接口访问权限。");
      expect(JSON.stringify(result)).not.toContain("private-upstream-secret");
      expect(result.message).not.toContain("real_name_required");
    },
  );

  test("rejects HTML and JSON responses which do not implement the selected model protocol", async () => {
    for (const response of [
      new Response("<html>login</html>"),
      Response.json({ ok: true }),
      Response.json({ choices: [] }),
      Response.json({ choices: [{ message: {} }] }),
    ]) {
      const { service } = setup({
        fetch: (async () => response) as typeof fetch,
      });
      expect((await service.test(initial)).ok).toBe(false);
    }
  });

  test("rejects Anthropic arrays without valid model content blocks", async () => {
    const { service } = setup({
      fetch: (async () =>
        Response.json({
          type: "message",
          content: [null, { type: "text", text: 123 }],
        })) as typeof fetch,
    });
    expect(
      (
        await service.test({
          provider: "anthropic",
          model: "claude",
          baseUrl: "https://anthropic.test/v1",
          apiKey: "secret",
        })
      ).ok,
    ).toBe(false);
  });

  test("network and timeout errors never expose a URL or key contained in the exception", async () => {
    const { service } = setup({
      fetch: (async () => {
        throw new Error(
          "https://user:environment-secret@existing.test refused",
        );
      }) as typeof fetch,
    });
    const result = await service.test(initial);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("environment-secret");
    expect(result.message).not.toContain("existing.test");
  });
});

describe("模型备选 Key 池配置", () => {
  test("保存多把备选 Key 时加密落盘、投影不泄露明文且运行时可完整解密", async () => {
    const keyPool = createModelKeyPool();
    const { store, service } = setup({ keyPool });
    const saved = await service.save(
      {
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://pool.example/v1",
        apiKey: "sk-primary-secret",
        pooledKeys: [
          { label: "华东主账户", apiKey: "sk-pool-east" },
          { label: "华南备账户", apiKey: "sk-pool-south" },
        ],
      },
      "admin-1",
    );

    expect(saved.hasApiKey).toBe(true);
    expect(saved.pooledKeys).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain("sk-primary-secret");
    expect(JSON.stringify(saved)).not.toContain("sk-pool-east");
    expect(JSON.stringify(saved)).not.toContain("sk-pool-south");

    const firstKeyId = saved.pooledKeys?.[0]?.id;
    const secondKeyId = saved.pooledKeys?.[1]?.id;
    expect(typeof firstKeyId).toBe("string");
    expect(typeof secondKeyId).toBe("string");

    const snapshot = await store.read();
    expect(snapshot?.pooledKeys).toHaveLength(2);
    expect(snapshot?.pooledKeys?.[0]?.encryptedApiKey).not.toBe("sk-pool-east");
    expect(
      await decryptSecret(
        encryptionKey,
        snapshot?.pooledKeys?.[0]?.encryptedApiKey ?? "",
      ),
    ).toBe("sk-pool-east");

    const current = await service.get();
    expect(current.pooledKeys).toEqual([
      {
        id: firstKeyId ?? "",
        label: "华东主账户",
        hasApiKey: true,
        healthy: true,
        cooldownUntil: null,
      },
      {
        id: secondKeyId ?? "",
        label: "华南备账户",
        hasApiKey: true,
        healthy: true,
        cooldownUntil: null,
      },
    ]);
    expect(JSON.stringify(current)).not.toContain("sk-pool-");

    const runtime = await service.resolve();
    expect(runtime.apiKey).toBe("sk-primary-secret");
    expect(runtime.pooledKeys).toEqual([
      { id: firstKeyId ?? "", label: "华东主账户", apiKey: "sk-pool-east" },
      { id: secondKeyId ?? "", label: "华南备账户", apiKey: "sk-pool-south" },
    ]);
  });

  test("保留条目不覆盖原有密钥，标记 remove: true 时从池与快照移除", async () => {
    const { service, store } = setup();
    const initialSaved = await service.save({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://pool.example/v1",
      apiKey: "sk-main",
      pooledKeys: [
        { label: "通道 A", apiKey: "sk-key-a" },
        { label: "通道 B", apiKey: "sk-key-b" },
      ],
    });
    const keyA = initialSaved.pooledKeys?.[0]?.id ?? "";
    const keyB = initialSaved.pooledKeys?.[1]?.id ?? "";

    const updated = await service.save({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://pool.example/v1",
      pooledKeys: [
        { id: keyA, label: "通道 A-更新名称" },
        { id: keyB, label: "通道 B", remove: true },
        { label: "通道 C", apiKey: "sk-key-c" },
      ],
    });

    expect(updated.pooledKeys).toHaveLength(2);
    expect(updated.pooledKeys?.[0]?.id).toBe(keyA);
    expect(updated.pooledKeys?.[0]?.label).toBe("通道 A-更新名称");
    expect(updated.pooledKeys?.[1]?.label).toBe("通道 C");

    const runtime = await service.resolve();
    expect(runtime.pooledKeys).toEqual([
      { id: keyA, label: "通道 A-更新名称", apiKey: "sk-key-a" },
      {
        id: updated.pooledKeys?.[1]?.id ?? "",
        label: "通道 C",
        apiKey: "sk-key-c",
      },
    ]);
    expect(
      (await store.read())?.pooledKeys?.some((item) => item.id === keyB),
    ).toBe(false);
  });

  test("切换协议或地址时拒绝复用旧备选密钥，关闭 API Key 时清空池配置", async () => {
    const { service } = setup();
    const first = await service.save({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://a.example/v1",
      apiKey: "sk-main",
      pooledKeys: [{ label: "通道 A", apiKey: "sk-key-a" }],
    });
    const keyA = first.pooledKeys?.[0]?.id ?? "";

    await expect(
      service.save({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        baseUrl: "https://b.example/v1",
        apiKey: "sk-new-main",
        pooledKeys: [{ id: keyA, label: "试图跨协议复用" }],
      }),
    ).rejects.toThrow(ModelSettingsValidationError);

    const noKey = await service.save({
      provider: "openai",
      model: "local-llm",
      baseUrl: "http://127.0.0.1:11434/v1",
      useApiKey: false,
    });
    expect(noKey.hasApiKey).toBe(false);
    expect(noKey.pooledKeys).toBeUndefined();
    expect((await service.resolve()).pooledKeys).toBeUndefined();
  });

  test("传入 keyPool 时投影可反映各 Key 的实时冷却与错误状态", async () => {
    let now = 1_700_000_000_000;
    const keyPool = createModelKeyPool();
    const { service } = setup({ keyPool, now: () => now });
    const saved = await service.save({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://status.example/v1",
      apiKey: "sk-main",
      pooledKeys: [
        { label: "Key-1", apiKey: "sk-1" },
        { label: "Key-2", apiKey: "sk-2" },
      ],
    });
    const k1 = saved.pooledKeys?.[0]?.id ?? "";
    const pid = modelPoolId(saved);
    keyPool.reportResult(pid, k1, 429, { "retry-after": "30" }, now);

    const projected = await service.get();
    expect(projected.pooledKeys?.[0]).toEqual({
      id: k1,
      label: "Key-1",
      hasApiKey: true,
      healthy: false,
      cooldownUntil: now + 30_000,
      lastStatus: 429,
    });
    expect(projected.pooledKeys?.[1]?.healthy).toBe(true);

    now += 31_000;
    const recovered = await service.get();
    expect(recovered.pooledKeys?.[0]?.healthy).toBe(true);
    expect(recovered.pooledKeys?.[0]?.cooldownUntil).toBeNull();
  });
});
