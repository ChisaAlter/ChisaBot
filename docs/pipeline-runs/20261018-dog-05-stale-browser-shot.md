# Pipeline run: DOG-05 stale browser shot / screenshot 503 (2026-10-18)

## Scope
CB-UX-DOG-05：计算机面板「机器人在用浏览器」+ 陈旧截图，活动为空；截图 API 曾 503。  
实现：`/workspace/ChisaBot/repo`（不用 Cursor cloud agents）。**未** resume 电车定时。

## Status log
- 2026-10-18 ~16:50 CST Asia/Shanghai — 分支 `fix/dog-05-stale-browser-shot`。

## Root cause
1. 截图轮询失败只 `setProblem`，**不清除** `shot`；`showScreen` 仍为真 → 占位从不出现，旧帧一直当直播。
2. 底栏只要 `holder === "bot"` 就写「机器人在用浏览器」，与活动 / 状态行无关；空闲时也像在干活。
3. `readScreenshot` 失败文案是英文 `"The screen is not available right now."`；503 时服务端英文 error 原样上屏。

## What changed
- `app/src/lib/computers/screenshot-poll.ts` — `applyScreenshotPollResult`（失败清帧）+ 失败退避
- `app/src/lib/computers/browser-presence.ts` — 检查中 / 交接 / 接管 / 忙碌 / 空闲 / 不可用 文案
- `app/src/lib/computers/screen.ts` — 中文错误；503→「电脑正忙或还没就绪…」
- `app/src/components/computer/computer-view.tsx` — 用上述逻辑；占位「重试」；状态行驱动「在用」
- `DESIGN.md` §96.5
- Tests: `browser-presence.test.ts`；`app-resilience-guards` 503

## Not in this PR
- 未 resume 电车定时
- 未改 agent-computer / 服务端 503 英文 `describe()`（面板已本地化）
- Live socket 大屏仍走原有 `streamProblem` 重试

## How to verify
1. 打开右栏「计算机」，机器人未浏览时底栏应是「浏览器空闲…」，不应写「在用浏览器」。
2. 模拟截图 503（或断掉 computer）：画面应换成「暂时看不到屏幕」+ 中文原因，**不应**继续显示上一张网页；可点「重试」或等自动恢复。
3. 机器人正在打开网页时，状态行 + 底栏可以说「在用浏览器」。

## PR / release
- （填合入后）
