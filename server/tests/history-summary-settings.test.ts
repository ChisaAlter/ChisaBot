import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createHistorySummaryModelService,
  type HistorySummaryModelStore,
  parseHistorySummaryModel,
} from "../src/agents/history-summary-settings";

function memoryStore(initial: string | null = null) {
  let model = initial;
  let reads = 0;
  const store: HistorySummaryModelStore = {
    async read() {
      reads++;
      return model;
    },
    async write(next) {
      model = next;
      return model;
    },
  };
  return { store, reads: () => reads, model: () => model };
}

describe("摘要模型 setting", () => {
  test("parse: empty means follow the main model; ids are validated", () => {
    expect(parseHistorySummaryModel({ model: null })).toBeNull();
    expect(parseHistorySummaryModel({ model: "  " })).toBeNull();
    expect(parseHistorySummaryModel({ model: " codex/gpt-6-luna " })).toBe(
      "codex/gpt-6-luna",
    );
    expect(() => parseHistorySummaryModel({ model: "has space" })).toThrow();
    expect(() => parseHistorySummaryModel({ model: 3 })).toThrow();
    expect(() =>
      parseHistorySummaryModel({ model: "x".repeat(201) }),
    ).toThrow();
  });

  test("model() caches for 30 s and save updates the cache", async () => {
    const memory = memoryStore();
    let t = 0;
    const service = createHistorySummaryModelService({
      store: memory.store,
      now: () => t,
    });
    expect(await service.model()).toBeNull();
    await service.model();
    expect(memory.reads()).toBe(1);
    await service.save({ model: "codex/mini" }, "admin");
    expect(await service.model()).toBe("codex/mini");
    expect(memory.reads()).toBe(1);
    t += 31_000;
    await service.model();
    expect(memory.reads()).toBe(2);
  });

  function app(role: "admin" | "member", memory = memoryStore()) {
    const service = createHistorySummaryModelService({ store: memory.store });
    const root = new Hono();
    root.route(
      "/api/admin/history-summary-model",
      service.routes(async (context, next) => {
        context.set("actor", { id: "u1", email: "u@x", role } as never);
        await next();
      }),
    );
    return { root, memory };
  }

  test("routes: admins read and save, bad input is 400, members are refused", async () => {
    const { root, memory } = app("admin");
    expect(
      await (await root.request("/api/admin/history-summary-model")).json(),
    ).toEqual({ model: null });
    const put = (body: unknown) =>
      root.request("/api/admin/history-summary-model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put({ model: "codex/mini" })).status).toBe(200);
    expect(memory.model()).toBe("codex/mini");
    expect((await put({ model: "no spaces" })).status).toBe(400);
    expect((await put({ model: null })).status).toBe(200);
    expect(memory.model()).toBeNull();
    const member = app("member");
    expect(
      (await member.root.request("/api/admin/history-summary-model")).status,
    ).toBe(403);
  });
});
