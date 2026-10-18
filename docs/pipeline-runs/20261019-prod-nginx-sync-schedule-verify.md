# Pipeline run: nginx sync + non-tram schedule verify (2026-10-19)

## Scope
生产成熟度残余（baseline **v0.1.33** → **v0.1.34**）：
1. Production nginx ↔ repo template **durable sync**（apply-or-fail；CI + deploy-serial）
2. Non-tram schedule re-verify：create→run→fail→pause→needs-attention；orphan；**never auto-resume**；电车政策暂停
3. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。

## What changed
- `scripts/ops/sync-nginx.sh`；`check-trust-boundary.sh` §5；`deploy-serial` 部署后 check（可 apply）
- `shared/schedules`：`partitionScheduleList`；reclaimStuckRuns 计入 fail-streak pause
- 设置页共用分区；单元/集成测；docs/ops gateway §2.1、schedules、production-checklist §10
- CI：sync-nginx --check-repo + schedules tests

## Not in this PR
- 未 resume 电车；未默认 `CHISABOT_ACCOUNTS_UI`；未 `CUTBACK_EXECUTE`
- 跳过 CB-017/018 / 完整浏览器 E2E；无表结构变更；PC 外壳指纹未变

## Verify
1. `sh scripts/ops/sync-nginx.sh --check-repo`
2. `bun test shared/schedules.test.ts shared/trust-boundary.test.ts`
3. 有库时：`TEST_DATABASE_URL=… bun test server/tests/schedules.test.ts`
4. 部署后：版本 0.1.34；`sync-nginx --check` 绿；电车仍 paused

## PR / release / deploy

（合并后回填）
