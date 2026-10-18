# Pipeline run: failed-send restore + CB-029 glass (2026-10-19)

## Scope
生产成熟度残余列车（baseline **v0.1.37** → **v0.1.38**）：
1. `failed-send-attachments` 3 条 restore 路径转绿（诚实、无假成功）
2. CB-029 弹窗/面板毛玻璃：§37.3 静止态去大面积 blur（Skyglass 令牌，不引入外来 chrome）
3. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。**未** 默认打开多用户 UI。跳过 CB-017/018 / 0.2.0 真机。

## What changed
- `app/tests/failed-send-attachments.test.tsx`：`/api/bot-threads` → 404（频道无 sync，与生产一致）；失败 run 用 HTTP 500（非连接断开类 502/503/504）
- `app/src/styles.css` §37.3：dialog/sheet/menu/popover/select/combobox 内容层 `backdrop-filter: none`；遮罩仍轻 blur + glass-hold
- `app/tests/glass-hold-panels.test.ts`；DESIGN §37.3；BACKLOG CB-029 ✅；ROADMAP 对齐

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC 外壳指纹未变（未 bump pc/android）
- 多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`；CB-017/018 → 0.2.0
- 4× CPU 实机 INP 数字可狗粮补测

## Verify
1. `bun test app/tests/failed-send-attachments.test.tsx app/tests/glass-hold-panels.test.ts`
2. 硬刷新 → 芯片 0.1.38；打开「新建机器人」弹窗应更跟手
3. 电车仍暂停

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/242 (squash → `4f137e6b`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.38
- Deploy: `deploy-serial.sh 4f137e6 grok-bot` → `local/chisabot:auto-202610182000-4f137e6`
- `/api/version` = **0.1.38**; post-deploy-smoke **PASSED** (含模型 + 匿名 admin 401)
- `sync-nginx --check` ALL GREEN
- **未** resume 电车定时
