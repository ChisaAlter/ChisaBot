# 给 AI 代理的 ChisaBot 安装与端到端验收指南

目标：面向自动化部署代理（Coding Agent / Ops Agent），一次性完成 ChisaBot 自托管服务端部署、模型与工具链初始化、多端客户端接入，以及端到端闭环验收。

---

## 1. 开始前一次性询问清单

动手前一次向用户确认以下信息，避免反复中断：

1. **部署位置与工作目录**：本机还是远程 Linux 服务器（若是远程，提供 SSH 主机、端口、用户名、密钥路径及源码目录，如 `/opt/chisabot`）。
2. **访问方式**：
   - 仅本机 / SSH 隧道（默认 `127.0.0.1:3001`，最安全）；
   - 公网 HTTPS 域名（需准备域名、TLS 证书目录，配套 `deploy/public/` 登录网关）；
   - 局域网或 Tailscale 私网访问（需配置 `TRUSTED_ORIGINS`）。
3. **默认模型连接**：协议类型（`openai` 兼容或 `anthropic`）、接口 Base URL、API Key 与默认模型 ID（`BOT_MODEL`）；是否同时部署内嵌 Magpie 多模型网关（`deploy/magpie.compose.yaml`）。
4. **可选能力**：是否需要开启外部联网搜索（Tavily / Brave / Serper / 博查 / Exa）、语音服务（ASR / TTS）、入站 Webhook、PC 桌面端或 Android 原生客户端。
5. **是否为存量升级**：若目标机器已有 `chisabot-zh` 容器或旧卷，严禁重建数据卷或覆盖 `KEY_ENCRYPTION_KEY`。

---

## 2. 宿主机前置检查与资源约束

在目标机器检查架构、内存、磁盘与工具链：

- **必需工具**：Docker Engine、Docker Compose v2、Bun `1.3.14`；宿主机直跑 DSH 内核时需 Node.js `>= 24.9`。
- **磁盘空间**：首次完整镜像构建与 PostgreSQL 数据卷需要充足空间，确认宿主承载卷有足够余量，避免在构建前清理用户真实数据卷。
- **复用已有环境**：已有部署保留原 `deploy/.env`、数据卷与 `KEY_ENCRYPTION_KEY`；更新前先备份数据库与 `.env`。

| 资产 / 目录 | 作用 | 持久化卷 / 产出 |
| --- | --- | --- |
| `Dockerfile` (`target: chisabot`) | 完整构建前端、服务端、DSH 内核与工具依赖 | `local/chisabot:latest`（或 `CHISABOT_IMAGE`） |
| `deploy/compose.yaml` | 主应用 + 内嵌 PostgreSQL（含 pgvector）+ DSH 运行时 | `chisabot-zh_database` / `_workspace` / `_profiles` / `_dsh` |
| `deploy/magpie.compose.yaml` | 可选多模型聚合网关（仅绑定 loopback） | `deploy/magpie-data`、`deploy/private/magpie.env` |
| `deploy/public/` | 可选公网 HTTPS 登录网关与多账号鉴权 | 渲染后的 `nginx.generated.conf` |
| `pc/` | Electron 桌面客户端 + 本机设备节点 | 安装包与本机 `%APPDATA%/ChisaBot/config.json` |
| `android/` | Kotlin 原生 Android 客户端 | APK + 扫码设备配对 |

---

## 3. 部署服务端

### 3.1 推荐快捷新装（好友自托管模板）

新装可直接运行仓库根目录的安全模板脚本，会自动生成随机密钥并拒绝将单用户后端端口暴露到公网：

```sh
sh deploy/friend-up.sh
```

### 3.2 标准自定义部署（`deploy/compose.yaml`）

在仓库根目录执行：

```sh
bun install --frozen-lockfile --omit=peer
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

为首次安装的 `KEY_ENCRYPTION_KEY` 生成 32 字节 Base64 随机加密密钥（不回显到终端；**存量部署切勿覆盖**）：

```sh
bun -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
let text = fs.readFileSync("deploy/.env", "utf8");
text = text.replace(/^KEY_ENCRYPTION_KEY=\s*$/m, "KEY_ENCRYPTION_KEY=" + crypto.randomBytes(32).toString("base64"));
fs.writeFileSync("deploy/.env", text, { mode: 0o600 });
'
```

按用户回答编辑 `deploy/.env` 中的关键环境变量：

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `CHISABOT_RUNTIME_MODE` | 会话运行模式 | `local` |
| `CHISABOT_AGENT_KERNEL` | 执行内核 | `dsh` |
| `KEY_ENCRYPTION_KEY` | AES-256-GCM 凭据封存主密钥（32B base64） | 启动前生成，随库备份 |
| `BOT_PROVIDER` | 默认模型协议（`openai` / `anthropic`） | `openai` |
| `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | 模型接口地址 | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 初始模型密钥（亦可留空后在管理台保存） | — |
| `BOT_MODEL` | 默认聊天模型 ID | `your-model-id` |
| `TRUSTED_ORIGINS` | 允许访问的浏览器源（逗号分隔） | `http://localhost:3001,http://127.0.0.1:3001` |
| `CHISABOT_DOMAIN` / `CHISABOT_HTTPS_PORT` | 公网 HTTPS 网关域名与端口（可选） | `chisabot.example.com` / `8443` |

启动构建与容器（`start.sh` 会先通过 `pin-resources.sh` 固定卷名与网络，再检查 Compose 配置并启动）：

```sh
sh deploy/start.sh
```

若不需要安装宿主机在线更新器 `chisabot-updater`，可传 `CHISABOT_UPDATER=off sh deploy/start.sh`。

> **安全边界**：`deploy/compose.yaml` 默认仅将主服务绑定至 `127.0.0.1:3001`。对外网开放时必须经由 `deploy/public/` HTTPS 登录网关反代，严禁将单用户模式后端直接暴露至 `0.0.0.0`。

---

## 4. 通过 API 或管理台完成初始化

主服务就绪后（可通过网页 `/admin/models` 操作，或使用已鉴权会话调用以下真实 API）：

| 用途 | 方法与路径 | 说明 |
| --- | --- | --- |
| 存活探针 | `GET /health` | 预期返回 `{"status":"ok"}` |
| 版本与构建信息 | `GET /api/version` | 核对运行版本、提交号与 `gatewayIdentity` |
| 部署能力探测 | `GET /api/capabilities` | 核对运行模式、生成式 UI 与鉴权提供方 |
| 综合健康检查 | `GET /api/admin/health` | 核对数据库连通性、DSH 内核、Magpie 与电脑节点状态 |
| 读取/保存模型配置 | `GET` / `PUT /api/admin/model-settings` | 配置主模型接口、协议、API Key 与备选 Key 池 |
| 测试模型连接 | `POST /api/admin/model-settings/test` | 不保存草稿直接验证模型连通性与延迟 |
| 按模型上下文覆写 | `GET` / `PUT` / `DELETE /api/admin/context-policies` | 支持 `1M` / `400K` / `128000` 覆写上下文窗口与摘要阈值 |
| 联网搜索配置与试搜 | `GET` / `PUT /api/web-search/settings`、`POST /api/web-search/test` | 配置 Tavily / Brave / Serper / 博查 / Exa / 自定义源与按模型覆写 |
| 语音服务配置与试听 | `GET` / `PUT /api/speech/settings`、`POST /api/speech/test-asr`、`POST /api/speech/test-tts` | 配置 OpenAI 兼容或 Fish Audio 语音能力 |
| 管理员端到端自检 | `POST /api/admin/smoke` | 发起一次真实模型往返冒烟测试 |
| 入站 Webhook 面板 | `GET` / `POST /api/webhooks`、`GET /api/webhooks/runs` | 管理 5 厂商签名族规则与 7 态执行流水 |
| Bot 常驻参考资料库 | `GET` / `POST` / `DELETE /api/bots/:agentId/library` | 上传 ≤20 MB 文档并由 `chat_file_search` 按需检索 |

> 若开启登录网关，所有 `/api/*` 写操作需携带有效登录 Cookie 与同源 `Origin` 请求头；返回密钥的接口均标记 `Cache-Control: no-store`。

---

## 5. 客户端接入（PC 桌面端与 Android）

1. **PC 桌面端（`pc/`）**：
   - 安装并启动 ChisaBot 桌面客户端，输入服务器 HTTPS 地址完成账号登录与自动设备登记（设备令牌经系统 DPAPI / Keychain 加密落盘）。
   - 支持在「设备 → 本机设置」中配置硬件加速开关（重启生效）、拼写检查、显式 IANA 时区覆盖，以及渲染进程出口域名白名单（默认仅放行已配服务器同源与 loopback）。
   - 支持 `chisabot://agent/<agentId>` 与 `chisabot://channel/<channelId>` 系统深链直达。
2. **Android 客户端（`android/`）**：
   - 在网页或 PC 端「设置 → 设备 → 添加一台手机」生成 192-bit 一次性配对码（5 分钟有效），使用 Android 客户端扫码配对。

---

## 6. 端到端闭环验收剧本

部署完成后按以下顺序逐项验收，并向用户如实汇报每一项实测结果：

1. **容器与端口健康**：
   ```sh
   docker compose --env-file deploy/.env -p chisabot-zh -f deploy/compose.yaml ps
   curl -fsS http://127.0.0.1:3001/health
   curl -fsS http://127.0.0.1:3001/api/version
   ```
2. **管理员健康与模型往返**：
   - 调用 `GET /api/admin/health`，确认数据库与执行内核在线；
   - 在 `/admin/models` 点击「测试连接」或调用 `POST /api/admin/model-settings/test` 与 `POST /api/admin/smoke`，确认模型真实返回。
3. **联网搜索与上下文策略**：
   - 在 `/admin/models` 底部「联网搜索」输入关键词执行「在线试搜」，确认返回结果与耗时；
   - 如使用自定义网关模型，在「上下文容量与摘要阈值」配置覆写并确认列表生效。
4. **首条真实对话与常驻资料库**：
   - 进入任意 Bot 资料页上传一份小型 `.md` / `.txt` 文档到「常驻参考资料库」，确认建立索引块；
   - 在聊天窗口向该 Bot 提问文档中的细节，确认回复准确并能正常流式输出。
5. **交付运维命令**：
   - 向用户交付访问地址、源码目录、`deploy/.env` 位置、实际卷名与以下日常维护命令：
   ```sh
   # 查看日志
   docker compose --env-file deploy/.env -p chisabot-zh -f deploy/compose.yaml logs -f --tail=100
   # 平滑重启
   docker compose --env-file deploy/.env -p chisabot-zh -f deploy/compose.yaml restart
   # 备份数据库（保留 KEY_ENCRYPTION_KEY 与 deploy/.env，切勿删卷）
   docker exec chisabot-zh pg_dump -U postgres chisabot > chisabot-backup-$(date +%Y%m%d).sql
   ```
