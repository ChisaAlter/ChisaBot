<p align="center">
  <img src="docs/images/logo.png" width="132" height="132" alt="ChisaBot 标志">
</p>

<h1 align="center">ChisaBot</h1>

<p align="center"><b>中文、自托管、可配置模型的 AI 助手平台。</b><br>网页 · Windows PC 客户端 · Android 客户端，连同一台你自己的服务器。</p>

<p align="center">
  <a href="docs/README.md">文档首页</a> ·
  <a href="docs/getting-started.md">快速开始</a> ·
  <a href="docs/models.md">模型配置与切换</a> ·
  <a href="docs/magpie.md">Magpie 深度集成</a> ·
  <a href="deploy/README.zh-CN.md">自托管部署</a> ·
  <a href="https://github.com/ChisaAlter/ChisaBot/releases">下载客户端</a>
</p>

ChisaBot 基于 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) 的开源代码开发，保留 AG-UI、多 BOT、工具权限和审计能力，加入中文界面、独立的网页登录、本地会话持久化，以及 Magpie 模型目录与 BOT 模型选择。本分支可通过 `OPENBOT_RUNTIME_MODE=local` 将会话保存在自己的 PostgreSQL 中，无需 CopilotKit Intelligence 项目。模型由管理员接入，可以是自托管模型、兼容 API 或自部署的 [Magpie](https://github.com/yetone/magpie) 网关。使用第三方模型时，推理仍由所选模型服务处理。

## 截图

> 以下截图来自一个全新的演示实例（演示账号、演示机器人，没有任何真实对话）。

### 网页（服务器）

浅色：左边是机器人列表，中间是对话，右栏是机器人做的面板。

![ChisaBot 网页 · 浅色](docs/images/web-desktop-light.webp)

<details>
<summary>深色模式</summary>

![ChisaBot 网页 · 深色](docs/images/web-desktop-dark.webp)

</details>

<details>
<summary>登录页（认证网关）</summary>

![ChisaBot 登录页](docs/images/web-login.webp)

</details>

### PC 客户端（Windows）

ChisaBot PC 是无边框窗口，打开后直接进入你服务器上的 ChisaBot，右上角是窗口按钮；首次运行先在本机的「登录 ChisaBot」页填写服务器地址。

![ChisaBot PC 客户端](docs/images/pc-client.webp)

<sub>说明：截图在 Linux 服务器上渲染，不是在 Windows 上截的——客户端窗口里显示的就是这套网页（桌面窗口模式，带窗口按钮），外框阴影是后加的。</sub>

<details>
<summary>PC / Android 客户端的本机登录页</summary>

![ChisaBot 客户端登录页](docs/images/pc-login.webp)

</details>

### 手机

手机浏览器（390×844）里的对话和面板，以及 Android 客户端的登录页。

![ChisaBot 手机端](docs/images/mobile.webp)

## 已有功能

- **中文界面**：聊天、BOT 管理、设置与管理页面中文化，内置中文租户包位于 `examples/zh-CN/`。
- **网页登录**：登录页面、服务端会话与退出登录，认证网关保护页面及 API。
- **本地运行与持久化**：本地运行模式使用 PostgreSQL 保存对话，重启后可继续查看会话。
- **模型配置**：管理员配置协议、API 地址、密钥与部署默认模型，并测试连接；密钥由服务端加密保存。
- **Magpie 模型目录**：读取网关实际开放的完整模型列表，保留供应商前缀，支持搜索和刷新。
- **每 BOT 独立选择**：聊天输入框与 BOT 设置修改同一个持久化值，两处及跨标签页同步，下一轮使用新模型。
- **工具与权限**：继承上游的 AG-UI 接入、BOT 电脑、MCP 工具、审批与审计，按部署配置启用。
- **面板与云端浏览器**：机器人可以在右栏建面板（可定时刷新），也可以在服务器上的云端浏览器里打开和操作网页，右栏「面板 | 计算机」切换查看。
- **客户端与在线更新**：Windows PC（Electron）和 Android 客户端连接你自己的服务器；服务器在「管理后台 → 系统更新」一键更新，网页和客户端各自提示新版本。

目录表示当前网关连接向 ChisaBot 开放的模型，不表示全部供应商缓存，也不保证每个上游模型均可调用。具体权限、额度和服务状态由上游决定。

## 开发与部署

开发依赖：Bun 1.3.14、Docker 和 PostgreSQL。

```sh
bun install --frozen-lockfile
bun run typecheck
```

自托管模板及认证网关放在 `deploy/`，详见 [部署说明](deploy/README.zh-CN.md)。数据库连接、加密密钥、登录与模型连接需要按自己的环境配置。密码、模型密钥、数据库备份与浏览器资料不写入仓库。

本分支保留上游 `OPENBOT_*` 环境变量、内部包名、协议标识和数据目录，兼容已有部署和数据。产品展示名称为 **ChisaBot**。

`OPENBOT_SINGLE_USER=true` 只用于本地开发或由认证网关保护的内部服务；对外入口必须配置登录保护。详细能力边界与源码位置见 [分支说明](docs/chisabot.md)。

## 给 AI 的部署引导

> 写给代替人部署 / 维护 ChisaBot 的 AI 代理（以及照着做的人）。适用于任意 Linux 服务器 / VPS 和任意域名，不依赖任何特定主机。
> 每一步都可以直接复制执行；`<...>` 是要替换的值（`<域名>`、`<端口>` 与 `deploy/.env` 的 `CHISABOT_DOMAIN`、`CHISABOT_HTTPS_PORT` 一致）。
> 规则：**不要打印、提交或回显任何密钥**（`.env`、`auth/config.json`、`private/`、证书、令牌）；**自检不要往真实对话里发消息**，一律用 `POST /api/admin/smoke`。
> 细节以这些文件为准：[`deploy/README.zh-CN.md`](deploy/README.zh-CN.md)、[`deploy/public/README.zh-CN.md`](deploy/public/README.zh-CN.md)、[`docs/online-update.md`](docs/online-update.md)、[`docs/admin-smoke.md`](docs/admin-smoke.md)、[`docs/magpie.md`](docs/magpie.md)、[`pc/README.md`](pc/README.md)。

### 0. 端口与组件一览

| 组件 | 监听 | 说明 |
| --- | --- | --- |
| ChisaBot 应用（容器 `openbot-zh`，Compose 项目 `openbot-zh`） | `127.0.0.1:3001` | 只绑 loopback，单管理员后端，**绝不直接对外** |
| 登录服务（容器 `openbot-web-auth`，host 网络） | `127.0.0.1:3002` | Argon2id 密码 + 会话，网关 `auth_request` 调它 |
| 公网网关（容器 `openbot-public-gateway`，nginx，host 网络） | `CHISABOT_HTTPS_PORT`（默认 8443）TLS | ChisaBot 入口 `https://<域名>:<端口>`（端口为 443 时就是 `https://<域名>`） |
| 同一网关的 Magpie 管理入口 | `CHISABOT_MAGPIE_PORT`（默认 2053）TLS | 备用入口；日常用「管理后台 → 模型平台 Magpie」（同源 `/magpie-admin/`） |
| Magpie 模型网关（Compose 项目 `magpie`，可选） | `127.0.0.1:3425`（API）、`127.0.0.1:3430`（管理） | 应用经 Docker 网络 `http://magpie:3425/v1` 访问 |
| 宿主机更新服务 `chisabot-updater`（systemd，python3） | 无端口 | 读 `/opt/chisabot-updater/spool/requests` 请求文件 |
| 客户端（PC / Android）更新源 | 无（可选任意静态 HTTPS 目录） | 默认用本仓库的 GitHub Releases；自建见第 8 步 |

两个公网端口都可以改。**用 Cloudflare 代理（橙色云）**时只能选它支持的 HTTPS 端口：443、2053、2083、2087、2096、8443；
证书可以用 Let's Encrypt（DNS 验证最省事）或 Cloudflare Origin 证书（SSL 模式设「完全（严格）」）。**不用 Cloudflare**
时任意端口都行，证书用 Let's Encrypt（`certbot certonly --standalone -d <域名>` 或 DNS 验证）。

### 1. 前置条件

- 任意 Linux 发行版（Debian / Ubuntu / CentOS / Rocky 等），root 或 sudo。
- **架构**：x86_64（amd64）与 arm64（aarch64）都可以——`Dockerfile` 按 `TARGETARCH` 选 s6 包，底座镜像都是多架构的；
  在哪台机器上 `docker build` 就得到哪种架构的镜像。Magpie 镜像是否有 arm64 以其发布页为准。
- **内存**：运行约 1–1.5 GB；**构建**前端 + 镜像需要 3–4 GB。小内存机器（1–2 GB）：加 2–4 GB swap
  （`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`），把 `deploy/updater/config.env`
  的 `BUILD_MEMORY` 调小，必要时在别的机器上构建镜像后 `docker save | ssh <主机> docker load`；不装 Magpie 也能省几百 MB。
- 磁盘剩余 ≥ 2.5 GB（更新脚本会检查）。
- Docker Engine + Docker Compose v2（+ buildx 插件）、git、curl、python3（3.6+，第 7 步的 `chisabot-updater` 用；没有 python3 的老系统也能用 python2.7）、systemd、Bun 1.3.14（构建前端）。
- 域名（A / AAAA 记录指向服务器）与证书：默认在 `/etc/letsencrypt/live/<域名>/{fullchain.pem,privkey.pem}`；
  别的位置就在 `deploy/.env` 设 `CHISABOT_CERT_DIRECTORY`（挂成容器里的 `/etc/letsencrypt`）和 `CHISABOT_CERT_NAME`。

```sh
docker --version && docker compose version && docker buildx version && git --version && python3 --version && bun --version
```

### 2. 获取代码

用本仓库或你自己的 fork（下文的 `<owner>/<repo>`）：

```sh
git clone https://github.com/<owner>/<repo>.git /opt/chisabot-src
cd /opt/chisabot-src
bun install --frozen-lockfile
```

### 3. 环境变量与密钥（只列名字）

```sh
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# 只给空字段生成随机值，不打印：
bun -e 'let t=await Bun.file("deploy/.env").text();for(const n of ["KEY_ENCRYPTION_KEY","WORKER_SHARED_SECRET"]){t=t.replace(new RegExp("^"+n+"=\\s*$","m"),n+"="+require("node:crypto").randomBytes(32).toString("hex"))}await Bun.write("deploy/.env",t)'
```

`deploy/.env` 里的变量：

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `KEY_ENCRYPTION_KEY` | 是 | 加密数据库里的模型密钥；**必须与数据库备份一起保存，已有安装绝不能重置** |
| `WORKER_SHARED_SECRET` | 是 | 例行任务 worker 与服务器之间的共享密钥 |
| `OPENBOT_RUNTIME_MODE` | 是（`local`） | 会话存自己的 PostgreSQL，不需要 CopilotKit Intelligence |
| `BOT_PROVIDER`、`BOT_MODEL`、`OPENAI_API_KEY` / `OPENAI_BASE_URL`、`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | 首次启动用 | 首个模型连接；之后在「管理后台 → 模型设置」改并测试 |
| `CHISABOT_IMAGE` | 否 | 镜像名，默认 `local/chisabot:latest` |
| `MAGPIE_NETWORK` | 否 | 与 Magpie 共用的 Docker 网络，默认 `openbot_magpie` |
| `MAGPIE_ADMIN_URL`、`MAGPIE_WEB_KEY_FILE` | 用 Magpie 时 | 内嵌管理控制台：`http://magpie:3430` + 只读 Web key 文件（uid 1002、0400） |
| `MODEL_CATALOG_REFRESH_MINUTES` | 否 | 模型目录刷新间隔，默认 10 |
| `SL_ENABLED`、`COPILOTKIT_TELEMETRY_DISABLED`、`DO_NOT_TRACK` | 否 | 关闭上游遥测 |
| `DEPLOYMENT_ID`、`VITE_MAGPIE_MANAGEMENT_URL` | 否 | 部署标识；后者已不用于导航 |

Compose 里固定写好的：`EMBEDDED_POSTGRES=on`（数据库在容器内，卷 `database`）、`OPENBOT_SINGLE_USER=true`（**只因为前面有登录网关才安全**）、`TENANT_PACKAGE_DIR=../examples/zh-CN`、在线更新的两个挂载和 `CHISABOT_UPDATER_DIR`（见第 7 步）。`CHISABOT_SOURCE_DIR`（仓库路径）由 `start.sh` 自动写进 `.env`。
其他私密文件：`deploy/private/magpie.env`（`MAGPIE_WEB_KEY`）、`deploy/public/auth/config.json`、`deploy/public/magpie-private.conf`。都被 Git 忽略，不要提交。

### 4. 构建并启动应用

```sh
cd /opt/chisabot-src
TENANT_PACKAGE_DIR=../examples/zh-CN bun run --cwd app build     # start.sh 要求 app/dist 已存在
sudo sh deploy/start.sh                                           # 装在线更新服务（第 7 步）、建 Magpie 网络，build + up --wait openbot
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health   # 期望 200
curl -s http://127.0.0.1:3001/api/version                               # {version, commit, buildId, builtAt}
```

可选 Magpie（在 `deploy/` 下；已有安装复用 `private/magpie.env` 与 `magpie-data`，不要重新生成 Web key）：

```sh
cd deploy
install -d -m 700 private magpie-data
umask 077; { printf 'MAGPIE_WEB_KEY='; openssl rand -hex 32; } > private/magpie.env
docker compose --env-file .env -p magpie -f magpie.compose.yaml up -d --wait
```

可选定时任务（例行任务、附件清理）：`CHISABOT_ENABLE_TIMERS=1 sh deploy/start.sh`（root + systemd）。

### 5. HTTPS 网关与首个管理员

管理员账号就是登录网关的账号（Argon2id 哈希写进 `deploy/public/auth/config.json`）。按 [`deploy/public/README.zh-CN.md`](deploy/public/README.zh-CN.md)「初始化认证配置」执行：密码用 `read -s` 读、经 stdin 传入，**不要放进命令参数或日志**；AI 代理应让人自己输入密码。

```sh
cd /opt/chisabot-src/deploy/public
# deploy/.env 里先填 CHISABOT_DOMAIN（以及要改的 CHISABOT_HTTPS_PORT / CHISABOT_MAGPIE_PORT / CHISABOT_CERT_NAME）
sh render-nginx.sh                     # 由模板 nginx.conf 生成 nginx.generated.conf（Origin 白名单、Host 校验、证书路径、端口）
sed -i 's#^CHISABOT_NGINX_CONF=.*#CHISABOT_NGINX_CONF=./nginx.generated.conf#' ../.env
umask 077; printf 'proxy_set_header Cookie "";\n' > magpie-private.conf   # 未启用 Magpie 时；启用后按文档生成
# ……按文档生成 auth/config.json（publicOrigin 必须与 https://<域名>:<端口> 完全一致；443 端口不写 :443）……
docker compose --env-file ../.env -p openbot-public -f compose.yaml run --rm --no-deps gateway nginx -t
docker compose --env-file ../.env -p openbot-public -f compose.yaml up -d --wait
curl -s -o /dev/null -w '%{http_code}\n' https://<域名>:<端口>/login      # 期望 200
```

防火墙（云厂商安全组 + 本机 firewalld / ufw）只开你选的两个 HTTPS 端口（以及自建更新源所在的端口）；3001 / 3002 / 3425 / 3430 保持 loopback。
同一台机器上已有别的 nginx / Caddy 占着 443 时：要么给 ChisaBot 换端口，要么让现有反代把某个域名转发到网关端口。
登录后第一件事：「管理后台 → 模型设置」配置连接并点「测试」。首次打开时系统会自动建一个私有的默认「助手」机器人。

### 6. 自检（不碰任何对话）

```sh
curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3001/api/admin/smoke
# 期望 "ok":true 且 "persisted":false；装了更新服务后也可以：
sh /opt/chisabot-updater/smoke.sh [机器人 id]     # 失败时退出码非 0
```

网页上：管理后台 → 系统更新 →「自检」。**禁止**用「在某个机器人对话里发一句 ok」来验证。

### 7. 在线更新服务（管理后台 → 系统更新）

**默认已经装好**：第 4 步的 `sh deploy/start.sh`（用 root 运行）会顺带运行 `deploy/install-updater.sh`：

- 按这份部署生成 `/opt/chisabot-updater/config.env`：`COMPOSE_DIR` = 仓库的 `deploy/`，`PUBLIC_HEALTH_URL` = `https://<CHISABOT_DOMAIN>:<CHISABOT_HTTPS_PORT>/login`（`deploy/.env` 里还没填域名时留空 = 健康检查跳过公网登录页，填好后重跑一次自动补上），`GITHUB_REPO` 取 `git remote`，`FULL_BUILD_MEMORY` 按本机内存；
- 从 GitHub 拉 `main` 到 `/opt/chisabot-updater/mirror.git`，安装并启动 systemd 服务 `chisabot-updater`（python3，没有时退回 python2.7）；
- `deploy/compose.yaml` 自带两个挂载和 `CHISABOT_UPDATER_DIR`，不用手改。

以后每次一键更新成功，更新服务会用新提交里的 `deploy/updater/` 自动升级自己；可以反复运行 `sudo sh deploy/install-updater.sh`（幂等）。

```sh
docker buildx version                    # 完整构建要用 buildx 插件（Debian/Ubuntu：apt install docker-buildx-plugin）
systemctl is-active chisabot-updater     # active
sh deploy/install-updater.sh --check     # 只检查：已是最新 / 会做什么（不改任何东西）
```

不是 root / 没有 systemd 时 `start.sh` 只提示、照常启动，系统更新页会显示安装命令。自己写的 compose（不是仓库的 `deploy/compose.yaml`）要手动给 `openbot` 服务加：

```yaml
    volumes:
      - /opt/chisabot-updater/spool/requests:/var/lib/chisabot-updater/requests
      - /opt/chisabot-updater/spool/state:/var/lib/chisabot-updater/state:ro
    environment:
      CHISABOT_UPDATER_DIR: /var/lib/chisabot-updater
```

#### 老部署怎么升级到可一键更新

2026-10-13 之前部署的、或当时跳过了这一步的：系统更新页是空的或显示「未安装」，**收不到任何更新**。在服务器上运行一次：

```sh
cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh
```

它安装（或升级）更新服务，把 `PUBLIC_HEALTH_URL` 从示例域名改成 `deploy/.env` 里的真实域名，并用**现在正在运行的镜像**重建一次容器挂上更新目录（不重新构建，断开十几秒）。然后打开 管理后台 → 系统更新 →「检查更新」→「一键完整更新」：第一次是完整构建（老镜像没有记录来源提交，也还没有快速更新的底座），之后都能一键更新。

新提交怎么到服务器：

- 每 30 分钟和点「检查更新」时宿主机直接从 GitHub 拉 `main`：公开仓库匿名拉取，不需要令牌；
- 私有 fork：放 `/opt/chisabot-updater/github-token`（root 600，fine-grained，**只给 Contents: Read**）；不想让宿主机联网就设 `GITHUB_FETCH=off`，发布者推一份到本机镜像：`git push root@<主机>:/opt/chisabot-updater/mirror.git main`。

依赖没变时「更新」只替换代码层（约 2 分钟）；`bun.lock`、各 `package.json`、`Dockerfile`、`docker/` 变了（或第一次安装还没有底座）时页面显示「一键完整更新」：
用仓库 `Dockerfile` 从头构建（限内存，有层缓存，FRA 上约 3–8 分钟），同样先备份、健康检查、失败自动回滚，成功后它就是之后快速更新的底座。
宿主机上手动操作用 `/opt/chisabot-updater/request.sh check | update [--full] | rollback | status`（和页面同一个队列）；演练（备份 + 构建，切换前停下）：`/opt/chisabot-updater/update.sh --job manual-test --target <40 位提交> [--full] --dry-run`。

### 8. 网页与客户端（PC / Android）的更新

- **网页**：无需配置。镜像构建号变了，`/api/version` 返回新 `buildId`，页面顶部出现「有新版本，点此刷新」（从不自动刷新）。
- **客户端安装包由 GitHub Actions 构建**（`.github/workflows/release.yml`）：推 `v*` 标签（或在 Actions 页手动运行并填标签），
  windows-latest 打 PC（`pc/`，Electron：NSIS 安装包 + 免安装 zip + `latest.yml` + `.blockmap`），ubuntu-latest 打 Android
  （`android/`，JDK 17 + Gradle `assembleRelease`），然后创建 / 更新该标签的 GitHub Release 并上传全部文件和
  `chisabot-android.json`（含 sha256）。
- **通用版**（Release 里的）：不内置任何服务器。PC 和 Android 打开后是客户端自带的「登录 ChisaBot」页：服务器地址
  （就是浏览器里打开 ChisaBot 的 `https://<域名>:<端口>`，可以省略 `https://`）+ 账号 + 密码 + 记住登录。地址保存在本机，
  有最近用过的下拉；以后可以改（PC：托盘菜单「切换服务器…」；Android：长按桌面图标 →「切换服务器」）。密码不保存。
  在线更新默认读本仓库 GitHub Releases 的 `latest/download/`（仓库须公开）。
- **自建版**（可选）：在仓库 Settings → Secrets and variables → Actions → Variables 设
  `CHISABOT_SERVER_URL`（预填服务器地址）、`CHISABOT_UPDATE_FEED`（PC 更新目录）、`CHISABOT_ANDROID_UPDATE_FEED`（Android 的 latest.json 地址），
  工作流会多产出 `pc-custom`、`android-custom` 两个工作流产物；把它们放到自己的静态 HTTPS 目录（`Cache-Control: no-cache`），
  **先放安装包 / APK 和 .blockmap，最后放 `latest.yml` / `latest.json`**，并保留上一版安装包（差分下载）。
- **Android 签名**：仓库 Secrets `ANDROID_KEYSTORE_BASE64`（`base64 -w0 release.jks`）、`ANDROID_KEYSTORE_PASSWORD`、
  `ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。生成：`keytool -genkeypair -keystore release.jks -storetype PKCS12 -alias chisabot -keyalg RSA -keysize 4096 -validity 36500`。
  **密钥库丢了就再也不能给已安装的用户推更新**，离线备份；不要提交进仓库。没配 Secrets 时 CI 产出 `-unsigned.apk`。
- 版本号：`pc/package.json` 的 `version` 和 `android/app/build.gradle.kts` 的 `versionName` / `versionCode` 必须同时变大，
  否则客户端认为没有新版本（Android 只比较 `versionCode`；2026-10-12 版本号重置为 0.1.0 时 `versionCode` 从 206 继续，以后只增不减）。

本地打包（不用 CI 时）：

```sh
cd pc && npm ci && npm test
npx electron-builder --win nsis zip --x64 --publish never -c.publish.url=https://<你的更新目录>/   # Windows 本机，或 x86_64 Linux + wine
cd ../android && gradle assembleRelease          # JDK 17 + Android SDK（compileSdk 34）；签名变量同上，ANDROID_KEYSTORE_FILE 指向 .jks
```

发布后核对：

```sh
curl -s https://<更新源>/latest.yml                              # version 是新版本
curl -sL https://<更新源>/ChisaBot-PC-<版本>-x64-setup.exe | openssl dgst -sha512 -binary | base64 -w0   # 必须等于 latest.yml 的 sha512
curl -sL https://<更新源>/ChisaBot-Android-<版本>.apk | sha256sum                                       # 必须等于 latest.json 的 sha256
```

安装包没有代码签名（完整性靠 HTTPS + sha512 / sha256）；PC 只有 NSIS 安装版会自动更新。

### 9. 回滚

- 网页：管理后台 → 系统更新 →「回滚到上一版」（只换镜像，数据库不回退）。
- 宿主机：每次切换都会留下 `/opt/openbot-zh/rollback-to-<旧标签>.sh` 和 `compose.yaml.before-<新标签>`：

```sh
ls -t /opt/openbot-zh/rollback-to-*.sh | head -3
sh /opt/openbot-zh/rollback-to-<旧标签>.sh
```

- 数据：一键更新前的 `pg_dump`、compose、profiles / workspace 卷在 `/opt/chisabot-updater/backups/<时间>-<任务>/`（保留 5 份）。
- 客户端：把更新源里的 `latest.yml` / `latest.json` 换回上一版的（不会降级已升级的客户端，只会停止再升级）。

### 10. 健康检查清单

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'openbot|magpie'   # 都是 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health               # 200
curl -s http://127.0.0.1:3001/api/version                                           # buildId = 当前镜像标签
curl -s -o /dev/null -w '%{http_code}\n' https://<域名>:<端口>/login                 # 200
docker exec openbot-public-gateway nginx -t
systemctl is-active chisabot-updater
git --git-dir=/opt/chisabot-updater/mirror.git log --oneline -1 main               # 系统更新页能看到的最新提交
sh /opt/chisabot-updater/smoke.sh                                                    # "ok":true,"persisted":false
```

更新服务自己的健康检查（`deploy/updater/health.sh`）就是：容器 healthy、20 秒内不重启、本机 `/health` 200、公网登录页 200、`/api/version` 构建号是新的，不通过自动回滚。

### 11. 常见坑

- **把 3001 直接暴露到公网**：后端是 `OPENBOT_SINGLE_USER=true`，谁能访问谁就是管理员。只能经 HTTPS 网关。
- **重置了 `KEY_ENCRYPTION_KEY`**：已保存的模型密钥全部解不开。随数据库备份一起保存。
- **网关还在用模板 `nginx.conf`**（里面是 `chisabot.example.com`），或 `auth/config.json` 的 `publicOrigin` 与实际入口（含端口）不一致：登录后跨站校验失败、Cookie 不共享。改了域名或端口就重跑 `render-nginx.sh`。
- **忘了先构建前端**：`start.sh` 直接报 `Build the frontend first`。
- **镜像层数**：反复在旧镜像上叠层会撞到 127 层上限；一键更新基于压平的底座只加固定层，手动发布也应在压平底座上构建。
- **改了依赖却点一键更新**：会停在「需要完整构建」，这是预期行为，不是故障。
- **系统更新页是空的 / 显示「未安装」/「更新程序是旧版本」**：老部署，运行一次 `cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh`（第 7 步「老部署怎么升级」）。
- **一键更新总是「已自动回滚」、日志里公网检查不是 200**：`/opt/chisabot-updater/config.env` 的 `PUBLIC_HEALTH_URL` 不对（老版本默认是示例域名 `chisabot.example.com`）。填好 `deploy/.env` 的域名后 `sudo sh deploy/install-updater.sh` 会自动改。
- **系统更新页看不到新提交**：仓库私有且宿主机没有令牌时，必须同步 `mirror.git`（第 7 步）。
- **小内存机器构建 OOM**：加 swap，调小 `BUILD_MEMORY`；构建期间更新脚本会暂停 `PROTO_CONTAINERS` 里列出的容器腾内存；客户端安装包交给 GitHub Actions 打，不要在服务器上打。
- **客户端版本号没变**：客户端认为没有新版本；`latest.yml` / `latest.json` 先于安装包上线：客户端会下载失败。
- **Cloudflare 代理**：只能用它支持的端口（443、2053、2083、2087、2096、8443）；更新源和 `latest.yml` 不要被缓存（`no-cache`）。个别用户的本地 DNS 若被污染，表现为自签证书 / 403，属于客户端网络问题。
- **arm64 服务器**：直接在本机 `docker build` 即可；不要把 x86 机器上构建的镜像拿到 arm64 上跑（反之亦然），跨架构用 `docker buildx build --platform`。
- **Magpie 升级**：模板固定已验证的镜像 digest，升级前先备份配置并单独验证；一键更新不管 Magpie 和登录网关，它们按各自文档手动更新。

## 目录

| 路径 | 内容 |
| --- | --- |
| `app/` | 中文 Web 界面 |
| `server/` | API、本地运行、模型配置、BOT 与工具权限 |
| `shared/` | 前后端共享类型与协议 |
| `examples/zh-CN/` | 中文品牌、BOT、频道和技能配置 |
| `deploy/` | 自托管部署与认证网关 |
| `pc/` | ChisaBot PC（Windows，Electron）客户端：设备节点 + 在线更新 |
| `android/` | ChisaBot Android 客户端（Kotlin WebView 外壳，minSdk 24）：本机登录页（服务器地址 + 账号密码）、文件上传下载、APK 在线更新 |
| `.github/workflows/release.yml` | 推 `v*` 标签时用 GitHub Actions 构建 PC + Android 安装包并发布到 Releases |
| `deploy/updater/` | 宿主机在线更新服务（管理后台 → 系统更新） |
| `desktop/`、`mobile/` | 继承上游的桌面和移动客户端源码（未作为 ChisaBot 客户端发布，没有在线更新） |
| `docs/` | 中文使用指南、模型集成与上游技术参考；`docs/images/` 是 README 截图 |
| `assets/brand/` | 品牌头像原图与生成脚本（`python3 assets/brand/generate.py` 生成网页、登录页、PC、Android 的全部图标），规则见 `DESIGN.md` §28 |

上游 Intelligence 与第三方连接器按需使用。桌面和移动源码保留上游的安装、OAuth 和发布集成，分发前需按自己的环境配置并构建。容器发布镜像是 `ghcr.io/chisaalter/chisabot`（组件镜像 `ghcr.io/chisaalter/chisabot-<服务名>`），见 [docs/releasing.md](docs/releasing.md)。生产机仍用 `deploy/` 从 `main` 构建 `local/chisabot`。PC（`pc/`）和 Android（`android/`）客户端的通用安装包在本仓库的 GitHub Releases（CI 构建，首次运行填自己的服务器地址）；也可以自己构建并放到自己的更新源（见上文第 8 步）。

## 来源与许可证

- 上游项目：[CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)
- 交互协议：[AG-UI](https://github.com/ag-ui-protocol/ag-ui)
- 模型网关：[yetone/magpie](https://github.com/yetone/magpie)

代码继续使用 [MIT License](LICENSE)，保留上游 `Copyright (c) 2026 CopilotKit` 及原有许可声明。ChisaBot 是在上游基础上定制的分支。
