# Pipeline run: live-screen input after reconnect (2026-10-19)

## Scope

修「接管之后点不动、滚不动、键盘没反应」。顺带消化 main 上已合入未发版的 #253/#254/#255/#256 → **v0.1.42**。

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed (#257)

- `screen-connection`：`onReady` 只表示 socket 可发；删 `verifyOwnership` / `inputReady`
- 输入门闩只看 `driving`；拒因中文盖到大屏
- 滚轮 `deltaMode` 折算；地址栏重连中文提示
- 测试：screen-connection / live-screen-mouse / live-screen-blank-page

## Also in 0.1.42

- #256 卡片 liveCast 慢探恢复
- #254/#255 Magpie 自更新与回退
- #253 npm 全局前缀 + ops 预算落盘（完整构建）

## Verify

1. `bun test app/tests/screen-connection.test.ts app/tests/live-screen-mouse.test.tsx app/tests/live-screen-blank-page.test.ts` → 17 pass
2. CI「Web, model settings and Magpie catalog」success
3. 硬刷新 → 芯片 0.1.42；接管后断线重连仍可点/滚/打
4. 电车仍暂停

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/257 (squash → `5cc58caf`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.42
- Deploy: `deploy-serial.sh e3c555e4 grok-bot` → `local/chisabot:auto-202610190958-e3c555e`; `/api/version` **0.1.42**; post-deploy-smoke **PASSED**; sync-nginx ALL GREEN
- **未** resume 电车定时
