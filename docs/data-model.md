# 数据模型

ChisaBot 的数据都在应用容器里的 PostgreSQL（数据库 `chisabot`）；登录网关另有一个 SQLite（账号、邀请、会话）。截至 main `0e23321`。

## 1. 两种建表方式

| 方式 | 用在哪 | 回滚 |
|---|---|---|
| **开机自建**：服务启动时 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` | 所有 `chisabot_*` 表、`openbot_local_*` 表、少数给上游表加的可空列 | 只换镜像即可：旧代码不认识新表 / 新列，直接忽略 |
| **迁移**：`server/drizzle/NNNN_*.sql`（drizzle） | 上游表，以及必须改上游表的 ChisaBot 变化（0054 设备、0055 工作流、0056/0057 面板、0058 机器人一律私有） | 迁移只加表 / 可空列，回滚镜像安全；**瘦身 P5 的 DROP 迁移例外**，回滚前要先恢复数据库 |

原则：**只加不删**。瘦身移除的功能保留它们的表和数据（P5 才会在稳定 ≥ 2 周后 DROP 空表，见 [slimming.md](slimming.md)）。
所有用户数据都带 `user_id`（或经机器人 / 设备归属到人），多账号下按人隔离（[accounts.md](accounts.md)）。

## 2. ChisaBot 自己的表（`chisabot_*`，46 张）

按功能分组。「代码」是建表所在文件（`server/src/` 下）。

### 聊天与对话

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_bot_threads` | 每个 (用户, 机器人) 当前的对话指针 + 历史对话；全端同步的依据 | `bot-threads.ts` | §42 |
| `chisabot_thread_inbox` | 回答期间的消息与后台结果队列；Stop/失败后持久暂停，用户显式发送或撤回；HTTP 撤回预留终态防晚到提交 | `thread-inbox.ts` | §38、§108 |
| `chisabot_thread_inbox_control` | 每线程暂停状态；行锁串行暂停、晚入队、认领和单条恢复；删线程/机器人一并清理 | `thread-inbox.ts` | §108 |
| `chisabot_workers` | 后台任务（delegate_task）的状态、步骤、结果 | `workers/service.ts` | §38 |
| `chisabot_thread_truncations` | 「重新生成 / 编辑后重发」的截断记录（同步戳版本号） | `thread-truncate.ts` | §67 |
| `chisabot_chat_shots` | 聊天里的截图缩略图（≤400KB，每人 200 张，30 天） | `chat-shots.ts` | §27 |
| `chisabot_chat_files` | 聊天上传 / 机器人交付的文件（存进机器人工作区 `uploads/`） | `chat-files/service.ts` | §56 |
| `chisabot_image_dims` | 图片宽高缓存（存图时写，旧图读时懒补），让对话按比例预留位置 | `image-dims/index.ts` | §83.2 |
| `chisabot_link_previews` · `chisabot_link_preview_assets` | 链接卡元数据与转存的缩略图 / 商品图 | `link-preview/service.ts` | §48、§72 |

### 机器人

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_bot_avatars` | 机器人头像（上传图 256² WebP / 表情 + 颜色 / 首字 + 颜色） | `bot-avatars/service.ts` | §81 |
| `chisabot_bot_permissions` | 每个机器人的权限：「请求批准 / 完全访问」；没有行 = 沿用全局「操作你的电脑」偏好 | `confirmations/service.ts` | §97 |

### 确认与审批

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_confirm_prefs` | 四类（对外发消息 / 删除 / 付款 / 操作电脑）「先问我 / 直接做」 | `confirmations/service.ts` | §58 |
| `chisabot_confirm_rules` | 用户用自己的话写的规则（关键词全部命中；问 > 直接做） | `confirmations/service.ts` | §58 |
| `chisabot_confirm_requests` | 聊天里的确认卡（等 10 分钟，跨刷新 / 设备 / 重启，晚批准会接着做） | `confirmations/service.ts` | §58 |

### 设备与本地 agent

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_device_agent_settings` | 每台设备的本地 agent 档位（只读 / 工作区 / 完全访问）、隔离方式、网络开关 | `local-agents/service.ts` | §66 |
| `chisabot_local_agent_tasks` | 交给本地 agent 的任务、输出、diff、状态 | `local-agents/service.ts` | §66 |

设备本身在上游表 `devices`（迁移 0054；开机加列 `full_access_until`）和 `device_audit_events`；`device_bot_access` 已不用（设备属于账号）。

### 云端 Claude Code（已删除，CB-099，2026-10-26）

功能代码已删除，下面这些表**没有 drop**（`CREATE TABLE IF NOT EXISTS` 也不会再执行），留着旧数据，以后可以手工清理。

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_cloud_workspaces` | 云端工作区节点（哪台设备是云端节点、登录状态） | `cloud-cc/service.ts` | §73 |
| `chisabot_cc_workspaces` | Claude Code 工作区（草稿 / GitHub 克隆 / 电脑文件夹；开机加列 `clone_state`、`clone_error`） | `cloud-cc/service.ts` | §73 |
| `chisabot_cc_sessions` | 会话（`cc/…` 分支；开机加列 `merged_at`、`pr_number`、`pr_url`） | `cloud-cc/service.ts` | §73 |
| `chisabot_cc_messages` · `chisabot_cc_events` | 会话消息与事件流 | `cloud-cc/service.ts` | §73 |
| `chisabot_cc_permission_rules` | Claude Code 工具审批规则 | `cloud-cc/service.ts` | §73 |
| `chisabot_cc_sync_bindings` | 电脑文件夹 ↔ 云端工作区的同步绑定 | `cloud-cc/sync.ts` | §73、§87 |
| `chisabot_cc_leases` | 同步租约（谁在写：电脑 / 云端；交接） | `cloud-cc/sync.ts` | §73 |
| `chisabot_cc_sync_conflicts` · `chisabot_cc_sync_events` | 冲突与同步事件 | `cloud-cc/sync.ts` | §73 |

开机清理：工作区行已不存在的同步绑定 / 租约 / 冲突会被删掉（#181）。

### Hark 同款能力

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_memory_notes` | 长期记忆（种类、主题、情境；同一人 / 地 / 项目 / 天合并；硬删除） | `memory-notes/service.ts` | §50 |
| `chisabot_memory_bots` | 哪些机器人不用记忆 | `memory-notes/service.ts` | §50 |
| `chisabot_vault_secrets` | 保险箱（值用 `KEY_ENCRYPTION_KEY` AES-GCM 加密，只显示末 4 位；绑定域名） | `vault/service.ts` | §52 |
| `chisabot_vault_requests` | 聊天里的安全输入卡 | `vault/service.ts` | §52 |
| `chisabot_github_connections` · `chisabot_github_actions` | GitHub 连接信息与写操作（pending → running，防重复）；令牌本身在保险箱保留名 `github` | `github/service.ts` | §53 |
| `chisabot_pages` · `chisabot_page_versions` · `chisabot_page_assets` · `chisabot_page_origins` | 页面、版本（保留 50 个）、资源（bytea）、来源 | `pages/service.ts` | §54 |
| `chisabot_schedules` · `chisabot_schedule_runs` | 定时任务与每次触发（`next_run_at` 比较并交换，多容器不重复触发） | `schedules/service.ts` | §55 |
| `chisabot_im_connections` · `chisabot_im_chats` · `chisabot_im_logs` | IM 连接（凭据加密）、每个 IM 会话（开机加列 `last_inbound`）、最近 100 条日志 | `im/service.ts` | §49 |
| `chisabot_browser_bookmarks` · `chisabot_browser_bookmark_seeds` | 每账号的浏览器收藏夹；种子行记录「已用旧起始页 5 个链接初始化过」（第一次 GET 会写入） | `browser-bookmarks/service.ts` | §95 |

### 模型与图片

| 表 | 用途 | 代码 | DESIGN |
|---|---|---|---|
| `chisabot_image_settings` | 部署的生图模型（管理员） | `chat-files/service.ts` | §56、§59 |
| `chisabot_media_models` | 个人覆盖的生图 / 识图模型（密钥加密，显示末 4 位） | `chat-files/media-models.ts` | §59 |
| `chisabot_image_descriptions` | 识图模型对上传图片的描述 + OCR 缓存（按文件 + 模型） | `chat-files/media-models.ts` | §59 |

默认模型连接和备用模型存在上游表 `enterprise_settings`（key `model_connection` / `model_fallbacks`）。

## 3. 本地对话表（`openbot_local_*`）

替代上游 Intelligence 托管服务，开机自建（`server/src/local-conversations.ts`）：

| 表 | 用途 |
|---|---|
| `openbot_local_threads` | 对话线程 + **线程锁**（`lock_expires_at`；启动时释放孤儿锁，部署脚本等锁清零再切换） |
| `openbot_local_runs` | 每一轮的运行记录（finished / error / interrupted / stopped） |
| `openbot_local_events` | AG-UI 事件流（回放用；目前无上限增长，CB-031） |

## 4. 仍在用的上游表（节选）

| 表 | ChisaBot 怎么用 |
|---|---|
| `users` · `user_roles` · `sessions` | 应用用户（单用户时 = 管理员；网关身份模式下朋友自动建行） |
| `agents` · `agent_profiles` | 机器人（迁移 0058 起用户建的一律私有） |
| `channels` · `channel_agents` · `channel_memberships` · `intelligence_channel_mappings` | 频道聊天（唯一聊天路径；旧 `/bot` 线程第一次打开时建频道） |
| `live_panels` | 实时面板（迁移 0056；0057 加 `refresh_at`） |
| `devices` · `device_audit_events` | 设备与审计（迁移 0054） |
| `skills` | 技能（ChisaBot 技能直接用这张表） |
| `workflows` · `workflow_runs` · `workflow_run_events` | 工作流（迁移 0055；默认隐藏） |
| `enterprise_settings` | 默认模型连接、备用模型 |
| `audit_events` | 活动记录 |
| `saved_logins` · `credentials` | 账号连接里保存的网站登录、模型密钥 |
| `computer_snapshot` · `computer_page_frame` | 云端浏览器快照 |
| `attachments` | 上游附件（定时清理 `chisabot-zh-attachments.timer`） |

瘦身后**不再读写但保留**的上游表：`routines` / `routine_runs` / `routine_sweeps`、`responsibilities*`、`learning_*`、`scim_*`、`sso_providers`、
`team_bot_*`、`group_*`、`delivery_*`、`push_devices`、`demonstrations`、`personal_memories`、`proactive_*`、`model_usage`、`voice_sessions`、
`bot_panel_*` / `panel_*`（旧面板系统）等。P5 处理（CB-016）。

## 5. 登录网关（SQLite，`deploy/public/auth/`）

| 表 | 用途 |
|---|---|
| `accounts` | 朋友账号（账号名大小写不敏感；内置管理员来自 `config.json`，不在表里） |
| `invites` | 一次性邀请 / 重置链接（1 / 3 / 7 天；重置 24 小时） |
| `sessions` | 登录会话（`user_id` 为空 = 内置管理员；`device_id` / `verified_at` 用于扫码绑定的手机） |

删除网关账号**不会**删除应用里的数据。

## 6. 浏览器本地存储（不上传）

| 键 | 内容 |
|---|---|
| `chisabot-ui-memory:v1` | 每个机器人的右栏标签 / 展开 / 宽度；每段对话的草稿、滚动位置；干活卡展开（§88） |
| `chisabot-sky` | 背景随时间变化开关（§7） |
| `chisabot-layout` | 强制 `phone` / `wide` 布局（§40） |
| `chisabot-sw` | `off` = 本浏览器停用 Service Worker（§40） |
