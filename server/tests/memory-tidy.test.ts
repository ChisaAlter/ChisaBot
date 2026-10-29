import { describe, expect, test } from "bun:test";
import { MEMORY_LIMITS } from "../../shared/memory-notes";
import { categoryOfTool, titleForTool } from "../src/confirmations/classify";
import {
  applyTidy,
  dedupeLines,
  planTidy,
  previewOf,
  TidyConflictError,
  type TidyRow,
  type TidySql,
  undoTidy,
} from "../src/memory-notes/tidy";

/**
 * 整理记忆（审计 12-settings 必修 1）：不用数据库的部分。
 * 计划是纯函数；整理 / 撤销用一个内存版 SQL（只认 tidy.ts 用到的那几条语句），begin 里出错就把状态整个还原，
 * 事务外写库直接报错——这样能验证「所有写都在一个事务里、中途失败什么都不留」。真库版本见 memory-tidy.integration.test.ts。
 */

let seq = 0;
const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 9, 29, 12, 0) - minutesAgo * 60_000).toISOString();
function note(partial: Partial<TidyRow> & Pick<TidyRow, "content">): TidyRow {
  seq++;
  return {
    id: `mem_${seq.toString(16).padStart(12, "0")}`,
    owner_user_id: "u1",
    kind: "note",
    subject: null,
    context: null,
    agent_id: null,
    shared: false,
    created_at: at(1000 - seq),
    updated_at: at(1000 - seq),
    ...partial,
  };
}
const newestFirst = (rows: TidyRow[]) =>
  [...rows].sort((a, b) =>
    String(b.updated_at).localeCompare(String(a.updated_at)),
  );

type Backup = {
  batch_id: string;
  owner_user_id: string;
  note_id: string;
  action: string;
  original: string;
  after_content: string | null;
  created_at: string;
  merged: number;
  deduplicated: number;
};
type State = { notes: TidyRow[]; backups: Backup[] };

/** 内存版 SQL。failOnWrite = 第几次写（从 1 数）时抛错。 */
function memorySql(initial: TidyRow[], options: { failOnWrite?: number } = {}) {
  let state: State = { notes: structuredClone(initial), backups: [] };
  let writes = 0;
  let inTx = false;
  const run = async (
    query: string,
    params: unknown[] = [],
  ): Promise<unknown> => {
    const q = query.replace(/\s+/g, " ").trim();
    const isWrite = /^(INSERT|UPDATE|DELETE)/.test(q);
    if (isWrite) {
      if (!inTx)
        throw new Error(`write outside a transaction: ${q.slice(0, 60)}`);
      writes++;
      if (options.failOnWrite === writes) throw new Error("injected failure");
    }
    const [p1, p2, p3, p4, p5] = params as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_notes WHERE owner_user_id = $1 AND shared = false",
      )
    )
      return structuredClone(
        newestFirst(
          state.notes.filter((row) => row.owner_user_id === p1 && !row.shared),
        ),
      );
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 OR",
      )
    ) {
      state.backups = state.backups.filter((row) => row.owner_user_id !== p1);
      return [];
    }
    if (q.startsWith("INSERT INTO chisabot_memory_tidy_backups")) {
      const [
        batch_id,
        owner_user_id,
        note_id,
        action,
        original,
        after_content,
        merged,
        deduplicated,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
        number,
      ];
      state.backups.push({
        batch_id,
        owner_user_id,
        note_id,
        action,
        original,
        after_content,
        merged,
        deduplicated,
        created_at: new Date().toISOString(),
      });
      return [];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_memory_notes SET content = $3, updated_at = now()",
      )
    ) {
      for (const row of state.notes)
        if (row.id === p1 && row.owner_user_id === p2)
          Object.assign(row, {
            content: p3,
            updated_at: new Date().toISOString(),
          });
      return [];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_notes WHERE owner_user_id = $1 AND id = ANY",
      )
    ) {
      const ids = new Set(p2.split("\u001f"));
      state.notes = state.notes.filter(
        (row) => !(row.owner_user_id === p1 && ids.has(row.id)),
      );
      return [];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2",
      )
    )
      return state.backups
        .filter((row) => row.owner_user_id === p1 && row.batch_id === p2)
        .map((row) => ({ ...row, original: JSON.parse(row.original) }));
    if (q.startsWith("INSERT INTO chisabot_memory_notes")) {
      if (state.notes.some((row) => row.id === p1)) return [];
      const [
        id,
        owner_user_id,
        kind,
        subject,
        content,
        context,
        agent_id,
        created_at,
        updated_at,
      ] = params as [
        string,
        string,
        TidyRow["kind"],
        string | null,
        string,
        string | null,
        string | null,
        Date,
        Date,
      ];
      state.notes.push({
        id,
        owner_user_id,
        kind,
        subject,
        content,
        context,
        agent_id,
        shared: false,
        created_at: created_at.toISOString(),
        updated_at: updated_at.toISOString(),
      });
      return [{ id }];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_memory_notes SET content = $3, updated_at = $5",
      )
    ) {
      const row = state.notes.find(
        (r) => r.id === p1 && r.owner_user_id === p2 && r.content === p4,
      );
      if (!row) return [];
      Object.assign(row, {
        content: p3,
        updated_at: (p5 as unknown as Date).toISOString(),
      });
      return [{ id: row.id }];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2",
      )
    ) {
      state.backups = state.backups.filter(
        (row) => !(row.owner_user_id === p1 && row.batch_id === p2),
      );
      return [];
    }
    throw new Error(`unexpected statement: ${q.slice(0, 80)}`);
  };
  const sql: TidySql = {
    unsafe: run as TidySql["unsafe"],
    async begin(fn) {
      const snapshot = structuredClone(state);
      inTx = true;
      try {
        return await fn(sql);
      } catch (error) {
        state = snapshot; // ROLLBACK
        throw error;
      } finally {
        inTx = false;
      }
    },
  };
  return { sql, state: () => state };
}

describe("planTidy", () => {
  test("同一个机器人、同种类同主题的笔记并成一条，旧的接在后面，重复行去掉", () => {
    const old = note({
      kind: "person",
      subject: "小林",
      content: "大学室友\n住在杭州",
      agent_id: "bot-a",
    });
    const recent = note({
      kind: "person",
      subject: "小林",
      content: "住在杭州\n喜欢爬山",
      agent_id: "bot-a",
    });
    const plan = planTidy(newestFirst([old, recent]));
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.skipped).toBeNull();
    expect(plan.groups[0]!.keep.id).toBe(recent.id);
    expect(plan.groups[0]!.drop.map((row) => row.id)).toEqual([old.id]);
    expect(plan.groups[0]!.content).toBe("住在杭州\n喜欢爬山\n大学室友");
    expect(previewOf(plan)).toMatchObject({
      mergedCount: 1,
      totalRemaining: 1,
    });
  });

  test("合并后超过 4000 字的组整组不并，原文一个字不少", () => {
    const a = note({ subject: "长文", content: "甲".repeat(3000) });
    const b = note({ subject: "长文", content: "乙".repeat(3000) });
    const plan = planTidy(newestFirst([a, b]));
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      skipped: "too_long",
      count: 2,
      drop: [],
    });
    expect(plan.groups[0]!.length).toBeGreaterThan(MEMORY_LIMITS.content);
    const preview = previewOf(plan);
    expect(preview.mergedCount).toBe(0);
    expect(preview.totalRemaining).toBe(2);
  });

  test("不同机器人、不同情境记的同主题笔记不合并", () => {
    const rows = [
      note({
        kind: "person",
        subject: "小林",
        content: "室友",
        agent_id: "bot-a",
      }),
      note({
        kind: "person",
        subject: "小林",
        content: "同事",
        agent_id: "bot-b",
      }),
      note({
        kind: "person",
        subject: "小林",
        content: "邻居",
        agent_id: null,
      }),
      note({ kind: "preference", content: "喝美式", context: "在公司" }),
      note({ kind: "preference", content: "喝美式", context: "周末" }),
    ];
    const plan = planTidy(newestFirst(rows));
    expect(plan.groups).toHaveLength(0);
    expect(previewOf(plan)).toMatchObject({
      mergedCount: 0,
      totalRemaining: 5,
    });
  });

  test("没主题的只有正文完全相同才算一组", () => {
    const plan = planTidy(
      newestFirst([
        note({ content: "不吃香菜" }),
        note({ content: " 不吃香菜 " }),
        note({ content: "不吃辣" }),
      ]),
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.count).toBe(2);
  });

  test("行去重只删重复行（日志时间不算正文），不截断", () => {
    expect(dedupeLines("- 09:00 跑步\n- 18:00 跑步\n- 19:00 看书")).toEqual({
      content: "- 09:00 跑步\n- 19:00 看书",
      removed: 1,
    });
    const long = `${"字".repeat(3990)}\n重复\n重复`;
    expect(dedupeLines(long).content).toBe(`${"字".repeat(3990)}\n重复`);
  });

  test("指纹：笔记一变就不同", () => {
    const a = note({ content: "x" });
    const b = note({ content: "x" });
    const first = planTidy(newestFirst([a, b])).fingerprint;
    expect(planTidy(newestFirst([a, b])).fingerprint).toBe(first);
    expect(
      planTidy(newestFirst([a, { ...b, updated_at: at(-5) }])).fingerprint,
    ).not.toBe(first);
  });
});

describe("applyTidy / undoTidy（内存版 SQL）", () => {
  const fixture = () => [
    note({
      kind: "person",
      subject: "小林",
      content: "大学室友",
      agent_id: "bot-a",
    }),
    note({
      kind: "person",
      subject: "小林",
      content: "住在杭州",
      agent_id: "bot-a",
    }),
    note({
      kind: "person",
      subject: "小林",
      content: "同事",
      agent_id: "bot-b",
    }),
    note({
      kind: "daily",
      subject: "2026-10-29",
      content: "- 09:00 跑步\n- 18:00 跑步",
    }),
    note({ subject: "长文", content: "甲".repeat(3000) }),
    note({ subject: "长文", content: "乙".repeat(3000) }),
  ];

  test("整理在事务里做、留原文，撤销后一模一样", async () => {
    const rows = fixture();
    const db = memorySql(rows);
    const { preview } = { preview: previewOf(planTidy(newestFirst(rows))) };
    const result = await applyTidy(db.sql, "u1", { token: preview.token });
    expect(result.batchId).toMatch(/^tidy_/);
    expect(result.mergedCount).toBe(1);
    expect(result.deduplicatedCount).toBe(1);
    const after = db.state().notes;
    expect(after).toHaveLength(5);
    expect(after.find((row) => row.id === rows[1]!.id)!.content).toBe(
      "住在杭州\n大学室友",
    );
    expect(after.some((row) => row.content === "甲".repeat(3000))).toBe(true);
    expect(after.some((row) => row.content === "乙".repeat(3000))).toBe(true);
    expect(db.state().backups).toHaveLength(3);

    const undone = await undoTidy(db.sql, "u1", result.batchId!);
    expect(undone).toEqual({ restored: 3, skipped: 0 });
    const restored = newestFirst(db.state().notes).map((row) => [
      row.id,
      row.content,
      new Date(row.updated_at).toISOString(),
    ]);
    expect(restored).toEqual(
      newestFirst(rows).map((row) => [
        row.id,
        row.content,
        new Date(row.updated_at).toISOString(),
      ]),
    );
    expect(db.state().backups).toHaveLength(0);
  });

  test.each([1, 2, 3, 4, 5, 6, 7])(
    "第 %i 次写库失败：整个回滚，笔记和备份都不留",
    async (failOnWrite) => {
      const rows = fixture();
      const db = memorySql(rows, { failOnWrite });
      await expect(applyTidy(db.sql, "u1")).rejects.toThrow("injected failure");
      expect(db.state().notes).toEqual(rows);
      expect(db.state().backups).toEqual([]);
    },
  );

  test("预览之后笔记变了：拒绝整理，什么都不改", async () => {
    const rows = fixture();
    const token = previewOf(planTidy(newestFirst(rows))).token;
    const db = memorySql([
      ...rows,
      note({
        kind: "person",
        subject: "小林",
        content: "新内容",
        agent_id: "bot-a",
        updated_at: at(-10),
      }),
    ]);
    const before = structuredClone(db.state());
    await expect(applyTidy(db.sql, "u1", { token })).rejects.toBeInstanceOf(
      TidyConflictError,
    );
    expect(db.state()).toEqual(before);
  });

  test("整理后又改过的那条，撤销时不覆盖", async () => {
    const rows = fixture();
    const db = memorySql(rows);
    const result = await applyTidy(db.sql, "u1");
    const kept = db.state().notes.find((row) => row.id === rows[1]!.id)!;
    kept.content = "用户后来改的";
    const undone = await undoTidy(db.sql, "u1", result.batchId!);
    expect(undone.skipped).toBe(1);
    expect(
      db.state().notes.find((row) => row.id === rows[1]!.id)!.content,
    ).toBe("用户后来改的");
    // 被删的那条还是放回来了。
    expect(db.state().notes.some((row) => row.id === rows[0]!.id)).toBe(true);
  });

  test("没东西可整理时不写库、不留备份", async () => {
    const db = memorySql([note({ content: "唯一一条" })]);
    const result = await applyTidy(db.sql, "u1");
    expect(result.batchId).toBeNull();
    expect(db.state().backups).toEqual([]);
  });
});

describe("memory_dream 审批", () => {
  test("整理记忆算「删除」类，其它记忆工具照旧不拦", () => {
    expect(categoryOfTool("memory_dream", "memory/memory_dream")).toBe(
      "delete",
    );
    expect(categoryOfTool("memory_dream")).toBe("delete");
    expect(categoryOfTool("memory_forget", "memory/memory_forget")).toBeNull();
    expect(categoryOfTool("memory_save", "memory/memory_save")).toBeNull();
    expect(titleForTool("memory_dream", "delete")).toContain("整理记忆");
  });
});
