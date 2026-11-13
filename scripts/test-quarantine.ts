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
export const SERVER_TEST_QUARANTINE: Record<string, string> = {
  "server/tests/approvals-frontend.test.ts":
    "Cannot find module '../../app/src/lib/chat/approval-context' — 模块在 a98a4889 删除，测试没跟上 (2026-11 measurement)",
  "server/tests/approvals-policy.test.ts":
    "Cannot find module '../src/host-access/broker' — 模块在 a98a4889 删除，测试没跟上 (2026-11 measurement)",
  "server/tests/headless-components.test.ts":
    "Cannot find module '../../app/src/components/gallery/activity' — 目标组件已删除 (2026-11 measurement)",
  "server/tests/headless-components.integration.test.ts":
    "Cannot find module '../../app/src/components/gallery/charts' — 目标组件已删除 (2026-11 measurement)",
  "server/tests/memory-tidy.test.ts":
    "TypeError: p5.toISOString is not a function (:212) — 内存 SQL fixture 与 src/memory-notes/tidy.ts:411 不一致 (2026-11 measurement)",
  "server/tests/headless-tools.test.ts":
    "Expected promise that resolves / Received rejected (:196) — This conversation runner requires a lease adapter. (src/turns/run-turn.ts:497) (2026-11 measurement)",
  "server/tests/passwords-sign-in.test.ts":
    "expect(paused).toBeInstanceOf(HeadlessToolSuspension) — 同一个 lease adapter 错误 (:619) (2026-11 measurement)",
  "server/tests/tool-selection-environment-restoration.test.ts":
    "expect(proof.exitCode).toBe(1) received 0 (:180)；remoteStopStatus expected \"rejected\" got \"fulfilled\" (:223) (2026-11 measurement)",
};
