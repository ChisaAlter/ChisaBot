import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tidyUndoHref } from "../../shared/memory-notes";
import {
  withConfirmToolCall,
  withConfirmTurn,
} from "../src/confirmations/context";
import { createConfirmations } from "../src/confirmations/service";
import { createDatabase } from "../src/db/client";
import { createMemoryNotes } from "../src/memory-notes/service";
import { applyTidy, type TidySql } from "../src/memory-notes/tidy";
import { type GrantedTool, REFUSAL_MARKER } from "../src/plugins/tools";
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

/**
 * 整理记忆走审批（#430 小爱必改）：定时任务里不直接删也不静默失败——留一张带预览的整理建议卡片；
 * 点「确认」后按预览 token 执行；确认后记忆变了，旧确认作废、重出一张写明原因的卡片；
 * 删除审批设为「直接做」照常执行，结果带撤销链接，memory_dream_undo 能撤销。
 */
suite("memory_dream through confirmations (real PostgreSQL)", () => {
  let database: ReturnType<typeof createDatabase>;
  let notes: ReturnType<typeof createMemoryNotes>;
  let confirm: ReturnType<typeof createConfirmations>;
  const owner = `tidycf-${randomUUID().slice(0, 8)}`;
  const thread = `thread-${randomUUID().slice(0, 8)}`;
  const resumed: { threadId: string; text: string }[] = [];
  const sql = () => database.$client;
  const turn = () => ({
    threadId: thread,
    runId: "run-1",
    stopped: () => false,
  });
  const count = async () =>
    (
      await sql().unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_memory_notes WHERE owner_user_id = $1",
        [owner],
      )
    )[0]!.n;
  const insert = async (subject: string, content: string, minutesAgo: number) =>
    await sql().unsafe(
      `INSERT INTO chisabot_memory_notes (id, owner_user_id, kind, subject, content, agent_id, created_at, updated_at)
       VALUES ($1, $2, 'person', $3, $4, 'bot-a', now() - make_interval(mins => $5), now() - make_interval(mins => $5))`,
      [
        `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        owner,
        subject,
        content,
        minutesAgo,
      ],
    );
  const reset = async () => {
    for (const table of [
      "chisabot_memory_notes",
      "chisabot_memory_tidy_backups",
      "chisabot_confirm_requests",
      "chisabot_confirm_prefs",
    ])
      await sql().unsafe(`DELETE FROM ${table} WHERE owner_user_id = $1`, [
        owner,
      ]);
    await insert("小林", "大学室友", 10);
    await insert("小林", "住在杭州", 9);
  };
  const toolsFor = (initiator: { kind: "routine"; id: string }) => {
    const wrapped = confirm.wrap(notes.tools(owner, "bot-a"), {
      ownerUserId: owner,
      agentId: "bot-a",
      initiator,
    });
    const byName = (name: string) =>
      wrapped.find((tool) => tool.name === name)!;
    return { dream: byName("memory_dream"), undo: byName("memory_dream_undo") };
  };
  const exec = (tool: GrantedTool, args: unknown) =>
    withConfirmTurn(turn(), () =>
      withConfirmToolCall(`call-${randomUUID().slice(0, 6)}`, tool.name, () =>
        tool.execute(args, {} as never),
      ),
    );
  const cards = async (status = "pending") =>
    (await confirm.list(owner, { threadId: thread })).filter(
      (card) => card.tool === "memory_dream" && card.status === status,
    );

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    notes = createMemoryNotes(database);
    confirm = createConfirmations(database);
    await notes.ensure();
    await confirm.ensure();
    confirm.setResume(async (input) => {
      resumed.push({ threadId: input.threadId, text: input.text });
    });
  });
  afterAll(async () => {
    for (const table of [
      "chisabot_memory_notes",
      "chisabot_memory_tidy_backups",
      "chisabot_confirm_requests",
      "chisabot_confirm_prefs",
    ])
      await sql().unsafe(`DELETE FROM ${table} WHERE owner_user_id = $1`, [
        owner,
      ]);
    await database.$client.close();
  });

  test("定时任务（不在场）→ 留一张带预览的整理建议，不删；点确认 → 按 token 执行，带撤销入口，能撤销", async () => {
    await reset();
    const routine = toolsFor({ kind: "routine", id: "schedule:weekly-dream" });
    const out = await exec(routine.dream, {});
    expect(out).toContain(REFUSAL_MARKER);
    expect(out).toContain("确认卡片");
    expect(await count()).toBe(2); // 没删
    const [card] = await cards();
    expect(card!.title).toContain("合并 1 组");
    expect(card!.details.map((detail) => detail.value)).toContain(
      "人物「小林」（这个机器人记的）：2 条合并为 1 条",
    );
    expect(card!.category).toBe("delete");

    await confirm.decide(owner, card!.id, "approve");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumed.at(-1)?.threadId).toBe(thread);
    // 服务器叫机器人接着做：同样的调用，预览 token 没变 → 用这次确认放行。
    const resumedRun = toolsFor({ kind: "routine", id: `confirm:${card!.id}` });
    const done = await exec(resumedRun.dream, {});
    expect(done).toContain("已整理记忆：合并了 1 条重复笔记");
    const last = await notes.lastDream(owner);
    expect(done).toContain(tidyUndoHref(last!.batchId));
    expect(await count()).toBe(1);

    expect(await exec(resumedRun.undo, {})).toBe("已恢复整理前的 2 条记忆。");
    expect(await count()).toBe(2);
    expect(await exec(resumedRun.undo, { batchId: last!.batchId })).toContain(
      "已经撤销过",
    );
  });

  test("确认后记忆又变了：旧确认作废、不执行，重出一张写明原因的卡片", async () => {
    await reset();
    const routine = toolsFor({ kind: "routine", id: "schedule:weekly-dream" });
    await exec(routine.dream, {});
    const [card] = await cards();
    await confirm.decide(owner, card!.id, "approve");
    await insert("小林", "喜欢猫", 1);

    const resumedRun = toolsFor({ kind: "routine", id: `confirm:${card!.id}` });
    const pending = exec(resumedRun.dream, {});
    let fresh: Awaited<ReturnType<typeof cards>>[number] | undefined;
    for (let i = 0; i < 40 && !fresh; i++) {
      fresh = (await cards()).find((c) => c.id !== card!.id);
      if (!fresh) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fresh!.title).toContain("内容在你确认后有了变化");
    expect(fresh!.details.map((detail) => detail.value)).toContain(
      "人物「小林」（这个机器人记的）：3 条合并为 1 条",
    );
    expect(await count()).toBe(3); // 旧确认没有被拿来删新内容
    await confirm.decide(owner, fresh!.id, "deny");
    expect(await pending).toContain(REFUSAL_MARKER);
    expect(await count()).toBe(3);
  });

  test("删除审批设为「直接做」：定时任务里照常整理，结果带撤销入口；过期 token、没东西可整理都有明确回复", async () => {
    await reset();
    await confirm.setPref(owner, "delete", "auto", null);
    const routine = toolsFor({ kind: "routine", id: "schedule:weekly-dream" });
    expect(await exec(routine.dream, { token: "stale-token" })).toContain(
      "这份整理建议已经过期",
    );
    expect(await count()).toBe(2);

    const done = await exec(routine.dream, {});
    expect(done).toContain("已整理记忆");
    expect(done).toContain("/settings/memory?undoTidy=");
    expect(await cards()).toHaveLength(0);
    expect(await count()).toBe(1);
    expect(await exec(routine.dream, {})).toContain("记忆已经很整洁");
    expect(await exec(routine.undo, {})).toBe("已恢复整理前的 2 条记忆。");
    expect(await count()).toBe(2);
  });
});
