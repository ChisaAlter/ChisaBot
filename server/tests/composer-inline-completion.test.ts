import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createComposerService } from "../src/composer/index";
import {
  buildInlineCompletionPrompt,
  createInlineCompletionSuggester,
  parseInlineCompletion,
} from "../src/composer/inline-completion";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 输入框智能第三层：行内补全（CB-145 PR6）。 */

describe("inline completion 纯函数", () => {
  test("prompt 携带草稿并约束只输出续写", () => {
    const prompt = buildInlineCompletionPrompt("帮我把周报");
    expect(prompt).toContain("帮我把周报");
    expect(prompt).toContain("不要重复草稿");
  });

  test("解析：直接 suffix 原样返回", () => {
    expect(parseInlineCompletion("写完发出去", "帮我把周报")).toBe("写完发出去");
  });

  test("解析：剥掉模型复述的草稿前缀", () => {
    expect(parseInlineCompletion("帮我把周报写完发出去", "帮我把周报")).toBe(
      "写完发出去",
    );
  });

  test("解析：多行输出只取第一行", () => {
    expect(parseInlineCompletion("写完\n再说点别的", "帮我把周报")).toBe("写完");
  });

  test("解析：空输出与纯复述都无效", () => {
    expect(parseInlineCompletion("", "草稿")).toBeNull();
    expect(parseInlineCompletion("   ", "草稿")).toBeNull();
    expect(parseInlineCompletion("草稿", "草稿")).toBeNull();
  });

  test("解析：超过 60 字掐断", () => {
    const long = "续".repeat(80);
    const parsed = parseInlineCompletion(long, "草稿");
    expect(parsed).not.toBeNull();
    expect([...(parsed ?? "")].length).toBe(60);
  });

  test("解析：suffix 与草稿尾相同（无新内容）无效", () => {
    expect(parseInlineCompletion("周报", "帮我把周报")).toBeNull();
  });
});

describe("inline completion 建议器", () => {
  test("端到端：草稿进 context，出 suffix", async () => {
    const suggester = createInlineCompletionSuggester(async () => "写完发出去");
    const result = await suggester.suggest("u1", "inline", [
      { role: "user", text: "帮我把周报" },
    ]);
    expect(result.suggestions).toEqual(["写完发出去"]);
  });

  test("模型复述草稿时剥到只剩 suffix", async () => {
    const suggester = createInlineCompletionSuggester(
      async () => "帮我把周报写完",
    );
    const result = await suggester.suggest("u1", "inline", [
      { role: "user", text: "帮我把周报" },
    ]);
    expect(result.suggestions).toEqual(["写完"]);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("composer inline completion 端点门槛（PG）", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  let completerCalls = 0;
  const service = url
    ? createComposerService(database, {
        completionSuggester: createInlineCompletionSuggester(async () => {
          completerCalls += 1;
          return "写完发出去";
        }),
      })
    : (null as never);
  const owner = `cpic-${randomUUID().slice(0, 8)}`;

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

  test("completionEnabled 默认关：不触发模型", async () => {
    const before = completerCalls;
    const result = await service.inlineCompletion(owner, {
      text: "帮我把周报",
    });
    expect(result.completion).toBeNull();
    expect(completerCalls).toBe(before);
  });

  test("开启后返回 suffix；短草稿不调用；总开关优先", async () => {
    await service.writeSettings(owner, { completionEnabled: true });
    const result = await service.inlineCompletion(owner, {
      text: "帮我把周报",
    });
    expect(result.completion).toBe("写完发出去");
    const before = completerCalls;
    expect((await service.inlineCompletion(owner, { text: "好" })).completion).toBeNull();
    expect(completerCalls).toBe(before);
    await service.writeSettings(owner, { enabled: false });
    expect(
      (await service.inlineCompletion(owner, { text: "继续测试长一点" }))
        .completion,
    ).toBeNull();
    expect(completerCalls).toBe(before);
  });
});
