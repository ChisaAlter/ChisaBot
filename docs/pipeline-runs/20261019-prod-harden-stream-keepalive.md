# Pipeline run: production harden — stream keepalive + review residuals (2026-10-19)

## Scope

生产加固一批（用户反馈「不要只做皮毛」）：
1. CR-P2-12 / CB-CR-17：电脑直播 `idleTimeout` 120s → 协议 ping + 应用层 keepalive（穿代理）
2. 审查 Limitations 残留：cloud-cc / composio（无出站 fetch）/ skills-chisa（无 SSRF 面）skim；oauth / media-models SSRF 边；日志脱敏补全
3. 诚实 UI 相邻：屏幕断线中文；ping 重置重试预算
4. 测试缺口：keepalive 单元、`/api/version` 烟雾、oauth 私网拒绝、screen-connection ping 预算
5. 路线图：`/workspace/ChisaBot-production-readiness.md`

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## What changed

### Stream keepalive

- `agent-computer/src/stream-keepalive.ts` + 测试
- serve websocket：`sendPings: true`、`idleTimeout: 120`；每 30s `send({type:ping})`；message 早路径应答 pong
- `server/src/index.ts` 代理 websocket 同样 `sendPings` + idleTimeout
- `live-screen.tsx` 收到 ping 回 pong；`screen-connection.ts` ping 重置 backoff；断线文案中文

### SSRF / logging

- oauth：`checkPublicUrl` + `resolvePublic` 后再 fetch；错误 `reasonWithoutStatement`
- media-models：默认 `redirect:"error"`
- cloud-cc service/sync、passwords：日志脱敏

### Tests / smoke

- stream-keepalive、screen-connection ping 预算、health `/api/version`、plugin-oauth 元数据 URL 拒绝

## Deferred（见 production-readiness.md）

- 完整 metrics / 部署后自动烟雾编排（P1）
- magpie 网络隔离强化（P0 后续）
- forgetIdle 在 occupied 时不缩 map（观察）

## Not in this PR

- 未 resume 电车定时
- 无表结构变更；PC 外壳指纹未变

## PR / release

- PR: https://github.com/ChisaAlter/ChisaBot/pull/217
- Merge: squash on main as `6d2fd497`
- Release: v0.1.25 — https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.25

## Deploy

- done

## Ship result (2026-10-19 Asia/Shanghai)

- PR #217 squash-merged as `6d2fd497`
- Release **v0.1.25** — https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.25
- Deploy: `deploy-serial.sh 6d2fd49 grok-bot` → image `local/chisabot:auto-202610181652-6d2fd49`
- `/api/version` = **0.1.25**；容器 healthy（commit `6d2fd497`）
- **未** resume 电车定时
- 路线图：`/workspace/ChisaBot-production-readiness.md`
