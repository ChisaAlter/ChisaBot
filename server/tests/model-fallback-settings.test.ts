import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createModelFallbackService,
  MAX_FALLBACK_MODELS,
  type ModelFallbackStore,
  parseFallbackModels,
} from "../src/agents/model-fallback-settings";

function memoryStore(initial: string[] = []) {
  let models = [...initial];
  let reads = 0;
  const store: ModelFallbackStore = {
    async read() {
      reads++;
      return [...models];
    },
    async write(next) {
      models = [...next];
      return models;
    },
  };
  return { store, reads: () => reads, models: () => models };
}

describe("备用模型 settings (DESIGN.md §61)", () => {
  test("parse: trims, dedupes, keeps order, validates", () => {
    expect(parseFallbackModels({ models: [" a/b ", "c/d", "a/b"] })).toEqual([
      "a/b",
      "c/d",
    ]);
    expect(parseFallbackModels([])).toEqual([]);
    expect(() => parseFallbackModels({ models: ["has space"] })).toThrow();
    expect(() => parseFallbackModels({ models: [""] })).toThrow();
    expect(() => parseFallbackModels({ models: "a/b" })).toThrow();
    expect(() => parseFallbackModels(null)).toThrow();
    expect(() =>
      parseFallbackModels({
        models: Array.from(
          { length: MAX_FALLBACK_MODELS + 1 },
          (_, i) => `m/${i}`,
        ),
      }),
    ).toThrow();
  });

  test("models() caches for 30 s; save updates the cache at once", async () => {
    const memory = memoryStore(["x/1"]);
    let t = 0;
    const service = createModelFallbackService({
      store: memory.store,
      now: () => t,
    });
    expect(await service.models()).toEqual(["x/1"]);
    expect(await service.models()).toEqual(["x/1"]);
    expect(memory.reads()).toBe(1);
    await service.save({ models: ["y/2", "x/1"] }, "admin");
    expect(memory.models()).toEqual(["y/2", "x/1"]);
    expect(await service.models()).toEqual(["y/2", "x/1"]);
    expect(memory.reads()).toBe(1);
    t += 31_000;
    await service.models();
    expect(memory.reads()).toBe(2);
  });

  function app(role: "admin" | "member", memory = memoryStore()) {
    const service = createModelFallbackService({ store: memory.store });
    const root = new Hono();
    root.route(
      "/api/admin/model-fallbacks",
      service.routes(async (context, next) => {
        context.set("actor", { id: "u1", email: "u@x", role } as never);
        await next();
      }),
    );
    return { root, memory };
  }

  test("routes: admin reads and saves; bad input is 400", async () => {
    const { root, memory } = app("admin");
    expect(
      await (await root.request("/api/admin/model-fallbacks")).json(),
    ).toEqual({ models: [] });
    const saved = await root.request("/api/admin/model-fallbacks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: ["clinepass/cline-free/step-5-preview", "codex/gpt-5.6-luna"],
      }),
    });
    expect(saved.status).toBe(200);
    expect(memory.models()).toEqual([
      "clinepass/cline-free/step-5-preview",
      "codex/gpt-5.6-luna",
    ]);
    const bad = await root.request("/api/admin/model-fallbacks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["no spaces allowed"] }),
    });
    expect(bad.status).toBe(400);
    expect(memory.models()).toEqual([
      "clinepass/cline-free/step-5-preview",
      "codex/gpt-5.6-luna",
    ]);
  });

  test("routes: non-admins are refused", async () => {
    const { root } = app("member");
    expect((await root.request("/api/admin/model-fallbacks")).status).toBe(403);
    const put = await root.request("/api/admin/model-fallbacks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [] }),
    });
    expect(put.status).toBe(403);
  });
});
