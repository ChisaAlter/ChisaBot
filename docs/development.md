# 本地开发参考

首次配置数据库、加密密钥与模型连接可先阅读 [快速开始](getting-started.md)。现役系统结构以 [ChisaBot 架构](architecture.md) 为准；生产容器部署见 [自托管部署](../deploy/README.zh-CN.md)，线上更新与回滚见 [串行部署](ops/deploy.md)。

## 1. 环境与依赖安装

本地开发需准备：Docker（用于运行本地 PostgreSQL + `pgvector` 或 `agent-computer`）、[Bun](https://bun.sh) `1.3.14`、Node.js `24.9+`（运行 DSH Host）、`openssl` 与 `curl`。

在仓库根目录执行：

```sh
cp .env.example .env
bun install --frozen-lockfile --omit=peer
npm ci --prefix runtime/dsh
```

- 根工作区统一使用 `--omit=peer` 安装锁定依赖；`runtime/dsh` 为独立锁文件的 Node.js 子包，需单独执行 `npm ci --prefix runtime/dsh`。
- `.env.example` 默认开启本地免登录单用户模式（`CHISABOT_SINGLE_USER=true`、`TRUSTED_ORIGINS=http://localhost:3010`）与 `CHISABOT_AGENT_KERNEL=dsh`。切勿将公开示例 `KEY_ENCRYPTION_KEY` 用于生产部署。

## 2. 启动本地开发服务

确保本地 PostgreSQL（`postgres://chisabot:chisabot@localhost:5432/chisabot`）已启动并执行迁移后，运行：

```sh
bun run dev
```

- 前端 Vite 开发服务器默认监听 `http://localhost:3010`，API 服务端监听 `http://localhost:3001`。
- 本地开发下，服务端会按 `CHISABOT_DSH_ROOT=.data/dsh` 自动按需拉起本机 DSH Host 进程；生产多账号独立 Host 与工具网关接线见 [DSH 运行时与恢复](ops/dsh-runtime.md)。
- **未发送草稿附件清理**：聊天输入框暂存但未发送的附件在单人累计达到 32 个时会拦截新上传。`bun run dev` 不内置定时清扫，长期本地开发如需手动回收超过 24 小时的弃用草稿附件，可在 `server/` 下执行 `bun scripts/cull-staged-attachments.ts`。生产部署由 systemd 附件清理定时器自动处理。

## 3. 数据库迁移（Drizzle）

修改 `server/src/db/` 下的 Drizzle Schema 后，生成并应用迁移：

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

遵循以下迁移安全规范：

1. **禁止手改自动生成的结构迁移 SQL**：若生成的 `ADD COLUMN ... NOT NULL` 在已有数据的表上无法直接执行，应拆分为「新增可空列 → 独立数据回填迁移 → 后续版本收紧约束」。
2. **自定义数据迁移 / 原地重命名使用 `--custom`**：
   ```sh
   bun run --filter server db:generate -- --custom --name=your_migration_name
   ```
   仅在 `--custom` 生成的已登记空白迁移文件中手写幂等 SQL。
3. **保持 `meta/_journal.json` 与 `server/drizzle/*.sql` 严格对应**：CI 会运行 `drizzle-kit check` 与脏 Schema 检测；合并或变基后若 `drizzle-kit migrate` 异常退出，请核对 `_journal.json` 中记录的文件名是否与磁盘 SQL 文件完全一致。

## 4. 代码质量检查与测试

提交 PR 前请按 [`.github/workflows/chisabot.yml`](../.github/workflows/chisabot.yml) 执行质量检查：

```sh
node scripts/check-zh-localization.cjs
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:app
bun run build
```

### 数据库集成测试隔离红线

服务端数据库集成测试要求独立的 PostgreSQL（带 `pgvector`）测试库，通过 `TEST_DATABASE_URL` 指定：

```sh
export TEST_DATABASE_URL=postgres://chisabot:chisabot@localhost:5432/chisabot_test
```

测试框架拒绝连接应用日常使用的 `chisabot` 库，以防测试产生的临时机器人与审计记录污染真实数据；**严禁**对生产数据库运行任何集成测试（详见 [测试与验证](testing.md)）。CI 中使用 `bun run test:ci` 额外校验预期用例数量。

### 可选专项测试

- **运行栈冒烟测试（`bun run test:smoke`）**：针对已通过 `deploy/start.sh` 启动的实例验证完整 HTTP 链路，需在环境变量中提供有效登录 Cookie（`CHISABOT_SMOKE_COOKIE`，切勿写入代码或 PR 评论）。
- **云端浏览器实时画面测试（`bun run test:live-screen`）**：需先在 `agent-computer/` 下执行 `bun install` 安装 Playwright 与 Chromium，再设置 `CHISABOT_LIVE_SCREEN=1` 运行。

## 5. 提交检查清单

- 保持改动聚焦，敏感权限与安全边界必须在服务端强制校验，不能仅靠前端隐藏。
- 严禁将任何真实密钥、Cookie、私人服务器域名、本机绝对路径（含个人用户名）或用户对话内容提交进版本库。
- 涉及配置项、架构或功能入口变更时，同步更新 [环境变量参考](configuration.md)、[架构说明](architecture.md) 或 [功能目录](features.md)。
