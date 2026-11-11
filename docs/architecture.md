# ChisaBot 架构

ChisaBot 采用**DSH 执行内核 + 自有会话服务 + 用户设备节点**。独立 DSH Host 管理模型循环与 Session；账号、机器人、工具权限、审批、任务成果和交付由 ChisaBot 管理。

关键决定都记在 [ADR](adr/README.md) 里，界面规则在 [DESIGN.md](../DESIGN.md)。一页概览见 [overview.md](overview.md)，全部功能见
[features.md](features.md)，全部数据表见 [data-model.md](data-model.md)。本页描述 DSH 与 0067 / reader 4 的当前源码结构；部署版本及运行证据统一见 [实施记录](pipeline-runs/20261108-assistant-production.md)，升级与旧客户端兼容见 [迁移说明](ops/upstream-removal.md)。

## 1. 总览

```
 浏览器 / PWA          ChisaBot (Electron)           ChisaBot Android (WebView)       IM 平台
      │                  │  聊天窗口 = 同一个网页          │ 同一个网页的手机布局        │ QQ/微信/飞书/…
      │                  │  设备节点 WSS ───────┐         │                            │
      ▼                  ▼                      │         ▼                            ▼
 ┌──────────── 公网网关（nginx，TLS，默认 8443）────────────────────────────────────────────┐
 │ 登录 auth_request → 登录服务（Argon2id + 会话）     /api/devices/agent/ 设备令牌直通       │
 │ /p/ 公开页面（无 Cookie，CSP sandbox）              /api/im/onebot/ OneBot 反向 WS          │
 └───────────────────────────┬────────────────────────────────────────────────────────────┘
                             ▼  127.0.0.1:3001
 ┌──────────── ChisaBot 应用容器（chisabot-zh）──────────────────────────────────────────────┐
 │ server（Hono + 自有 Conversation）                  app（React/Vite 构建产物）          │
 │ PostgreSQL（容器内）   agent-computer（Chromium + Xvfb，机器人的云端浏览器 / 工作区）      │
 │ 进程内定时：定时任务 15 s · 面板刷新                                                       │
 └───────────┬─────────────────────────────┬───────────────────────────┬────────────────────┘
             │ http://magpie:3425/v1       │                           │ 只写 spool 请求文件
             ▼                             ▼                           ▼
     Magpie 模型网关（可选）    独立 Node DSH Host           宿主机 chisabot-updater
                               每账号一实例 + Session 卷    构建 → 备份 → 切换 → 健康检查/回滚

```

## 2. 组件

### 2.1 服务器上的 agent（`server/`）

- ChisaBot 的 Conversation 模块接纳命令、保存展示历史并管理业务权限；选择 DSH 时由独立 Node Host 维护模型/工具循环、Session 和压缩（`runtime/dsh/`、`server/src/agents/dsh-runtime.ts`）。模型来自原部署连接（Magpie 或 OpenAI / Anthropic 兼容接口，[models.md](models.md)），Bot 模型覆盖继续生效。
- 回合开头注入的上下文：工作方式提示、记忆（§50）、技能目录（§51）、保险箱用法（§52）、GitHub（§53）、当前北京时间（§55）、
  用户的设备情况（§45）。工具按回合类型给：人的回合全量；IM 回合只给文字类（§49）；面板刷新回合只给面板工具（§43）；
  后台任务（§38）有自己的工具集。
- 产品历史使用 `chisabot_local_threads / chisabot_local_runs / chisabot_local_events`；0067 原地重命名旧表，保留记录与引用。0063 已登记 DSH binding、command、run、工具账本、交互与旧历史导入表。DSH 模型历史在账号 Session 卷中。应用重启先接回仍在工作的 Host，工具回执未知时不自动重做。
- 默认是**云端 agent + 设备节点**；也可以把整件活交给设备上的本地 agent（Claude Code / Codex / OpenCode / 内置循环，
  [ADR-0003](adr/0003-cloud-agent-device-nodes.md)、[ADR-0010](adr/0010-local-agent-handoff.md)，§66）。
- 每轮的权限：确认卡片 + 审批偏好（§58）+ 每个机器人「请求批准 / 完全访问」（§97，`chisabot_bot_permissions`）在服务器端执行；
  付款、被关掉的设备能力、急停永远拦住。

### 2.2 网页（`app/`）

React + TanStack Router + 自有会话客户端与呈现注册表（`app/src/lib/conversations/`）。主动请求统一使用 `/api/conversations`，旧客户端路径集中在服务端兼容入口。一个应用覆盖聊天、设置、管理；网页、PWA、Electron 和 Android 共用前端，Android 使用手机响应式布局；旧原生客户端的 AG-UI 兼容接口继续保留。服务器前端发布后各端通过网页刷新取得更新；本地预览构建不更新线上网页。右侧常驻栏和窄窗口弹出层共享内容与卡片表面，见 [侧栏与弹出面板一致性](sidebar-panel-parity.md)。界面规范见 DESIGN.md（顶部有章节索引）。消息节点、暂停队列、请求期限与数据库故障恢复见[聊天可靠性](chat-reliability.md)。

### 2.3 公网网关与登录（`deploy/public/`）

- nginx（`deploy/public/nginx.conf`）在 TLS 端口上做 `auth_request` 到登录服务（`deploy/public/auth/server.ts`，
  Argon2id + 会话 Cookie，30 天记住登录）；应用只绑 loopback，永不直接对外。
- 例外路由：`/api/devices/agent/`（设备用自己的令牌）、`/api/im/onebot/`（连接自己的 token，允许无 Origin 的 WS 升级）、
  `/p/`（公开页面，GET/HEAD、不转发 Cookie、CSP sandbox，[ADR-0005](adr/0005-pages-sandbox.md)）、带哈希的 `/assets/*` 可缓存。
- **多账号**（[accounts.md](accounts.md)、[ADR-0011](adr/0011-gateway-accounts.md)）：登录服务里有朋友账号和一次性邀请链接；
  每次 `auth_request` 通过后给出签名身份 `X-ChisaBot-Identity`（HMAC + 时间戳），nginx 转给应用，应用据此认人
  （`server/src/auth/gateway-identity.ts`，`CHISABOT_GATEWAY_SECRET`）。直连本机不带转发头的请求仍是管理员。
- 网关和登录服务**不随一键更新**，改了要手动部署（[ops/deploy.md](ops/deploy.md)）。

### 2.4 在线更新（`deploy/updater/`）

宿主机上的 `chisabot-updater`（python3，systemd）读 spool 请求文件队列；应用容器拿不到 docker socket。已有部署使用 [串行发布入口](ops/deploy.md)，更新器从配置的仓库获取版本，按依赖指纹选择代码层更新或根 `Dockerfile` 的完整构建。

前端、核心服务和 DSH 依赖属于同一版本；独立 Host 使用对应运行配置。切换前排空并保留同批数据库、Session、工作文件和配置，先持久保存 reader 要求，随后迁移、启动和检查。失败只恢复到能读当前数据的版本；登录 Cookie 迁移后恢复也必须保留兼容网关。网关与登录服务不在应用镜像里，改动时按 [网关运维](ops/gateway.md) 纳入同次发布。更新器机制见 [在线更新](online-update.md)，备份与恢复见 [DSH 运维](ops/dsh-runtime.md)。

### 2.4.1 会话与工具接口边界

| 入口                                                   | 责任                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `POST /api/conversations/:threadId/commands`           | 接纳带幂等身份的会话命令                             |
| `GET /api/conversations/:threadId/commands/:commandId` | 查询已接纳命令的结果                                 |
| `POST /api/conversations/:threadId/events`             | 订阅对应命令的持久事件与实时输出                     |
| `server/src/agents/dsh-runtime.ts` → `runtime/dsh/`    | 将会话执行连接到账号 DSH Host                        |
| 核心服务的工具网关                                     | 校验账号、机器人、回合与权限，保存工具结果和交付记录 |

当前前端发送新消息走 commands/events；AG-UI 兼容调用、停止与重新接入仍由同一会话边界处理。旧协议映射集中在 `server/src/legacy/protocol.ts`，不作为新增功能的第二套入口。

### 2.5 设备节点（`pc/`、`server/src/devices/`）

- ChisaBot（Electron，Windows 桌面客户端）：一个窗口加载服务器网页 + 一个设备节点。节点主动发起 WSS 连到服务器（经系统代理），
  用每台设备自己的令牌；70 s 静默看门狗，休眠唤醒 / 解锁时重连。
- 设备属于**账号**，不属于某个机器人：用户的每个机器人都能拿到在线设备的 `device_*` 工具
  （[ADR-0002](adr/0002-devices-belong-to-account.md)）。能力分「关闭 / 询问 / 允许」，新设备默认「询问」；命令行、写文件、
  键鼠还要本机再确认；全部写审计，有急停。协议与安全见 [pc-node.md](pc-node.md)。
- 已上线（0.1.8，§62，[ADR-0009](adr/0009-device-full-access.md)）：无界面 Linux / macOS 节点 `chisabot-node`、设备编码工具
  （搜索、按行读、精确替换带 diff 和备份、打补丁、git、后台命令、持久 shell）、按设备的「完全访问」（1h / 24h / 永久）。
  允许的文件夹之外的路径必问，批准即加入（`server/src/devices/roots.ts`）。

### 2.6 Android（`android/`）

Kotlin 壳用全屏 WebView 加载桌面端同一套 React 前端，气泡、卡片、抽屉、输入框和设置都使用网页手机布局，不额外包原生聊天顶栏。原生层保留登录、扫码绑定（§33）、CookieManager、文件/相机选择、下载、麦克风权限、返回键、系统栏与键盘处理，以及 APK 更新。按服务器恢复上次网页路由；旧 Compose 页面保留为兼容代码。用户于 2026-11-08 明确采用此方向，替代 §80、§86 的旧原生主界面方案；细节见 [android-native.md](android-native.md)。手机用于登录聊天，不是机器人的设备节点。APK 更新源是 `latest.json`（GitHub Releases 或自建静态目录）。

### 2.7 云端浏览器（`agent-computer/`）

当前应用容器内，云端计算机服务为每个机器人维护独立 Chromium 持久配置，隔离 Cookie、登录和标签；默认在 Xvfb 里有界面运行。服务进程与 `/workspace` 文件区由该容器内的机器人共享，不是每个机器人一个容器或文件系统。工作区文件通过虚拟源
`https://workspace.local/` 给浏览器看。用户可以在右栏「计算机」接管 / 交还（§23、§39）。真标签最多 8 个、人和机器人同一组，
每账号一份收藏夹（§95、§96，[browser-tabs.md](browser-tabs.md)）。

机器人的 shell（`computer_run_command`）也在这个容器里：以 `pwuser` 运行，每条命令的 `HOME` 是 `/workspace`（`agent-computer/src/shell.ts`），
所以 `~` 写的就是工作区。三处安装位置都在工作区卷里、都归 `pwuser`：npm 的全局前缀 `/workspace/.npm-global`（`Dockerfile` 的
`npm config set prefix`）、bun 的 `$HOME/.bun`、`pip install --user` 的 `.local`。**`PATH` 由 `shell.ts` 拼**，不靠镜像里的
`ENV PATH`：那条 `ENV` 到不了运行中的容器（s6-overlay 启动时重建 `PATH`，镜像与容器的 `Config.Env` 里都没有它），所以
`environmentForCommand` 把这三个 `bin` 目录**追加**在部署给的 `PATH` 之后——不前置，装的包不会遮蔽镜像自己的 `node` / `bun`。
少了这一步，机器人 `npm i -g` 成功、下一条命令 `command not found`，它就把装好了读成装失败（2026-10-19 在测试机上实测）。
此前前缀还是 root 拥有的 `/usr/local`，机器人每次 `npm i -g` 都在一两秒内 EACCES 失败。

## 3. 功能 → 代码 → 数据

业务表沿 `server/drizzle/` 登记版本化变更，部分模块保留幂等初始化。回滚必须检查产品reader，不能仅因新增表或列可被忽略就使用旧镜像。每张表的用途见 [data-model.md](data-model.md)。

| 功能                                                             | DESIGN                   | 文档                                                                   | 代码                                                                                                                                                                                    | 数据                                                                                                     |
| ---------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 聊天、流式、富卡片                                               | §24–§27、§30–§32、§35    | [streaming.md](streaming.md)                                           | `app/src/lib/conversations/`、`server/src/conversation-runtime.ts`、`server/src/agents/`                                                                                                | `chisabot_local_threads/_runs/_events`                                                                   |
| 聊天截图缩略图                                                   | §27                      | —                                                                      | `server/src/chat-shots.ts`                                                                                                                                                              | `chisabot_chat_shots`                                                                                    |
| 回答中发消息 · 后台任务                                          | §38                      | —                                                                      | `server/src/thread-inbox.ts`、`server/src/workers/`                                                                                                                                     | `chisabot_thread_inbox`、`chisabot_workers`                                                              |
| 全端同步 · 历史对话                                              | §42                      | —                                                                      | `server/src/bot-threads.ts`                                                                                                                                                             | `chisabot_bot_threads`                                                                                   |
| 只有一套聊天（`/bot` → 频道聊天跳转、open-thread、上传进工作区） | §68 · ADR-0013           | [streaming.md](streaming.md)                                           | `app/src/routes/_authed/_app/bot.tsx`、`app/src/lib/channels/open-thread.ts`、`server/src/channels/routes.ts`（`/api/channels/open-thread`）、`server/src/chat-files/channel-mirror.ts` | `chisabot_channel_mappings`、`channel_agents`、`chisabot_chat_files`                                     |
| 实时面板                                                         | §29、§43、§77            | —                                                                      | `server/src/live-panels/`                                                                                                                                                               | `live_panels`（迁移 0056/0057）                                                                          |
| 浏览器多标签 · 收藏夹                                            | §95、§96                 | [browser-tabs.md](browser-tabs.md)                                     | `agent-computer/src/tabs.ts`、`server/src/browser-bookmarks/`                                                                                                                           | `chisabot_browser_bookmarks`、`chisabot_browser_bookmark_seeds`                                          |
| 重新生成 / 编辑后重发                                            | §67                      | —                                                                      | `server/src/thread-truncate.ts`                                                                                                                                                         | `chisabot_thread_truncations`                                                                            |
| 图片宽高预留                                                     | §83.2                    | —                                                                      | `server/src/image-dims/`                                                                                                                                                                | `chisabot_image_dims`                                                                                    |
| 链接卡                                                           | §48                      | —                                                                      | `server/src/link-preview/`、`app/src/lib/rich-previews/`                                                                                                                                | `chisabot_link_previews`、`chisabot_link_preview_assets`                                                 |
| 设备 / PC 节点 · 扫码绑定                                        | §16、§33、§45            | [pc-node.md](pc-node.md)                                               | `server/src/devices/`、`pc/`                                                                                                                                                            | `devices`、`device_audit_events`（迁移 0054；`device_bot_access` 已不用）                                |
| 新建机器人 · 资料页                                              | §46、§47、§81            | [coworkers.md](coworkers.md)                                           | `server/src/agents/`                                                                                                                                                                    | `agents` 表（迁移 0058 一律私有）                                                                        |
| 机器人头像                                                       | §81                      | [bot-avatars.md](bot-avatars.md)                                       | `server/src/bot-avatars/`                                                                                                                                                               | `chisabot_bot_avatars`                                                                                   |
| 确认卡片 · 权限与审批 · 每个机器人的权限                         | §58、§97                 | [confirmations.md](confirmations.md)、[settings-ia.md](settings-ia.md) | `server/src/confirmations/`                                                                                                                                                             | `chisabot_confirm_prefs/_rules/_requests`、`chisabot_bot_permissions`                                    |
| 设备编码工具 · 完全访问 · 无界面节点                             | §62                      | [pc-node.md](pc-node.md)                                               | `server/src/devices/tools.ts`、`roots.ts`、`node-install.ts`                                                                                                                            | `devices.full_access_until`                                                                              |
| 本地 agent                                                       | §66 · ADR-0010           | [local-agents.md](local-agents.md)                                     | `server/src/local-agents/`、`pc/src/agent-runtime/`                                                                                                                                     | `chisabot_device_agent_settings`、`chisabot_local_agent_tasks`                                           |
| Android 同源网页客户端                                           | §80 当前方向；§86 旧实现 | [android-native.md](android-native.md)                                 | `android/`、`app/`                                                                                                                                                                      | —                                                                                                        |
| 设置分组 · 设置搜索                                              | §97                      | [settings-ia.md](settings-ia.md)                                       | `app/src/lib/settings/registry.ts`                                                                                                                                                      | —                                                                                                        |
| IM 接入与持久交付                                                | §49；DSH §13             | [im.md](im.md)                                                         | `server/src/im/`、`shared/im.ts`                                                                                                                                                        | `chisabot_im_connections/_chats/_logs`、0064 `_inbox/_outbox`；正文与平台回执独立于模型执行保存          |
| 长期记忆                                                         | §50                      | [memory.md](memory.md)                                                 | `server/src/memory-notes/`                                                                                                                                                              | `chisabot_memory_notes`、`chisabot_memory_bots`                                                          |
| 技能                                                             | §51                      | [skills.md](skills.md)                                                 | `server/src/skills-chisa/`                                                                                                                                                              | `skills` 表                                                                                              |
| 密钥保险箱                                                       | §52                      | [vault.md](vault.md)                                                   | `server/src/vault/`                                                                                                                                                                     | `chisabot_vault_secrets`、`chisabot_vault_requests`                                                      |
| GitHub 连接                                                      | §53                      | [github.md](github.md)                                                 | `server/src/github/`                                                                                                                                                                    | `chisabot_github_connections`、`chisabot_github_actions`（令牌在保险箱 `github`）                        |
| 页面                                                             | §54                      | [pages.md](pages.md)                                                   | `server/src/pages/`                                                                                                                                                                     | `chisabot_pages/_page_versions/_page_assets/_page_origins`                                               |
| 定时任务与提醒                                                   | §55                      | [schedules.md](schedules.md)                                           | `server/src/schedules/`                                                                                                                                                                 | `chisabot_schedules`、`chisabot_schedule_runs`                                                           |
| 聊天文件与生图 · 识图                                            | §56、§59                 | [chat-files.md](chat-files.md)                                         | `server/src/chat-files/`                                                                                                                                                                | `chisabot_chat_files`、`chisabot_image_settings`、`chisabot_media_models`、`chisabot_image_descriptions` |
| 备用模型                                                         | §60、§61                 | [models.md](models.md)                                                 | `server/src/agents/model-fallback.ts`                                                                                                                                                   | `enterprise_settings`（`model_fallbacks`）                                                               |
| 工作流（默认隐藏）                                               | §26、§74                 | [workflows.md](workflows.md)                                           | `server/src/workflows/`                                                                                                                                                                 | `workflows`、`workflow_runs`、`workflow_run_events`（迁移 0055）                                         |
| 在线更新 · 自检                                                  | §22                      | [online-update.md](online-update.md)、[admin-smoke.md](admin-smoke.md) | `server/src/system-update.ts`、`deploy/updater/`                                                                                                                                        | 宿主机 spool                                                                                             |
| 手机网页 · PWA                                                   | §40                      | [pwa.md](pwa.md)                                                       | `app/public/sw.js`、`app/src/lib/device.ts`                                                                                                                                             | —                                                                                                        |
| 朋友账号（多账号，默认隐藏）                                     | §65                      | [accounts.md](accounts.md)                                             | `deploy/public/auth/server.ts`、`server/src/auth/gateway-identity.ts`、`app/src/routes/_authed/admin/accounts.tsx`                                                                      | 网关 SQLite `accounts`、`invites`、`sessions.user_id`；应用 `users` / `user_roles` 自动建行              |
| 导航 · 瘦身                                                      | §57                      | [slimming.md](slimming.md)                                             | `server/src/package-orphans.ts`                                                                                                                                                         | 只删孤儿行                                                                                               |

## 4. 运行时开关（常用）

以下是环境变量的仓库默认值或可选开关；生产实际值取决于部署配置。完整列表见 [configuration.md](configuration.md) 和各功能文档。

| 变量                                                                                           | 作用                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CHISABOT_EXTRAS`                                                                              | 默认空；`workflows,plugins,boundaries,components` 或 `all` 重新打开被精简隐藏的功能（§74）                 |
| `CHISABOT_ACCOUNTS_UI=1`                                                                       | 显示 设置 → 账号（朋友账号）；网关 `config.json` 的 `"invites": true` 才能发新邀请                         |
| `CHISABOT_GATEWAY_SECRET` / `_FILE`                                                            | 多账号：与登录服务 `identitySecret` 相同的密钥（≥32 字符），启用网关签名身份（[accounts.md](accounts.md)） |
| `CHISABOT_SCHEDULES_SWEEP=0`                                                                   | 关掉定时任务扫描                                                                                           |
| `CHISABOT_IM=0`                                                                                | 开机不启动 IM 连接                                                                                         |
| `CHISABOT_RELEASE_LOCKS_ON_START=0`                                                            | 不在启动时释放孤儿线程锁（多进程共用一个库时）                                                             |
| `CHISABOT_ORPHAN_SWEEP=0` / `CHISABOT_WORKER_ORPHAN_SWEEP=0` / `CHISABOT_PANEL_ORPHAN_SWEEP=0` | 关掉对应的开机孤儿清理                                                                                     |
| `CHISABOT_DEVICE_ASK_DEFAULTS=0`                                                               | 不把从没改过的「全部关闭」设备改成「询问」                                                                 |
| `COMPUTER_BROWSER_MODE=headless`                                                               | 云端浏览器回到无界面模式                                                                                   |
| `CHISABOT_MAX_OUTPUT_TOKENS`                                                                   | 单次输出上限（默认按模型目录，封顶 32000）                                                                 |
| `CHISABOT_GITHUB_API_BASE`                                                                     | GitHub Enterprise 或测试替身                                                                               |
| `CHISABOT_LINK_PREVIEW_SHOTS=1`                                                                | 没有 og:image 时截图做链接卡缩略图                                                                         |
