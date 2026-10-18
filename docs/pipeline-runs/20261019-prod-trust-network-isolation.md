# Pipeline run: trust-boundary network isolation (2026-10-19)

## Scope
生产成熟度安全残余（baseline **v0.1.32** → **v0.1.33**）：
1. Trust-boundary **network isolation**：Local-Caller 绑定、admin health 刮数鉴权、friend-up / TRUSTED_ORIGINS、compose 端口 deny-by-default、CI 红线、`docs/ops/trust-boundary.md`
2. readiness / requirements / dogfood / pipeline-run 更新
3. **未** resume 电车；**未**默认打开多用户 UI；**未**对产流量 `CUTBACK_EXECUTE`

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。

## What changed
- `deploy/public/nginx.conf`：所有反代到 `:3001` 清空 `X-ChisaBot-Local-Caller`
- `deploy/start.sh` / `friend-up.sh`：拒 `0.0.0.0` 与裸端口发布；TRUSTED_ORIGINS 仅 loopback http；检查 magpie.compose
- `deploy/updater/post-deploy-smoke.sh`：网关模式匿名 admin health → 401
- `shared/trust-boundary.ts` + 单元测；`server/tests/trust-boundary-redline.test.ts`；CI step
- `scripts/ops/check-trust-boundary.sh`
- `docs/ops/trust-boundary.md` 网络隔离专节；production-checklist §9

## Not in this PR
- 未 resume 电车；无表结构变更；PC / Android 外壳指纹未变
- 未翻转 `CHISABOT_ACCOUNTS_UI` 默认；未 live cutback
- 跳过 CB-017/018 / 完整浏览器 E2E
- 非电车定时复验仍人工（本批不改调度逻辑；Track B 已从不 auto-resume）

## Verify
1. `bun test shared/trust-boundary.test.ts server/tests/trust-boundary-redline.test.ts server/tests/gateway-identity.test.ts`
2. `sh scripts/ops/check-trust-boundary.sh`
3. 部署后：匿名 `/api/admin/health` → 401；Local-Caller → ok；版本 0.1.33

## PR / release / deploy

- PR: (fill after open)
- Release: v0.1.33
- Deploy: (fill after Haupt)
- **未** resume 电车定时
