# 监控与巡检

[← 运维手册总览](README.md)

## 1. 巡检清单（只读）

建议每天一次、每次上线后一次：

```sh
df -h / | tail -1                                      # 根分区 < 80%，超过就按 cleanup.md 清理
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'chisabot|chisabot|magpie'
curl -s 127.0.0.1:3001/api/version                     # 提交号 = 你期望的 main
sh /opt/chisabot-updater/request.sh status             # 最近一次更新成功
bash /opt/chisabot-updater/post-deploy-smoke.sh        # 版本 + capabilities + 聚合健康（硬）
sh /opt/chisabot-updater/smoke.sh                      # 模型往返自检（不保存）
docker logs --since 24h chisabot-zh 2>&1 | grep -cE 'bind message supplies|PostgresError'   # 应为 0
systemctl is-active chisabot-updater chisabot-public-cert-reload.timer
docker system df                                       # 镜像 / 构建缓存 / 卷的占用
ls -t /opt/chisabot-zh/rollback-to-*.sh | head -3       # 并确认对应镜像还在（docker image inspect）
openssl x509 -enddate -noout -in /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem   # 证书到期时间
```

外部探活（从别的机器）：`curl -sI https://<YOUR_DOMAIN>:8443/login` 返回 200。可以接任何你习惯的监控（Uptime Kuma、
云厂商探测等），探 `/login` 即可，不要探需要登录的接口。

**聚合健康面（本机 / 值班）**：`GET /api/admin/health`（管理员会话或 `X-ChisaBot-Local-Caller`）一次看 app / DB / Magpie / 电脑节点 / 当前 DSH 内核。DSH Host 的身份、版本和历史读取失败会使整体返回 503。
部署后自动跑 `post-deploy-smoke.sh`（见 [production-checklist.md](../production-checklist.md)）。手动：`sh /opt/chisabot-updater/request.sh smoke`。

## 2. 关注的信号

| 信号                                 | 说明                                     | 处理                                                       |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| 根分区 > 80%                         | 镜像、构建缓存、预览容器、备份会持续增长 | [cleanup.md](cleanup.md)                                   |
| `bind message supplies … requires …` | Bun SQL 连接错位，之后所有 `/api` 挂起   | 重启应用容器，见 [incidents.md](incidents.md) §1           |
| 所有发送返回 409                     | 线程锁残留（部署中断后）                 | [incidents.md](incidents.md) §2                            |
| 自检失败 / 机器人不答                | 模型额度或上游故障                       | [model-config.md](model-config.md)                         |
| 回滚脚本对应的镜像不存在             | 清理或 `KEEP_IMAGES` 删掉了              | 心里有数：需要更早版本时走 revert PR                       |
| 更新器底座镜像不存在                 | 清理删掉了                               | 下一次部署自动走完整构建（时间更长、更吃内存），成功后恢复 |

## 3. 宿主机定时任务

| 定时任务                            | 频率   | 作用                                                      |
| ----------------------------------- | ------ | --------------------------------------------------------- |
| `chisabot-zh-attachments.timer`     | 每小时 | 清理无主附件（可选）                                      |
| `chisabot-public-cert-reload.timer` | 每天   | 证书续期后 reload 网关                                    |
| acme.sh / certbot 定时任务          | 每天   | 证书续期                                                  |
| `chisabot-zh-routines.timer`        | —      | **已废弃，不要启用**（[containers.md](containers.md) §4） |

应用内部的定时任务（ChisaBot 定时任务、附件扫描）在服务器进程里跑，不需要宿主机定时器。

### 复用账号协调 timer 做独立检查

已有 `chisabot-dsh-accounts.timer` 的部署可以复用同一次唤醒，不安装第二套调度器。先安装匹配版本的更新器脚本，在宿主 `config.env` 中将 `CHISABOT_MONITOR_CERT_FILE` 指向**当前网关实际挂载的证书**；阈值默认根分区 80%、证书剩余 14 天、完整备份 30 小时。没有配置证书时检查明确失败，不会当作正常。

先运行一次只读检查：

```sh
bash /opt/chisabot-updater/host-monitor.sh
```

每项输出一行脱敏 JSON，任一必需项异常退出 1。API `/health`、DSH readiness、完整备份、磁盘和证书分别判定；API 进程不响应不会阻止后续磁盘或备份检查。DSH 复用部署探针，验证账号身份、版本和持久历史，不调用模型。备份复用 `complete-backup.sh --status`，同时保留 `local` 与 `offsite` 结果；未配置异机仓库时明确显示 `offsite:missing`。

确认一次检查结果后，为现有 `chisabot-dsh-accounts.service` 增加 `monitor.conf` drop-in：

```ini
[Service]
TimeoutStopSec=150
ExecStopPost=-/bin/bash /opt/chisabot-updater/host-monitor.sh
```

然后 `systemctl daemon-reload`。`ExecStopPost` 在一次协调结束后运行，协调失败时也运行；前缀 `-` 保留监控自己的非零日志，但不把监控失败变成账号协调失败。保留现有 timer 配置；下一次协调的 `OnUnitInactiveSec` 从本次检查结束后计时，故障时检查会延长实际唤醒间隔。API、DSH、助理账本信号和备份分别有 8、60、20、15 秒上限，150 秒的停止阶段预算避免 systemd 默认值提前截断检查。安装器只复制检查脚本，不自动添加此 drop-in；取消接线只需移除该 drop-in 并 reload，保留原协调器和 timer。

```sh
journalctl -u chisabot-dsh-accounts.service --since '30 min ago' -o cat | grep '"type":"host-monitor"'
```

这条入口在应用进程退出后仍可给宿主 journal 发信号，不做自动重启、回滚或清理。检查结束会原子写入既有 `spool/state/host-monitor.json`，记录最新检查及当前故障周期的开始和恢复时间；该目录已只读挂载到 API。备份检查维持原有行为，不进入本轮新增的故障通知范围。

需要本人收件时，先在「设置 → 账号连接」绑定现有通知 Webhook，再在宿主 `config.env` 设置 `CHISABOT_MONITOR_NOTIFY_OWNER` 为接收管理员的用户 ID。这里不复制 Webhook 地址或密钥，空值表示仅记录监控状态，并输出 `notification:not_configured`。

API 的既有通知扫描读取监控记录，沿同一条个人交付账本发送故障和恢复通知。当前异常项发生变化时，记录递增修订号并发送新的当次状态；同一修订使用固定 ID，重复扫描不重复发送，发送结果未知时也不自动重发。连接建立之前的异常状态不会在初次绑定后补发。监控只保留当前/最近一个故障周期及其最新异常状态，不充当完整事件归档。

API 不可用期间不能即时投递这条产品通知；宿主仍记录故障，API 恢复后补交仍保留的故障与恢复状态。整台宿主机宕机时，本机代码无法发出通知，即时收件需要部署外部探测。当前尚无实际 Webhook 目标或外部探测资源，收件验收仍待接通；不能以本机 journal 或记录文件代替已送达。

### 连续失败与未知效果是业务待处理，不触发镜像回滚

`/api/admin/health` 的 `checks.assistant` 与宿主 `host-monitor` 的 `assistant` 行复用同一只读账本查询。API 只返回当前管理员所属账号的数据；宿主通过 `deploy/dsh/ops.ts signals` 汇总已有 DSH 绑定账号，不输出账号、内容或操作 ID。任一来源读不到时明确显示 `unavailable` / `unreadable`。

最近 24 小时内最后三次已完成的任务或定时运行都失败时，状态为 `needs_attention`。暂停、排队、取消和等待批准不计为失败；最近一次成功会中断失败序列。个人通知/SMTP 或工具操作账本发现 `outcome_unknown` 也会提示处理，但不自动核对、重发或改写记录。

查询沿现有索引取最近 100 个任务、100 个个人交付，以及最近 20 个会话的最新 Session 各 64 个工具操作；定时运行使用现有 owner/完成时间索引取窗口内最后三次终态。`coverage` 明确列出范围，`unknown.*AtLeast` 是**数量下界**。`clear_in_sample` 只表示本次样本未发现问题，不能据此宣布全部历史没有未知效果；IM outbox 未纳入此采样，显示 `imOutbox:not_sampled`。

助理业务信号不参与 `/api/admin/health` 顶层 readiness 判定，避免一条需人工核对的历史效果让更新器反复回滚。宿主检查仍会为 `needs_attention` 返回非零并写 journal，供值班与已授权的监控消费。

## 4. 日志

- 应用：`docker logs --since 1h chisabot-zh`。
- 网关：`docker logs chisabot-public-gateway`（访问日志带 UA 和来源 IP）。
- 登录服务：`docker logs chisabot-web-auth`。
- 更新器：`journalctl -u chisabot-updater`、`/opt/chisabot-updater/audit.log`、`jobs/<任务>/`。

排查时把 UTC 时间（镜像标签、备份目录、日志）和你所在时区的时间对清楚再下结论。

## 5. 错误预算时序（无 SaaS）

进程内计数仍在 `GET /api/admin/health` → `budgets`（totals / last15m）。自 v0.1.32 起额外提供：

| 字段 / 端点                                    | 含义                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budgets.rates`                                | `last1h` / `last6h` / `last24h` 事件数；`perHour1h` / `perHour6h`                                                                                                                                                                                                            |
| `budgets.series.points`                        | 近 60 分钟**非零**分钟桶（稀疏）                                                                                                                                                                                                                                             |
| `GET /api/admin/health/budgets?hours=1\|6\|24` | 刮数友好：同结构 + 更长 `points`                                                                                                                                                                                                                                             |
| 磁盘文件                                       | 默认 `/workspace/.chisabot-ops/budgets.json`（compose `workspace` 卷）；`CHISABOT_OPS_METRICS_PATH` 可覆盖。重启后 `import` 进分钟环。目录由 `docker/s6/s6-rc.d/api/run` 在降权前建好并 `chown apiuser`——工作区卷属 `pwuser`，少了这一步每次 flush 都 EACCES，预算永远是空的 |

本机读取示例：

```sh
SECRET=$(grep -E '^[[:space:]]*CHISABOT_GATEWAY_SECRET=' /opt/chisabot-zh/.env | head -1 | cut -d= -f2- | tr -d '"'\'')
curl -s -H "X-ChisaBot-Local-Caller: $SECRET" \
  'http://127.0.0.1:3001/api/admin/health/budgets?hours=6' | jq '{at, rates, points: (.points|length)}'
# 或看持久化文件（容器内）：
docker exec chisabot-zh sh -c 'wc -c /workspace/.chisabot-ops/budgets.json; tail -c 200 /workspace/.chisabot-ops/budgets.json'
```

仍**没有**托管 Prometheus/Grafana；需要看板时用上述 JSON + 你自己的 Uptime/脚本即可。
