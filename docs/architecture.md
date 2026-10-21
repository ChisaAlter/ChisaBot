# ChisaBot 架构

ChisaBot 是 CopilotKit/OpenBot 的中文私人助手分支：**一个云端服务器上的机器人（agent）+ 用户的设备作为节点**。这一页讲
ChisaBot 现在实际在跑的结构；上游 OpenBot 的原始架构（Intelligence、AG-UI Bot 框架、supervisor、SPIRE 等）见
[openbot-architecture.md](openbot-architecture.md)，其中很多部分正在瘦身（[slimming.md](slimming.md)）。

关键决定都记在 [ADR](adr/README.md) 里，界面规则在 [DESIGN.md](../DESIGN.md)。一页概览见 [overview.md](overview.md)，全部功能见
[features.md](features.md)，全部数据表见 [data-model.md](data-model.md)。本页截至 main `0e23321`（2026-10-17）。

## 1. 总览

```
 浏览器 / PWA          ChisaBot PC (Electron)        ChisaBot Android (原生 Compose)  IM 平台
      │                  │  聊天窗口 = 同一个网页          │ 原生聊天 + 网页兜底          │ QQ/微信/飞书/…
      │                  │  设备节点 WSS ───────┐         │                            │
      ▼                  ▼                      │         ▼                            ▼
 ┌──────────── 公网网关（nginx，TLS，默认 8443）────────────────────────────────────────────┐
 │ 登录 auth_request → 登录服务（Argon2id + 会话）     /api/devices/agent/ 设备令牌直通       │
 │ /p/ 公开页面（无 Cookie，CSP sandbox）              /api/im/onebot/ OneBot 反向 WS          │
 └───────────────────────────┬────────────────────────────────────────────────────────────┘
                             ▼  127.0.0.1:3001
 ┌──────────── ChisaBot 应用容器（openbot-zh）──────────────────────────────────────────────┐
 │ server（Hono + CopilotKit runtime，内置 agent 循环）  app（React/Vite 构建产物）          │
 │ PostgreSQL（容器内）   agent-computer（Chromium + Xvfb，机器人的云端浏览器 / 工作区）      │
 │ 进程内定时：定时任务 15 s · 面板刷新                                                       │
 └───────────┬─────────────────────────────┬────────────────────────────────────────────────┘
             │ http://magpie:3425/v1       │ 只写 spool 请求文件
             ▼                             ▼
     Magpie 模型网关（可选）        宿主机 chisabot-updater（systemd，root）
                                     拉 GitHub main → 构建镜像 → 备份 → 切换 → 健康检查 → 失败回滚

 云端工作区节点（可选，手工部署）：Claude Code CLI + chisabot-node + 同步边车，作为一台「设备」连回应用
```

## 2. 组件

### 2.1 服务器上的 agent（`server/`）

- 每个机器人的回合都在服务器进程里跑（`server/src/agents/`、`copilot.ts`）：模型来自部署的模型连接（Magpie 或任意
  OpenAI / Anthropic 兼容接口，[models.md](models.md)），每个机器人可选自己的模型。
- 回合开头注入的上下文：工作方式提示、记忆（§50）、技能目录（§51）、保险箱用法（§52）、GitHub（§53）、当前北京时间（§55）、
  用户的设备情况（§45）。工具按回合类型给：人的回合全量；IM 回合只给文字类（§49）；面板刷新回合只给面板工具（§43）；
  后台任务（§38）有自己的工具集。
- 对话存在本地表 `openbot_local_threads / _runs / _events`（替代上游 Intelligence），线程锁防并发（重启时释放孤儿锁）。
- 默认是**云端 agent + 设备节点**；也可以把整件活交给设备上的本地 agent（Claude Code / Codex / OpenCode / 内置循环，
  [ADR-0003](adr/0003-cloud-agent-device-nodes.md)、[ADR-0010](adr/0010-local-agent-handoff.md)，§66）。
- 每轮的权限：确认卡片 + 审批偏好（§58）+ 每个机器人「请求批准 / 完全访问」（§97，`chisabot_bot_permissions`）在服务器端执行；
  付款、被关掉的设备能力、急停永远拦住。

### 2.2 网页（`app/`）

React + TanStack Router + CopilotKit。一个应用覆盖聊天、设置、管理；PC 和 Android 加载的就是服务器上的这份网页，所以网页
改动不需要客户端发版。桌面端仍需服务器发布新前端后刷新；本地预览构建不更新线上网页。右侧常驻栏和窄窗口弹出层共享内容与卡片表面，见 [侧栏与弹出面板一致性](sidebar-panel-parity.md)。界面规范见 DESIGN.md（顶部有章节索引）。消息节点、暂停队列、请求期限与数据库故障恢复见[聊天可靠性](chat-reliability.md)。

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

宿主机上的 `chisabot-updater`（python3，systemd）读 spool 请求文件队列；应用容器拿不到 docker socket。它从公开 GitHub
拉 main 到本机镜像仓库，按依赖指纹自动选「快速更新」（只换代码层，约 1–2 分钟）或「完整构建」（仓库根 Dockerfile），先
`pg_dump` 备份，再切换、健康检查（含模型自检），失败自动回滚，每次切换留一个回滚脚本。详见 [online-update.md](online-update.md)。

### 2.5 设备节点（`pc/`、`server/src/devices/`）

- ChisaBot PC（Electron，Windows）：一个窗口加载服务器网页 + 一个设备节点。节点主动发起 WSS 连到服务器（经系统代理），
  用每台设备自己的令牌；70 s 静默看门狗，休眠唤醒 / 解锁时重连。
- 设备属于**账号**，不属于某个机器人：用户的每个机器人都能拿到在线设备的 `device_*` 工具
  （[ADR-0002](adr/0002-devices-belong-to-account.md)）。能力分「关闭 / 询问 / 允许」，新设备默认「询问」；命令行、写文件、
  键鼠还要本机再确认；全部写审计，有急停。协议与安全见 [pc-node.md](pc-node.md)。
- 已上线（0.1.8，§62，[ADR-0009](adr/0009-device-full-access.md)）：无界面 Linux / macOS 节点 `chisabot-node`、设备编码工具
  （搜索、按行读、精确替换带 diff 和备份、打补丁、git、后台命令、持久 shell）、按设备的「完全访问」（1h / 24h / 永久）。
  允许的文件夹之外的路径必问，批准即加入（`server/src/devices/roots.ts`）。

### 2.6 Android（`android/`）

Kotlin + Jetpack Compose 原生应用（v0.1.13 起，DESIGN §80、[android-native.md](android-native.md)）：登录、机器人列表、聊天、面板原生；v0.1.14 第二轮加了确认卡片、附件、停止、重新生成 / 编辑、原生设置基础（§86）；其余页面应用内网页兜底；自带登录页，扫码绑定（§33）后用设备令牌换会话；手机只用来
登录聊天，不是机器人的设备节点。更新源是 `latest.json`（GitHub Releases 或自建静态目录）。

### 2.7 云端浏览器（`agent-computer/`）

每个机器人一个 Chromium（默认在 Xvfb 里有界面运行，避免被 Cloudflare 拦截）+ `/workspace` 工作区；工作区文件通过虚拟源
`https://workspace.local/` 给浏览器看。用户可以在右栏「计算机」接管 / 交还（§23、§39）。真标签最多 8 个、人和机器人同一组，
每账号一份收藏夹（§95、§96，[browser-tabs.md](browser-tabs.md)）。

机器人的 shell（`computer_run_command`）也在这个容器里：以 `pwuser` 运行，每条命令的 `HOME` 是 `/workspace`（`agent-computer/src/shell.ts`），
所以 `~` 写的就是工作区。三处安装位置都在工作区卷里、都归 `pwuser`：npm 的全局前缀 `/workspace/.npm-global`（`Dockerfile` 的
`npm config set prefix`）、bun 的 `$HOME/.bun`、`pip install --user` 的 `.local`。**`PATH` 由 `shell.ts` 拼**，不靠镜像里的
`ENV PATH`：那条 `ENV` 到不了运行中的容器（s6-overlay 启动时重建 `PATH`，镜像与容器的 `Config.Env` 里都没有它），所以
`environmentForCommand` 把这三个 `bin` 目录**追加**在部署给的 `PATH` 之后——不前置，装的包不会遮蔽镜像自己的 `node` / `bun`。
少了这一步，机器人 `npm i -g` 成功、下一条命令 `command not found`，它就把装好了读成装失败（2026-10-19 在测试机上实测）。
此前前缀还是 root 拥有的 `/usr/local`，机器人每次 `npm i -g` 都在一两秒内 EACCES 失败。

### 2.8 云端工作区节点（`deploy/cloud-node/`、`server/src/cloud-cc/`）

手工部署的容器（非 root、只读根文件系统、没有 docker.sock、不发布端口、防火墙只放公网），里面是 Claude Code CLI + chisabot-node，
配对后就是一台特殊的设备。管理员在 设置 → 云端工作区 用自己的 Claude 订阅登录（「在云端完成登录」：节点里的浏览器）、可设 Claude 上游代理
（sing-box 转换节点链接）；左栏「机器人｜Claude Code」切换到 Claude Code 会话；工作区可以来自草稿、GitHub 克隆，或 PC 上的文件夹
（同步边车 `cloudnode-sync`：节点网络命名空间里的 sshd + MIT 版 mutagen-agent，经设备隧道，不开新端口）。
**节点程序只在容器启动时下载**：改了 `pc/src/cloud-cc` 的部署之后要重启节点容器。详见 [cloud-claude-code.md](cloud-claude-code.md)、
[ADR-0014](adr/0014-cloud-claude-code.md)。

## 3. 功能 → 代码 → 数据

ChisaBot 自己的表大多在服务启动时 `CREATE TABLE IF NOT EXISTS`（不走迁移，回滚到旧镜像时旧代码直接忽略它们）；
上游表和少数需要改上游表的变化走 `server/drizzle/` 迁移。每张表的用途见 [data-model.md](data-model.md)。

| 功能 | DESIGN | 文档 | 代码 | 数据 |
|---|---|---|---|---|
| 聊天、流式、富卡片 | §24–§27、§30–§32、§35 | [streaming.md](streaming.md) | `app/src/lib/copilot/`、`server/src/agents/` | `openbot_local_threads/_runs/_events` |
| 聊天截图缩略图 | §27 | — | `server/src/chat-shots.ts` | `chisabot_chat_shots` |
| 回答中发消息 · 后台任务 | §38 | — | `server/src/thread-inbox.ts`、`server/src/workers/` | `chisabot_thread_inbox`、`chisabot_workers` |
| 全端同步 · 历史对话 | §42 | — | `server/src/bot-threads.ts` | `chisabot_bot_threads` |
| 只有一套聊天（`/bot` → 频道聊天跳转、open-thread、上传进工作区） | §68 · ADR-0013 | [streaming.md](streaming.md) | `app/src/routes/_authed/_app/bot.tsx`、`app/src/lib/channels/open-thread.ts`、`server/src/channels/routes.ts`（`/api/channels/open-thread`）、`server/src/chat-files/channel-mirror.ts` | `intelligence_channel_mappings`、`channel_agents`、`chisabot_chat_files` |
| 实时面板 | §29、§43、§77 | — | `server/src/live-panels/` | `live_panels`（迁移 0056/0057） |
| 浏览器多标签 · 收藏夹 | §95、§96 | [browser-tabs.md](browser-tabs.md) | `agent-computer/src/tabs.ts`、`server/src/browser-bookmarks/` | `chisabot_browser_bookmarks`、`chisabot_browser_bookmark_seeds` |
| 重新生成 / 编辑后重发 | §67 | — | `server/src/thread-truncate.ts` | `chisabot_thread_truncations` |
| 图片宽高预留 | §83.2 | — | `server/src/image-dims/` | `chisabot_image_dims` |
| 链接卡 | §48 | — | `server/src/link-preview/`、`app/src/lib/rich-previews/` | `chisabot_link_previews`、`chisabot_link_preview_assets` |
| 设备 / PC 节点 · 扫码绑定 | §16、§33、§45 | [pc-node.md](pc-node.md) | `server/src/devices/`、`pc/` | `devices`、`device_audit_events`（迁移 0054；`device_bot_access` 已不用） |
| 云端 Claude Code（云端工作区节点、Claude 登录、Claude Code 标签页） | §73 · ADR-0014 | [cloud-claude-code.md](cloud-claude-code.md) | `server/src/cloud-cc/`、`pc/src/cloud-cc/`、`deploy/cloud-node/`、`app/src/routes/_authed/_app/cc/`、`app/src/components/cloud-cc/` | `chisabot_cloud_workspaces`、`chisabot_cc_*` |
| 新建机器人 · 资料页 | §46、§47、§81 | [coworkers.md](coworkers.md) | `server/src/agents/` | 上游 agents 表（迁移 0058 一律私有） |
| 机器人头像 | §81 | [bot-avatars.md](bot-avatars.md) | `server/src/bot-avatars/` | `chisabot_bot_avatars` |
| 确认卡片 · 权限与审批 · 每个机器人的权限 | §58、§97 | [confirmations.md](confirmations.md)、[settings-ia.md](settings-ia.md) | `server/src/confirmations/` | `chisabot_confirm_prefs/_rules/_requests`、`chisabot_bot_permissions` |
| 设备编码工具 · 完全访问 · 无界面节点 | §62 | [pc-node.md](pc-node.md) | `server/src/devices/tools.ts`、`roots.ts`、`node-install.ts` | `devices.full_access_until` |
| 本地 agent | §66 · ADR-0010 | [local-agents.md](local-agents.md) | `server/src/local-agents/`、`pc/src/agent-runtime/` | `chisabot_device_agent_settings`、`chisabot_local_agent_tasks` |
| Android 原生 | §80、§86 | [android-native.md](android-native.md) | `android/` | — |
| 设置分组 · 设置搜索 | §97 | [settings-ia.md](settings-ia.md) | `app/src/lib/settings/registry.ts` | — |
| IM 接入 | §49 | [im.md](im.md) | `server/src/im/`、`shared/im.ts` | `chisabot_im_connections/_chats/_logs` |
| 长期记忆 | §50 | [memory.md](memory.md) | `server/src/memory-notes/` | `chisabot_memory_notes`、`chisabot_memory_bots` |
| 技能 | §51 | [skills.md](skills.md) | `server/src/skills-chisa/` | 上游 `skills` 表 |
| 密钥保险箱 | §52 | [vault.md](vault.md) | `server/src/vault/` | `chisabot_vault_secrets`、`chisabot_vault_requests` |
| GitHub 连接 | §53 | [github.md](github.md) | `server/src/github/` | `chisabot_github_connections`、`chisabot_github_actions`（令牌在保险箱 `github`） |
| 页面 | §54 | [pages.md](pages.md) | `server/src/pages/` | `chisabot_pages/_page_versions/_page_assets/_page_origins` |
| 定时任务与提醒 | §55 | [schedules.md](schedules.md) | `server/src/schedules/` | `chisabot_schedules`、`chisabot_schedule_runs` |
| 聊天文件与生图 · 识图 | §56、§59 | [chat-files.md](chat-files.md) | `server/src/chat-files/` | `chisabot_chat_files`、`chisabot_image_settings`、`chisabot_media_models`、`chisabot_image_descriptions` |
| 备用模型 | §60、§61 | [models.md](models.md) | `server/src/agents/model-fallback.ts` | `enterprise_settings`（`model_fallbacks`） |
| 工作流（默认隐藏） | §26、§74 | [workflows.md](workflows.md) | `server/src/workflows/` | `workflows`、`workflow_runs`、`workflow_run_events`（迁移 0055） |
| 在线更新 · 自检 | §22 | [online-update.md](online-update.md)、[admin-smoke.md](admin-smoke.md) | `server/src/system-update.ts`、`deploy/updater/` | 宿主机 spool |
| 手机网页 · PWA | §40 | [pwa.md](pwa.md) | `app/public/sw.js`、`app/src/lib/device.ts` | — |
| 朋友账号（多账号，默认隐藏） | §65 | [accounts.md](accounts.md) | `deploy/public/auth/server.ts`、`server/src/auth/gateway-identity.ts`、`app/src/routes/_authed/admin/accounts.tsx` | 网关 SQLite `accounts`、`invites`、`sessions.user_id`；应用 `users` / `user_roles` 自动建行 |
| 导航 · 瘦身 | §57 | [slimming.md](slimming.md) | `server/src/package-orphans.ts` | 只删孤儿行 |

## 4. 运行时开关（常用）

都是环境变量，默认值就是生产用的值；完整列表见 [configuration.md](configuration.md) 和各功能文档。

| 变量 | 作用 |
|---|---|
| `CHISABOT_EXTRAS` | 默认空；`workflows,plugins,boundaries,components` 或 `all` 重新打开被精简隐藏的功能（§74） |
| `CHISABOT_ACCOUNTS_UI=1` | 显示 设置 → 账号（朋友账号）；网关 `config.json` 的 `"invites": true` 才能发新邀请 |
| `CHISABOT_GATEWAY_SECRET` / `_FILE` | 多账号：与登录服务 `identitySecret` 相同的密钥（≥32 字符），启用网关签名身份（[accounts.md](accounts.md)） |
| `CHISABOT_SCHEDULES_SWEEP=0` | 关掉定时任务扫描 |
| `CHISABOT_IM=0` | 开机不启动 IM 连接 |
| `CHISABOT_RELEASE_LOCKS_ON_START=0` | 不在启动时释放孤儿线程锁（多进程共用一个库时） |
| `CHISABOT_ORPHAN_SWEEP=0` / `CHISABOT_WORKER_ORPHAN_SWEEP=0` / `CHISABOT_PANEL_ORPHAN_SWEEP=0` | 关掉对应的开机孤儿清理 |
| `CHISABOT_DEVICE_ASK_DEFAULTS=0` | 不把从没改过的「全部关闭」设备改成「询问」 |
| `COMPUTER_BROWSER_MODE=headless` | 云端浏览器回到无界面模式 |
| `CHISABOT_MAX_OUTPUT_TOKENS` | 单次输出上限（默认按模型目录，封顶 32000） |
| `CHISABOT_GITHUB_API_BASE` | GitHub Enterprise 或测试替身 |
| `CHISABOT_LINK_PREVIEW_SHOTS=1` | 没有 og:image 时截图做链接卡缩略图 |
