# ChisaBot 自托管部署

此目录是可自行配置的 Linux 部署模板。ChisaBot 用自有 Conversation 服务管理会话、权限与交付，聊天记录和个人记忆保存在自己的 PostgreSQL 中；DSH Host 负责模型/工具循环与独立 Session。模型推理由接入的模型服务处理，支持自托管模型、兼容 API 和自部署 Magpie。

宿主机需要 Bun 1.3.14、Docker Engine、Docker Compose v2；在宿主机直接运行 DSH 时还需 Node.js 24.9 或以上。主应用由仓库根 `Dockerfile` 的 `chisabot` 目标完整构建，前端、服务端、DSH 依赖与工具环境一起进入镜像。

## 构建与启动

**好友可装包（推荐新装）**：`sh deploy/friend-up.sh` —— 安全默认模板、自动填密钥、拒绝公网直连应用端口。说明见 [docs/friend-deploy.md](../docs/friend-deploy.md)。

首次安装时，在仓库根目录执行；已有安装保留原 `.env`，按下文升级步骤操作：

```sh
bun install --frozen-lockfile --omit=peer
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
# 仅为首次安装的空字段生成随机密钥，不打印密钥（服务端要求 base64 编码的 32 字节密钥）。
bun -e 'let text=await Bun.file("deploy/.env").text();for(const name of ["KEY_ENCRYPTION_KEY"]){text=text.replace(new RegExp("^"+name+"=\\s*$","m"),name+"="+require("node:crypto").randomBytes(32).toString("base64"))}await Bun.write("deploy/.env",text)'
sh deploy/start.sh
```

`deploy/.env` 中的 `BOT_PROVIDER`、`BOT_MODEL`、对应 API 地址及密钥是首次启动的模型连接。可以先保留示例模型，再通过网页登录后的“管理 → 模型设置”配置和测试真实连接。启动不要求先调用模型，旧 `preflight-model.ts` 仅作为手动 OpenAI 兼容接口诊断工具。

使用 DSH 还需设置 `CHISABOT_AGENT_KERNEL=dsh`，并完成账号 Host、targets、Session 持久化及工具网关配置，按 [DSH 运维](../docs/ops/dsh-runtime.md) 接线。仅启动主应用或设置一个环境变量不能代替这一步。

主服务默认只监听 `127.0.0.1:3001`。公网使用需要继续配置 [HTTPS 登录网关](public/README.zh-CN.md)。网关保护下的后端沿用单管理员工作空间；不要将该单用户后端端口直接对外开放。

`start.sh` 先检查 `.env`，通过 `pin-resources.sh` 固定已有卷与网络，再检查 Compose 配置。它会**安装或升级宿主机在线更新服务 `chisabot-updater`**（`install-updater.sh`，需要 root + systemd；不满足时只提示，照常启动），创建共享模型网络，最后完整构建并启动容器。前端在镜像构建内生成，无须预先准备 `app/dist`。默认镜像名为 `local/chisabot:latest`，可通过 `CHISABOT_IMAGE` 修改；镜像会记下来源提交（工作区没有未提交改动时），系统更新页据此显示落后多少个提交。

## 在线更新（管理后台 → 系统更新）

默认就装：`sudo sh deploy/start.sh` 会顺带运行 `deploy/install-updater.sh`，按这份部署生成 `/opt/chisabot-updater/config.env`（`COMPOSE_DIR` = 这个 `deploy/` 目录，`PUBLIC_HEALTH_URL` 取 `.env` 的 `CHISABOT_DOMAIN` + `CHISABOT_HTTPS_PORT`，`GITHUB_REPO` 取 git 远程，完整构建内存上限按本机内存），装好 systemd 服务，`compose.yaml` 已经带了两个挂载和 `CHISABOT_UPDATER_DIR`。之后在网页上点「检查更新」「一键更新」即可，第一次是完整构建（约 4–8 分钟），之后依赖不变的更新只替换代码（约 1–2 分钟）。不想装：`CHISABOT_UPDATER=off sh deploy/start.sh`。

装了在线更新以后，镜像由它管理（`.env` 里 `CHISABOT_IMAGE=local/chisabot:auto-…`），再运行 `start.sh` 不会重新构建、只启动；一定要按当前检出重新构建：`CHISABOT_FORCE_BUILD=1 sh deploy/start.sh`。

**老部署（2026-10-13 之前部署的，或跳过了在线更新那一步）**：系统更新页是空的 / 显示「未安装」，收不到新版本。在服务器上运行一次：

```sh
cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh
```

它安装（或升级）更新服务，并用**现在正在运行的镜像**重建一次容器挂上更新目录（不重新构建，断开十几秒）。只想看会做什么：`sh deploy/install-updater.sh --check`。详见 [在线更新](../docs/online-update.md)。

## Magpie

主模板与 `magpie.compose.yaml` 使用相同的 `MAGPIE_NETWORK`，首次安装默认为 `chisabot_magpie`。已有安装由启动入口保留原网络；两个 Compose 必须使用同一个已固定值。独立使用其他模型 API 时该空网络仍会创建，不依赖其他部署的 New API 网络。

首次配置 Magpie 时，主服务启动后在 `deploy/` 执行：

```sh
install -d -m 700 private magpie-data
# Magpie 容器以 uid 65532（nonroot）运行，数据目录属主必须改过去，否则报 providers.json permission denied
chown -R 65532:65532 magpie-data
umask 077
{ printf 'MAGPIE_WEB_KEY='; openssl rand -hex 32; } > private/magpie.env
docker compose --env-file .env -p magpie -f magpie.compose.yaml up -d --wait
```

已有安装请保留并复用 `private/magpie.env` 与 `magpie-data`，不要重新生成 Web key。模板固定使用已验证的 Magpie v0.1.1141 镜像 digest；升级应先备份配置和独立验证。

API 端口 `3425`、管理端口 `3430` 只绑定 loopback。ChisaBot 容器通过 `http://magpie:3425/v1` 访问网关，并在「管理后台 → 模型平台 Magpie」内嵌 Magpie 管理控制台（同源 `/magpie-admin/`，仅管理员，沿用 ChisaBot 登录）。为此在 ChisaBot 的 compose 中设置 `MAGPIE_ADMIN_URL=http://magpie:3430`，并把 Magpie Web key 以只读文件挂载（`MAGPIE_WEB_KEY_FILE`，属主为容器内 API 用户 uid 1002、权限 0400）。模型列表启动时、每 `MODEL_CATALOG_REFRESH_MINUTES`（默认 10）分钟和点「刷新」时从 Magpie 同步。详见 [Magpie 指南](../docs/magpie.md)。

登录网关上独立的管理入口（例如 `https://chisabot.example.com:2053`）可以保留作备用；`VITE_MAGPIE_MANAGEMENT_URL` 已不再用于界面导航。

## 数据与兼容性

首次安装使用 Compose 项目和容器名 `chisabot-zh`，卷默认为 `chisabot-zh_database`、`chisabot-zh_workspace`、`chisabot-zh_profiles`、`chisabot-zh_dsh`，内部网络为 `chisabot-zh_default`。现役配置、HTTP 请求与数据库表统一使用 `CHISABOT_*`、`/api/conversations` 与 `chisabot_*` 自有命名空间。

已有安装必须通过 `start.sh` 或更新器升级：`deploy/pin-resources.sh` 会优先采用现有容器挂载并在 `.env` 固定实际卷名和网络名，内置 PostgreSQL 启动脚本（`docker/s6/scripts/database-identity.sh`）会读取数据卷中的 `identity` 标记保持原有数据库角色与库名兼容。不要为了改名重建空卷、删除旧库或覆盖加密密钥。迁移 `0067` / `0068` 已完成会话表与频道映射表原地重命名（`chisabot_local_*`、`chisabot_channel_mappings`）及废弃空表清理，产品 reader 固定为 4，升级后不能再将 reader 1–3 的旧镜像挂回同一数据库。具体兼容与恢复边界见 [命名切换与存量资源兼容](../docs/ops/upstream-removal.md)。

`KEY_ENCRYPTION_KEY` 加密持久化的模型密钥，必须随数据库备份保存；更新已有安装时不可重置它。`.env`、Magpie 私密配置、网页登录配置、会话数据库、证书与备份不能提交 Git。

附件清理使用原兼容的 systemd 服务名（定时任务在服务器进程里每 15 秒自己扫描，不需要宿主机定时器）。需要时由 root 执行 `CHISABOT_ENABLE_TIMERS=1 sh deploy/start.sh`；容器名称应与模板相同。证书重载定时器在 `public/` 中，安装前按实际部署目录修改其路径。

## 可选 SSH 维护

日常使用走 HTTPS 网页。Windows 维护脚本针对已经上传或克隆的服务器源码目录，不负责首次传输整个仓库。构建由服务器的 `start.sh` 完成。先通过可信渠道核对服务器指纹并写入 known_hosts；脚本使用 `StrictHostKeyChecking=yes`。

```powershell
./deploy/configure.ps1 -Server server.example.com -User root -Port 22 `
  -IdentityFile C:/keys/server_ed25519 -KnownHostsFile C:/keys/known_hosts `
  -DeploymentDirectory /opt/chisabot/deploy
# 可选临时访问 loopback 工作台，后台启动的窗口隐藏。
./deploy/connect.ps1 -Server server.example.com -IdentityFile C:/keys/server_ed25519 `
  -KnownHostsFile C:/keys/known_hosts
```

`configure.ps1` 上传本地 `deploy/.env` 并更新模型/运行设置；已有加密密钥和其他配置保留。它随后调用服务器的 `start.sh`，不会打印配置值。`connect.ps1` 默认转发本地 `3001` 到服务器 `127.0.0.1:3001`，可用 `-LocalPort` 改本地端口。

## 验证

```sh
node scripts/check-zh-localization.cjs
TENANT_PACKAGE_DIR=../examples/zh-CN bun run --cwd app typecheck
bun run --cwd server typecheck
docker compose --env-file deploy/.env -p chisabot-zh -f deploy/compose.yaml config --quiet
```

这些命令检查本地源码与配置；发布还需完成数据库迁移、资源兼容和健康/恢复检查，以及桌面与手机布局的实际验收。按 [测试指南](../docs/testing.md) 先完成本地定向 QA，再执行最终 CI。历史生产交付记录见 [实施记录](../docs/pipeline-runs/20261108-assistant-production.md)。
