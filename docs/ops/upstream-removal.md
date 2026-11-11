# 命名空间切换与存量资源兼容

ChisaBot 已完成产品命名空间统一与历史过渡代码清理：现役会话接口（`/api/conversations`）、请求头（`x-chisabot-*`）、前端状态模块、执行内核（DSH）与数据库表名均统一使用自有命名，同时通过原地数据库迁移与宿主机挂载卷固定机制保障存量部署零数据丢失。

## 1. 数据库原地迁移与废弃空表清理（`0067` / `0068`）

命名切换与历史表收尾通过两次显式 Drizzle 迁移在原库上原地完成，保留全部用户记录、消息 ID、外键约束与序列水位：

1. **迁移 `0067_conversation_namespace`（会话三表改名，reader 升至 4）**：
   - 早期本地线程、运行、事件三表原地重命名为 `chisabot_local_threads`、`chisabot_local_runs`、`chisabot_local_events`；
   - 同步重命名主键、外键、索引与事件自增序列。升级后产品 reader 固定为 **4**，禁止再用 reader 1–3 的旧镜像挂载同一数据库。
2. **迁移 `0068_detachment_and_cleanup`（频道映射表改名、事件载荷键名归一与废弃空表清理）**：
   - 将频道线程映射表 `intelligence_channel_mappings` 原地重命名为 `chisabot_channel_mappings`（含主键、外键与唯一索引）；
   - 将历史会话事件、线程中断状态、运行命令与工具结果 JSONB 中的遗留兼容键名原地归一为 `chisabot*` 字段，并将历史运行时绑定中的 `hermes` 标记归一为 `dsh`（不触碰用户消息正文）；
   - 显式 `DROP TABLE IF EXISTS ... CASCADE` 清理 14 张早已下线且零现役引用的废弃表（`chisabot_legacy_imports`、`demonstrations`、`learning_settings`、`learning_thread_bindings`、`memory_sources`、`personal_memories`、`proactive_settings`、`proactive_suggestions`、`team_bot_assignments`、`team_bot_audience`、`team_bot_consent_defaults`、`team_bot_consents`、`team_bot_publications`、`voice_sessions`）。

早期迁移 SQL 文件与快照继续保留在 `server/drizzle/` 中，供全新安装按序完整重放。

## 2. 代码层旧路由、旧请求头与过渡内核彻底移除

随着自有命名迁移与 DSH 内核稳定运行，代码层历史过渡垫片已全部退役下线：

- **移除旧路由与请求头兼容层**：服务端旧会话兼容路由、旧前缀请求头、环境变量旧前缀兼容层及前端旧垫片模块已彻底删除；Web、PC、Android 客户端统一调用 `/api/conversations` 与自有认证会话。
- **退役旧执行内核与云端连接代码**：早期过渡用的 Hermes ACP 桥接内核、Intelligence 云端托管连接模式、Mastra 协议桥接及上游推广横幅逻辑均已从代码库与依赖树中彻底移除；`CHISABOT_AGENT_KERNEL=dsh` 为唯一内置执行内核。
- **纯净依赖产物**：开发、CI 与容器构建统一使用 `bun install --frozen-lockfile --omit=peer` 与 `npm ci --prefix runtime/dsh`，实际安装产物中不含任何已移除的上游包。

## 3. 存量容器卷固定与数据库身份兼容（零数据丢失防线）

为防止已有部署在容器名称或默认前缀更新后误建空白卷，部署与容器启动层保留两项物理资源兼容机制：

1. **挂载卷与网络自动固定（`deploy/pin-resources.sh`）**：
   - 新安装默认使用 `chisabot-zh`（或 `chisabot`）卷与网络命名；
   - 存量部署在运行 `deploy/start.sh`、宿主机更新器或安装脚本时，自动调用 `deploy/pin-resources.sh` 检测当前容器实际挂载的物理卷与网络并写入 `.env` 固定；若需手工直接执行 `docker compose`，请先执行：

     ```sh
     . ./pin-resources.sh
     pin_existing_resources .env chisabot-zh
     ```

2. **内置 PostgreSQL 集群身份读取（`docker/s6/scripts/database-identity.sh`）**：
   - 容器内嵌入式 PostgreSQL 将初始角色与库名记录在数据卷的 `identity` 文件中；
   - `database-identity.sh` 在启动时优先读取既有数据卷中的 `identity` 标记，使存量数据库集群继续沿用原有底层角色与库名平滑启动，仅在初始化全新空卷时写入当前默认名称。

升级已有实例时，请始终保留原数据库卷、DSH Session 卷与原 `KEY_ENCRYPTION_KEY`，切勿为追求卷名统一而删除旧卷重建。
