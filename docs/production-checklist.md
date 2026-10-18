# 生产上线清单（PRD-P1-01…06）

面向值班的一页纸：合并后怎样确认「版本对、自检过、无密钥泄露」，以及监控该探什么。

相关：[ops/monitoring.md](ops/monitoring.md)、[ops/deploy.md](ops/deploy.md)、[admin-smoke.md](admin-smoke.md)、[online-update.md](online-update.md)。

## 1. 监控 / 探活该打什么

| 探谁 | 认证 | 期望 | 用途 |
|------|------|------|------|
| `GET /health` | 无 | `200` `{"status":"ok"}` | 进程活着（Uptime Kuma / 云探测） |
| `GET /login`（公网） | 无 | `200` | HTTPS 网关 + 登录页 |
| `GET /api/version` | 无（公网经网关会话） | `version` / `buildId` / `commit`；**无密钥** | 确认已上到期望构建 |
| `GET /api/admin/health` | 管理员会话 **或** `X-ChisaBot-Local-Caller: $CHISABOT_GATEWAY_SECRET` | `200` 且 `"ok":true`；失败 `503` | **聚合健康面**：app + DB + Magpie（若配）+ 电脑节点（若配）+ Local-Caller 标记 |
| `POST /api/admin/smoke` | 同上 | `"ok":true` 且 `"persisted":false` | 模型往返（不写对话） |

聚合响应形状（字段可增，勿依赖未文档化的密钥）：

```json
{
  "ok": true,
  "checkedAt": "2026-10-19T04:00:00.000Z",
  "version": { "version": "0.1.26", "buildId": "…", "commit": "…" },
  "checks": {
    "app": { "ok": true, "status": "ok" },
    "database": { "ok": true, "latencyMs": 3 },
    "magpie": { "ok": true, "configured": true, "reachable": true, "providersReady": 2, "providersTotal": 3 },
    "computer": { "ok": true, "configured": true, "reachable": false, "total": 3 },
    "localCaller": { "ok": true, "authenticated": true, "gatewayMode": "on" }
  }
}
```

- `ok: null` = 未配置，**不算失败**。
- `ok: false` = 已配置但探失败 → 整体 `ok: false`、HTTP 503。
- computer：`ok` 表示 provider `list()` 通；某机器人是否 ready 看 `reachable`（假 botId 会让 agent-computer 500，已避免）。
- 日志里失败会打一行 `{"type":"ops","code":"OPS_HEALTH_DEGRADED",…}`（见 `shared/ops-codes.ts`）。

本机示例（网关模式）：

```sh
SECRET=$(grep -E '^[[:space:]]*CHISABOT_GATEWAY_SECRET=' /opt/openbot-zh/.env | head -1 | cut -d= -f2- | tr -d '"'\''')
curl -s -H "X-ChisaBot-Local-Caller: $SECRET" http://127.0.0.1:3001/api/admin/health | jq .
```

或：`sh /opt/chisabot-updater/request.sh smoke` / `bash /opt/chisabot-updater/post-deploy-smoke.sh`。

## 2. 部署后自动烟雾（硬失败 → 回滚）

`deploy/updater/health.sh` 在切换镜像且带了构建号时调用 `post-deploy-smoke.sh`：

1. `GET /health` → 200  
2. `GET /api/version` → 含期望 `buildId`；正文不含密钥样形态  
3. `GET /api/capabilities` → 有 `mode`；不含密钥样形态  
4. `GET /api/admin/health`（带 Local-Caller）→ `"ok":true`  
5. `POST /api/admin/smoke` → 默认**只告警**（上游额度抖动不误回滚）；设 `STRICT_MODEL_SMOKE=1` 则一并硬失败  

硬检查任一条红 → `health.sh` 非 0 → 更新器自动回滚上一镜像。

脚本安装：随更新器自升级（`install.sh` / `install-updater.sh` 的文件列表含 `post-deploy-smoke.sh`）。老主机若还没有该文件，健康检查会回退到旧的「模型自检仅记录」并打 warn。

## 3. 人肉巡检（合并后 15 分钟内）

```sh
sh /opt/chisabot-updater/request.sh status
curl -s 127.0.0.1:3001/api/version
bash /opt/chisabot-updater/post-deploy-smoke.sh   # 或 request.sh smoke
docker logs --since 30m openbot-zh 2>&1 | grep -E 'OPS_|PostgresError|bind message supplies' | tail
```

通过判据：版本对、烟雾绿、无 `OPS_HEALTH_DEGRADED` / SQL bind 错位。

## 4. 结构化错误码（PRD-P1-02 起步）

| code | 含义 |
|------|------|
| `OPS_HEALTH_DEGRADED` | 聚合健康整体失败 |
| `OPS_HEALTH_DB` / `_MAGPIE` / `_COMPUTER` | 对应子检查失败 |
| `OPS_SMOKE_HARD_FAIL` / `OPS_SMOKE_MODEL_FAIL` | 烟雾硬失败 / 模型自检失败 |
| `SEND_UNREACHABLE` | 发消息未达服务器 |
| `STREAM_DISCONNECT` | 直播屏非正常断开 |
| `SSRF_DENIED` | 出站被 SSRF/出口地板拒绝 |

实现：`shared/ops-codes.ts` 的 `opsLogLine` + `shared/ops-counters.ts` 进程内计数。

`GET /api/admin/health` 现含 `budgets`（进程启动以来的 totals + 近 15 分钟 `last15m`）：

```json
"budgets": {
  "at": "2026-10-19T05:00:00.000Z",
  "windowMs": 900000,
  "totals": { "SEND_UNREACHABLE": 0, "STREAM_DISCONNECT": 0, "SSRF_DENIED": 0 },
  "last15m": { "SEND_UNREACHABLE": 0, "STREAM_DISCONNECT": 0, "SSRF_DENIED": 0 }
}
```

| 谁 bump | 怎么看见 |
|---------|----------|
| `SSRF_DENIED` | `guardedFetch` / `resolvePublic` 拒绝时；日志一行 + health |
| `STREAM_DISCONNECT` | 电脑流代理异常关闭 / 上游 open 失败 / `onerror` |
| `SEND_UNREACHABLE` | 浏览器判定「没发出去」时 `POST /api/ops/budget`（需登录 Cookie） |

部署后：`curl …/api/admin/health | jq .budgets`。进程重启（每次发版）计数归零——正常。

CI 红线：`server/tests/ssrf-redline.test.ts`（PRD-P1-06）。备份演练：[ops/backup-rollback-drill.md](ops/backup-rollback-drill.md)。信任边界：[ops/trust-boundary.md](ops/trust-boundary.md)。

## 5. 部署失败怎么处理

见 [ops/incidents.md](ops/incidents.md) §「部署失败速查」：看 `request.sh status` → 容器日志 → 自动回滚是否成功 → 必要时手动 `rollback-to-*.sh`。


## 6. 好友可装包 / 安全默认（Track D）

| 检查 | 期望 |
|------|------|
| 应用端口 | compose 仅 `127.0.0.1:3001`（`start.sh` / `friend-up.sh` 拒 `0.0.0.0`） |
| 单用户 | `TRUSTED_ORIGINS` 无 https 公网；公网走 `deploy/public` |
| Cookie | 网关 Cookie 已 Secure；Better Auth 在 https 公网 URL 或 `CHISABOT_SECURE_COOKIES=1` 时 Secure |
| 一键入口 | `sh deploy/friend-up.sh`；说明见 [friend-deploy.md](friend-deploy.md) |
| 设置页 | 管理员可见「分享给朋友」 |
