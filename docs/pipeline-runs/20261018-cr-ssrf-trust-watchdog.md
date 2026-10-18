# Pipeline run: code-review SSRF + trust boundary + send watchdog (2026-10-18)

## Scope
CB-CR-01…04（审查 CR-P0-01 / CR-P1-01 / CR-P1-02 / CR-P1-03）。  
实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。P2 与 CR-P1-04 本批不做。

## Status log
- 2026-10-18 ~21:38 CST Asia/Shanghai — 分支 `fix/cr-ssrf-trust-watchdog`。

## What changed

### CR-P0-01 / CR-P1-01 — 统一 SSRF
- `server/src/chat-files/service.ts` `defaultDownload` → `guardedFetch`（钉死 DNS、逐跳重验；去掉 `assertPublicUrl` + `redirect: follow`）。
- `server/src/web/tools.ts`：删除本地弱 `privateIp` / `assertPublicUrl`；`assertPublicUrl` 改为 `checkPublicUrl` + `resolvePublic`；`fetchPublic` / `web_fetch` 走 `guardedFetch`。
- vault / media-models 仍调用强版 `assertPublicUrl`（前置拒绝映射地址）；其后续自带 fetch 的钉死仍属后续加固。

### CR-P1-02 — 本机管理员信任边界
- `resolveGatewayRequest`：**不再**把「没有 X-Forwarded-For / X-Real-IP」当成管理员。
- 无身份头时必须带 `X-ChisaBot-Local-Caller: <CHISABOT_GATEWAY_SECRET>`（常量时间比较），或紧急 `CHISABOT_TRUST_UNSIGNED_LOCAL=1`。
- `/api/devices/agent/state/:id` 在配了网关密钥时同样要求该头（顺带收紧 CR-P2-01）。
- 登录网关 `deviceActive`、`deploy/updater/smoke.sh` / `health.sh` 从 compose `.env` 自动带头。
- **未**从 compose 摘掉 `magpie` 外网：Magpie 仍需同网；边界改由应用层证明，不靠「没代理头」。

### CR-P1-03 — 发送看门狗第二段封顶
- 已落库后不再 `await runPromise` 无界；再赛跑 `SEND_REPLY_WATCHDOG_MS`（180s），超时 stop + `SEND_REPLY_HANG_REASON`，`finally` 释放计数。

## Tests
- `server/tests/web-tools.test.ts` — 映射 / NAT64 / 6to4 / Teredo / 文档段
- `server/tests/guarded-fetch-ssrf.test.ts` — 302 → 元数据 / RFC1918
- `server/tests/gateway-identity.test.ts` — 无证明拒绝 / local-caller / 错误密钥 / 紧急逃生
- `app/tests/connection-drop.test.ts` — reply hang 文案与第二段超时

## Residual risks
- vault `api_request` 仍用强 assert 后自带 `fetch`（未 DNS 钉死）；需 POST/自定义头，guardedFetch 目前只做 GET。
- `CHISABOT_TRUST_UNSIGNED_LOCAL=1` 会恢复旧的不安全本机回落；仅排障。
- 共享 Docker 网络上 Magpie 等容器仍能 TCP 连到 :3001；无密钥则只能打到需身份的路由并 401/404，不能再当管理员。
- CR-P1-04（egress 地板）与其余 P2 未做。

## Not in this PR
- 未 resume 电车定时
- CB-CR-05…17（P1-04 + P2）

## PR / release
-（填）
