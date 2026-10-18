# Pipeline run: DOG-01 send silent drop (2026-10-18)

## Scope
DOG-01 from dogfood R1 / FIX backlog — 发消息假成功（乐观气泡、无停止/无回复、刷新消失）。
Prod: https://ayase.cn:8443 v0.1.17. 实现：`/workspace/ChisaBot/repo`（不用 Cursor cloud agents）。

## Status log
- 2026-10-18 ~15:00 CST — dogfood R1 复现：星灵发送乐观成功，sync/wss `ERR_TUNNEL_CONNECTION_FAILED`，刷新气泡消失。
- 2026-10-18 ~15:05 CST — 诊断：`settleDroppedTurn` 在 sync 全失败时按重启干等最长 75s；期间无 Stop、无错误 toast；消息未 persist。
- 2026-10-18 — 开发：短「unreachable」时限 + `SEND_UNREACHABLE_REASON` + 识别 `ERR_TUNNEL_*`。
- 2026-10-18 — 单测绿；开 PR → 合入 → 发版 → 部署。

## Root cause
浏览器到服务器的隧道/代理整段失败时，`copilotkit.runAgent` 以 connection-drop 结束；客户端按 DESIGN.md §89 进入 `settleDroppedTurn`，默认等最多 **75s** 看服务是否重启回来。狗粮场景下 `/api/bot-threads/.../sync` 与 `wss://…/api/channels/events` 同样 `ERR_TUNNEL_CONNECTION_FAILED`，变化戳一直是 `null`，于是：
1. 乐观用户气泡留在本地 `agent.messages`；
2. `runsInFlight` 已归零 → 无「停止」；
3. 无错误文案；
4. 服务器从未收到 `/run` → 刷新后气泡消失。

不是 Magpie/模型挂死：VPS 上 `openbot-zh` healthy、`admin-smoke` 模型自检通过；无遗留 thread lock 需清（嵌入式 PG 凭据未在本机脚本侧展开，但从 API 健康与启动日志判断服务正常）。

## What changed
- `app/src/lib/copilot/connection-drop.ts`
  - `isConnectionDrop` 识别 `ERR_TUNNEL_*` / proxy / SSL / DNS 超时等
  - `settleDroppedTurn`：从未问到服务器时用 `unreachableMs`（默认 10s）返回 `"unreachable"`；问到过之后仍用 75s 重启预算
  - 新增 `SEND_UNREACHABLE_REASON`（明确「可能没发出去」）
- `app/src/components/channels/channel-chat.tsx`：unreachable → 该文案 + 既有 fail/恢复草稿路径
- `app/src/lib/chat/friendly-error.ts`：友好标题「连不上服务器」
- `app/tests/connection-drop.test.ts`：覆盖隧道错误与短/长预算

## Not in this PR
- FIX-10 活动记录剩余英文工具名 / block 文案（仍 backlog）
- FIX-11 安装横幅视觉盖住标题（已有永久关闭；本次不改 CSS）
- 未 resume 电车定时

## How to verify
1. 断网或拦 `/api/copilotkit`+`/api/bot-threads` 后发一条：约 10s 内出现「连不上…没发出去」，输入框恢复原文，无静默假成功。
2. 正常网络发一条：仍有回复；刷新后消息仍在。
3. （回归）模拟短暂 null 后 idle+已回答 → 仍为 finished，不误报。

## Ops
Prod 当前 v0.1.17 可聊；本修是客户端硬化。部署新版后在 星灵 实发一条验证。
