import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  estimateEventCostUsd,
  lookupModelPrice,
} from "../../shared/usage-pricing";
import type { AppVariables } from "../src/auth/guards";
import {
  buildUsageAnalytics,
  buildUsageCsv,
} from "../src/quotas/usage-analytics";
import {
  createMemoryUsageBreakdownStorage,
  createPgUsageBreakdownStorage,
  createUsageBreakdownService,
  type UsageBreakdownDatabase,
  type UsageEventRecord,
} from "../src/quotas/usage-breakdown";

function createRoleMiddleware(
  role: "admin" | "user",
  id = role === "admin" ? "admin-1" : "user-1",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, name: id, role });
    await next();
  };
}

function makeEvent(overrides: Partial<UsageEventRecord>): UsageEventRecord {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    ownerUserId: "u1",
    kind: "chat",
    modelId: "gpt-4o",
    effort: "default",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    createdAt: new Date().toISOString(),
    provider: "openai",
    agentId: "",
    scenario: "",
    durationMs: 0,
    status: "ok",
    errorKind: "",
    ...overrides,
  };
}

describe("CB-146 用量分析纯函数", () => {
  test("维度分组 / 失败率 / 耗时分布 / 成本估算与覆盖率", () => {
    const events = [
      makeEvent({
        provider: "openai",
        agentId: "bot-a",
        scenario: "chat",
        modelId: "gpt-4o",
        inputTokens: 1_000_000,
        outputTokens: 0,
        durationMs: 100,
      }),
      makeEvent({
        provider: "openai",
        agentId: "bot-a",
        scenario: "chat",
        modelId: "gpt-4o",
        durationMs: 300,
      }),
      makeEvent({
        provider: "anthropic",
        agentId: "bot-b",
        scenario: "summarization",
        modelId: "unknown-model-x",
        durationMs: 200,
        status: "error",
        errorKind: "http_429",
      }),
    ];
    const report = buildUsageAnalytics(events);
    expect(report.summary.requests).toBe(3);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.failureRate).toBeCloseTo(1 / 3);
    // gpt-4o $2.5/1M input：第一个事件 1M input = $2.5；unknown-model-x 无价
    expect(report.summary.costUsd).toBeCloseTo(2.50075, 4);
    expect(report.summary.costCoverage).toBeCloseTo(2 / 3);
    expect(report.summary.latency.samples).toBe(3);
    expect(report.summary.latency.p50Ms).toBe(200);
    expect(report.summary.latency.maxMs).toBe(300);

    const openai = report.byProvider.find((b) => b.key === "openai");
    expect(openai?.requests).toBe(2);
    expect(openai?.costUsd).not.toBeNull();
    const anthropic = report.byProvider.find((b) => b.key === "anthropic");
    expect(anthropic?.errors).toBe(1);
    expect(anthropic?.costUsd).toBeNull();

    expect(report.byAgent.map((b) => b.key).sort()).toEqual(["bot-a", "bot-b"]);
    expect(
      report.byScenario.find((b) => b.key === "summarization")?.requests,
    ).toBe(1);
    expect(
      report.byModel.find((b) => b.key === "unknown-model-x")?.costUsd,
    ).toBeNull();
  });

  test("空事件集：零值安全，不产生 NaN", () => {
    const report = buildUsageAnalytics([]);
    expect(report.summary.requests).toBe(0);
    expect(report.summary.failureRate).toBe(0);
    expect(report.summary.costUsd).toBeNull();
    expect(report.summary.latency.p95Ms).toBe(0);
    expect(report.byProvider).toEqual([]);
  });
});

describe("CB-146 成本估算单价表", () => {
  test("精确 / provider 前缀 / 日期后缀回退 / 未知 null", () => {
    expect(lookupModelPrice("gpt-4o")?.inputPer1M).toBe(2.5);
    expect(lookupModelPrice("openai/gpt-4o")?.inputPer1M).toBe(2.5);
    expect(lookupModelPrice("gpt-4o-2024-11-20")?.inputPer1M).toBe(2.5);
    expect(lookupModelPrice("some-random-model")).toBeNull();
    expect(estimateEventCostUsd("gpt-4o", 500_000, 100_000)).toBeCloseTo(
      2.25,
      4,
    );
    expect(estimateEventCostUsd("nope", 100, 100)).toBeNull();
  });
});

describe("CB-146 CSV 导出", () => {
  test("metadata-only 列、转义、成本列", () => {
    const csv = buildUsageCsv([
      makeEvent({
        modelId: "gpt-4o",
        inputTokens: 1_000_000,
        agentId: 'bot-"x"',
        scenario: "chat",
      }),
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain(
      "created_at,kind,scenario,provider,agent_id,model_id",
    );
    expect(lines[0]).not.toContain("prompt");
    expect(lines[0]).not.toContain("content");
    expect(lines[1]).toContain('"bot-""x"""');
    expect(lines[1]).toContain("2.500500");
  });
});

describe("CB-146 服务端点", () => {
  async function setup(role: "admin" | "user" = "admin") {
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0);
    const storage = createMemoryUsageBreakdownStorage({ now: () => nowMs });
    const service = createUsageBreakdownService(storage, { now: () => nowMs });
    await service.record({
      ownerUserId: "admin-1",
      kind: "chat",
      modelId: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      provider: "openai",
      agentId: "bot-a",
      scenario: "chat",
      durationMs: 1200,
      createdAt: nowMs - 2000,
    });
    await service.record({
      ownerUserId: "admin-1",
      kind: "chat",
      modelId: "gpt-4o",
      inputTokens: 0,
      outputTokens: 0,
      provider: "openai",
      agentId: "bot-a",
      scenario: "chat",
      durationMs: 80,
      status: "error",
      errorKind: "http_429",
      createdAt: nowMs - 1000,
    });
    await service.record({
      ownerUserId: "user-1",
      kind: "chat",
      modelId: "deepseek-chat",
      inputTokens: 100,
      outputTokens: 50,
      provider: "openai",
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/usage", service.routes(createRoleMiddleware(role)));
    return app;
  }

  test("GET /extended 返回维度分组与失败率", async () => {
    const app = await setup("admin");
    const res = await app.request("/api/usage/extended?days=30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analytics.summary.requests).toBe(2);
    expect(body.analytics.summary.errors).toBe(1);
    expect(body.analytics.byAgent[0].key).toBe("bot-a");
    expect(body.window.days).toBe(30);
  });

  test("GET /detail 分页与 before 游标", async () => {
    const app = await setup("admin");
    const res = await app.request("/api/usage/detail?limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(body.events[0].ownerUserId).toBeUndefined();
    const cursor = body.events[0].createdAt;
    const res2 = await app.request(
      `/api/usage/detail?limit=10&before=${encodeURIComponent(cursor)}`,
    );
    const body2 = await res2.json();
    expect(body2.events.length).toBeGreaterThanOrEqual(1);
    expect(
      body2.events.every(
        (e: { createdAt: string }) =>
          Date.parse(e.createdAt) < Date.parse(cursor),
      ),
    ).toBe(true);
  });

  test("GET /export.csv 非管理员 403，管理员得 CSV", async () => {
    const userApp = await setup("user");
    const forbidden = await userApp.request("/api/usage/export.csv");
    expect(forbidden.status).toBe(403);
    const adminApp = await setup("admin");
    const res = await adminApp.request("/api/usage/export.csv?days=30");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("gpt-4o");
    expect(text).toContain("http_429");
  });
});

const pgUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!pgUrl)("CB-146 PG 存储", () => {
  test("ensure 幂等加列 + 扩展字段读写往返", async () => {
    const postgres = await import("postgres");
    const sql = postgres.default(pgUrl!);
    try {
      const storage = createPgUsageBreakdownStorage({
        $client: { unsafe: sql.unsafe.bind(sql) },
      } as unknown as UsageBreakdownDatabase);
      await storage.ensure();
      await storage.ensure();
      const rec = await storage.insertEvent({
        ownerUserId: "pgtest-cb146",
        kind: "chat",
        modelId: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
        provider: "openai",
        agentId: "bot-pg",
        scenario: "chat",
        durationMs: 321,
        status: "error",
        errorKind: "http_500",
      });
      expect(rec.provider).toBe("openai");
      expect(rec.agentId).toBe("bot-pg");
      expect(rec.durationMs).toBe(321);
      expect(rec.status).toBe("error");
      const rows = await storage.listEventsSince(
        "pgtest-cb146",
        new Date(Date.now() - 60_000).toISOString(),
      );
      const hit = rows.find((row) => row.id === rec.id);
      expect(hit?.agentId).toBe("bot-pg");
      expect(hit?.scenario).toBe("chat");
      expect(hit?.errorKind).toBe("http_500");
      expect(hit?.durationMs).toBe(321);
      await sql.unsafe(
        "DELETE FROM chisabot_usage_events WHERE owner_user_id = $1",
        ["pgtest-cb146"],
      );
    } finally {
      await sql.end();
    }
  });
});
