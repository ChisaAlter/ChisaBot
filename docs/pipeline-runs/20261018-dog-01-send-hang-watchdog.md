# Pipeline run: DOG-01 send hang (v0.1.18 verify FAIL → 0.1.19) (2026-10-18)

## Scope

DOG-01 live verify on **v0.1.18 failed**: 星灵 send `DOGFOOD018-VERIFY…` → optimistic bubble ~35–40s, no Stop, no「连不上」/draft restore; soft reload bubble gone. Implement deeper fix in `/workspace/ChisaBot/repo` (no cloud agents). Ship **0.1.19+**.

## Status log

- 2026-10-18 ~15:20 CST — computerUse: v0.1.18 chip; silent hang; sync still 200 so unreachable path never fires.
- 2026-10-18 — gateway evidence: busy/activity POSTs without matching `/run` in window; connect ~825KB; thread has **3882 events / ~1265KB** in `chisabot_local_events（原早期事件表）`.
- 2026-10-18 — root cause verified: connect still replays full (slimmed) event log; browser main-thread apply + 旧聊天前端框架 `runAgent`→`detachActiveRun` race delays `/run`; v0.1.18 assumed drop classification (wrong when sync works).
- 2026-10-18 — fix: snapshot connect + client send watchdog + Stop while turn in flight + suppress sync connect during send.

## Root cause (verified)

1. **Message never persists**: `POST .../run` often never reaches nginx while client is busy with a huge `/connect` replay (825KB / 3882 events after slimReplay). Optimistic `addMessage` is local-only → soft reload drops it.
2. **10s unreachable UI missing**: `settleDroppedTurn` unreachable branch only runs after a classified connection-drop **and** sync staying null. Live verify had **sync 200**, so that path never ran; hang was not a tunnel drop.
3. **No Stop**: `stoppable` keyed on `runsInFlight`/`isRunning`; main-thread stall / pre-run wait left UI without a usable cancel for the turn.

## What changed

- `server/src/local-conversations.ts`: connect emits `MESSAGES_SNAPSHOT` + `STATE_SNAPSHOT` from durable thread row (+ live tail if running); `lastEventSequence` without loading full event log.
- `app/src/lib/copilot/connection-drop.ts`: `SEND_HANG_REASON`, `SEND_WATCHDOG_MS` (12s), `raceSendWatchdog`.
- `app/src/components/channels/channel-chat.tsx`: race `runAgent` vs watchdog; on timeout stop + check persist → hang reason + draft restore; `stoppable` includes `turnsInFlight`; `sendInFlightRef` suppresses sync reconnect during send.
- `app/src/lib/copilot/use-conversation-sync.ts`: `suppressConnect` option.
- Tests: connection-drop watchdog; connect-snapshot size; integration expect updated for snapshot connect.

## Not in this PR

- DOG-02/03 (#211) still held for separate merge after chat P0.
- Tram schedule not resumed.
- FIX-10/11 backlog items.

## How to verify

1. Hard refresh https://example.com:8443 → chip **0.1.19**.
2. 星灵 send a short unique line: within a few seconds expect either a reply **or** visible error + draft restored — never silent 40s then vanish on reload.
3. DevTools Network: `/connect` body should be on the order of messages size (tens of KB), not ~825KB; `/run` should appear shortly after send.
4. Optional: throttle CPU / block `/run` only → ~12s hang reason.

## PR / release

- PR: https://github.com/ChisaAlter/ChisaBot/pull/212
- Merge: squash on main as `f2de07e1`
- Release: v0.1.19 (pending deploy)

## Ship result (2026-10-18 Asia/Shanghai)

- PR #212 squash-merged as `f2de07e1`
- Release **v0.1.19** tag `00046661` — https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.19
- <PROD_HOST> deploy `ACTOR=grok-bot request.sh check|update` → image `local/chisabot:auto-202610180730-0004666`
- `/api/version` = 0.1.19; 容器 healthy；模型自检通过
- DB evidence for dogfood thread: messages ~117KB / 284 rows vs events ~1.3MB / 3882（connect 现走消息快照）
- 前端包含「迟迟没发出去」文案
- **Live UI**：本 agent 无用户会话 Cookie，未在浏览器实发；请硬刷新后芯片确认 0.1.19，再在星灵发一句验证
