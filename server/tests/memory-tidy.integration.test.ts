import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { createMemoryNotes } from "../src/memory-notes/service";
import { applyTidy, type TidySql } from "../src/memory-notes/tidy";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 整理记忆（审计 12-settings 必修 1），真库：超长不合并、不同机器人不合并、预览 token、撤销、
 * 事务中途失败整个回滚（笔记和原文备份都不留）、备份表和索引建好了。没有 TEST_DATABASE_URL 时跳过（测试 bot 跑）。
 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("memory tidy on a dedicated PostgreSQL database", () => {
  let database: ReturnType<typeof createDatabase>;
  let notes: ReturnType<typeof createMemoryNotes>;
  const owner = `tidytest-${randomUUID().slice(0, 8)}`;
  const sql = () => database.$client;
  const rows = async () =>
    (
      await sql().unsafe<
        {
          id: string;
          content: string;
          agent_id: string | null;
          updated_at: Date;
        }[]
      >(
        "SELECT id, content, agent_id, updated_at FROM chisabot_memory_notes WHERE owner_user_id = $1 ORDER BY id",
        [owner],
      )
    ).map((row) => ({
      ...row,
      updated_at: new Date(row.updated_at).toISOString(),
    }));
  const backups = async () =>
    (
      await sql().unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1",
        [owner],
      )
    )[0]!.n;
  const reset = async () => {
    await sql().unsafe(
      "DELETE FROM chisabot_memory_notes WHERE owner_user_id = $1",
      [owner],
    );
    await sql().unsafe(
      "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1",
      [owner],
    );
  };
  /** 直接插（create 会按主题自动并，这里要造出重复的）。 */
  const insert = async (input: {
    kind: string;
    subject: string | null;
    content: string;
    agentId?: string | null;
    context?: string | null;
    minutesAgo: number;
  }) => {
    const id = `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await sql().unsafe(
      `INSERT INTO chisabot_memory_notes (id, owner_user_id, kind, subject, content, context, agent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8), now() - make_interval(mins => $8))`,
      [
        id,
        owner,
        input.kind,
        input.subject,
        input.content,
        input.context ?? null,
        input.agentId ?? null,
        input.minutesAgo,
      ],
    );
    return id;
  };

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    notes = createMemoryNotes(database);
    await notes.ensure();
    await notes.ensure(); // 重复开机不出错
  });
  afterAll(async () => {
    await reset();
    await database.$client.close();
  });

  test("备份表和按人查的索引建好了", async () => {
    const indexes = await sql().unsafe<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'chisabot_memory_tidy_backups'",
    );
    expect(indexes.map((row) => row.indexname)).toContain(
      "chisabot_memory_tidy_backups_owner",
    );
  });

  test("合并后超过 4000 字不合并；不同机器人不合并；同一机器人的合并，撤销后恢复原样", async () => {
    await reset();
    await insert({
      kind: "note",
      subject: "长文",
      content: "甲".repeat(3000),
      minutesAgo: 10,
    });
    await insert({
      kind: "note",
      subject: "长文",
      content: "乙".repeat(3000),
      minutesAgo: 9,
    });
    await insert({
      kind: "person",
      subject: "小林",
      content: "同事",
      agentId: "bot-b",
      minutesAgo: 8,
    });
    const old = await insert({
      kind: "person",
      subject: "小林",
      content: "大学室友",
      agentId: "bot-a",
      minutesAgo: 7,
    });
    const recent = await insert({
      kind: "person",
      subject: "小林",
      content: "住在杭州",
      agentId: "bot-a",
      minutesAgo: 6,
    });
    const before = await rows();

    const preview = await notes.previewDream(owner);
    expect(
      preview.groups.map((group) => [
        group.title,
        group.agentId,
        group.skipped,
        group.count,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["长文", null, "too_long", 2],
        ["小林", "bot-a", null, 2],
      ]),
    );
    expect(preview.groups.some((group) => group.agentId === "bot-b")).toBe(
      false,
    );

    const result = await notes.dream(owner, preview.token);
    expect(result.mergedCount).toBe(1);
    const after = await rows();
    expect(after).toHaveLength(4);
    expect(after.find((row) => row.id === recent)!.content).toBe(
      "住在杭州\n大学室友",
    );
    expect(after.some((row) => row.id === old)).toBe(false);
    expect(after.filter((row) => row.content.length === 3000)).toHaveLength(2);
    expect((await notes.lastDream(owner))?.batchId).toBe(result.batchId!);

    expect(await notes.undoDream(owner, result.batchId!)).toEqual({
      restored: 2,
      skipped: 0,
    });
    expect(await rows()).toEqual(before);
    expect(await backups()).toBe(0);
    expect(await notes.lastDream(owner)).toBeNull();
  });

  test("预览后笔记变了：409 冲突，什么都不改", async () => {
    await reset();
    await insert({
      kind: "note",
      subject: "重复",
      content: "a",
      minutesAgo: 5,
    });
    await insert({
      kind: "note",
      subject: "重复",
      content: "b",
      minutesAgo: 4,
    });
    const preview = await notes.previewDream(owner);
    await insert({
      kind: "note",
      subject: "重复",
      content: "c",
      minutesAgo: 1,
    });
    const before = await rows();
    await expect(notes.dream(owner, preview.token)).rejects.toThrow("重新");
    expect(await rows()).toEqual(before);
  });

  test("事务中途失败（删被并条目时出错）：整个回滚，笔记和备份都不留", async () => {
    await reset();
    await insert({
      kind: "project",
      subject: "装修",
      content: "定了瓷砖",
      agentId: "bot-a",
      minutesAgo: 5,
    });
    await insert({
      kind: "project",
      subject: "装修",
      content: "约了水电",
      agentId: "bot-a",
      minutesAgo: 4,
    });
    await insert({
      kind: "daily",
      subject: "2026-10-29",
      content: "- 09:00 跑步\n- 18:00 跑步",
      minutesAgo: 3,
    });
    const before = await rows();
    // 真事务，只在最后一步「删掉被并的笔记」时注入错误。
    const real = sql() as unknown as TidySql;
    const failing: TidySql = {
      unsafe: real.unsafe.bind(real),
      begin: (fn) =>
        real.begin((tx) =>
          fn({
            begin: tx.begin.bind(tx),
            unsafe: ((query: string, params?: unknown[]) => {
              if (query.startsWith("DELETE FROM chisabot_memory_notes"))
                throw new Error("injected failure");
              return tx.unsafe(query, params);
            }) as TidySql["unsafe"],
          }),
        ),
    };
    await expect(applyTidy(failing, owner)).rejects.toThrow("injected failure");
    expect(await rows()).toEqual(before);
    expect(await backups()).toBe(0);
  });
});
