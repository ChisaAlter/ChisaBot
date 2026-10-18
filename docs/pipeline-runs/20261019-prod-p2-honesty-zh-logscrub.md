# Pipeline run: prod P2 honesty / ZH / log-scrub (2026-10-19)

## Scope
生产成熟度 P2 列车（baseline **v0.1.35** → **v0.1.36**）：
1. PRD-P2-01 诚实 UI 长尾：活动/busy 失败可见；CC 空草稿；已删机器人定时自动取消；活动页不永久 busy
2. PRD-P2-02 中文一致：作曲器/附件拒因剩余英文 → 中文
3. PRD-P0-05 余：`reasonWithoutStatement` 扩面 + CI log-scrub 红线
4. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。**未** 默认打开多用户 UI。**未** `CUTBACK_EXECUTE`。跳过 CB-017/018 / 0.2.0 真机。

## What changed
- `shared/activity-labels.ts` + tests；`server/src/activity` stale-run 诚实 + 中文短句；`bot-profile/activity` 失败显眼
- `schedules/service.cancelOrphanSchedules` 扫周期取消已删机器人 live 定时
- `cc-tree` 零回合 idle →「空草稿」
- composer / picked-files 用户可见英文字符串中文化 + 测试对齐
- console 路径 `reasonWithoutStatement`；`server/tests/log-scrub-redline.test.ts` + chisabot.yml

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC 外壳指纹未变
- 多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`；CB-017/018 → 0.2.0；托管 Prometheus 不做
- PRD-P2-03 长对话首屏（CB-025）未扩 scope（connect 封顶已在 0.1.29）

## Verify
1. `bun test shared/activity-labels.test.ts server/tests/log-scrub-redline.test.ts shared/schedules.test.ts app/tests/composer-drop-guard.test.tsx app/tests/composer-dropped-attachments.test.tsx app/tests/composer-upload-group.test.tsx app/tests/composer-attachments.test.ts`
2. 硬刷新 → 芯片 0.1.36；机器人活动失败项中文+红色；CC 空会话标「空草稿」
3. 电车仍暂停


## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/238 (squash → `ba97c842`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.36
- Deploy: `deploy-serial.sh ba97c84 grok-bot` → `local/chisabot:auto-202610181929-ba97c84`
- `/api/version` = **0.1.36**; post-deploy-smoke **PASSED** (含模型 + 匿名 admin 401)
- `sync-nginx --check` ALL GREEN
- **未** resume 电车定时
