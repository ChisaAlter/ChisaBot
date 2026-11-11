# 数据模型

ChisaBot 的产品数据保存在 PostgreSQL；登录网关另有一个 SQLite（账号、邀请、会话）。启用 DSH 后，每账号的执行源日志另存于 `CHISABOT_DSH_ROOT` 持久目录。数据库已完成 `0067` / `0068` 自有命名空间迁移（核心表名统一为 `chisabot_*`，reader 4）与废弃空表清理，存量卷与数据库身份兼容规则见[命名切换与存量资源兼容](ops/upstream-removal.md)。

## 1. 两种建表方式

| 方式                                                                                             | 用在哪                                                                                 | 回滚                                                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **开机自建**：服务启动时 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` | 多数 `chisabot_*` 表及少数扩展列；已登记迁移的会话模块仍保留幂等初始化                 | 旧代码可忽略新增表、列；能否继续执行还须符合内核与日志读取版本                                 |
| **迁移**：`server/drizzle/NNNN_*.sql`（Drizzle）                                                 | 当前业务表与显式版本化变更；0063 接管会话账本，0067 / 0068 原地重命名表并清理废弃空表 | 记录和外键引用保留；0067 之后要求 reader 4，回滚必须同时保留 PostgreSQL 与 Session 卷并使用兼容镜像 |

原则：**保留现役用户数据，显式版本化迁移结构**。命名变更采用原地 `RENAME`，仅对确认已下线且无现役消费者的废弃空表通过显式迁移清理。
所有用户数据都带 `user_id`（或经机器人 / 设备归属到人），多账号下按人隔离（[accounts.md](accounts.md)）。

## 2. ChisaBot 业务表（`chisabot_*`）

0.1.142 的个人连接沿现有 `ensure()` 增加可空字段 `smtp_host / smtp_port / smtp_user / smtp_pass_enc / smtp_checked_at`，旧连接保持原值与 IMAP 用法。操作核对写入 `chisabot_tool_operations.result.reconciliation`，与对应会话后续命令同事务提交；工作流通知复用 `workflow_run_events` 与既有个人交付账本，不新增队列表。宿主状态保存于更新器的只读 `state/host-monitor.json`，通知交付仍由数据库账本去重。

按功能分组。「代码」是建表所在文件（`server/src/` 下）。

### 聊天与对话

| 表                                                        | 用途                                                                                               | 代码                                          | DESIGN                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `chisabot_runtime_bindings`                               | thread/revision → 账号 Host/Session；每线程只有一个 active binding，编辑后旧绑定保留               | `conversations/bindings.ts`；迁移 0063        | [DSH §5](dsh-kernel-migration.md#5-身份会话运行与任务) |
| `chisabot_conversation_commands`                          | 持久接纳；同 thread/command ID 幂等；`execution_run_id` 记录补话加入的实际运行                     | `conversations/commands.ts`；迁移 0063        | DSH §6                                                 |
| `chisabot_dsh_runs`                                       | 运行来源、Host generation、源日志 baseline、分段 request ID、停止状态和恢复状态                    | `conversations/run-journal.ts`；迁移 0063     | DSH §7–8                                               |
| `chisabot_tool_operations`                                | 工具调用身份、不可变参数、审批 ID、实际结果；回执未知时禁止自动重做                                | `conversations/tool-operations.ts`；迁移 0063 | DSH §9                                                 |
| `chisabot_conversation_interactions`                      | 卡片问题、原 continuation、答复及原始答复输入；答复与后续工作入队同事务                            | `conversations/interactions.ts`；迁移 0063    | DSH §10                                                |
| `chisabot_bot_threads`                                    | 每个 (用户, 机器人) 当前的对话指针 + 历史对话；全端同步的依据                                      | `bot-threads.ts`                              | §42                                                    |
| `chisabot_thread_inbox`                                   | 回答期间的消息与后台结果队列；Stop/失败后持久暂停，用户显式发送或撤回；HTTP 撤回预留终态防晚到提交 | `thread-inbox.ts`                             | §38、§108                                              |
| `chisabot_thread_inbox_control`                           | 每线程暂停状态；行锁串行暂停、晚入队、认领和单条恢复；删线程/机器人一并清理                        | `thread-inbox.ts`                             | §108                                                   |
| `chisabot_workers`                                        | 后台任务（delegate_task）的状态、步骤、结果                                                        | `workers/service.ts`                          | §38                                                    |
| `chisabot_thread_truncations`                             | 「重新生成 / 编辑后重发」的截断记录（同步戳版本号）                                                | `thread-truncate.ts`                          | §67                                                    |
| `chisabot_chat_shots`                                     | 聊天里的截图缩略图（≤400KB，每人 200 张，30 天）                                                   | `chat-shots.ts`                               | §27                                                    |
| `chisabot_chat_files`                                     | 聊天上传 / 机器人交付的文件（存进机器人工作区 `uploads/`）                                         | `chat-files/service.ts`                       | §56                                                    |
| `chisabot_image_dims`                                     | 图片宽高缓存（存图时写，旧图读时懒补），让对话按比例预留位置                                       | `image-dims/index.ts`                         | §83.2                                                  |
| `chisabot_link_previews` · `chisabot_link_preview_assets` | 链接卡元数据与转存的缩略图 / 商品图                                                                | `link-preview/service.ts`                     | §48、§72                                               |

### 机器人

| 表                         | 用途                                                                             | 代码                       | DESIGN |
| -------------------------- | -------------------------------------------------------------------------------- | -------------------------- | ------ |
| `chisabot_bot_avatars`     | 机器人头像（上传图 256² WebP / 表情 + 颜色 / 首字 + 颜色）                       | `bot-avatars/service.ts`   | §81    |
| `chisabot_bot_permissions` | 每个机器人的权限：「请求批准 / 完全访问」；没有行 = 沿用全局「操作你的电脑」偏好 | `confirmations/service.ts` | §97    |

### 确认与审批

| 表                          | 用途                                                                                            | 代码                                  | DESIGN       |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------ |
| `chisabot_confirm_prefs`    | 四类（对外发消息 / 删除 / 付款 / 操作电脑）「先问我 / 直接做」                                  | `confirmations/service.ts`            | §58          |
| `chisabot_confirm_rules`    | 用户用自己的话写的规则（关键词全部命中；问 > 直接做）                                           | `confirmations/service.ts`            | §58          |
| `chisabot_confirm_requests` | 确认卡与决定；0063 的 `continuation` 保存原运行/工具上下文。恢复前重查 Stop、编辑版本和操作账本 | `confirmations/service.ts`；迁移 0063 | §58；DSH §10 |

### 设备与本地 agent

| 表                               | 用途                                                                      | 代码                      | DESIGN |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------- | ------ |
| `chisabot_device_agent_settings` | 每台设备的本地 agent 档位（只读 / 工作区 / 完全访问）、隔离方式、网络开关 | `local-agents/service.ts` | §66    |
| `chisabot_local_agent_tasks`     | 交给本地 agent 的任务、输出、diff、状态                                   | `local-agents/service.ts` | §66    |

设备本身在 `devices`（迁移 0054；开机加列 `full_access_until`）和 `device_audit_events`。

### 个人助理能力

| 表                                                                                             | 用途                                                                                                                                                           | 代码                           | DESIGN  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- |
| `chisabot_memory_notes`                                                                        | 长期记忆（种类、主题、情境；同一人 / 地 / 项目 / 天合并；硬删除）                                                                                              | `memory-notes/service.ts`      | §50     |
| `chisabot_memory_bots`                                                                         | 哪些机器人不用记忆                                                                                                                                             | `memory-notes/service.ts`      | §50     |
| `chisabot_vault_secrets`                                                                       | 保险箱（值用 `KEY_ENCRYPTION_KEY` AES-GCM 加密，只显示末 4 位；绑定域名）                                                                                      | `vault/service.ts`             | §52     |
| `chisabot_vault_requests`                                                                      | 聊天里的安全输入卡                                                                                                                                             | `vault/service.ts`             | §52     |
| `chisabot_github_connections` · `chisabot_github_actions`                                      | GitHub 连接信息与写操作（pending → running，防重复）；令牌本身在保险箱保留名 `github`                                                                          | `github/service.ts`            | §53     |
| `chisabot_pages` · `chisabot_page_versions` · `chisabot_page_assets` · `chisabot_page_origins` | 页面、版本（保留 50 个）、资源（bytea）、来源                                                                                                                  | `pages/service.ts`             | §54     |
| `chisabot_schedules` · `chisabot_schedule_runs`                                                | 定时任务与每次触发（`next_run_at` 比较并交换，多容器不重复触发）                                                                                               | `schedules/service.ts`         | §55     |
| `chisabot_im_connections` · `chisabot_im_chats` · `chisabot_im_logs`                           | IM 连接（凭据加密）、每个 IM 会话（开机加列 `last_inbound`）、最近 100 条日志                                                                                  | `im/service.ts`                | §49     |
| `chisabot_im_inbox` · `chisabot_im_outbox`                                                     | 0064 持久收发账本：账号/Bot/thread 身份、原消息信封、回复正文/分片、平台回执和状态；发送结果未知时保留记录供核对，不自动重发。连接删除后仍可按账号查询交付记录 | `im/delivery.ts`；迁移 0064    | DSH §13 |
| `chisabot_personal_sources` · `chisabot_personal_deliveries`                                   | 个人日历（ICS）、邮箱（IMAP/SMTP）数据源与本人通知持久去重交付账本（迁移 0065）                                                                                | `personal-sources/`            | §128    |
| `chisabot_browser_bookmarks` · `chisabot_browser_bookmark_seeds`                               | 每账号的浏览器收藏夹；种子行记录「已用起始页默认链接初始化过」（第一次 GET 会写入）                                                                            | `browser-bookmarks/service.ts` | §95     |

### 模型与图片

| 表                            | 用途                                                 | 代码                         | DESIGN   |
| ----------------------------- | ---------------------------------------------------- | ---------------------------- | -------- |
| `chisabot_image_settings`     | 部署的生图模型（管理员）                             | `chat-files/service.ts`      | §56、§59 |
| `chisabot_media_models`       | 个人覆盖的生图 / 识图模型（密钥加密，显示末 4 位）   | `chat-files/media-models.ts` | §59      |
| `chisabot_image_descriptions` | 识图模型对上传图片的描述 + OCR 缓存（按文件 + 模型） | `chat-files/media-models.ts` | §59      |

默认模型连接和备用模型存在 `enterprise_settings`（key `model_connection` / `model_fallbacks`）。

## 3. 本地对话表（`chisabot_local_*`）

本地会话与 DSH 展示投影共用这些表。0063 已登记原始结构；0067 将旧会话表及相关索引、约束和事件序列原地迁入当前命名，0068 进一步将历史事件 JSONB 载荷中的遗留兼容键名归一。`server/src/conversations/` 使用当前表名并保留幂等初始化。

| 表                       | 用途                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `chisabot_local_threads` | 对话线程、展示快照与线程 lease；`snapshot_sequence` 标识快照包含到哪个事件。已有 DSH 执行重启时恢复观察，不能仅清锁重新派发 |
| `chisabot_local_runs`    | 每一轮的运行记录（finished / error / interrupted / stopped）                                                                |
| `chisabot_local_events`  | 持久产品事件和 AG-UI 流回放；DSH 源日志仍在 Session 卷                                                                      |

迁移 0063 可在全新数据库和已执行运行时 `ensure()` 的数据库上执行：建表、索引使用 `IF NOT EXISTS`，新增列保留可空状态；旧快照缺失水位时按已存事件回填，新 DSH run 的 `initiator` 默认 `person`。现有非空水位、运行输入、消息 ID、审批状态不会被覆盖。迁移与备份命令见 [DSH 运维](ops/dsh-runtime.md)。

## 4. 核心基础业务表（节选）

| 表                                                                                   | ChisaBot 怎么用                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `users` · `user_roles` · `sessions`                                                  | 应用用户（单用户时 = 管理员；网关身份模式下朋友自动建行）                     |
| `agents` · `agent_profiles` · `agent_preferences`                                    | 机器人定义、提示词与默认偏好（迁移 0058 起用户新建的一律私有）                |
| `channels` · `channel_agents` · `channel_memberships` · `chisabot_channel_mappings`  | 频道聊天与对话线程映射（唯一聊天路径；`chisabot_channel_mappings` 由 0068 重命名） |
| `live_panels`                                                                        | 实时面板（迁移 0056；0057 加 `refresh_at`；0059 加直连数据源）                |
| `devices` · `device_audit_events`                                                    | 设备与审计（迁移 0054）                                                       |
| `skills`                                                                             | 技能（ChisaBot 技能直接用这张表）                                             |
| `workflows` · `workflow_runs` · `workflow_run_events`                                | 工作流（迁移 0055；默认隐藏）                                                 |
| `enterprise_settings`                                                                | 默认模型连接、备用模型                                                        |
| `audit_events`                                                                       | 活动记录                                                                      |
| `saved_logins` · `credentials`                                                       | 账号连接里保存的网站登录、模型密钥                                            |
| `computer_snapshot` · `computer_page_frame`                                          | 云端浏览器快照                                                                |
| `attachments`                                                                        | 附件（定时清理 `chisabot-zh-attachments.timer`）                              |

### 已在 `0068` 迁移中清理移除的废弃空表

以下早期遗留或已下线功能的废弃空表，已在迁移 `0068` 中统一清理移除（`DROP TABLE`）：

- **已下线的云端 Claude Code（CB-099 下线）**：`chisabot_cloud_workspaces`、`chisabot_cc_workspaces`、`chisabot_cc_sessions`、`chisabot_cc_messages`、`chisabot_cc_events`、`chisabot_cc_permission_rules`、`chisabot_cc_sync_bindings`、`chisabot_cc_leases`、`chisabot_cc_sync_conflicts`、`chisabot_cc_sync_events`。
- **早期过渡与上游遗留空表**：`chisabot_legacy_imports`（旧托管历史导入表）、`team_bot_*`、`proactive_*`、`demonstrations`、`organization_settings`、`memory_sources` 等无现役消费者的历史空表。

其余被现役模块复用的早期表（如 `routines` 等）按实际消费者保留，不在未经核对前删除。

## 5. 登录网关（SQLite，`deploy/public/auth/`）

| 表         | 用途                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `accounts` | 朋友账号（账号名大小写不敏感；内置管理员来自 `config.json`，不在表里）                  |
| `invites`  | 一次性邀请 / 重置链接（1 / 3 / 7 天；重置 24 小时）                                     |
| `sessions` | 登录会话（`user_id` 为空 = 内置管理员；`device_id` / `verified_at` 用于扫码绑定的手机） |

删除网关账号**不会**删除应用里的数据。

## 6. 浏览器本地存储（不上传）

| 键                      | 内容                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `chisabot-ui-memory:v1` | 每个机器人的右栏标签 / 展开 / 宽度；每段对话的草稿、滚动位置；干活卡展开（§88） |
| `chisabot-sky`          | 背景随时间变化开关（§7）                                                        |
| `chisabot-layout`       | 强制 `phone` / `wide` 布局（§40）                                               |
| `chisabot-sw`           | `off` = 本浏览器停用 Service Worker（§40）                                      |
