# AGENTS.md — ChisaBot 仓库工作守则

给在这个仓库里改代码的人和 AI agent 的**入口索引**。细节不在这里重复，以链接的文档为准；这里只写「改之前必须知道」的东西。

## 1. 仓库地图

| 目录                | 是什么                                                                     | 运行时               |
| ------------------- | -------------------------------------------------------------------------- | -------------------- |
| `app/`              | 网页 / PC / Android 共用前端（React 19 + TanStack Router/Query）           | 浏览器、Electron、WebView |
| `server/`           | Bun + Hono 服务端，Drizzle + PostgreSQL；`src/index.ts` 是接线根，`src/app.ts` 是路由根 | Bun                  |
| `shared/`           | app 与 server 共用的类型与纯逻辑（含 `net/guarded-fetch.ts` SSRF 出口）    | 两端                 |
| `agent-computer/`   | 云端浏览器 / 计算机控制服务（Chromium + Xvfb，loopback）                   | Bun                  |
| `runtime/dsh/`      | DSH 执行内核宿主（独立 npm 锁文件）                                        | Node ≥ 24.9          |
| `pc/`、`android/`   | Electron 外壳 + 本机设备节点；Kotlin 原生壳                                | Node 22 / Gradle     |
| `deploy/`、`docker/` | nginx 网关、登录服务、s6 进程树、镜像                                      | —                    |

依赖方向只有一条：`app → shared ← server`。app 与 server 互不 import。系统结构见 [docs/architecture.md](docs/architecture.md)，取舍见 [docs/adr/](docs/adr/README.md)。

## 2. 命令

| 目的                         | 命令                                   | 说明 |
| ---------------------------- | -------------------------------------- | ---- |
| 本地快速门禁（每次提交前）   | `bun run check`                        | typecheck（server/agent-computer/app）+ lint，必须 0 error 0 warning |
| 完整门禁（PR 前）            | `bun run check:full`                   | check + server 全量 + app 测试 |
| server + shared 全量测试     | `bun run test:server`                  | 自动包含新测试；排除 `dsh-*`（走 `test:dsh`）和隔离名单 |
| app DOM 测试                 | `bun run test:app`                     | 会把替换全局模块的用例放进独立进程，不要改成直接 `bun test app/tests` |
| DSH 恢复测试                 | `bun run test:dsh`                     | 需要 `CHISABOT_DSH_TEST_DATABASE_URL`（pgvector） |
| 格式                         | `bun run format` / `format:check`      | |

- **数据库测试**需要 `TEST_DATABASE_URL`（CI：`postgres://test:test@127.0.0.1:5432/chisabot_test`）。没有时 `*.integration.test.ts` 会直接报错，这是环境缺失，不是缺陷。
- **Windows 本机**：`compose-network-drift`、`provider-oauth` 依赖 symlink（需开发者模式），`im-net-ssrf` 的 socket 关闭时序在 Windows 上不稳；以 Linux CI 为准。
- **Bun 定时器陷阱**：测试里如果 `AbortSignal.timeout` 是进程里唯一挂着的定时器，它不会触发，测试会挂死（生产里总有 socket 撑着，不受影响）。假模型 / 假服务要模拟超时时，额外挂一个 `setTimeout`（见 `server/tests/approvals-policy.test.ts`）。
- `bun run test` / `test:ci` 是全仓联合跑，单机 20 分钟以上，日常不要用。
- CI 另有 Biome 增量门禁（`scripts/biome-new-issues.ts`）：改动文件的 error+warning 数不得增加。

## 3. 测试隔离名单

`scripts/test-quarantine.ts` 记录**已知坏掉**、暂不进 CI 的测试文件，每条带原因。规则：

- 只能放「任何系统上都确定失败」的文件；环境缺失、平台差异、偶发失败不进名单。
- 修好一个就从名单里删掉；名单里的路径不存在时 `test:server` 会直接失败，防止名单腐烂。
- 不要为了让 CI 变绿往里加新文件——先修，修不了就在 PR 里说明并标 owner。

## 4. 必须遵守的约定

- **浏览器取数**：[`.claude/skills/chisabot-data-access`](.claude/skills/chisabot-data-access/SKILL.md)。所有请求走 `app/src/lib/client.ts`；读 = `lib/<entity>/queries.ts`，写 = `mutations.ts`。`app/tests/no-raw-fetch.test.ts` 会拦组件 / lib 里的裸 `fetch`，例外只能加进它的白名单并写原因。
- **配置页布局**：[`.claude/skills/chisabot-screen-layout`](.claude/skills/chisabot-screen-layout/SKILL.md)。
- **视觉与交互**：[DESIGN.md](DESIGN.md) 是唯一真相源（顶部有章节索引）；skill 与 DESIGN.md 冲突时以 DESIGN.md 为准，并修 skill。
- **性能红线**：不写 `group-has-*` / `peer-has-*` / `peer-hover` 等（`app/tests/no-group-has.test.ts`），原因见 DESIGN.md §41。
- **流程**：分支、PR 必带内容（测试、截图、DESIGN.md、两个 CHANGELOG、BACKLOG）见 [CONTRIBUTING.md](CONTRIBUTING.md)；发版见 [docs/release.md](docs/release.md)；测试分层和「实机测试」的硬性定义见 [docs/testing.md](docs/testing.md) §0。

## 5. 高风险区域（改之前多看一眼）

这些文件同时是体量最大、历史修复次数最多的地方。改动保持小而聚焦，不顺手重构，必须带回归测试：

| 文件 | 风险 |
| ---- | ---- |
| `app/src/styles.css`（~11K 行） | 玻璃材质重写过 4 次，选择器层叠牵一发动全身；改后跑 `no-group-has` 和 `perf:jank` |
| `app/src/components/channels/chat-transcript.tsx`、`channel-chat.tsx`、`composer/composer.tsx` | 聊天滚动 / 乐观态 / 账本同步；改后跑 `tests/chat-scroll/regression.sh` |
| `server/src/index.ts` | 全部服务接线根；新服务在这里接线，不在这里写业务逻辑 |
| `server/src/plugins/store.ts`（~7.5K 行） | 插件授权（grant / policy / audit 三层），不要把三层合并 |
| `server/src/local-conversations.ts`、`conversation-runtime.ts` | 回合租约、停止、恢复；历史上死锁和超时都在这里 |
| PC 更新链（`pc/src/update-*.js`） | 0.1.11–0.1.45 曾全部无法自更新；改动必须验证「上一版 → 当前版」 |

## 6. 不要做的事

- **数据库**：不要从 `server/src/db/schema/` 删表声明来"清理"——下一次 `db:generate` 会生成 `DROP TABLE`。删表要写独立迁移并单独评审（例：`schema/scim.ts` 是有意保留的遗留声明）。迁移规范见 [docs/development.md](docs/development.md) §3。
- **安全边界**：出网请求一律走 `shared/net/guarded-fetch.ts`；外部内容进模型前用 `markUntrusted` 包裹；不要信任请求体里的 Bot / 用户身份（以签名断言为准）。
- **配置**：新环境变量在 `server/src/config.ts` 里读和校验，不要在业务代码里直接 `process.env`。
- **仓库是公开的**：不提交服务器 IP、真实域名、主机名、密钥、真实用户数据（CI 有 Private host info guard）。临时调试脚本不要留在仓库根目录。
- **lint**：不要用 `biome-ignore` 去压一条规则而不写具体原因；不要删掉写着原因的 suppression，即使 Biome 报它"未使用"（多半是规则域没开，原因仍然有价值）。Biome 2.6 不会因为根 package.json 没有 react 就开 React 规则域，所以 `useExhaustiveDependencies` / `noArrayIndexKey` / `noDangerouslySetInnerHtml` 是在 `biome.json` 里显式打开的，不要删。
