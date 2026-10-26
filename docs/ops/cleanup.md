# 磁盘清理指南

[← 运维手册总览](README.md)

ChisaBot 的磁盘大头是**镜像**（每个应用镜像约 5–6 GB）、**buildx 构建缓存**、**预览容器和它们的卷**、**更新备份**。
根分区超过 80% 就该清理。清理是破坏性操作：先列清单、写成脚本、留日志，再执行。

## 1. 先看清楚

```sh
df -h /
docker system df
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'
docker volume ls -f dangling=true
du -sh /opt/chisabot-updater/backups /opt/chisabot-release 2>/dev/null
ls -t /opt/chisabot-zh/rollback-to-*.sh | head -3
grep -E '^BASE_IMAGE=' /opt/chisabot-updater/base.env
```

## 2. 必须保留

| 什么 | 为什么 |
|---|---|
| 当前运行的应用镜像（`docker inspect -f '{{.Config.Image}}' chisabot-zh`） | 生产 |
| 最近 1–2 个回滚镜像（最新几个 `rollback-to-*.sh` 指向的） | 能一步回滚 |
| 更新器底座镜像（`base.env` 的 `BASE_IMAGE`） | 删了下次部署会走完整构建（不致命，但更慢、更吃内存） |
| 登录服务 `chisabot-web-auth` 使用的镜像 | 它不随更新换镜像，删了无法重建登录服务 |
| 云端节点、同步边车当前镜像 | 删了无法重建节点 |
| 所有**运行中**容器的镜像，包括同机其他项目的 | 别动别人的东西 |
| 卷 `chisabot-zh_database`、`chisabot-zh_workspace`、`chisabot-zh_profiles`、`chisabot-cloudnode_*` | 生产数据 |
| `/opt/chisabot-updater/backups/`（更新器自己保留 5 份） | 数据恢复 |
| 发版的 CI 产物目录（至少最近几版） | 更新源损坏时的重建来源 |

## 3. 可以删

| 什么 | 怎么删 |
|---|---|
| 已停止的预览容器、假模型容器 | `docker rm <容器>`，连同它们的卷和临时网络 |
| 不再需要的可交互原型 / 模拟器容器 | 先用它自己的 down 脚本拆，再删它独占的镜像 |
| 旧应用镜像（保留名单之外的 `local/chisabot:*`） | `docker rmi <镜像>` |
| 旧的云端节点 / 同步边车镜像 | 同上（删之前确认 `Dockerfile.bak-*` 还在，需要时能重建） |
| 超过 24 小时的构建缓存 | `docker builder prune -f --filter until=24h`；buildx 构建器：`docker buildx prune --builder chisabot-builder -f --filter until=24h` |
| 无主的匿名卷 | `docker volume prune -f`（只删没有容器引用的**匿名**卷；先 `docker volume ls -f dangling=true` 看一眼） |
| 对应镜像已不存在的 `rollback-to-*.sh` / `compose.yaml.before-*` | 可以移到 `archive/` 目录，避免误用 |
| 过期的 `*.bak-*`、更新源的 `downloads-backup-*` | 保留最近几份，其余删除 |

**不要用** `docker system prune -a --volumes`：它会删掉所有当前没在运行的镜像（包括回滚镜像、底座镜像）和所有没挂载的卷。

## 4. 不要碰的地方

- **`/tmp/systemd-private-*` 目录不要删**。它们是 systemd 给开启了 `PrivateTmp` 的服务（例如 sshd、时间同步、数据库等）准备的私有
  `/tmp`，服务运行期间删掉会让这些服务出错。清理 `/tmp` 只删你自己确认过的临时文件，或者干脆交给 `systemd-tmpfiles`。
- `/var/lib/docker` 下的文件不要手工删，一律用 docker 命令。
- 同机其他项目的容器、镜像（包括它们的「备份 / 保留」标签）和卷。
- 证书目录、`.env`、`secrets/`、`auth-data/`。

## 5. 推荐做法

1. 把要删的东西写进一个脚本（例如 `/root/cleanup-<日期>.sh`），脚本里每一项都显式列出名字，不用通配。
2. `sh /root/cleanup-<日期>.sh 2>&1 | tee /root/cleanup-<日期>.log`。
3. 清理后再跑一次 [monitoring.md](monitoring.md) 的巡检，确认生产正常、`df` 下降。
4. 记下**副作用**，例如：
   - 底座镜像被删 → 下次部署走完整构建；
   - 回滚镜像被删 → 只剩下最近几个回滚脚本可用；
   - 节点旧镜像被删 → 节点回滚需要先重建镜像。

## 6. 预防

- 预览容器跑完立刻拆（[preview.md](preview.md)）。
- 更新器 `KEEP_IMAGES`、`KEEP_BACKUPS`、`BUILD_CACHE_MAX` 按磁盘大小调。
- 根分区设一个 80% 的告警。
