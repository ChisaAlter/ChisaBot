import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createComposerService,
  normalizeComposerText,
} from "../src/composer/index";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 输入框效率第一层：快捷短语 + 本地候选 + 习惯学习（CB-145 PR4）。 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("composer settings / quick phrases / habits", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const service = url ? createComposerService(database) : (null as never);
  const alice = `cpalice-${randomUUID().slice(0, 8)}`;
  const bob = `cpbob-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const botB = `agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    await service.ensure();
    await database.$client.unsafe(
      "DELETE FROM chisabot_quick_phrases WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
  });
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_quick_phrases WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id IN ($1, $2)",
      [alice, bob],
    );
  });

  test("normalizeComposerText 小写压缩空白", () => {
    expect(normalizeComposerText("  你好   世界 \n")).toBe("你好 世界");
    expect(normalizeComposerText("ABC")).toBe("abc");
  });

  test("默认设置：总开关与本地候选开，AI/补全/学习关", async () => {
    const settings = await service.readSettings(alice);
    expect(settings.enabled).toBe(true);
    expect(settings.aiEnabled).toBe(false);
    expect(settings.completionEnabled).toBe(false);
    expect(settings.learningEnabled).toBe(false);
    expect(settings.localCompletionEnabled).toBe(true);
  });

  test("设置写入持久化且部分更新不影响其他字段", async () => {
    await service.writeSettings(alice, { learningEnabled: true });
    let settings = await service.readSettings(alice);
    expect(settings.learningEnabled).toBe(true);
    expect(settings.enabled).toBe(true);
    await service.writeSettings(alice, { aiEnabled: true });
    settings = await service.readSettings(alice);
    expect(settings.aiEnabled).toBe(true);
    expect(settings.learningEnabled).toBe(true);
  });

  test("快捷短语增删改与排序持久化", async () => {
    const first = await service.addPhrase(alice, {
      text: "帮我总结一下今天的进展",
    });
    const second = await service.addPhrase(alice, { text: "继续" });
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    let phrases = await service.listPhrases(alice);
    expect(phrases.map((p) => p.text)).toEqual([
      "帮我总结一下今天的进展",
      "继续",
    ]);
    // 重排
    phrases = await service.reorderPhrases(alice, {
      ids: [second.id, first.id],
    });
    expect(phrases.map((p) => p.text)).toEqual([
      "继续",
      "帮我总结一下今天的进展",
    ]);
    // 改
    const updated = await service.updatePhrase(alice, second.id, {
      text: "继续往下做",
    });
    expect(updated?.text).toBe("继续往下做");
    // 删
    expect(await service.deletePhrase(alice, first.id)).toBe(true);
    expect(await service.deletePhrase(alice, first.id)).toBe(false);
    phrases = await service.listPhrases(alice);
    expect(phrases.map((p) => p.text)).toEqual(["继续往下做"]);
  });

  test("重复短语（归一化后）被拒绝", async () => {
    await service.addPhrase(bob, { text: "你好 世界" });
    let duplicateError: Error | null = null;
    try {
      await service.addPhrase(bob, { text: "  你好   世界 " });
    } catch (error) {
      duplicateError = error as Error;
    }
    expect(duplicateError?.message).toBe("这条短语已经存在。");
  });

  test("owner 隔离：alice 的短语对 bob 不可见", async () => {
    const alicePhrases = await service.listPhrases(alice);
    const bobPhrases = await service.listPhrases(bob);
    for (const phrase of alicePhrases) {
      expect(bobPhrases.some((p) => p.id === phrase.id)).toBe(false);
    }
    // bob 不能改/删 alice 的短语
    const alien = alicePhrases[0];
    if (alien) {
      expect(
        await service.updatePhrase(bob, alien.id, { text: "x" }),
      ).toBeNull();
      expect(await service.deletePhrase(bob, alien.id)).toBe(false);
    }
  });

  test("学习关闭时 recordHabit 不写入", async () => {
    await service.writeSettings(alice, { learningEnabled: false });
    const result = await service.recordHabit(alice, {
      botId: bot,
      text: "帮我看看这个",
    });
    expect(result.recorded).toBe(false);
  });

  test("学习开启后发送累加 use_count，候选按频次排序", async () => {
    await service.writeSettings(alice, { learningEnabled: true });
    await service.recordHabit(alice, { botId: bot, text: "帮我看看这个" });
    await service.recordHabit(alice, { botId: bot, text: "帮我看看这个" });
    await service.recordHabit(alice, { botId: bot, text: "帮我整理一下" });
    const found = await service.candidates(alice, {
      botId: bot,
      prefix: "帮我",
    });
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found[0]!.text).toBe("帮我看看这个");
    expect(found[0]!.useCount).toBe(2);
    expect(found[0]!.source).toBe("habit");
  });

  test("习惯按 bot 隔离", async () => {
    const found = await service.candidates(alice, {
      botId: botB,
      prefix: "帮我",
    });
    expect(found.length).toBe(0);
  });

  test("快捷短语候选优先于习惯候选且去重", async () => {
    await service.addPhrase(alice, { text: "帮我写个周报" });
    const found = await service.candidates(alice, {
      botId: bot,
      prefix: "帮我",
    });
    expect(found[0]!.source).toBe("phrase");
    expect(found[0]!.text).toBe("帮我写个周报");
    // 完全等于前缀时不候选自己
    const exact = await service.candidates(alice, {
      botId: bot,
      prefix: "帮我写个周报",
    });
    expect(exact.every((c) => c.text !== "帮我写个周报")).toBe(true);
  });

  test("清空习惯：按 bot 与全量", async () => {
    const perBot = await service.clearHabits(alice, bot);
    expect(perBot.cleared).toBeGreaterThanOrEqual(2);
    expect(
      (await service.candidates(alice, { botId: bot, prefix: "帮我" })).every(
        (c) => c.source !== "habit",
      ),
    ).toBe(true);
    await service.recordHabit(alice, { botId: bot, text: "再来一次" });
    const all = await service.clearHabits(alice);
    expect(all.cleared).toBeGreaterThanOrEqual(1);
  });

  test("总开关或本地候选关闭时候选为空", async () => {
    await service.writeSettings(alice, { localCompletionEnabled: false });
    expect(
      (await service.candidates(alice, { botId: bot, prefix: "帮我" })).length,
    ).toBe(0);
    await service.writeSettings(alice, {
      localCompletionEnabled: true,
      enabled: false,
    });
    expect(
      (await service.candidates(alice, { botId: bot, prefix: "帮我" })).length,
    ).toBe(0);
    await service.writeSettings(alice, { enabled: true });
  });
});
