# 监控与巡检

[← 运维手册总览](README.md)

## 1. 巡检清单（只读）

建议每天一次、每次上线后一次：

```sh
df -h / | tail -1                                      # 根分区 < 80%，超过就按 cleanup.md 清理
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'openbot|chisabot|magpie'
curl -s 127.0.0.1:3001/api/version                     # 提交号 = 你期望的 main
sh /opt/chisabot-updater/request.sh status             # 最近一次更新成功
bash /opt/chisabot-updater/post-deploy-smoke.sh        # 版本 + capabilities + 聚合健康（硬）
sh /opt/chisabot-updater/smoke.sh                      # 模型往返自检（不保存）
docker logs --since 24h openbot-zh 2>&1 | grep -cE 'bind message supplies|PostgresError'   # 应为 0
systemctl is-active chisabot-updater openbot-public-cert-reload.timer \
  chisabot-cloudnode-syncwatch.timer                   # 用了出口路由 / 节点防火墙的再加上对应单元
journalctl -t chisabot-syncwatch --since -1d | tail -3 # 看门狗最近有没有频繁重启边车
docker system df                                       # 镜像 / 构建缓存 / 卷的占用
ls -t /opt/openbot-zh/rollback-to-*.sh | head -3       # 并确认对应镜像还在（docker image inspect）
openssl x509 -enddate -noout -in /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem   # 证书到期时间
```

外部探活（从别的机器）：`curl -sI https://<YOUR_DOMAIN>:8443/login` 返回 200。可以接任何你习惯的监控（Uptime Kuma、
云厂商探测等），探 `/login` 即可，不要探需要登录的接口。

**聚合健康面（本机 / 值班）**：`GET /api/admin/health`（管理员会话或 `X-ChisaBot-Local-Caller`）一次看 app / DB / Magpie / 电脑节点。
部署后自动跑 `post-deploy-smoke.sh`（见 [production-checklist.md](../production-checklist.md)）。手动：`sh /opt/chisabot-updater/request.sh smoke`。

## 2. 关注的信号

| 信号 | 说明 | 处理 |
|---|---|---|
| 根分区 > 80% | 镜像、构建缓存、预览容器、备份会持续增长 | [cleanup.md](cleanup.md) |
| `bind message supplies … requires …` | Bun SQL 连接错位，之后所有 `/api` 挂起 | 重启应用容器，见 [incidents.md](incidents.md) §1 |
| 所有发送返回 409 | 线程锁残留（部署中断后） | [incidents.md](incidents.md) §2 |
| 自检失败 / 机器人不答 | 模型额度或上游故障 | [model-config.md](model-config.md) |
| 电脑文件夹同步全部失败（ECONNREFUSED） | 节点重启后边车在旧网络命名空间 | 看门狗应在 30 秒内修好；没装就装上（[cloud-node.md](cloud-node.md) §4） |
| 回滚脚本对应的镜像不存在 | 清理或 `KEEP_IMAGES` 删掉了 | 心里有数：需要更早版本时走 revert PR |
| 更新器底座镜像不存在 | 清理删掉了 | 下一次部署自动走完整构建（时间更长、更吃内存），成功后恢复 |

## 3. 宿主机定时任务

| 定时任务 | 频率 | 作用 |
|---|---|---|
| `chisabot-cloudnode-syncwatch.timer` | 30 秒 | 同步边车看门狗 |
| `openbot-zh-attachments.timer` | 每小时 | 清理无主附件（可选） |
| `openbot-public-cert-reload.timer` | 每天 | 证书续期后 reload 网关 |
| acme.sh / certbot 定时任务 | 每天 | 证书续期 |
| `openbot-zh-routines.timer` | — | **已废弃，不要启用**（[containers.md](containers.md) §4） |

应用内部的定时任务（ChisaBot 定时任务、附件扫描）在服务器进程里跑，不需要宿主机定时器。

## 4. 日志

- 应用：`docker logs --since 1h openbot-zh`。
- 网关：`docker logs openbot-public-gateway`（访问日志带 UA 和来源 IP）。
- 登录服务：`docker logs openbot-web-auth`。
- 更新器：`journalctl -u chisabot-updater`、`/opt/chisabot-updater/audit.log`、`jobs/<任务>/`。
- 看门狗：`journalctl -t chisabot-syncwatch`。

排查时把 UTC 时间（镜像标签、备份目录、日志）和你所在时区的时间对清楚再下结论。
