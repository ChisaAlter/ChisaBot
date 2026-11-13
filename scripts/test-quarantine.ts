/**
 * 全量 server/shared 测试的隔离名单（scripts/run-server-tests.ts 用）。
 *
 * 这里只放 2026-11 全量测量里确认的产品 / 测试本身缺陷（defect）——在任何操作系统、
 * 有没有数据库都一样挂的文件。环境缺失（没有 TEST_DATABASE_URL）、Windows-only、
 * 偶发（flaky）一律不进名单：它们能跑的时候必须跑。
 *
 * 每条 reason 记测量时的第一处报错；路径在仓库里不存在时 runner 直接失败，
 * 名单不会悄悄烂掉。
 */
export const SERVER_TEST_QUARANTINE: Record<string, string> = {};
