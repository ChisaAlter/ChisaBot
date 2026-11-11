# 环境变量与配置参考

本页汇总 ChisaBot 现役核心环境变量与中文租户包规则。本地开发示例见仓库根 [`.env.example`](../.env.example)，Linux 容器部署模板见 [`deploy/.env.example`](../deploy/.env.example) 与 [`deploy/friend.env.example`](../deploy/friend.env.example)。

---

## 1. 数据库、运行模式与密钥保险箱

| 变量                          | 默认 / 示例                                            | 说明                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `postgres://chisabot:chisabot@localhost:5432/chisabot` | PostgreSQL 连接串。容器内部署由内置 PostgreSQL 服务自动注入，本地开发指向宿主机数据库。                                                                                    |
| `CHISABOT_RUNTIME_MODE`       | `local`                                                | 现役唯一运行模式，所有会话、记忆与业务账本保存在你自己的 PostgreSQL 中。                                                                                                   |
| `KEY_ENCRYPTION_KEY`          | 必填（32 字节 Base64）                                 | 加密库内模型密钥、IM 凭据与保险箱密文的对称主密钥（`openssl rand -base64 32`）。生产环境检测到 `.env.example` 的公开示例值会拒绝启动；升级时严禁重置，须与数据库一同备份。 |
| `AUDIT_RETENTION_DAYS`        | 不设置（永久保留）                                     | 审计日志（`audit_events`）保留天数；审计表仅追加写入。                                                                                                                     |
| `SL_ENABLED` / `DO_NOT_TRACK` | `false` / `1`                                          | 保持外部遥测关闭。                                                                                                                                                         |

---

## 2. 服务端口与租户包（`examples/zh-CN`）

| 变量                   | 默认 / 示例          | 说明                                                                               |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `PORT` / `SERVER_PORT` | `3001`               | API 服务端监听端口。两者同时设置时必须一致；前端 Vite 开发代理读取 `SERVER_PORT`。 |
| `TENANT_PACKAGE_DIR`   | `../examples/zh-CN`  | 租户包目录（相对 `server/` 或绝对路径）。前后端构建与运行应指向同一目录。          |
| `DEPLOYMENT_ID`        | 取租户包 `tenant.id` | 部署实例命名空间（默认 `chisabot`，容器模板常用 `chisabot-zh`）。                  |

### 租户包文件与主题规则（`examples/zh-CN/`）

- `brand.yaml`：配置产品展示名称（`product_name: ChisaBot`）、`tenant.id`（保留 `chisabot` 兼容存量数据）以及主色调/界面主题参数。字标与自定义名称也可在登录后左上角按用户调整。
- `agents.yaml` / `channels.yaml`：初始系统机器人与频道列表，默认为空；新用户首次进入时会自动获得私有的「助手」，其余机器人在界面按需新建。
- `skills.yaml` / `knowledge.yaml`：随部署下发的共享技能（如公开信息研究、核实说法）与基础参考知识；从 YAML 中移除的包级技能会在下次启动时自动卸载，不影响用户在界面自建的技能。
- `model.yaml`：首次启动的示例模型占位配置；真实协议、API 地址、密钥与默认/备用模型在「设置 → 模型」中持久化保存。
- **切勿**将真实 API 密钥、密码或私人服务器域名写入租户包目录。

---

## 3. DSH 执行内核与会话控制

详见 [DSH 运行时与恢复](ops/dsh-runtime.md)。

| 变量                                                 | 默认 / 示例                                    | 说明                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHISABOT_AGENT_KERNEL`                              | `dsh`                                          | 现役唯一内置执行内核（独立 Node.js Host 进程执行模型/工具循环，PostgreSQL 持久化命令与投影）。本地开发首次运行前须执行 `npm ci --prefix runtime/dsh`。 |
| `CHISABOT_DSH_ROOT`                                  | `.data/dsh`                                    | DSH Session 源日志与运行状态持久化根目录（容器内挂载独立持久卷）。                                                                                     |
| `CHISABOT_DSH_TARGETS_FILE`                          | 可选                                           | 多账号生产环境按账号隔离独立 Host 时的路由映射 JSON 文件路径。                                                                                         |
| `CHISABOT_DSH_TOOL_GATEWAY_URL`                      | `http://127.0.0.1:3001/api/internal/dsh-tools` | DSH Host 回调主服务执行产品工具、权限检查与确认卡的内部网关地址。                                                                                      |
| `AGENT_STALL_TIMEOUT_MS`                             | `60000`                                        | 单轮流式输出静默看门狗（毫秒）。衡量两次事件之间的无输出间隔而非总耗时；超时自动收束本轮并记审计日志，`0` 表示关闭。                                   |
| `BOT_HANDOFF_MAX_DEPTH` / `BOT_HANDOFF_MAX_PER_RUN`  | `0` / `3`                                      | 跨机器人接力最大深度（默认 `0` 关闭）与单轮最多呼叫机器人数。                                                                                          |
| `BOT_FACTORY_MAX_DEPTH` / `BOT_FACTORY_MAX_PER_USER` | `1` / `20`                                     | 机器人创建子机器人的最大深度与单用户上限（设为 `0` 关闭）。                                                                                            |
| `MANAGED_AGENT_AG_UI_URL` / `MANAGED_AGENT_TOKEN`    | 可选                                           | 接入外部自定义 AG-UI 机器人的端点与共享鉴权密钥。                                                                                                      |
| `AGENT_TOOL_TOKEN`                                   | 可选                                           | 外部自定义机器人回调服务端受控工具时出示的鉴权密钥。                                                                                                   |

---

## 4. 模型、Magpie 网关与语音听写

详见 [模型配置与切换](models.md) 与 [Magpie 深度集成](magpie.md)。网页端「设置 → 模型」保存的配置优先于环境变量初始值。

| 变量                                                                                                  | 说明                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_PROVIDER` / `BOT_MODEL`                                                                          | 初始默认模型提供商（`openai`、`anthropic`、`google`）与模型 ID（如 `gpt-5.5`）。                                                                                 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`                                                                  | OpenAI 或任意兼容 `/v1/chat/completions` 接口（含自部署 Magpie、Ollama 等）的密钥与基础地址；容器需走内部路由时可另设 `OPENAI_CONTAINER_BASE_URL`。              |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`                                                            | Anthropic 原生接口密钥与自定义地址；亦可配置 `CLAUDE_CODE_OAUTH_TOKEN`。                                                                                         |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_BASE_URL`                                                    | Google Gemini 接口密钥与自定义地址。                                                                                                                             |
| `CHISABOT_MODEL_FALLBACKS`                                                                            | 逗号分隔的备用模型列表（设为 `off` 关闭自动降级；网页端设置的备用模型列表优先）。                                                                                |
| `BOT_RESPONSES_API` / `BOT_REASONING_EFFORT`                                                          | 显式开启 OpenAI Responses API（`true`/`false`）与推理强度（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。                                              |
| `MAGPIE_ADMIN_URL` / `MAGPIE_WEB_KEY_FILE`                                                            | 内嵌 Magpie 管理控制台的服务端内网地址（如 `http://magpie:3430`）与只读 Web key 文件路径；`MODEL_CATALOG_REFRESH_MINUTES`（默认 `10`）控制模型目录自动同步间隔。 |
| `TRANSCRIPTION_PROVIDER` / `TRANSCRIPTION_BASE_URL` / `TRANSCRIPTION_MODEL` / `TRANSCRIPTION_API_KEY` | 输入框语音听写服务（`openai-compatible`，调用 `POST /audio/transcriptions`，独立于聊天模型配置）。                                                               |

---

## 5. 信任边界与认证网关

详见 [安全信任边界](ops/trust-boundary.md)、[网关与登录服务](ops/gateway.md) 与 [朋友账号](accounts.md)。

| 变量                                                              | 说明                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHISABOT_SINGLE_USER`                                            | `true` 时启用免内建 OAuth 的单用户模式。**安全红线**：仅允许配合回环 `TRUSTED_ORIGINS`（`localhost` / `127.0.0.1`）或前置 HTTPS 登录网关使用，严禁将 `:3001` 直接暴露公网。 |
| `TRUSTED_ORIGINS`                                                 | 逗号分隔的可信前端来源（本地开发为 `http://localhost:3010`，网关回环转发为 `http://localhost:3001,http://127.0.0.1:3001`）。                                                |
| `CHISABOT_GATEWAY_SECRET`                                         | 与前置认证网关 `auth/config.json` 中 `identitySecret` 一致的共享签名密钥（≥32 字符）。启用后，本机运维脚本/更新器访问本机管理接口须携带 `X-ChisaBot-Local-Caller` 头。      |
| `CHISABOT_ACCOUNTS_UI`                                            | 设为 `1` 在「设置 → 账号与连接」显示多用户「账号」管理入口（默认关闭）。                                                                                                    |
| `CHISABOT_SECURE_COOKIES`                                         | 设为 `1` 强制会话 Cookie 启用 `Secure`（当 `CHISABOT_PUBLIC_URL` 为 `https://` 时自动开启）。                                                                               |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` / `INITIAL_ADMIN_EMAILS` | 不使用前置登录网关而直接启用 Google / Microsoft / Okta OAuth 时的回调根地址、会话签名密钥（≥32 字符）与管理员邮箱列表；可配合 `SIGNIN_ALLOWED_EMAIL_DOMAINS` 限制邮箱域名。 |

---

## 6. 云端浏览器与受控计算机（`agent-computer`）

| 变量                                                 | 默认 / 说明                                                                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL` / `COMPUTER_TOKEN`              | `agent-computer` 服务地址（如 `http://localhost:4100`，留空则关闭计算机功能）及调用鉴权密钥。                                                                                                 |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`                 | **仅限本机开发调试**（设为 `true` 允许访问本机私有地址；`.env.example` 中默认注释，`NODE_ENV=production` 下开启会拒绝启动）。生产内网 Agent 请改用精确白名单 `AGENT_ENDPOINT_ALLOWED_HOSTS`。 |
| `AGENT_COMPUTER_POLICY`                              | 计算机工具动作策略 JSON（`mode: "enforce" \| "dry-run"`，`deny` 优先于 `allow`，格式非法时拒绝启动）。                                                                                        |
| `COMPUTER_BROWSER_BACKEND` / `COMPUTER_BROWSER_MODE` | 浏览器后端（`managed` 容器 Chromium 或 `local-chrome`）与显示模式（Linux 带 Xvfb 默认为 `headed` 以减少站点拦截，可设 `headless`）。                                                          |
| `PROFILES_DIR` / `COMPUTER_RUNTIME`                  | 浏览器登录态持久目录（容器内 `/profiles`）与可选容器运行时（如 `runsc`）。                                                                                                                    |

---

## 7. 功能扩展与后台任务开关

| 变量                                                                      | 默认           | 说明                                                                                                                                                         |
| ------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHISABOT_EXTRAS`                                                         | 空（默认隐藏） | 逗号分隔开启高级扩展模块：`workflows`（工作流）、`plugins`（外部插件与 MCP）、`boundaries`（CEL 权限边界）、`components`（UI 组件目录），或 `all` 全部开启。 |
| `CHISABOT_GENERATIVE_UI`                                                  | `true`         | 是否允许机器人通过受控 Skyglass 组件目录渲染 `render_ui` 卡片（设 `false` 关闭）。                                                                           |
| `CHISABOT_PANEL_COMMANDS`                                                 | `0`（关）      | 设为 `1` 允许管理员为实时面板配置服务端本机命令数据源（见 [面板直连数据源](live-panel-sources.md)）。                                                        |
| `CHISABOT_IM` / `CHISABOT_SCHEDULES_SWEEP` / `CHISABOT_LIVE_PANEL_SWEEP`  | `1`（开）      | 设为 `0` 可分别停用 IM 连接收发、定时任务扫描或实时面板定时刷新（常用于隔离预览环境）。                                                                      |
| `COMPOSIO_API_KEY`                                                        | 空             | 可选：填入后在插件页启用 Composio 托管第三方应用连接器。                                                                                                     |
| `CHISABOT_INBOUND_EMAIL_DOMAIN` / `CHISABOT_INBOUND_EMAIL_SNS_TOPIC_ARNS` | 空             | 可选：Amazon SES + SNS 入站邮件触发器域名与允许的 SNS Topic ARN。                                                                                            |
