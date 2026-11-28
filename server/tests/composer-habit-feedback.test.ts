import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createComposerService } from "../src/composer/index";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 输入框智能第四层：习惯反馈记账与排序加权（CB-145 PR7）。 */

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("composer habit feedback（PG）", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const service = url ? createComposerService(database) : (null as never);
  const owner = `cphf-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    await service.ensure();
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id = $1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id = $1",
      [owner],
    );
    await service.writeSettings(owner, { learningEnabled: true });
  });
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_habit_items WHERE owner_user_id = $1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_composer_settings WHERE owner_user_id = $1",
      [owner],
    );
  });

  test("feedback 累加计数且不创造新行", async () => {
    await service.recordHabit(owner, { botId: bot, text: "帮我写个周报" });
    const result = await service.recordHabitFeedback(owner, {
      botId: bot,
      events: [
        { kind: "shown", text: "帮我写个周报" },
        { kind: "shown", text: "帮我写个周报" },
        { kind: "accepted", text: "帮我写个周报" },
        { kind: "ignored", text: "不存在的文本" },
      ],
    });
    expect(result.recorded).toBe(3);
    const rows = await database.$client.unsafe(
      "SELECT shown_count, accepted_count, ignored_count, use_count FROM chisabot_composer_habit_items WHERE owner_user_id = $1",
      [owner],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].shown_count)).toBe(2);
    expect(Number(rows[0].accepted_count)).toBe(1);
    expect(Number(rows[0].ignored_count)).toBe(0);
    expect(Number(rows[0].use_count)).toBe(1);
  });

  test("非法事件被跳过，空列表报错", async () => {
    const result = await service.recordHabitFeedback(owner, {
      botId: bot,
      events: [
        { kind: "bogus", text: "帮我写个周报" },
        { kind: "shown", text: "" },
        null,
      ],
    });
    expect(result.recorded).toBe(0);
    let threw = false;
    try {
      await service.recordHabitFeedback(owner, { botId: bot, events: [] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("反馈按 (owner, bot) 隔离：别人的行记不上", async () => {
    const stranger = `cphf-other-${randomUUID().slice(0, 8)}`;
    const result = await service.recordHabitFeedback(stranger, {
      botId: bot,
      events: [{ kind: "shown", text: "帮我写个周报" }],
    });
    expect(result.recorded).toBe(0);
    const wrongBot = `agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const result2 = await service.recordHabitFeedback(owner, {
      botId: wrongBot,
      events: [{ kind: "shown", text: "帮我写个周报" }],
    });
    expect(result2.recorded).toBe(0);
  });

  test("排序加权：accepted 提权、ignored 降权，零反馈时按 use_count", async () => {
    // 三条习惯：A use 5 零反馈；B use 4 但 accepted 2；C use 6 但 ignored 3。
    // 加权分：A=5, B=4+4=8, C=6-3=3 → 排序 B > A > C。
    for (const [text, count] of [
      ["高频甲", 5],
      ["高频乙", 4],
      ["高频丙", 6],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        await service.recordHabit(owner, { botId: bot, text });
      }
    }
    await service.recordHabitFeedback(owner, {
      botId: bot,
      events: [
        { kind: "accepted", text: "高频乙" },
        { kind: "accepted", text: "高频乙" },
        { kind: "ignored", text: "高频丙" },
        { kind: "ignored", text: "高频丙" },
        { kind: "ignored", text: "高频丙" },
      ],
    });
    const candidates = await service.candidates(owner, {
      botId: bot,
      prefix: "高频",
    });
    const order = candidates.map((c) => c.text);
    expect(order.indexOf("高频乙")).toBeLessThan(order.indexOf("高频甲"));
    expect(order.indexOf("高频甲")).toBeLessThan(order.indexOf("高频丙"));
  });
});
