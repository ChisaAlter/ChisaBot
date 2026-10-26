# 容器与服务

[← 运维手册总览](README.md)

名字都是仓库模板里的默认值（为了兼容上游，很多仍叫 `chisabot`）。查看：
`docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`。

## 1. 容器

| 容器 | 镜像 | 来源 | 用途 |
|---|---|---|---|
| `chisabot-zh` | `local/chisabot:<标签>` | [`deploy/compose.yaml`](../../deploy/compose.yaml)，更新器管理 | **ChisaBot 应用**：server + 网页 + 内置 PostgreSQL + 云端浏览器，`127.0.0.1:3001` |
| `chisabot-web-auth` | 复用本地 ChisaBot 镜像（`pull_policy: never`） | [`deploy/public/compose.yaml`](../../deploy/public/compose.yaml) | 登录服务（`auth/server.ts`，host 网络，`127.0.0.1:3002`） |
| `chisabot-public-gateway` | `nginx:alpine`（`CHISABOT_NGINX_IMAGE` 可固定 digest） | 同上 | 公网网关（host 网络，8443 / 2053） |
| `magpie` | 固定 digest 的 Magpie 镜像 | [`deploy/magpie.compose.yaml`](../../deploy/magpie.compose.yaml) | 可选的模型网关，`127.0.0.1:3425/3430` |
| `chisabot-cloudnode` | `chisabot-cloudnode:<Claude Code 版本>[-bN]` | [`deploy/cloud-node/`](../../deploy/cloud-node/README.md) | 云端工作区节点（Claude Code CLI + `chisabot-node`），独占网桥 |
| `chisabot-cloudnode-sync` | `chisabot-cloudnode-sync:<Mutagen 版本>` | 同上 | 电脑文件夹同步边车（`network_mode: service:cloudnode`） |
| `buildx_buildkit_chisabot-builder0` | moby/buildkit | 更新器自动创建 | 完整构建用的 buildx 构建器（内存 / 并行受 `config.env` 限制） |
| 预览容器 `cb-<功能>-preview`、假模型 `cb<功能>-mock` | 生产或分支镜像 | 自己的测试脚本 | 临时，用完拆除（[preview.md](preview.md)） |

`chisabot-web-auth` 用的镜像要一直保留：它不随一键更新换镜像，删掉后登录服务重建时会失败。如果你给它固定了某个标签，
清理时把这个标签加入保留名单（[cleanup.md](cleanup.md)）。

## 2. 镜像

| 镜像 | 说明 |
|---|---|
| `local/chisabot:auto-<UTC 时间>-<提交前 7 位>` | 更新器每次构建的应用镜像；标签就说明了是哪次提交、什么时候构建的 |
| `local/chisabot:latest`（或 `CHISABOT_IMAGE`） | `start.sh` 首次构建的镜像；装了更新器后由更新器接管 |
| 底座镜像（`base.env` 里的 `BASE_IMAGE`） | 快速更新的基础层；被删掉后下一次更新自动走完整构建，成功后写入新底座 |
| 云端节点 / 同步边车镜像 | 手工构建，版本号写在标签里 |

更新器只保留最近 `KEEP_IMAGES`（默认 3）个应用镜像（新、当前、底座之外的旧镜像会被删除），所以**只有最近两三个回滚脚本真正可用**。

## 3. 卷

| 卷 | 内容 | 备份 |
|---|---|---|
| `chisabot-zh_database` | 生产数据库（PostgreSQL 数据目录） | **必须**：每次一键更新前自动 `pg_dump`，另外建议定期异地备份 |
| `chisabot-zh_workspace` | 机器人工作区文件、附件 | 建议 |
| `chisabot-zh_profiles` | 云端浏览器配置（登录状态） | 可选 |
| `chisabot-cloudnode_home` | 节点的 Claude 凭据、设备令牌（600） | 删掉 = 需要重新配对和重新登录 Claude |
| `chisabot-cloudnode_workspace` | 云端工作区里的项目代码 | 建议 |
| `chisabot-cloudnode_sync-*` | 同步边车的主机密钥、公钥、状态 | 删掉 = 电脑端需重新建立同步 |

卷名前缀是 compose 项目名（`chisabot-zh`、`chisabot-cloudnode`），改了项目名就是一套新卷，旧数据不会自动带过去。

## 4. 宿主机 systemd 单元

| 单元 | 来源 | 作用 |
|---|---|---|
| `chisabot-updater.service` | `deploy/updater/`，`install-updater.sh` 安装 | 宿主机更新器（处理网页「检查更新 / 一键更新 / 回滚」请求） |
| `chisabot-public-cert-reload.timer` | `deploy/public/` | 每天检查证书并 reload 网关（安装前改 service 里的目录） |
| `chisabot-zh-attachments.timer` | `deploy/` | 每小时清理无主附件（可选，`CHISABOT_ENABLE_TIMERS=1 sh deploy/start.sh` 安装） |
| `chisabot-cloudnode-syncwatch.timer` | `deploy/cloud-node/systemd/` | 每 30 秒检查同步边车和节点是否在同一网络命名空间，不同就重启边车 |
| `chisabot-cloudnode-firewall.service`（自建） | 包一层 `firewall.sh` | 开机恢复节点网段的 `DOCKER-USER` 规则 |
| `sing-box.service`（可选） | 自己安装 | 主机级 Claude 出口路由（[cloud-node.md](cloud-node.md) §5） |

**不要启用** `chisabot-zh-routines.timer`：上游 Routines 已在瘦身中删除（`fire-routines.ts` 不在镜像里），老部署上残留的这个单元
应停用并删除（[slimming.md](../slimming.md)）。

检查：`systemctl is-active chisabot-updater chisabot-cloudnode-syncwatch.timer chisabot-public-cert-reload.timer`。
