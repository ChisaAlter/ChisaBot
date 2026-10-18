# Pipeline run: prod P2-03 long-thread first paint (2026-10-19)

## Scope
生产成熟度 P2-03 性能列车（baseline **v0.1.36** → **v0.1.37**）：
1. PRD-P2-03 / CB-025 长对话首屏：尾屏优先挂载 + rAF 分批补历史（超出 0.1.29 connect 封顶）
2. 0.1.36 测试漂移：作曲器断言 `Remove`→`移除` 等产品中文
3. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。**未** 默认打开多用户 UI。跳过 CB-017/018 / 0.2.0 真机。面板毛玻璃未扩 scope（CB-029 仍开放）。

## What changed
- `app/src/lib/chat/tail-first-paint.ts` + `use-tail-first-mount.ts`；`ChatTranscript` 尾窗切片
- 单元 / 挂载回归：`tail-first-paint.test.ts`、`tail-first-mount.test.tsx`
- 作曲器相关测试中文断言对齐（移除 / 附件 / 队列消息 / 驳回…）

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC 外壳指纹未变
- 多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`；CB-017/018 → 0.2.0
- 面板毛玻璃（CB-029）；chat-scroll 浏览器回归未在本机跑（建议部署后）
- `failed-send-attachments` 3 条 restore 路径仍红（0.1.36 ZH 后既有；本批未扩 scope 修 CopilotKit harness）

## Verify
1. `bun test app/tests/tail-first-paint.test.ts app/tests/tail-first-mount.test.tsx app/tests/composer-inflight-removal.test.tsx app/tests/composer-attachment-strip.test.tsx`
2. 硬刷新 → 芯片 0.1.37；打开 >100 条对话应更快见尾屏
3. 电车仍暂停
