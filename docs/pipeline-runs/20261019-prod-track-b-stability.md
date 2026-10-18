# Pipeline run: prod Track B stability (2026-10-19)

## Scope
生产成熟度 Track B（baseline **v0.1.28** → **v0.1.29**）：
1. Hung turns：可靠停止 / 清锁 / 不永久 busy（墙钟 + 周期扫锁 + 客户端立刻清 busy + `/unlock`）
2. Long threads：connect 消息快照条数/体积封顶，压力测试
3. Schedule failure：stuck running 周期回收、连续失败自动暂停（从不自动 resume）、UI「需要关注」+ 孤儿 live 清理
4. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed
- `shared/connect-snapshot.ts` + tests；`local-conversations` connect 封顶 + 25min wall-clock + stale lock sweep + `POST .../unlock`
- `connection-drop` / `channel-chat`：停止立刻清 busy；SEND_HANG / SEND_REPLY_HANG beacon + unlock
- `schedules/service`：reclaimStuckRuns；failStreak auto-pause；settings UI attention + orphan live
- Ops codes: `SEND_HANG` / `SEND_REPLY_HANG`

## Not in this PR
- 未 resume 电车；无表结构变更；PC 外壳指纹未变
- Track D（好友部署包 / 真机 0.2.0）未做

## Verify
1. `bun test shared/connect-snapshot.test.ts shared/schedules.test.ts server/tests/connect-snapshot.test.ts`
2. 硬刷新 → 芯片 0.1.29；长对话发一句不假成功
3. 设置 → 定时：失败/等确认进「需要关注」；电车仍暂停
