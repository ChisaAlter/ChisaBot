import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createAdminSmokeRoutes, smokeAnswered, smokePrompt } from "../src/admin-smoke";
import type { AppVariables } from "../src/auth/guards";
import type { RuntimeModelConnection } from "../src/copilot";

const connection: RuntimeModelConnection = {
  model: { provider: "openai", defaultModel: "gpt-test", baseUrl: "http://model.invalid/v1" },
  apiKey: "sk-secret",
};

function app(
  role: "admin" | "user",
  generate: (c: RuntimeModelConnection, prompt: string) => Promise<string>,
  extra: {
    forAgent?: (id: string) => Promise<RuntimeModelConnection>;
    logs?: string[];
    probeHermes?: () => Promise<{ reachable: boolean; error?: string }>;
  } = {},
) {
  const requireUser = (async (context: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    context.set("actor", { id: `${role}-1`, email: `${role}@x`, name: role, role });
    await next();
  }) as never;
  const root = new Hono<{ Variables: AppVariables }>();
  root.route(
    "/api/admin/smoke",
    createAdminSmokeRoutes({
      requireUser,
      resolveConnection: async () => connection,
      resolveConnectionForAgent: extra.forAgent,
      generate: (c, prompt) => generate(c, prompt),
      log: (line) => extra.logs?.push(line),
      ...(extra.probeHermes ? { probeHermes: extra.probeHermes } : {}),
    }),
  );
  return root;
}

const post = (root: Hono<{ Variables: AppVariables }>, body: unknown = {}) =>
  root.request("/api/admin/smoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("admins only", async () => {
  let called = false;
  const response = await post(
    app("user", async () => {
      called = true;
      return "";
    }),
  );
  expect(response.status).toBe(403);
  expect(called).toBe(false);
});

/** 测试用「模型」：把题目里的两个数加起来。 */
const solve = (prompt: string) => {
  const [a = 0, b = 0] = (prompt.match(/\d+/gu) ?? []).map(Number);
  return String(a + b);
};

test("a correct answer passes (answered); never persists; no question or secrets in logs", async () => {
  const logs: string[] = [];
  let seenPrompt = "";
  const response = await post(
    app(
      "admin",
      async (_c, prompt) => {
        seenPrompt = prompt;
        return `答案是 ${solve(prompt)}。`;
      },
      { logs },
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, answered: true, echoed: true, persisted: false, model: "gpt-test", agentId: null });
  expect(seenPrompt).toMatch(/^\d{2} \+ \d{2} /u);
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain("sk-secret");
  expect(logs[0]).not.toContain(seenPrompt);
});

test("any non-empty reply proves the round trip (a refusal must not fail the self-test)", async () => {
  const refused = await post(app("admin", async () => "抱歉，我不能执行这个请求。"));
  expect(refused.status).toBe(200);
  expect(await refused.json()).toMatchObject({ ok: true, answered: false, persisted: false });
});

test("an empty reply or a failed call is a 502 with a reason", async () => {
  const empty = await post(app("admin", async () => "   "));
  expect(empty.status).toBe(502);
  expect(await empty.json()).toMatchObject({ ok: false, answered: false, persisted: false });
  const failed = await post(
    app("admin", async () => {
      throw new Error("boom sk-secret");
    }),
  );
  expect(failed.status).toBe(502);
  const body = await failed.json();
  expect(body.ok).toBe(false);
  expect(JSON.stringify(body)).not.toContain("sk-secret");
});

test("agentId uses the Bot's own model resolution and is validated", async () => {
  const asked: string[] = [];
  const root = app("admin", async (c, prompt) => `${c.model.defaultModel} ${solve(prompt)}`, {
    forAgent: async (id) => {
      asked.push(id);
      return { ...connection, model: { ...connection.model, defaultModel: "bot-model" } };
    },
  });
  const response = await post(root, { agentId: "agent-1" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, model: "bot-model", agentId: "agent-1" });
  expect(asked).toEqual(["agent-1"]);
  expect((await post(root, { agentId: "../x y" })).status).toBe(400);
});

test("prompt and answer check", () => {
  expect(smokePrompt({ a: 37, b: 48 })).toContain("37 + 48");
  expect(smokeAnswered("85", 85)).toBe(true);
  expect(smokeAnswered("＝８５", 85)).toBe(true);
  expect(smokeAnswered("185", 85)).toBe(false);
  expect(smokeAnswered("", 85)).toBe(false);
});

test("self-test passes through a fallback model when the main model is out of quota, and says so (§61)", async () => {
  const { fallbackLanguageModel, resetModelCooldowns } = await import("../src/agents/model-fallback");
  resetModelCooldowns();
  const quota = Object.assign(new Error("Daily free limit reached. Try again in 18h 14m"), { statusCode: 429 });
  const logs: string[] = [];
  const response = await post(
    app(
      "admin",
      async (_c, prompt) => {
        const primary = { modelId: "p", doGenerate: async () => { throw quota; } };
        const backup = { modelId: "b", doGenerate: async () => ({ text: solve(prompt) }) };
        const wrapped = fallbackLanguageModel(primary, "clinepass/cline-free/mimo", {
          candidates: async () => ["clinepass/cline-free/step-5-preview"],
          build: () => backup,
          log: () => {},
        });
        return ((await wrapped.doGenerate({})) as { text: string }).text;
      },
      { logs },
    ),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.fallback).toEqual({ from: "clinepass/cline-free/mimo", to: "clinepass/cline-free/step-5-preview", reason: "quota" });
  expect(body.message).toContain("主模型额度用完，已改用 step-5-preview");
  expect(logs[0]).toContain("fallback=clinepass/cline-free/step-5-preview");
  resetModelCooldowns();
});

// CB-100：自检要真的连一次 Hermes。以前只直连模型，Hermes 连不上时发布照样通过。
test("Hermes not configured: hermes=skipped and model result decides", async () => {
  const response = await post(app("admin", async (_c, prompt) => solve(prompt)));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, hermes: "skipped" });
});

test("Hermes reachable: hermes=ok", async () => {
  const logs: string[] = [];
  const response = await post(
    app("admin", async (_c, prompt) => solve(prompt), { logs, probeHermes: async () => ({ reachable: true }) }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, hermes: "ok" });
  expect(logs[0]).toContain("hermes=ok");
});

test("Hermes unreachable fails the smoke even though the model answered", async () => {
  const logs: string[] = [];
  const response = await post(
    app("admin", async (_c, prompt) => solve(prompt), {
      logs,
      probeHermes: async () => ({ reachable: false, error: "连接不上 Hermes 桥接（可能没有启动或端口不对）" }),
    }),
  );
  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, hermes: "unreachable", answered: true, persisted: false });
  expect(body.message).toContain("Hermes");
  expect(logs[0]).toContain("hermes=unreachable");
});

test("a throwing Hermes probe counts as unreachable", async () => {
  const response = await post(
    app("admin", async (_c, prompt) => solve(prompt), {
      probeHermes: async () => {
        throw new Error("ConnectionRefused");
      },
    }),
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ ok: false, hermes: "unreachable" });
});
