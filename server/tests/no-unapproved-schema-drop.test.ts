import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 历史上已经合入主干、允许保留的破坏性 SQL 迁移文件及其精确次数。
 * 新迁移默认禁止 `DROP TABLE`、`DROP COLUMN` 与 `TRUNCATE TABLE`；
 * 如确需删表/删列，必须写独立迁移评审并在本冻结表显式登记（见 AGENTS.md §6）。
 */
const APPROVED_HISTORICAL_DROPS: Record<
  string,
  { dropTable: number; dropColumn: number; truncate: number }
> = {
  "0010_drop_the_document_index.sql": {
    dropTable: 3,
    dropColumn: 0,
    truncate: 0,
  },
  "0011_drop_the_old_connector_tables.sql": {
    dropTable: 4,
    dropColumn: 0,
    truncate: 0,
  },
  "0022_drop_attention_resolutions.sql": {
    dropTable: 1,
    dropColumn: 0,
    truncate: 0,
  },
  "0068_detachment_and_cleanup.sql": {
    dropTable: 14,
    dropColumn: 0,
    truncate: 0,
  },
};

export function stripSqlCommentsAndLiterals(sql: string): string {
  const withoutBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutLines = withoutBlocks.replace(/--[^\r\n]*/g, " ");
  return withoutLines.replace(/'(?:''|[^'])*'/g, "''");
}

export function countDestructiveSqlOps(sql: string): {
  dropTable: number;
  dropColumn: number;
  truncate: number;
} {
  const clean = stripSqlCommentsAndLiterals(sql);
  // 排除触发器定义中的 `BEFORE TRUNCATE ON ...`、`AFTER TRUNCATE ON ...`、`FOR EACH ... TRUNCATE` 等 DDL 事件名。
  const withoutTriggerClause = clean.replace(
    /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE|TRUNCATE))*\b/gi,
    " ",
  );
  const dropTable = [...clean.matchAll(/\bDROP\s+TABLE\b/gi)].length;
  const dropColumn = [...clean.matchAll(/\bDROP\s+COLUMN\b/gi)].length;
  const truncate = [...withoutTriggerClause.matchAll(/\bTRUNCATE\b/gi)].length;
  return { dropTable, dropColumn, truncate };
}

describe("no-unapproved-schema-drop SQL migration guard", () => {
  const drizzleDir = path.join(import.meta.dir, "../drizzle");

  test("server/drizzle/*.sql 不允许出现未登记的 DROP TABLE / DROP COLUMN / TRUNCATE", () => {
    const sqlFiles = readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(sqlFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of sqlFiles) {
      const ops = countDestructiveSqlOps(
        readFileSync(path.join(drizzleDir, file), "utf8"),
      );
      const allowed = APPROVED_HISTORICAL_DROPS[file] ?? {
        dropTable: 0,
        dropColumn: 0,
        truncate: 0,
      };
      if (
        ops.dropTable !== allowed.dropTable ||
        ops.dropColumn !== allowed.dropColumn ||
        ops.truncate !== allowed.truncate
      ) {
        violations.push(
          `${file}: 实际=${JSON.stringify(ops)}, 已登记=${JSON.stringify(allowed)}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("登记表不过期：所有历史特批文件名必须真实存在", () => {
    const missing = Object.keys(APPROVED_HISTORICAL_DROPS).filter(
      (file) => !readdirSync(drizzleDir).includes(file),
    );
    expect(missing).toEqual([]);
  });

  test("单测校准：能抓出新增删表/删列/清表语句，同时不误伤触发器与注释", () => {
    expect(
      countDestructiveSqlOps(`
        -- DROP TABLE "commented_out";
        /* TRUNCATE TABLE audit_events; */
        CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events EXECUTE FUNCTION deny();
        SELECT 'DROP TABLE foo';
      `),
    ).toEqual({ dropTable: 0, dropColumn: 0, truncate: 0 });

    expect(
      countDestructiveSqlOps(`
        DROP TABLE IF EXISTS "users";
        ALTER TABLE "bots" DROP COLUMN "legacy_flag";
        TRUNCATE TABLE "sessions";
      `),
    ).toEqual({ dropTable: 1, dropColumn: 1, truncate: 1 });
  });
});
