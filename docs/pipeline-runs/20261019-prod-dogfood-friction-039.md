# Pipeline run: dogfood friction after v0.1.39 smoke (2026-10-19)

## Scope
v0.1.39 线上冒烟狗粮摩擦（baseline **v0.1.39** → **v0.1.40**），弥斯爱 / 千咲：
1. Computer screenshot 503：面板仍像健康 + 接管，控制台 503（对齐 DOG-05）
2. 暂停电车仍显示「在等你确认 · N小时前」+ 立即运行
3. 「清理已删除机器人的任务（8）」不可靠 / 扫不干净
4. Optional：安装胶囊压住对话顶

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时「和 Claude 聊电车」。

## What changed
- `screenshot-poll.ts`：退避上限 30s；连续 5 次失败暂停轮询
- `computer-view.tsx`：大屏展开停 HTTP 截图轮询（LiveScreen 出图）
- `shared/schedules.ts`：`scheduleLastLineZh` / `scheduleLastTone`；paused+waiting 改写
- `settings/schedules.tsx`：隐藏主「立即运行」；隐藏机器人不计入孤儿；进页自动 purge
- `schedules/service.ts`：`purgeOrphanSchedules` + `DELETE /api/schedules/orphans`；扫周期硬删
- 安装胶囊 `--install-hint-gap` 48→56px
- readiness / requirements / dogfood-log / pipeline-run

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC / Android 外壳未变
- 多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`；CB-017/018 → 0.2.0

## Verify
1. `bun test app/tests/browser-presence.test.ts shared/schedules.test.ts`
2. 硬刷新 → 芯片 0.1.40；计算机大屏展开时 Network 无刷屏 `/screenshot` 503
3. 设置→定时：暂停电车不再写「打开对话处理」；孤儿按钮清零或一键清空
4. 电车仍暂停


## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/246 (squash → `037fbce3`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.40
- Deploy: `deploy-serial.sh 037fbce grok-bot` → `local/chisabot:auto-202610182051-037fbce`
- `/api/version` = **0.1.40**; post-deploy-smoke **PASSED** (含模型 + 匿名 admin 401)
- `sync-nginx --check` ALL GREEN; Magpie isolate verify ALL GREEN
- **未** resume 电车定时
