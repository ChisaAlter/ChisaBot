import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const state = {
  agentId: "bot-a",
  model: "provider/selected",
  overrideModel: "provider/selected",
  defaultModel: "provider/default",
  available: true,
  canManage: true,
};
const catalog = {
  models: [
    { id: "provider/selected", label: "Selected", provider: "provider" },
  ],
  fetchedAt: 1,
};
function setup(role: "admin" | "user" | null = "user", fail = false) {
  const calls: unknown[] = [];
  const args = Array.from({ length: 40 }) as never[];
  args[0] = loadConfig(
    testEnvironment({ CHISABOT_SINGLE_USER: "false" }),
  ) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () =>
        role ? { user: { id: "owner", email: "owner@test" } } : null,
    },
  } as never;
  args[2] = { rolesForUser: async () => [role] } as never;
  args[38] = {
    get: async (actor: unknown, id: string) => {
      calls.push({ actor, id });
      if (fail) throw new Error("key=private-secret");
      return state;
    },
    set: async (actor: unknown, id: string, model: unknown) => {
      calls.push({ actor, id, model });
      if (fail) throw new Error("key=private-secret");
      return {
        ...state,
        overrideModel: model,
        model: model ?? state.defaultModel,
      };
    },
  } as never;
  args[39] = {
    list: async (input: unknown) => {
      calls.push(input);
      if (fail) throw new Error("upstream-key=private-secret");
      return catalog;
    },
  } as never;
  return { app: createApp(...args), calls };
}

test("model catalog and BOT choice require login", async () => {
  const { app, calls } = setup(null);
  for (const [path, method] of [
    ["/api/models", "GET"],
    ["/api/agents/bot-a/model", "GET"],
    ["/api/agents/bot-a/model", "PUT"],
  ]) {
    const res = await app.request(path!, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "PUT" ? { body: '{"model":"provider/selected"}' } : {}),
    });
    expect(res.status).toBe(401);
  }
  expect(calls).toHaveLength(0);
});

test("authenticated users can refresh safe catalog and read their BOT model", async () => {
  const { app, calls } = setup();
  const list = await app.request(
    "/api/models?refresh=1&url=https://untrusted.test&apiKey=ignored",
  );
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(await list.json()).toEqual(catalog);
  expect(calls[0]).toEqual({ refresh: true });
  const read = await app.request("/api/agents/bot-a/model");
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(state);
  expect(calls[1]).toMatchObject({
    actor: { id: "owner", role: "user" },
    id: "bot-a",
  });
});

test("model-only writes carry authenticated actor and support inheritance", async () => {
  const { app, calls } = setup("admin");
  const write = await app.request("/api/agents/bot-a/model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"model":null}',
  });
  expect(write.status).toBe(200);
  expect(await write.json()).toEqual({
    ...state,
    overrideModel: null,
    model: "provider/default",
  });
  expect(calls[0]).toMatchObject({
    actor: { id: "owner", role: "admin" },
    id: "bot-a",
    model: null,
  });
});

test.each([
  "{}",
  "null",
  "[]",
  '{"model":123}',
  '{"model":"bad model"}',
  '{"model":"x","role":"admin"}',
  '{"model":"x","baseUrl":"http://evil.test"}',
])("invalid model-only bodies never reach storage", async (body) => {
  const { app, calls } = setup();
  const res = await app.request("/api/agents/bot-a/model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  expect(res.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("upstream and persistence failures never reveal private exception contents", async () => {
  const { app } = setup("admin", true);
  for (const path of ["/api/models", "/api/agents/bot-a/model"]) {
    const res = await app.request(path);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private-secret");
  }
});
