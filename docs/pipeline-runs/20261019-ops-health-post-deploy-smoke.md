# Pipeline run: ops health + post-deploy smoke (2026-10-19)

## Scope
生产成熟度 P1 运维列车（`/workspace/ChisaBot-production-readiness.md` Track C / PRD-P1-01…03）：
1. 聚合健康面 `GET /api/admin/health`
2. 部署后自动硬烟雾 `post-deploy-smoke.sh`（挂进 updater `health.sh`）
3. 顺带：结构化错误码起步、部署失败 playbook stub、production-checklist

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed
### Health aggregation
- `server/src/ops-health.ts` + tests：app / DB `SELECT 1` / Magpie / computer / localCaller
- 挂载 `/api/admin/health`（管理员或 Local-Caller）；整体失败 HTTP 503 + `OPS_HEALTH_*` 日志行

### Post-deploy smoke
- `deploy/updater/post-deploy-smoke.sh`：/health、/api/version（期望 buildId）、/api/capabilities 无密钥、聚合健康；模型自检默认 advisory
- `health.sh` 在带 TAG 时调用；失败 → 回滚
- `request.sh smoke`；install 文件列表含新脚本

### Docs / codes
- `docs/production-checklist.md`
- monitoring / deploy / incidents「部署失败速查」
- `shared/ops-codes.ts`

## Not in this PR
- 完整 metrics 后端、备份演练实操、网关拓扑图、CI SSRF 红线（仍在 readiness 后续）
- 未 resume 电车定时；无表结构变更；PC 外壳指纹未变

## PR / release
- PR: https://github.com/ChisaAlter/ChisaBot/pull/218
- Release: v0.1.26

## Deploy
- v0.1.26: `deploy-serial.sh b463e7f` → `auto-202610181702-b463e7f`；烟雾脚本曾被嵌套 ok 骗过，computer 因假 botId 500 → 热修 0.1.27

