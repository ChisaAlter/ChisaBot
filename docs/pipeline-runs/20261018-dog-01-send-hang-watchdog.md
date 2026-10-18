# Pipeline run: DOG-01 send hang (v0.1.18 verify FAIL → 0.1.19) (2026-10-18)

## Scope
DOG-01 live verify on **v0.1.18 failed**: 星灵 send `DOGFOOD018-VERIFY…` → optimistic bubble ~35–40s, no Stop, no「连不上」/draft restore; soft reload bubble gone. Implement deeper fix in `/workspace/ChisaBot/repo` (no cloud agents). Ship **0.1.19+**.

## Status log
- 2026-10-18 ~15:20 CST — computerUse: v0.1.18 chip; silent hang; sync still 200 so unreachable path never fires.
- 2026-10-18 — gateway evidence: busy/activity POSTs without matching `/run` in window; connect ~825KB; thread has **3882 events / ~1265KB** in `openbot_local_events`.
- 2026-10-18 — root cause verified: connect still replays full (slimmed) event log; browser main-thread apply + CopilotKit `runAgent`→`detachActiveRun` race delays `/run`; v0.1.18 assumed drop classification (wrong when sync works).
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
1. Hard refresh https://ayase.cn:8443 → chip **0.1.19**.
2. 星灵 send a short unique line: within a few seconds expect either a reply **or** visible error + draft restored — never silent 40s then vanish on reload.
3. DevTools Network: `/connect` body should be on the order of messages size (tens of KB), not ~825KB; `/run` should appear shortly after send.
4. Optional: throttle CPU / block `/run` only → ~12s hang reason.

## PR / release
- (filled after ship)
