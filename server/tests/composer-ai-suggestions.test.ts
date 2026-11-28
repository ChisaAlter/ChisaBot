import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildAiSuggestPrompt,
  createComposerAiSuggester,
} from "../src/composer/ai-suggestions";
import { createComposerService } from "../src/composer/index";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 输入框智能第二层：AI 输入建议（CB-145 PR5）。 */

describe("ai suggestion 纯函数与建议器", () => {
  test("prompt 携带草稿并约束输出格式", () => {
    const prompt = buildAiSuggestPrompt("帮我写个周报");
    expect(prompt).toContain("帮我写个周报");
    expect(prompt).toContain("每条占一行");
  });

  test("解析：去编号 / 引号 / 空行，剔除草稿本身，去重限 3 条", async () => {
    const raw = [
      "1. 帮我写个周报",
      "- 帮我写一份本周工作周报",
      "「帮我总结这周的工作进展」",
      "",
      "帮我写个周报",
      "  ",
      "2) 帮我把周报写得简洁一点",
      "帮我写一份本周工作周报",
    ].join("\n");
    const completer = async () => raw;
    const suggester = createComposerAiSuggester({
      completer,
      rateLimitMs: 0,
    });
    const result = await suggester.suggest("u1", "agent_a", "帮我写个周报");
    expect(result.suggestions).toEqual([
      "帮我写一份本周工作周报",
      "帮我总结这周的工作进展",
      "帮我把周报写得简洁一点",
    ]);
  });

  test("超过 200 字的建议被丢弃", async () => {
    const long = "长".repeat(201);
    const suggester = createComposerAiSuggester({
      completer: async () => `${long}\n短建议`,
      rateLimitMs: 0,
    });
    const result = await suggester.suggest("u1", "agent_a", "起草");
    expect(result.suggestions).toEqual(["短建议"]);
  });

  test("缓存：同 key 第二次不触发模型调用", async () => {
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
    const first = await suggester.suggest("u1", "agent_a", "草稿甲");
    expect(first.cached).toBe(false);
    const second = await suggester.suggest("u1", "agent_a", "草稿甲");
    expect(second.cached).toBe(true);
    expect(second.suggestions).toEqual(["建议一"]);
    expect(calls).toBe(1);
    clock += 61_000;
    const third = await suggester.suggest("u1", "agent_a", "草稿甲");
    expect(third.cached).toBe(false);
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
    await suggester.suggest("u1", "agent_a", "草稿甲");
    expect(calls).toBe(1);
    clock += 500;
    const limited = await suggester.suggest("u1", "agent_a", "草稿乙不一样");
    expect(limited.suggestions).toEqual([]);
    expect(calls).toBe(1);
    clock += 1_200;
    await suggester.suggest("u1", "agent_a", "草稿乙不一样");
    expect(calls).toBe(2);
  });

  test("限流按 owner 隔离：别人调用不影响我的额度", async () => {
    let clock = 5_000;
    const suggester = createComposerAiSuggester({
      completer: async () => "建议",
      now: () => clock,
      rateLimitMs: 1_500,
    });
    await suggester.suggest("u1", "agent_a", "草稿甲");
    clock += 100;
    const other = await suggester.suggest("u2", "agent_a", "草稿乙");
    expect(other.suggestions).toEqual(["建议"]);
  });

  test("模型失败回落空数组，且缓存隔离不同 owner 的同文本", async () => {
    let fail = true;
    const suggester = createComposerAiSuggester({
      completer: async () => {
        if (fail) throw new Error("model down");
        return "恢复后的建议";
      },
      rateLimitMs: 0,
    });
    const failed = await suggester.suggest("u1", "agent_a", "草稿");
    expect(failed.suggestions).toEqual([]);
    fail = false;
    const recovered = await suggester.suggest("u1", "agent_a", "草稿");
    expect(recovered.suggestions).toEqual(["恢复后的建议"]);
    const otherOwner = await suggester.suggest("u2", "agent_a", "草稿");
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
      suggester.suggest("u1", "agent_a", "一样的草稿"),
      suggester.suggest("u1", "agent_a", "一样的草稿"),
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
            return "帮我润色这段周报\n帮我把周报压缩到三行";
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
      text: "帮我写个周报",
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
  });

  test("开启 aiEnabled 后返回解析后的建议", async () => {
    await service.writeSettings(owner, { aiEnabled: true });
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      text: "帮我写个周报",
    });
    expect(result.suggestions.length).toBe(2);
    expect(result.suggestions[0]).toEqual({
      source: "ai",
      text: "帮我润色这段周报",
      useCount: 0,
    });
  });

  test("总开关关闭时即使 aiEnabled 开也不出建议", async () => {
    await service.writeSettings(owner, { enabled: false });
    const before = completerCalls;
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      text: "再试一次的草稿",
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
    await service.writeSettings(owner, { enabled: true });
  });

  test("短于 2 字的草稿不值得模型调用", async () => {
    const before = completerCalls;
    const result = await service.aiSuggestions(owner, {
      botId: bot,
      text: "好",
    });
    expect(result.suggestions).toEqual([]);
    expect(completerCalls).toBe(before);
  });
});
