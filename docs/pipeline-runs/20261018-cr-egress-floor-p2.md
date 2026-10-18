# Pipeline run: code-review egress floor + P2 (2026-10-18)

## Scope
CB-CR-05（CR-P1-04）+ CB-CR-06…17（P2）。实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。

## Status log
- 2026-10-18 ~23:35 CST Asia/Shanghai — 分支 `fix/cr-egress-floor-p2`。

## What changed

### CR-P1-04 / CB-CR-05 — Bot egress 地板对齐导航私网拒绝
- `ALWAYS_DENIED` 增加 RFC1918、`127.0.0.0/8`、`::1`、`fc00::/7`（与 `checkNavigationTarget` / `isPrivateIpv*` 同地板），allow_all 与 allowlist cidr 都不能覆盖。
- 名字一律本机解析，使 ALWAYS_DENIED 与 domain 规则能看见地址（含上游代理 / allow_all）。
- `needsResolution`：非 allow_all/deny_all 即解析（不再要求有 cidr 规则）。
- 测试：单元 + filter；成功路径改走「公网解析 + mock upstream」，私网目标一律期望 403。

### P2
| ID | 处理 |
|----|------|
| CB-CR-06 / P2-01 | **已由 #215 Local-Caller 收紧**；本批核验 `/agent/state` 仍要求密钥头 |
| CB-CR-07 / P2-02 | page frame 空结果有界重试（0/400/1200ms）再 stamp `asked` |
| CB-CR-08 / P2-03 | 消息搜索 `isError` →「搜索暂时不可用」，不再伪装空结果 |
| CB-CR-09 / P2-04 | 深链：4s 快轮询后只要可见就慢轮询；换 message / 可见性重跑 |
| CB-CR-10 / P2-05 | 安装横幅：仅装成或点「不再提示」永久关掉；取消/超时只收起本轮 |
| CB-CR-11 / P2-06 | `markChannelRead` onError 回滚；activity/busy 失败 `console.warn` |
| CB-CR-12 / P2-07 | 若干 `console.error` 改走 `reasonWithoutStatement` |
| CB-CR-13 / P2-08 | MCP `withClient` 连接前 `resolvePublic` |
| CB-CR-14 / P2-09 | 电脑流代理：upstream 构造 try/catch、两端 error、高 bufferedAmount 丢帧 |
| CB-CR-15 / P2-10 | preview browser：`newContext` 失败清缓存并 close |
| CB-CR-16 / P2-11 | `advanced.useSecureCookies` 随 `BETTER_AUTH_URL` https 显式打开 |
| CB-CR-17 / P2-12 | drain timer `unref`；supervisor sessions 软封顶；**idleTimeout/ping 产品歧义暂缓** |

### 顺带
- vault `api_request` 默认走 `guardedFetch`（支持 method/body；`maxRedirects: 0`）；测试注入 fetch 仍走强 assert。

## Deferred
- agent-computer `idleTimeout: 120` 无 ping/pong（静态页空闲观看可能被踢）— 需产品决定是否加心跳。
- `forgetIdle` 在 occupied/live 时不缩 map — 观察即可；已有 cap。

## Tests
- `agent-computer/tests/egress-policy.test.ts` — 22 pass
- `server/tests/guarded-fetch-ssrf.test.ts` / `gateway-identity.test.ts` / `app/tests/connection-drop.test.ts` — pass
- `app/tests/focus-message.test.ts` — pass

## Not in this PR
- 未 resume 电车定时

## PR / release
- （合并后填）

## Deploy
- （合并后填）
