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
  "last15m": { "SEND_UNREACHABLE": 0, "STREAM_DISCONNECT": 0, "SSRF_DENIED": 0 },
  "rates": {
    "last1h": { "SSRF_DENIED": 0 },
    "last6h": { "SSRF_DENIED": 0 },
    "last24h": { "SSRF_DENIED": 0 },
    "perHour1h": { "SSRF_DENIED": 0 },
    "perHour6h": { "SSRF_DENIED": 0 }
  },
  "series": { "bucketMs": 60000, "retentionMs": 86400000, "points": [] }
}
```

更长历史：`GET /api/admin/health/budgets?hours=6`。磁盘：`/workspace/.chisabot-ops/budgets.json`（见 [ops/monitoring.md](ops/monitoring.md) §5）。

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

## 7. 发送诚实 / MCP 停止（v0.1.31）

| 检查 | 期望 |
|------|------|
| 发消息超时未落库 | UI 报「迟迟没发出去」+ 草稿恢复；`SEND_HANG` 进 budgets |
| 已落库回答挂死 | 「已经发出去了，但回答迟迟没回来」；`SEND_REPLY_HANG` |
| MCP 工具中点停止 | 入口或进行中 JSON-RPC 中止；结果为停止拒绝，非迟到成功 |
| 自动化 | `connection-drop` + `mcp-protocol` + `plugin-tools-abort` 测试绿 |

## 8. 切流回滚窗口（v0.1.32）

| 检查 | 期望 |
|------|------|
| `KEEP_IMAGES` | ≥ 5（`deploy/updater/config.env`；扩大窗口需改主机 config） |
| Dry-run | `sh scripts/ops/cutback.sh` → image present、DRY-RUN、**不**切流量 |
| 真切流 | 仅变更窗口 + `CUTBACK_EXECUTE=1`；RTO ~2–5 min |
| 文档 | [ops/traffic-cut-rollback.md](ops/traffic-cut-rollback.md) |

## 9. 信任边界网络隔离（v0.1.33）

| 检查 | 期望 |
|------|------|
| 应用 / Magpie 端口 | compose 仅 `127.0.0.1`；`start.sh` / `friend-up.sh` 拒 `0.0.0.0` 与裸 `端口:端口` |
| TRUSTED_ORIGINS（好友包） | 仅 loopback `http://localhost` / `127.0.0.1` |
| Local-Caller | 仅宿主机 → `127.0.0.1:3001`；经网关（XFF）refuse；nginx 清空该头 |
| 管理员刮数 | 网关模式无 Local-Caller → `/api/admin/health` 401；带密钥 → 聚合绿 |
| CI | `trust-boundary-redline` + `ssrf-redline`；`sh scripts/ops/check-trust-boundary.sh` |
| 文档 | [ops/trust-boundary.md](ops/trust-boundary.md) |

## 9b. Magpie / 边车 → 应用隔离（v0.1.39 · PRD-P0-02）

| 检查 | 期望 |
|------|------|
| br_netfilter | `bridge-nf-call-iptables=1`（`--apply` 写入 sysctl.d） |
| DOCKER-USER | Magpie（及同网边车）→ app:3001 DROP；注释 `chisabot-sidecar-iso` |
| 活探 | `isolate-sidecar-app.sh --verify`：Magpie!-app 超时；App→magpie:3425 仍通 |
| deploy-serial | 默认 apply+verify；失败退出 8 |
| Local-Caller | 仍仅宿主机刮数；边车无密钥 → 401（即使 TCP 曾通） |
| 电车 / 多用户 | **不** resume；多用户仍 opt-in |
| 文档 | [ops/trust-boundary.md](ops/trust-boundary.md) §5.1 |


## 10. nginx 模板同步 / 非电车定时（v0.1.34）

| 检查 | 期望 |
|------|------|
| 仓库模板 | `sh scripts/ops/sync-nginx.sh --check-repo` 绿；CI 同 |
| 生产 live | `sync-nginx.sh --check` 绿；漂移 → `--apply`（备份 + nginx -t + reload） |
| deploy-serial | 默认 check；`CHISABOT_SYNC_NGINX=apply` 可随发版套模板；失败退出 7 |
| 普通定时 | create→run→fail×3→paused；paused 不被 sweep 触发；人手才 resume |
| 孤儿 / 需要关注 | 设置页分区；`partitionScheduleList` 单测 |
| 电车 | **保持 paused**（政策）；不 auto-resume |
| 多用户 UI | 仍需显式 `CHISABOT_ACCOUNTS_UI=1` |

## 10. 长对话首屏（v0.1.37）

| 项 | 说明 |
|----|------|
| 尾屏优先 | >48 条时先挂最后 36 条，rAF 分批往前补；`data-tail-first-pending` |
| 深链 | `?message=` 仍 MessageFind 轮询；全量挂完通常 <300ms |
| 不做 | 虚拟列表；content-visibility；电车 resume；多用户默认开 |

## 11. 狗粮摩擦 · v0.1.39 冒烟 follow-ups（v0.1.40）

| 检查 | 期望 |
|------|------|
| 截图 503 | 大屏展开不打 HTTP `/screenshot`；失败清帧 + 退避≤30s；连续 5 次停轮询等重试 |
| 暂停 + waiting | 文案「暂停前在等确认 · 已暂停，不会自动继续」；主按钮无「立即运行」 |
| 孤儿定时 | `DELETE /api/schedules/orphans`；扫周期 purge；设置页进页自动清；隐藏机器人不算孤儿 |
| 电车 | **保持 paused**；不 auto-resume |
| 安装胶囊 | `--install-hint-gap: 56px` |

## 12. 截图 503 根因协调（v0.1.41）

| 检查 | 期望 |
|------|------|
| LiveScreen 展开 | Network 无刷屏 HTTP `/screenshot`；流正常出图 |
| 直播中 HTTP 截图 | agent-computer 503 + `captureBusy` + `liveCast`（不抢 CDP）；UI「大屏正在直播…」并停轮询 |
| 并发 HTTP | 第二路 captureBusy；失败清帧 |
| 页面忙 | 422 + `pageTimeout` →「页面还在忙…」（非假电脑挂了） |
| 电车 | **保持 paused**；不 resume |

