# Pipeline run: ops residual metrics timeseries + traffic-cut (2026-10-19)

## Scope
生产成熟度运维残余（baseline **v0.1.31** → **v0.1.32**）：
1. Metrics timeseries：分钟环 + rates/series + 文件持久化 + scrape 端点
2. Traffic-cut rollback window：`cutback.sh` 默认 dry-run、KEEP_IMAGES=5、RTO 文档、Haupt dry-run
3. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。**未**对产流量执行真切流。

## What changed
- `shared/ops-counters.ts`：minute ring、`rates`、`series`、export/import
- `server/src/ops-metrics-store.ts`：`/workspace/.chisabot-ops/budgets.json`（可 `CHISABOT_OPS_METRICS_PATH`）
- `GET /api/admin/health/budgets?hours=1|6|24`
- `scripts/ops/cutback.sh`；`docs/ops/traffic-cut-rollback.md`；KEEP_IMAGES 默认 5
- monitoring / production-checklist / deploy 文档

## Not in this PR
- 未 resume 电车；无表结构变更；PC 外壳指纹未变
- 未对产流量 `CUTBACK_EXECUTE=1`
- 不做托管 Prometheus/Grafana；跳过 CB-017/018 / 多用户 UI

## Verify
1. `bun test shared/ops-counters.test.ts server/tests/ops-metrics-store.test.ts server/tests/ops-health.test.ts`
2. Haupt：`sh /opt/chisabot-ops/cutback.sh` → DRY-RUN、上一版镜像 present
3. 部署后：`curl …/api/admin/health | jq .budgets.rates`

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/229 (squash → `08d827ce`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.32
- Deploy: `deploy-serial.sh 08d827c grok-bot` → `local/chisabot:auto-202610181814-08d827c`
- `/api/version` = **0.1.32**; post-deploy-smoke **PASSED** (含模型)
- `budgets.rates` + `/api/admin/health/budgets` present；`ops-metrics` boot log `loaded:false`（首事件后写文件）
- Haupt `KEEP_IMAGES=5`；cutback dry-run 绿；**未** resume 电车定时
