# Pipeline run: screenshot capture coordination (2026-10-19)

## Scope
v0.1.40 只做了客户端诚实（展开停轮询 / 退避）。根因仍是 LiveScreen screencast 与 HTTP `/screenshot` 抢 CDP → opaque 503、面板假健康。

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## Root cause
1. `Page.startScreencast`（大屏）与 Playwright `page.screenshot`（卡片轮询 / `computer_screenshot`）共用 CDP。
2. 争用 → 超时或 502 → 网关 `ComputerUnavailableError` → API 503；LiveScreen 仍推旧帧，面板像健康直播。
3. 0.1.40 展开时停 HTTP 轮询，但工具路径 / 竞态 / 并发截图仍会打爆。

## What changed
- `agent-computer/src/capture-gate.ts` + `viewer.casting()` + session `capture`
- `/screenshot`：直播中 503+`captureBusy`+`liveCast`；并发串行；15s 超时 → 422+`pageTimeout`
- 网关 `CaptureBusyError` 透传；UI 中文 + liveCast 立刻停轮询
- Tests: capture-gate / viewer casting / browser-presence flags / computer-client mapping
- readiness / dogfood-log / production-checklist / DESIGN §96.5

## Not in this PR
- 未 resume 电车；无 cloud agents；无表结构变更；PC / Android 外壳未变
- 不把 screencast 帧回填给 HTTP 截图（另议）

## Verify
1. `bun test agent-computer/tests/capture-gate.test.ts agent-computer/tests/viewer.test.ts app/tests/browser-presence.test.ts server/tests/computer-client.test.ts`
2. 硬刷新 → 芯片 0.1.41；大屏展开 Network 无 `/screenshot` 刷屏
3. （可选）直播中用工具/卡片强制截图 → 503 body 含 `captureBusy`/`liveCast`，面板不假健康
4. 电车仍暂停

## PR / release / deploy

- PR: https://github.com/ChisaAlter/ChisaBot/pull/248 (squash → `ae79f5e9`)
- Release: https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.41
- Deploy: **pending** — box → `kvm18048` SSH timed out (tunnel/path down); run on Haupt when reachable:
  `sh /opt/chisabot-ops/deploy-serial.sh ae79f5e grok-bot`
- **未** resume 电车定时
