# Pipeline run: dogfood friction a11y / stop chip / install banner (2026-10-19)

## Scope
生产成熟度狗粮摩擦（baseline **v0.1.34** → **v0.1.35**），来自 ayase.cn:8443 星灵浏览器 E2E：
1. 「已停止」挂错轮（修服务器锚点 + 客户端停止选人发消息 + 折叠仍画标记）
2. 「安装 ChisaBot 应用」横幅常驻聊天顶（可安装才显示；× 永久；取消 snooze 14 天）
3. 复制 / 重新生成 a11y 叠层标签 → 单一 live aria-label
4. Choose File → 「选择文件」

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed
- `server/src/local-conversations.ts`：`userMessageIdForStoppedRun`（Math.max，对齐 fallbackTurns）
- `app/.../channel-chat.tsx`：stopTask 跳过非人发 user 行
- `app/.../chat-transcript.tsx`：折叠/隐藏行仍画「已停止」；Copy `aria-hidden` 叠层
- `app/.../message-actions.tsx` / `ui/button.tsx`：叠层 `aria-hidden` + live aria-label
- `app/.../install-hint.tsx` + `lib/install-hint-storage.ts`：dismiss / snooze
- `composer.tsx`：`aria-label="选择文件"`

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC 外壳指纹未变
- 多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`；CB-017/018 → 0.2.0；托管 Prometheus 不做

## Verify
1. `bun test server/tests/stopped-turn-anchor.test.ts app/tests/dogfood-friction-a11y.test.tsx app/tests/install-hint-dismiss.test.ts app/tests/chat-unify.test.ts`
2. 硬刷新 → 芯片 0.1.35；中途停止 → 「已停止」挂在本轮；安装横幅可 × 永久关掉
3. 电车仍暂停

## PR / release / deploy

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/236 (squash → `33d6a792`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.35
- Deploy: `deploy-serial.sh 33d6a79 grok-bot` → `local/chisabot:auto-202610181909-33d6a79`
- `/api/version` = **0.1.35**; post-deploy-smoke **PASSED** (含模型 + 匿名 admin 401)
- `sync-nginx --check` ALL GREEN
- **未** resume 电车定时
