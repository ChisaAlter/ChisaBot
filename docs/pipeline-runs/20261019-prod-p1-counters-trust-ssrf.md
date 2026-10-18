# Pipeline run: prod P1 counters / trust / SSRF / backup drill (2026-10-19)

## Scope
生产成熟度残余 PRD-P1-02…06（baseline v0.1.27）：
1. SEND/STREAM/SSRF **counters** → `/api/admin/health`.budgets + logs
2. Backup/rollback **dry-run** recorded on Haupt
3. Gateway/node **trust diagram**
4. CI **SSRF red-line** tests
5. readiness / requirements / dogfood 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed
- `shared/ops-counters.ts` + health `budgets`；`POST /api/ops/budget`；guardedFetch / stream proxy / client beacon 接线
- `server/tests/ssrf-redline.test.ts` + chisabot.yml CI step
- `docs/ops/trust-boundary.md`、`docs/ops/backup-rollback-drill.md`
- production-checklist §4 补全

## Not in this PR
- 完整 metrics 时序库；真回滚切流量（dry-run only）
- 未 resume 电车；无表结构变更；PC 外壳指纹未变

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/221 (squash → `f9eff34a`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.28
- Deploy: `deploy-serial.sh f9eff34` → `local/chisabot:auto-202610181715-f9eff34`
- `/api/version` = **0.1.28**; post-deploy-smoke **PASSED** (含模型)
- `budgets` present on `/api/admin/health`
- **未** resume 电车定时
