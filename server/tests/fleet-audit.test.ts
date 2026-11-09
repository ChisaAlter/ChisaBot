import { describe, expect, test } from "bun:test";
import type { RegisteredAgent } from "../src/conversation-runtime";
import type { Database } from "../src/db/client";
import {
  type FleetAuditData,
  formatAuditReport,
  modelTierOf,
  workloadHintsOf,
} from "../src/fleet-audit/audit";
import { createFleetAudit } from "../src/fleet-audit/service";

/** 车队模型审计（fleet_audit）：档位猜测、负载线索、报告排版、只读工具的数据采集。 */

describe("modelTierOf", () => {
  test("strong names", () => {
    for (const id of [
      "claude-opus-4-6",
      "gpt-5.2-pro",
      "deepseek-r1",
      "swe-2-high",
      "swe-2-max",
      "gemini-2.5-pro",
      "o3",
      "qwen3-235b-a22b-thinking",
    ]) {
      expect(modelTierOf(id)).toBe("strong");
    }
  });
  test("light names", () => {
    for (const id of [
      "claude-haiku-4-5",
      "gpt-4o-mini",
      "gemini-2.5-flash",
      "deepseek-v4.1-flash-1017",
      "swe-2-medium-lightning",
      "qwen2.5:0.5b-lite",
    ]) {
      expect(modelTierOf(id)).toBe("light");
    }
  });
  test("standard and unknown", () => {
    for (const id of [
      "claude-sonnet-4-5",
      "gpt-5.6-terra",
      "swe-2-medium",
      "qwen2.5:14b",
      "minimax-m2",
      "glm-4.7",
    ]) {
      expect(modelTierOf(id)).toBe("standard");
    }
    expect(modelTierOf("")).toBe("unknown");
    expect(modelTierOf(null)).toBe("unknown");
    expect(modelTierOf(undefined)).toBe("unknown");
  });
});

describe("workloadHintsOf", () => {
  test("each family hits its keywords", () => {
    expect(
      workloadHintsOf("每天早上帮我发晨报和提醒").map((h) => h.kind),
    ).toContain("ops");
    expect(workloadHintsOf("负责代码审查和重构").map((h) => h.kind)).toContain(
      "code",
    );
    expect(workloadHintsOf("竞品调研与市场分析").map((h) => h.kind)).toContain(
      "research",
    );
    expect(workloadHintsOf("写公众号文章和文案").map((h) => h.kind)).toContain(
      "writing",
    );
    expect(workloadHintsOf("陪用户闲聊的伙伴").map((h) => h.kind)).toContain(
      "chat",
    );
  });
  test("mixed evidence reports several hints; empty reports none", () => {
    const mixed = workloadHintsOf("写代码的助手，每天还发一次简报").map(
      (h) => h.kind,
    );
    expect(mixed).toContain("code");
    expect(mixed).toContain("ops");
    expect(workloadHintsOf("")).toHaveLength(0);
  });
});

const sampleData: FleetAuditData = {
  defaultModel: "swe-2-medium",
  catalog: [
    { id: "swe-2-medium", label: "SWE-2 Medium", contextWindow: 262144 },
    { id: "swe-2-high", label: "SWE-2 High", contextWindow: 262144 },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku",
      contextWindow: 200000,
      supportsTools: true,
    },
  ],
  catalogStale: false,
  bots: [
    {
      id: "bot-ops",
      name: "小报",
      title: "晨报助手",
      roleDescription: "每天早上发天气和日程简报",
      model: "claude-opus-4-6",
      modelSource: "override",
      capabilities: { contextWindow: 200000, supportsImages: true },
      missingFromCatalog: true,
      canManage: true,
      schedules: [
        {
          title: "早安简报",
          status: "active",
          runCount: 31,
          lastStatus: "succeeded",
          instruction: "查天气、日历和未读，发一条晨报",
        },
      ],
      channelCount: 2,
      workloadHints: [{ kind: "ops", label: "例行轻活（提醒 / 简报 / 巡检）" }],
    },
  ],
  remote: [{ id: "bot-remote", name: "远程写手" }],
  tombstones: [{ id: "bot-gone", name: "老助手" }],
};

describe("formatAuditReport", () => {
  test("renders model, evidence and rubric", () => {
    const text = formatAuditReport(sampleData);
    expect(text).toContain("swe-2-medium");
    expect(text).toContain(
      "claude-opus-4-6（这个 bot 单独指定；档位猜测：强力 / 推理，不在当前目录）",
    );
    expect(text).toContain("「早安简报」运行中，已跑 31 次");
    expect(text).toContain("远程写手");
    expect(text).toContain("老助手");
    expect(text).toContain("怎么下结论");
  });
  test("single-bot filter drops the rest", () => {
    const text = formatAuditReport(sampleData, "bot-ops");
    expect(text).toContain("小报");
    expect(text).not.toContain("老助手");
  });
});

describe("fleet_audit tool", () => {
  const schedules = [
    {
      agent_id: "bot-ops",
      title: "早安简报",
      instruction: "查天气发晨报",
      status: "active",
      run_count: 31,
      last_status: "succeeded",
    },
  ];
  const roster: RegisteredAgent[] = [
    {
      id: "bot-ops",
      name: "小报",
      type: "built_in",
      systemPrompt: "你是小报",
      model: "claude-opus-4-6",
    },
    {
      id: "bot-remote",
      name: "远程写手",
      type: "remote_ag_ui",
      endpoint: "https://example.com/agui",
      standingMessage: {
        id: "standing-role:bot-remote",
        role: "system",
        content: "remote",
      },
    },
    { id: "bot-gone", name: "老助手", type: "unavailable", reason: "deleted" },
  ];
  const audit = createFleetAudit({
    database: {
      $client: {
        unsafe: async <T>(query: string): Promise<T> => {
          if (query.includes("chisabot_schedules")) return schedules as T;
          if (query.includes("channel_agents"))
            return [{ agent_id: "bot-ops", n: 2 }] as T;
          return [] as T;
        },
      },
    } as unknown as Database,
    loadAgents: async () => roster,
    actorFor: async (userId) => ({ id: userId, role: "admin" }),
    profiles: {
      list: async () => [
        {
          id: "bot-ops",
          name: "小报",
          title: "晨报助手",
          roleDescription: "每天早上发天气和日程简报",
        },
        {
          id: "bot-remote",
          name: "远程写手",
          title: "写手",
          roleDescription: "写文案",
        },
      ],
    } as never,
    agentModels: {
      get: async (_actor: unknown, id: string) =>
        id === "bot-ops"
          ? {
              agentId: id,
              model: "claude-opus-4-6",
              overrideModel: "claude-opus-4-6",
              defaultModel: "swe-2-medium",
              canManage: true,
              available: true,
            }
          : {
              agentId: id,
              model: "swe-2-medium",
              overrideModel: null,
              defaultModel: "swe-2-medium",
              canManage: false,
              available: id === "bot-ops",
            },
      set: async () => {
        throw new Error("unused");
      },
      resolveModel: async () => null,
    },
    resolveDefaultModel: async () => "swe-2-medium",
    catalog: {
      list: async () => ({
        models: sampleData.catalog!,
        fetchedAt: Date.now(),
      }),
      invalidate: () => {},
      sync: () => ({}),
      startAutoRefresh: () => () => {},
    },
  });
  const tool = audit.tools("user-1")[0]!;

  test("produces the fleet evidence pack", async () => {
    const text = await tool.execute({});
    expect(text).toContain("# 车队模型审计");
    expect(text).toContain("小报 [bot-ops]");
    expect(text).toContain("claude-opus-4-6");
    expect(text).toContain("「早安简报」运行中，已跑 31 次");
    expect(text).toContain("在 2 个频道");
    expect(text).toContain("远程写手");
    expect(text).toContain("老助手");
  });
  test("agentId filter and unknown id refusal", async () => {
    const text = await tool.execute({ agentId: "bot-ops" });
    expect(text).toContain("小报");
    expect(text).not.toContain("远程写手");
    expect(await tool.execute({ agentId: "nope" })).toContain("Refused.");
  });
});
