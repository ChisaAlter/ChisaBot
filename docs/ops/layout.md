# 目录布局与凭据存放

[← 运维手册总览](README.md)

## 1. 宿主机目录（默认布局，可改）

| 路径 | 内容 |
|---|---|
| `/opt/chisabot-zh/` | 应用 compose 目录：`compose.yaml`、`.env`（600）、`secrets/`（700）、每次切换留下的 `rollback-to-<上一镜像>.sh` 和 `compose.yaml.before-<新标签>`、手工备份 `backups/` |
| `/opt/chisabot-zh/public/` | 网关与登录服务：`nginx.conf`（+ `*.bak-*`）、`security-headers.conf`、`magpie-private.conf`、`auth/server.ts`、`auth/config.json`、`auth-data/sessions.sqlite`、`auth-web/`（登录页、「正在更新」页）、`downloads/`（登录后可见的下载页，可选）、`reload-cert.sh` |
| `/opt/chisabot-updater/` | 更新器：`request.sh`、`update.sh`、`smoke.sh`、`health.sh`、`rollback.sh`、`config.env`、`base.env`、`mirror.git`（main 的本地镜像）、`spool/`（请求 / 状态）、`jobs/`、`backups/`（最近 5 份）、`deps-*`、`audit.log` |
| `/opt/chisabot-src/` | 仓库检出（`install-updater.sh` 和手工维护用） |
| `/opt/chisabot-cloudnode/` | 云端节点：`compose.yaml`、`firewall.sh`、`sync-watch.sh`、自己的启动脚本（例如 `up.sh`） |
| `/opt/chisabot-ops/`（建议） | 你自己的运维脚本：`deploy-serial.sh`（拷自 `scripts/ops/`）、测试守卫、快照脚本、部署日志 |
| `/opt/chisabot-release/`（建议） | 客户端发版工作目录：每次 CI 产物 `ci-<版本>/`、签名脚本；**签名密钥放这里时权限 600，且不能在 Web 根目录下** |
| `<PUBLIC_WEB_ROOT>/downloads/` | 公开的客户端更新源：`chisabot-pc/`、`chisabot-android/`（[client-release.md](client-release.md)） |
| `/etc/letsencrypt/` | 证书（`CHISABOT_CERT_DIRECTORY`），挂载整个目录以保证续期符号链接可解析 |

在仓库检出里直接用 `deploy/` 当 compose 目录也可以：`install-updater.sh` 会把 `COMPOSE_DIR` 写成那个目录。下文统一写
`/opt/chisabot-zh/`，按你的 `config.env` 替换。

## 2. 凭据应该放在哪里（只写位置和权限，值永远不进仓库）

| 什么 | 放在哪里 | 权限 / 注意 |
|---|---|---|
| 服务器 SSH 私钥 | 维护者自己的电脑或密钥管理工具 | 不放仓库、不放服务器 |
| 应用环境变量（`KEY_ENCRYPTION_KEY`、模型密钥、`CHISABOT_GATEWAY_SECRET`、`DEPLOYMENT_ID` 等） | `/opt/chisabot-zh/.env` | 600；改之前留 `.env.bak-<说明>-<日期>` |
| `KEY_ENCRYPTION_KEY` | 同上，**另外随数据库备份一起保存一份** | 丢了 = 数据库里加密的模型密钥、保险箱、IM 凭据全部无法解密；已有安装绝不重置 |
| 网关签名身份密钥（多账号用） | 主副本 `/opt/chisabot-zh/secrets/chisabot-gateway-identity.secret` | 600；必须与 `auth/config.json` 的 `identitySecret`、`.env` 的 `CHISABOT_GATEWAY_SECRET` **三处一致** |
| Magpie Web key | `deploy/private/magpie.env`；挂进应用的只读文件（`MAGPIE_WEB_KEY_FILE`） | 0400，属主为容器内 API 用户 |
| 管理员登录（用户名 + Argon2id 密码哈希） | `/opt/chisabot-zh/public/auth/config.json` | `root:1002`、0640；改账号或哈希会让旧会话失效 |
| 登录会话库 | `/opt/chisabot-zh/public/auth-data/sessions.sqlite` | 目录 `1002:1002`、0700；用 SQLite 备份接口或停服务后复制 |
| TLS 证书 | acme.sh / certbot 管理，安装到 `/etc/letsencrypt/live/<YOUR_DOMAIN>/` | 续期后由 `chisabot-public-cert-reload.timer` reload |
| 数据库密码 | 应用容器内 `/var/lib/postgresql/pgpassword` | 由镜像生成，不需要手工管理 |
| 用户保险箱、IM 凭据、个人模型密钥、Claude 上游代理地址 | 数据库（AES-GCM，主密钥 = `KEY_ENCRYPTION_KEY`） | 只能在网页里改 |
| 云端节点的 Claude 订阅凭据、设备令牌 | 卷 `chisabot-cloudnode_home` | 600，节点进程之外看不到 |
| 主机级出口代理的节点密码（可选） | `/etc/sing-box/config.json` | 600 |
| Android 签名密钥 | 维护者自己的电脑或发版工作目录（不在 Web 根目录） | 600；丢了 = 用户要卸载重装，务必离线备份 |
| GitHub 令牌（私有 fork 才需要） | `/opt/chisabot-updater/github-token`（只读权限） | 公开仓库匿名拉取，不需要令牌 |

**不能提交到 Git 的**：`.env`、`private/`、`secrets/`、`magpie-private.conf`、`auth/config.json`、`auth-data/`、证书、备份、签名密钥。
仓库的 `.gitignore` 已覆盖模板目录里的这些路径；放到别处时自己确认。

## 3. 数据库访问（只读排查）

```sh
docker exec -it chisabot-zh sh -c 'PGPASSWORD=$(cat /var/lib/postgresql/pgpassword) psql -h 127.0.0.1 -U openbot openbot'
```

排查时默认只读（`SELECT`）。需要写的操作先 `pg_dump` 一份，并优先通过网页或 API 完成。
