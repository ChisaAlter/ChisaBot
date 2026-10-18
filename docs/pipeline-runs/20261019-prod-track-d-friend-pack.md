# Pipeline run: prod Track D friend pack (2026-10-19)

## Scope
生产成熟度 Track D（baseline **v0.1.29** → **v0.1.30**）：
1. 好友一键 compose（`deploy/friend-up.sh` + `friend.env.example` + `docs/friend-deploy.md`）
2. 安全默认：Secure cookies、禁公网单用户直连、`start.sh` 拒 `0.0.0.0`
3. UX：设置「分享给朋友」；机器人列表一点开聊
4. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。跳过真机 CB-017/018 / 0.2.0 与 metrics 时序 / 真回滚窗口。

## What changed
- `shared/secure-cookies.ts` + AuthConfig.useSecureCookies
- `deploy/friend-up.sh`、`deploy/friend.env.example`、`docs/friend-deploy.md`
- `deploy/start.sh` 安全预检；设置 `/settings/share`；`bots.index` 一键 compose

## Not in this PR
- 未 resume 电车；无表结构变更；PC 外壳指纹未变
- 真机 CB-017/018 → 0.2.0；完整 metrics 时序；真回滚切流量

## Verify
1. `bun test shared/secure-cookies.test.ts`
2. `sh -n deploy/friend-up.sh && sh -n deploy/start.sh`
3. 硬刷新 → 芯片 0.1.30；设置 → 分享给朋友；机器人列表点开聊

## PR / release / deploy

（合入后填）
