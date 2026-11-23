# AGENTS.md — ChisaBot 仓库工作守则

给在这个仓库里改代码的人和 AI agent 的**入口索引**。细节不在这里重复，以链接的文档为准；这里只写「改之前必须知道」的东西。

<!-- project-build-storage:start -->
## 构建产物与磁盘约束

适用于本项目的开发、工作树和临时验收，供所有编码代理及贡献者遵守。

### 构建与验收前

- 普通构建复用工具的用户级共享缓存，包括 Go、npm、pnpm、Bun、Gradle、浏览器与编译器下载缓存。保留锁文件、工具链版本和调用方显式覆盖；不按项目、工作树或任务另建整套缓存，不强行共用可写的 node_modules。
- 冷缓存测试仅在验收目的确实要求时使用独立缓存，放入本次任务拥有的临时目录，结束后回收并恢复环境变量。现成的项目回收入口优先于手写临时脚本。
- 预计新增超过 1 GiB 的依赖安装、运行时复制、构建或打包前，检查目标卷空闲并估算峰值，计入副本、staging 和最终包。C 盘应保留至少 50 GiB 空闲；预计不足时先复用已有产物、回收已完成任务的明确可重建目录，或使用有空间的其他卷。仍不够时暂停这项大操作并说明所需空间，不影响可独立进行的小任务。

### 中间产物由创建者回收

- 每个任务只创建自己拥有的唯一临时目录，集中放置临时编译文件、合成 profile、解包工具、冷缓存和验收 runtime。日志、结果摘要、最终交付包放在目录外；源码、唯一补丁、真实账号和数据库不移入临时目录。
- 在现有构建/验收入口中使用 finally、defer 或测试 teardown 回收自有中间产物，覆盖正常完成、失败、超时和取消。先等使用它们的进程退出；仍在使用则保留并报告准确路径，不结束用户进程来腾空间。
- 打包副本在最终包及必要更新文件成功生成、且没有后续消费者时回收。保留原有 StageOnly、失败诊断和后续验收需要的输出合同；新增清理能力不能破坏旧入口。
- 优先复用同一候选的只读 runtime；只有会修改它的验收才复制。证据保留日志和必要的最小复现，不为每次成功或失败永久留一整套源码、依赖、浏览器或 Electron。

### 回收边界与交付

- 只删除本任务刚创建、归属已知的目录，或另经明确分类授权的旧产物。递归删除前检查解析后的绝对边界与目录联接；解除链接，不跟随到外部目标。共享缓存使用官方维护命令，且确认没有活动构建占用。
- 保留未提交代码、Git 历史/工作树、数据库、真实 profile、账号/会话、附件、恢复快照和有效备份。不因名字叫 tmp、cache、outputs、diagnostics、rollback 或 archives 就整删；不按年龄自动删除混合目录，不擅自卸载、清空回收站或调整分页/休眠。
- 修改产物生成入口后，实际运行相关路径，检查正常及受影响的失败分支，并确认重复执行不会按次数遗留中间环境。交付只报告最终产物和确实仍需保留的临时路径及原因；不把写入规则说成所有旧脚本已自动执行回收。
<!-- project-build-storage:end -->

## 1. 仓库地图

| 目录                 | 是什么                                                                                  | 运行时                    |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| `app/`               | 网页 / PC / Android 共用前端（React 19 + TanStack Router/Query）                        | 浏览器、Electron、WebView |
| `server/`            | Bun + Hono 服务端，Drizzle + PostgreSQL；`src/index.ts` 是接线根，`src/app.ts` 是路由根 | Bun                       |
| `shared/`            | app 与 server 共用的类型与纯逻辑（含 `net/guarded-fetch.ts` SSRF 出口）                 | 两端                      |
| `agent-computer/`    | 云端浏览器 / 计算机控制服务（Chromium + Xvfb，loopback）                                | Bun                       |
| `runtime/dsh/`       | DSH 执行内核宿主（独立 npm 锁文件）                                                     | Node ≥ 24.9               |
| `pc/`、`android/`    | Electron 外壳 + 本机设备节点；Kotlin 原生壳                                             | Node 22 / Gradle          |
| `deploy/`、`docker/` | nginx 网关、登录服务、s6 进程树、镜像                                                   | —                         |

依赖方向只有一条：`app → shared ← server`。app 与 server 互不 import。系统结构见 [docs/architecture.md](docs/architecture.md)，取舍见 [docs/adr/](docs/adr/README.md)。

## 2. 命令

| 目的                       | 命令                              | 说明                                                                  |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| 本地快速门禁（每次提交前） | `bun run check`                   | typecheck（server/agent-computer/app）+ lint，必须 0 error 0 warning  |
| 完整门禁（PR 前）          | `bun run check:full`              | check + server 全量 + app 测试                                        |
| server + shared 全量测试   | `bun run test:server`             | 自动包含新测试；排除 `dsh-*`（走 `test:dsh`）和隔离名单               |
| app DOM 测试               | `bun run test:app`                | 会把替换全局模块的用例放进独立进程，不要改成直接 `bun test app/tests` |
| DSH 恢复测试               | `bun run test:dsh`                | 需要 `CHISABOT_DSH_TEST_DATABASE_URL`（pgvector）                     |
| 实机浏览器 UI 自验收       | `bun run verify:ui`               | 复用本机 Edge / Chrome / Chromium 零下载跑双视口交互与截图自检        |
| 格式                       | `bun run format` / `format:check` |                                                                       |
- **数据库测试**需要 `TEST_DATABASE_URL`（CI：`postgres://test:test@127.0.0.1:5432/chisabot_test`）。库必须先迁移：`DATABASE_URL=<test-url> bun server/scripts/migrate.ts`（CI 由 `Migrate test database` 步骤做，service 镜像用 `pgvector` 因为 0000 迁移要 `vector` 扩展）。没有库时 `*.integration.test.ts` 会直接报错，这是环境缺失，不是缺陷。
- **Windows 本机**：`compose-network-drift`、`provider-oauth` 依赖 symlink（需开发者模式），其余平台差异以 Linux CI 为准。
- **Bun 定时器陷阱**：测试里如果 `AbortSignal.timeout` 是进程里唯一挂着的定时器，它不会触发，测试会挂死（生产里总有 socket 撑着，不受影响）。假模型 / 假服务要模拟超时时，额外挂一个 `setTimeout`（见 `server/tests/approvals-policy.test.ts`）。
- **Bun#9882 陷阱**：`node:http` 服务器 `upgrade` 事件给出的 socket 是僵尸——`write` 返回 true 但字节不上线，无 upgrade 监听时请求甚至不进 handler。测试里要做 WS / Upgrade 的 HTTP 服务，用 `node:net` 手写头（见 `server/tests/im-net-ssrf.test.ts`）。
- `bun run test` / `test:ci` 是全仓联合跑，单机 20 分钟以上，日常不要用。
- CI 的 `biome` 任务对全仓执行 `bun run lint`（`--error-on-warnings`），全仓必须保持 0 error 0 warning。

## 3. 测试隔离名单

`scripts/test-quarantine.ts` 记录**已知坏掉**、暂不进 CI 的测试文件，每条带原因。规则：

- 只能放「任何系统上都确定失败」的文件；环境缺失、平台差异、偶发失败不进名单。
- 修好一个就从名单里删掉；名单里的路径不存在时 `test:server` 会直接失败，防止名单腐烂。
- 不要为了让 CI 变绿往里加新文件——先修，修不了就在 PR 里说明并标 owner。

## 4. 必须遵守的约定

- **浏览器取数**：[`.claude/skills/chisabot-data-access`](.claude/skills/chisabot-data-access/SKILL.md)。所有请求走 `app/src/lib/client.ts`；读 = `lib/<entity>/queries.ts`，写 = `mutations.ts`。`app/tests/no-raw-fetch.test.ts` 会拦组件 / lib 里的裸 `fetch`，例外只能加进它的白名单并写原因。
- **配置页布局**：[`.claude/skills/chisabot-screen-layout`](.claude/skills/chisabot-screen-layout/SKILL.md)。
- **视觉与交互**：[DESIGN.md](DESIGN.md) 是唯一真相源（顶部有章节索引）；skill 与 DESIGN.md 冲突时以 DESIGN.md 为准，并修 skill。
- **性能红线**：详见 [docs/desktop-performance-guardrails.md](docs/desktop-performance-guardrails.md) 与 [DESIGN.md](DESIGN.md) §41 / §153 / §154。核心硬禁令：不写 `group-has-*` / `peer-has-*` / `peer-hover` 与大容器 `:has()`；Windows 小窗禁止 16ms JS `setBounds` 补间与协议热路径同步 FS；`<1280px` 面板抽屉开关禁止抖动 `has-narrow-rail` 改写消息列 `padding-right`，宽度重排贴底必须走 `instant`；已彻底下线重型液态玻璃 SVG 位移透镜与 JS 光栅采样，全站统一纯 CSS 三档材质（`glass` / `clear` / `solid`）× `[data-surface]` 单通道（`tokens.css` / `canvas.css` / `materials.css`），气泡/卡片采用轻模糊且禁止双层遮罩模糊，`data-resizing` 严禁切黑底或关模糊；高频 Context 与列表行必须稳定引用/记忆化，隐藏右栏停轮询，交互热路径禁用 `flushSync`。
- **流程**：分支、PR 必带内容（测试、截图、DESIGN.md、两个 CHANGELOG、BACKLOG）见 [CONTRIBUTING.md](CONTRIBUTING.md)；发版见 [docs/release.md](docs/release.md)；测试分层和「实机测试」的硬性定义见 [docs/testing.md](docs/testing.md) §0。

## 5. 高风险区域（改之前多看一眼）

这些文件同时是体量最大、历史修复次数最多的地方。改动保持小而聚焦，不顺手重构，必须带回归测试：

| 文件                                                                                           | 风险                                                                              |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `app/src/styles.css` 与 `app/src/styles/{tokens,canvas,materials}.css`                         | 5 层单通道令牌、唯一画布与纯 CSS 三档材质（`glass/clear/solid` × `[data-surface]`）；改后跑 `no-group-has`、`no-container-has` 和 `perf:jank` |
| `app/src/components/channels/chat-transcript.tsx`、`channel-chat.tsx`、`composer/composer.tsx` | 聊天滚动 / 乐观态 / 账本同步；改后跑 `tests/chat-scroll/regression.sh`            |
| `server/src/index.ts`                                                                          | 全部服务接线根；新服务在这里接线，不在这里写业务逻辑                              |
| `server/src/plugins/store.ts`（~7.5K 行）                                                      | 插件授权（grant / policy / audit 三层），不要把三层合并                           |
| `server/src/local-conversations.ts`、`conversation-runtime.ts`                                 | 回合租约、停止、恢复；历史上死锁和超时都在这里                                    |
| PC 更新链（`pc/src/update-*.js`）                                                              | 0.1.11–0.1.45 曾全部无法自更新；改动必须验证「上一版 → 当前版」                   |

## 6. 不要做的事

- **数据库**：不要从 `server/src/db/schema/` 删表声明来"清理"——下一次 `db:generate` 会生成 `DROP TABLE`。删表要写独立迁移并单独评审（例：`schema/scim.ts` 是有意保留的遗留声明）。迁移规范见 [docs/development.md](docs/development.md) §3。
- **安全边界**：出网请求一律走 `shared/net/guarded-fetch.ts`；外部内容进模型前用 `markUntrusted` 包裹；不要信任请求体里的 Bot / 用户身份（以签名断言为准）。
- **配置**：新环境变量在 `server/src/config.ts` 里读和校验，不要在业务代码里直接 `process.env`。
- **仓库是公开的**：不提交服务器 IP、真实域名、主机名、密钥、真实用户数据（CI 有 Private host info guard）。临时调试脚本不要留在仓库根目录。
- **lint**：不要用 `biome-ignore` 去压一条规则而不写具体原因；不要删掉写着原因的 suppression，即使 Biome 报它"未使用"（多半是规则域没开，原因仍然有价值）。Biome 2.6 不会因为根 package.json 没有 react 就开 React 规则域，所以 `useExhaustiveDependencies` / `noArrayIndexKey` / `noDangerouslySetInnerHtml` 是在 `biome.json` 里显式打开的，不要删。

## 7. 自动门禁对照表

每一条硬约束都有对应的自动门禁直接报错拦截（见 `server/tests/docs-truth-guards.test.ts` 校验索引真实性）：

| 约束规则                                                                                                                    | 自动门禁测试 / 脚本                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓 Biome 零错误零警告（含 `pc/`，生产代码禁用 `!` 非空断言与冗余 Fragment）                                               | `biome.json`（`bun run lint` / `bun run check`）                                                                                                                                                                                                                                                                                                                              |
| 前端禁止裸 `fetch`，统一走 `app/src/lib/client.ts`                                                                          | `app/tests/no-raw-fetch.test.ts`                                                                                                                                                                                                                                                                                                                                              |
| 前端样式禁止高开销 `:has` 祖先选择器（`group-has-*` / `peer-has-*`）与大容器 `:has()` 清零                                   | `app/tests/no-group-has.test.ts`、`app/tests/no-container-has.test.ts`                                                                                                                                                                                                                                                                                                       |
| 桌面端流畅度防复发（竖屏面板零回跳、`instant` 换行锁底与零滚动强排、下线重型液态玻璃透镜与纯 CSS 三档材质/`[data-surface]` 单通道、Context/渲染稳定、PC 小窗原子落位与零同步 FS 协议） | `app/tests/narrow-rail-sheet-stability.test.tsx`、`app/tests/settle-reflow-instant.test.tsx`、`app/tests/runtime-render-stability.test.tsx`、`app/tests/liquid-glass-screen-ink.test.ts`、`pc/test/compact.check.js`、`pc/test/local-web.check.js`                                                                                                                           |
| 测试禁止 `mock.module` / `vi.mock` / `jest.mock` 进程级模块替换（零白名单）                                                 | `app/tests/no-mock-module.test.ts`                                                                                                                                                                                                                                                                                                                                            |
| 前端业务代码禁止裸 `useEffect`，外部同步统一收口至 `app/src/hooks/`                                                         | `app/tests/no-raw-use-effect.test.ts`                                                                                                                                                                                                                                                                                                                                         |
| 服务端除受控出口外禁止裸 `fetch`，统一走 `guardedFetch` / `trustedEndpointFetch`                                            | `server/tests/no-raw-fetch.test.ts`                                                                                                                                                                                                                                                                                                                                           |
| 服务端除 `server/src/config.ts` 外零散代码禁止读 `process.env`（零白名单）                                                  | `server/tests/no-raw-env.test.ts`                                                                                                                                                                                                                                                                                                                                             |
| 数据库禁止未经显式登记的 `DROP TABLE` / `DROP COLUMN` / `TRUNCATE`                                                          | `server/tests/no-unapproved-schema-drop.test.ts`                                                                                                                                                                                                                                                                                                                              |
| 全仓 `biome-ignore` 必须写清 `>=10` 字真实技术原因且总量封顶只减不增                                                        | `server/tests/biome-ignore-hygiene.test.ts`                                                                                                                                                                                                                                                                                                                                   |
| 核心状态机（租约锁/插件三层权限/一次性审批/聊天账本/密钥池与配额/浏览器接管/群聊防循环/记忆四级隔离）BFS 穷举与双变异体捕杀 | `server/tests/formal-conversation-locks.test.ts`、`server/tests/formal-plugin-grants.test.ts`、`server/tests/formal-approval-gate.test.ts`、`server/tests/formal-quota-keypool.test.ts`、`server/tests/formal-computer-takeover.test.ts`、`server/tests/formal-group-relays.test.ts`、`server/tests/formal-memory-visibility.test.ts`、`app/tests/formal-chat-ledger.test.ts` |
| 关键热路径（Key 池、配额账本、内容安全扫描、群聊接力、记忆 KV 前缀、BFS 状态空间）性能预算基线                              | `scripts/chisa-bench.ts`（`bun run bench`）                                                                                                                                                                                                                                                                                                                                   |
| 实机无头浏览器 UI 自验收驱动链路与临时目录零泄漏                                                                            | `server/tests/verify-ui-driver.test.ts`                                                                                                                                                                                                                                                                                                                                       |
| `DESIGN.md` 目录与正文章节 1:1 同步、门禁表路径真实、`test-quarantine` 清零                                                 | `server/tests/docs-truth-guards.test.ts`                                                                                                                                                                                                                                                                                                                                      |
