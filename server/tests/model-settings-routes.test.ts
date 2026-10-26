import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { ModelSettingsValidationError } from "../src/model-settings";
import { testEnvironment } from "./support/environment";

const config = {
  provider: "openai",
  model: "saved-model",
  baseUrl: "https://model.test/v1",
  useApiKey: true,
  hasApiKey: true,
  source: "saved",
};
function appFor(role: "admin" | "user" | null = "admin", fail = false) {
  const calls: unknown[] = [];
  const args: never[] = Array.from({ length: 38 }) as never[];
  args[0] = loadConfig(
    testEnvironment({ CHISABOT_SINGLE_USER: "false" }),
  ) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () =>
        role
          ? {
              user: {
                id: "owner",
                email: "owner@test",
                name: "Owner",
                image: null,
              },
            }
          : null,
    },
  } as never;
  args[2] = { rolesForUser: async () => [role] } as never;
  args[37] = {
    get: async () => config,
    save: async (input: unknown, by: string) => {
      calls.push({ input, by });
      if (fail)
        throw new ModelSettingsValidationError("请填写有效的模型名称。");
      return config;
    },
    test: async (input: unknown) => {
      calls.push(input);
      return { ok: true, message: "连接成功", latencyMs: 2 };
    },
  } as never;
  return { app: createApp(...args), calls };
}
test("only administrators can read, save or test model configuration", async () => {
  for (const role of ["user", null] as const) {
    const { app, calls } = appFor(role);
    for (const [path, method] of [
      ["/api/admin/model-settings", "GET"],
      ["/api/admin/model-settings", "PUT"],
      ["/api/admin/model-settings/test", "POST"],
    ]) {
      const response = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(response.status).toBe(role ? 403 : 401);
    }
    expect(calls).toHaveLength(0);
  }
});
test("model admin routes project safe fields, attribute saves, and test unsaved drafts", async () => {
  const { app, calls } = appFor();
  const read = await app.request("/api/admin/model-settings");
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({ config });
  const draft = {
    provider: "openai",
    model: "draft-model",
    baseUrl: "https://model.test/v1",
    apiKey: "private-test-key",
  };
  const save = await app.request("/api/admin/model-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  expect(save.status).toBe(200);
  expect((await save.text()).includes("private-test-key")).toBe(false);
  expect(calls[0]).toEqual({ input: draft, by: "owner" });
  const probe = await app.request("/api/admin/model-settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  expect(await probe.json()).toEqual({
    ok: true,
    message: "连接成功",
    latencyMs: 2,
  });
  expect(calls[1]).toEqual(draft);
});
test("invalid model input returns a useful 400 rather than a storage or credential leak", async () => {
  const { app } = appFor("admin", true);
  const response = await app.request("/api/admin/model-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "请填写有效的模型名称。" });
});
