# ChisaBot 主线状态与开发交接摘要

> 更新日期：2026-11-11（基线：`v0.1.143` + 去上游印记与架构收尾）。全量看板与待办验收标准以 [ROADMAP.md](ROADMAP.md) 与 [BACKLOG.md](BACKLOG.md) 为准。

## 1. 当前主线状态

- **执行内核与会话层**：`CHISABOT_AGENT_KERNEL=dsh` 为现役唯一内置执行内核，客户端与服务端统一通过 `/api/conversations`、PostgreSQL `chisabot_local_*`（reader 4）及每账号独立 DSH Session 持久卷工作；旧 `/api/copilotkit` 路由、`x-openbot-*` 请求头及早期 Hermes / Intelligence / Mastra 过渡代码已全部移除。
- **数据库迁移与存量保护**：迁移 `0067` / `0068` 已完成会话三表与 `chisabot_channel_mappings` 原地重命名、历史事件 JSONB 键名归一，并清理移除已下线模块（含旧云端 Claude Code `chisabot_cc_*` 等）的废弃空表。已有部署通过 `deploy/pin-resources.sh` 与容器内 `docker/s6/scripts/database-identity.sh` 保持原物理卷与内置 PostgreSQL 身份零丢失（详见 [命名切换与存量资源兼容](ops/upstream-removal.md)）。
- **个人助理与连续体验**：个人日历（ICS）、邮箱（IMAP/独立 SMTP）、晨报、任务成果核验、未知副作用核对、本人通知去重账本、草稿/引用/IndexedDB 附件跨重载恢复及 PC 路径恢复均已合入主线并随 `v0.1.140`–`v0.1.143` 发布。
- **多用户状态**：网关签名身份（`CHISABOT_GATEWAY_SECRET`）、角色隔离、共享记忆/全局共享技能与邀请机制代码完备，默认面向单用户隐藏，按需通过 `CHISABOT_ACCOUNTS_UI=1` 开启（见 [朋友账号](accounts.md)）。

## 2. 常用本地验证命令

完整开发与测试规范见 [本地开发参考](development.md) 与 [测试与验证](testing.md)：

```sh
# 1. 安装依赖（根工作区锁定依赖 + DSH 运行时独立锁）
bun install --frozen-lockfile --omit=peer
npm ci --prefix runtime/dsh

# 2. 中文化门禁、类型检查与构建
node scripts/check-zh-localization.cjs
bun run typecheck
bun run build

# 3. 后端与前端单元/组件测试（注意前端测试统一走 test:app 隔离运行，切勿裸跑 bun test app/tests）
bun run test
bun run test:app
```

涉及 PostgreSQL / `pgvector` 的服务端集成测试必须使用独立测试库（`TEST_DATABASE_URL=postgres://chisabot:chisabot@localhost:5432/chisabot_test`），严禁连接正在使用的开发主库或生产数据库。

## 3. 关键文档导航

- **看板与待办**：[ROADMAP.md](ROADMAP.md) · [BACKLOG.md](BACKLOG.md)
- **系统架构与数据表**：[architecture.md](architecture.md) · [data-model.md](data-model.md) · [features.md](features.md)
- **环境变量与部署运维**：[configuration.md](configuration.md) · [deploy/README.zh-CN.md](../deploy/README.zh-CN.md) · [ops/README.md](ops/README.md)
- **测试、发布与回滚**：[testing.md](testing.md) · [release.md](release.md) · [ops/deploy.md](ops/deploy.md)
