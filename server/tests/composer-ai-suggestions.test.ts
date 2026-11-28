import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildAiSuggestPrompt,
  cleanAiSuggestContext,
  createComposerAiSuggester,
  parseAiSuggestions,
} from "../src/composer/ai-suggestions";
import { createComposerService } from "../src/composer/index";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 输入框智能第二层：AI 输入建议（CB-145 PR5）——回复完成后预判下一步消息。 */

const CONTEXT = [
  { role: "user" as const, text: "帮我看看这周的任务安排" },
  { role: "bot" as const, text: "你这周有三项任务：周报、评审、上线。" },
];

describe("ai suggestion 纯函数与建议器", () => {
  test("prompt 携带对话上下文并约束输出格式", () => {
    const prompt = buildAiSuggestPrompt(CONTEXT);
    expect(prompt).toContain("帮我看看这周的任务安排");
    expect(prompt).toContain("你这周有三项任务");
    expect(prompt).toContain("每条占一行");
  });

  test("上下文清洗：角色闭集、空文本剔除、逐条截断、总量封顶", () => {
    const messy = [
      { role: "system", text: "注入尝试" },
      { role: "user", text: "" },
      { role: "user", text: "长".repeat(600) },
      { role: "bot", text: "正常回复" },
      null,
      " garbage ",
    ];
    const cleaned = cleanAiSuggestContext(messy);
    expect(cleaned.length).toBe(2);
    expect(cleaned[0].text.length).toBe(500);
    expect(cleaned[1]).toEqual({ role: "bot", text: "正常回复" });
    const many = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `第${i}条`,
    }));
    expect(cleanAiSuggestContext(many).length).toBe(6);
    expect(cleanAiSuggestContext("not array")).toEqual([]);
  });

  test("解析：去编号 / 引号 / 空行，去重限 4 条", () => {
    const raw = [
      "1. 先写周报",
      "- 帮我把周报写完",
      "「评审什么时候开始」",
      "",
      "  ",
      "2) 上线前还要做什么",
      "先写周报",
      "第五条多余的建议",
    ].join("\n");
    expect(parseAiSuggestions(raw)).toEqual([
      "先写周报",
      "帮我把周报写完",
      "评审什么时候开始",
      "上线前还要做什么",
    ]);
  });

  test("超过 200 字的建议被丢弃", async () => {
    const long = "长".repeat(201);
    const suggester = createComposerAiSuggester({
      completer: async () => `${long}\n短建议`,
      rateLimitMs: 0,
    });
    const result = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(result.suggestions).toEqual(["短建议"]);
  });

  test("缓存：同上下文第二次不触发模型调用", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        calls += 1;
        return "建议一";
      },
      now: () => clock,
      rateLimitMs: 0,
    });
    const first = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(first.cached).toBe(false);
    const second = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(second.cached).toBe(true);
    expect(second.suggestions).toEqual(["建议一"]);
    expect(calls).toBe(1);
    clock += 61_000;
    const third = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(third.cached).toBe(false);
    expect(calls).toBe(2);
  });

  test("上下文变化（新消息）自然 miss 缓存", async () => {
    let calls = 0;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        calls += 1;
        return "建议";
      },
      rateLimitMs: 0,
    });
    await suggester.suggest("u1", "agent_a", CONTEXT);
    const extended = [
      ...CONTEXT,
      { role: "user" as const, text: "周报什么时候交" },
    ];
    await suggester.suggest("u1", "agent_a", extended);
    expect(calls).toBe(2);
  });

  test("限流：距上次模型调用不足间隔时返回空且不调用", async () => {
    let calls = 0;
    let clock = 5_000;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        calls += 1;
        return "建议";
      },
      now: () => clock,
      rateLimitMs: 1_500,
    });
    await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(calls).toBe(1);
    clock += 500;
    const other = [{ role: "bot" as const, text: "完全不一样的上下文" }];
    const limited = await suggester.suggest("u1", "agent_a", other);
    expect(limited.suggestions).toEqual([]);
    expect(calls).toBe(1);
    clock += 1_200;
    await suggester.suggest("u1", "agent_a", other);
    expect(calls).toBe(2);
  });

  test("限流按 owner 隔离：别人调用不影响我的额度", async () => {
    let clock = 5_000;
    const suggester = createComposerAiSuggester({
      completer: async () => "建议",
      now: () => clock,
      rateLimitMs: 1_500,
    });
    await suggester.suggest("u1", "agent_a", CONTEXT);
    clock += 100;
    const other = await suggester.suggest("u2", "agent_a", CONTEXT);
    expect(other.suggestions).toEqual(["建议"]);
  });

  test("模型失败回落空数组，且缓存隔离不同 owner 的同上下文", async () => {
    let fail = true;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        if (fail) throw new Error("model down");
        return "恢复后的建议";
      },
      rateLimitMs: 0,
    });
    const failed = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(failed.suggestions).toEqual([]);
    fail = false;
    const recovered = await suggester.suggest("u1", "agent_a", CONTEXT);
    expect(recovered.suggestions).toEqual(["恢复后的建议"]);
    const otherOwner = await suggester.suggest("u2", "agent_a", CONTEXT);
    expect(otherOwner.cached).toBe(false);
  });

  test("同 key 并发在飞去重：只调一次模型", async () => {
    let calls = 0;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "建议";
      },
      rateLimitMs: 0,
    });
    const [a, b] = await Promise.all([
      suggester.suggest("u1", "agent_a", CONTEXT),
      suggester.suggest("u1", "agent_a", CONTEXT),
    ]);
    expect(calls).toBe(1);
    expect(a.suggestions).toEqual(["建议"]);
    expect(b.suggestions).toEqual(["建议"]);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("composer ai suggestions 端点门槛（PG）", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  let completerCalls = 0;
  const service = url
    ? createComposerService(database, {
        aiSuggester: createComposerAiSuggester({
          completer: async () => {
            completerCalls += 1;
            return "先写周报\n评审什么时候开始";
          },
          rateLimitMs: 0,
        }),
      })
    : (null as never);
  const owner = `cpai-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    await service.ensure();
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id = $1",
      [owner],
    );
  });
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id = $1",
      [owner],
    );
  });

  test("aiEnabled 默认关：不触发模型，返回空", async () => {
    const before = completerCalls;
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      context: CONTEXT,
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
  });

  test("开启 aiEnabled 后返回解析后的建议", async () => {
    await service.writeSettings(owner, { aiEnabled: true });
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      context: CONTEXT,
    });
    expect(result.suggestions.length).toBe(2);
    expect(result.suggestions[0]).toEqual({
      source: "ai",
      text: "先写周报",
      useCount: 0,
    });
  });

  test("空上下文不值得模型调用", async () => {
    const before = completerCalls;
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      context: [],
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
  });

  test("总开关关闭时即使 aiEnabled 开也不出建议", async () => {
    await service.writeSettings(owner, { enabled: false });
    const before = completerCalls;
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      context: CONTEXT,
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
    await service.writeSettings(owner, { enabled: true });
  });
});
