# 瘦身：从「企业 AI 同事平台」收敛成私人助手（2026-10-14 起）

依据：2026-10-14 的整体审查（上游 ChisaBot 继承功能逐项评估），用户批准按建议分阶段做。原则是**先入口、后代码、最后数据**；每阶段一个 PR，走正常的 PR → 合并 → 一键更新 → 自检，出问题回滚镜像。

| 阶段 | 内容 | 数据库 |
|---|---|---|
| P1 导航收敛 | 顶栏去分段、左栏只留机器人、账号菜单与设置左栏重排、旧地址重定向、右栏去掉上游旧面板（DESIGN.md「导航收敛」一节） | 不动 |
| P2 孤儿数据与示例包 | 见下 | 只删孤儿行 |
| P3 删不发布的目录 | 上游 Tauri 桌面端、Expo 移动端、外部框架适配器、Helm、SPIRE、supervisor 等 | 不动 |
| P4a 删前端死页 | 已经重定向 / 隐藏的上游页面和组件 | 不动 |
| P4b 关服务端模块 | 不再构造无数据的上游模块（表保留） | 不动 |
| P4c 合并重复系统 | 上游与 ChisaBot 重复的系统并成一套（P4c-1：routines → 定时任务），见下 | 不动 |
| 以后 | 其余合并（旧面板、components、responsibilities…）；观察稳定后再一次性 DROP 空表（P5） | — |

## P2 孤儿数据与示例包

- **示例部署包 `examples/zh-CN`** 不再自带机器人和频道：每个人第一次进来会自动得到一个私有的「助手」（`ensureDefaultBot`），其他机器人自己新建。部署共享技能只留两个与具体连接器无关的：公开信息研究、核实说法。知识来源示例去掉。
- **开机清理**（`server/src/package-orphans.ts`，在部署包同步的同一个事务里跑，幂等，`CHISABOT_ORPHAN_SWEEP=0` 关掉）：
  1. 包里已经不声明的包技能（`origin = catalogue`、没有主人）连同工具声明与授权；用户自己写的技能不动。
  2. 包里已经不声明、且从没被当成对话用过（没有成员、没有映射）的包频道；用过的留着，那是历史对话。
  3. 授给已删除 / 不存在的机器人的 `plugin_grants`。
  1、2 只在库里只有这一个部署包时做（技能表按名字全局共享，多包时分不清是谁不要了）。
- **删机器人时**同一个事务里收回它的 `plugin_grants`。
- 上线前在生产 `pg_dump` 了受影响的表（`skills`、`skill_tools`、`plugin_grants`、`channels`、`channel_agents`）到 `/opt/chisabot-zh/backups/`，恢复就是把这份 SQL 导回去。

## P3 删不发布的目录（2026-10-15）

先核对过哪些目录进发布物：服务端镜像（根 `Dockerfile` / `deploy/Dockerfile.zh` 只拷 `app server shared examples scripts agent-computer docker`）、PC 客户端 `pc/`（Electron）、Android `android/`、CI（`chisabot.yml`、`release.yml`、`security_zizmor.yml`）。这些一律保留。删掉的都不进任何发布物：

| 删除 | 原来是什么 |
|---|---|
| `desktop/` | 上游 Tauri 桌面端（ChisaBot PC 用 `pc/`） |
| `mobile/` | 上游 Expo 移动端（Android 用 `android/`） |
| `agent-adk/ag2/agno/bot/claude-sdk/crewai/langgraph/langgraph-agui/langroid/llamaindex/mastra/microsoft/pydantic-ai/strands` | 外部框架适配器（`agent-computer` 保留，它进镜像） |
| `charts/`、`spire/`、`supervisor/` | Helm chart、SPIRE 身份、每机器人一台计算机的 supervisor 进程 |
| `examples/{langgraph-bot,mastra-bot,pydantic-ai-bot}` | 上游示例（`examples/fintech` 还是测试夹具，暂留） |
| 根 `docker-compose.yml`、`scripts/{start,stop,processes,require-bash}.sh` 及其测试 | 上游笔记本全栈（起 agent-bot / agent-langgraph / supervisor / SPIRE）；ChisaBot 部署走 `deploy/start.sh` |
| `.github/workflows/{ci,desktop,desktop-signing,publish-release,release-pr}.yml`、`.github/published-images.json` | 上游的全量手动 CI、桌面端构建签名、往 ghcr.io/copilotkit 发镜像的发布流程 |
| `Tauri-signing-SKILL.md`、`prompt.txt`、`scripts/check-new-values-keys.ts`、`scripts/check-rendered-chart.ts` | 上游遗留 |
| 只测被删目录的测试 | `tests/{agent-bot,compose}.test.ts`、`server/tests/{learning-mastra,mobile-links,handoff-caps-defaults}.test.ts`，`connector-tokens-never-reach-computer` 去掉 supervisor 那一半 |

**刻意没动：** `worker/`（根 workspaces、两个 Dockerfile 和更新器的依赖指纹都列着它，删它会让依赖指纹变化、触发一次完整构建）——放到 P4b 和去掉 Slack/Teams/Twilio 依赖一起做，只做一次完整构建。依赖指纹（`bun.lock`、各 `package.json`、`Dockerfile`、`docker/`）在 P3 里一个字节都没改，所以这次是快速更新。

**修好「ChisaBot checks」：** CI 的 `bun install` 默认是隔离链接，`shared/` 不是 workspace，里面 import 的 `zod`、`@json-render/core`、`@json-render/react/schema` 只在 `server/`、`app/` 的 node_modules 里，所以 server typecheck 报 TS2307 再连锁一串 TS7006，bun 测试运行时也解析不到（镜像一直用 `--linker hoisted`，所以本地是绿的）。现在 CI 和镜像一样 `bun install --frozen-lockfile --linker hoisted`；`app` 里两处 `@ag-ui/client`（没声明的传递依赖）改成从 `@ag-ui/core` / `@copilotkit/react-core/v2` 取类型；CI 先 `app build`（重新生成 `routeTree.gen.ts`，提交里的那份总落后于并行 PR 新加的路由）再 `app typecheck`。

## P4a 删前端死页

P1 已经隐藏 / 重定向的上游页面，这一步把代码删掉（约 1.2 万行，只改网页，服务器与数据库不动）：

- **页面**：管理后台 人员与角色、企业控制、身份提供者、自动学习、组件游乐场、旧的管理员设备页；设置 → UI 组件库；群聊 `/group/*`。地址都保留成重定向（去 设置、设置 → 技能、设置 → 设备、对话）。
- **机器人设置窗**去掉「交接」「例行任务」两栏；接管窗口去掉「录制成工作流…」。
- **只被它们用到的组件 / lib** 一起删：gallery、carousel、questionnaire、主动研究面板、可达性（delivery）、群聊、旧记忆（`lib/memory.ts`）、主动研究（`lib/proactive.ts`）、演示录制（`lib/demonstrations.ts`）、旧技能编辑、旧例行任务列表、人员 / 企业 / 身份提供者 / 学习的查询与修改等；对应的 10 个测试文件。
- 测试夹具里 `mock.module("@/components/layout/sidebar-toggle")` 改成提供全部导出（bun 的模块 mock 会漏到后面的文件里，缺 `TopBarOwnsSidebarToggle` 会在 glass-shell 处报「测试之间未处理的错误」）。
- 不动：审批 / 确认卡、设备、定时任务、保险箱、GitHub、页面、聊天文件 / 图片、模型设置、IM、技能、记忆、例行任务后端。

## P4b 关服务端模块（表保留）

原则：模块不再构造、路由不再挂载、代码删掉；**数据库表和旧数据一律不动**（回滚镜像即可恢复，DROP 留到 P5）。分几个小 PR 做：

| PR | 模块 | 处理 | 前端 |
|---|---|---|---|
| P4b-1 | 演示录制（`/api/demonstrations/*`，`demonstrations/` 的 store/recording/draft/schedule/routes） | 删 | P4a 已删「录制成工作流…」与 `lib/demonstrations.ts` |
| P4b-1 | 上游个人记忆（`/api/memory`、`memory/` 的 store/ingestion/routes，每分钟的 `memorySweep`） | 删；§50 的长期记忆（`memory-notes/`）不受影响，`memory/tools.ts` 里每轮读记忆的中间件保留 | P4a 已删 `lib/memory.ts` |
| P4b-1 | 主动研究（`/api/proactive/*`，`proactive/` 的 engine/store/routes） | 删；`proactive/restriction.ts`、`private-share.ts` 是通用的只读 / 私密分享守卫，保留。生命周期重置仍会清旧的 `proactive.run` 队列行 | P4a 已删 `lib/proactive.ts` |
| P4b-1 | 意图路由（`POST /api/route`，`routing/` 的 classify/routes/service） | 删；`routing/model.ts`（工具选择用的模型补全）保留。审计类型 `channel.routed` 不再写，旧行照常显示 | 删 `lib/channels/route.ts`；「选了机器人再开对话」不再先发一条路由审计 |
| P4b-2 | 推送与可达性（Slack / Teams / 短信 Twilio / 手机推送，`/api/delivery*` 与 webhooks，`delivery/` 的 router/routes/opentag/push/twilio） | 删；`delivery/store.ts`、`types.ts` 保留（`delivery_*` 表、Slack 触发器读绑定表时用）；内部的 `deliveryNotifications` 变成空操作。生产没有配置任何推送通道、绑定 0 条 | P4a 已删 `lib/delivery.ts`、`/reachability` 重定向 |
| P4b-2 | 群聊（`/api/groups`） | 路由删掉；`channels/group.ts` 里的群聊服务保留（只被机器人交接用，交接也默认关了）。旧的多机器人对话打开时显示「已不再支持」 | 删 `/group` 链接（左栏、对话页跳转、频道事件里的群聊刷新） |
| P4b-2 | 团队机器人（`/api/team-bots`） | 路由删掉；`team-bots/team-bots.ts` 的访问判断保留（机器人一律私有后只是一条恒为自己的路径） | 删同意卡片 `team-bot-consent` 与 `lib/team-bots` |
| P4b-2 | 机器人之间交接（`hand_off`、群里 @ 别的机器人） | `BOT_HANDOFF_MAX_DEPTH` 默认改为 `0`：不给工具、不跑交接队列；设成 `1` 恢复上游行为 | 机器人设置窗里外部机器人的「回调令牌」面板删掉（外部框架适配器 P3 已删） |
| P4b-3 | 自动学习（`/api/admin/learning`，`learning/` 的 routes/settings/runtime/remote，学到的技能注入、Intelligence 线程的学习容器） | 删；只在 Intelligence 模式下才会生效，生产是 `local` 模式，一直是休眠的。`/api/capabilities` 仍返回 `learning: false`；`createApp` / `buildAgents` / `resolveRuntimeAgents` 里原来的位置参数留了一个空位（`_removedLearning` / `_removedLearnedSkills`），免得后面的参数错位。`learning_*` 表、`shared/learning.ts`（表的类型）、`scripts/setup-learning.ts`（Intelligence 开通脚本）保留 | P4a 已删 `/admin/learning` |
| P4b-3 | 身份提供者管理接口（`GET/DELETE /api/admin/identity-providers`） | 删；Better Auth 的 SSO / SCIM 插件、`/api/auth/*` 处理、人员表与 `/api/admin/people` **不动**（多用户账号工作 cb-accounts 正在改认证，见下） | P4a 已删 `/admin/identity-providers` |
| P4b-3 | 每个机器人一台电脑的 Docker supervisor（`COMPUTER_SUPERVISOR_URL`、`SUPERVISOR_TOKEN`） | 配置不再读，`createComputerProvider` 只剩 shared / sandbox。`computer/supervisor.ts` 暂留：电脑会话守卫的测试拿它当真实的按机器人提供方 | 无 |

**P4b 刻意留下（之后再做）：**

- ~~**企业控制闸门**~~ → P6-1 已删（见下）。
- ~~**SSO / SCIM 插件与 `/api/auth/*` 里的身份提供者分支**~~ → P6-2 已删（见下）。
- **语音**（`/api/voice`、`voice/`、网页 `voice-call-widget` 与 `lib/voice`）：2026-10-15 在 CB-046 第 2 步删掉（DESIGN.md §68.7）；`voice_sessions` 表留着，等 P5 一起决定。
- ~~**`worker/`**~~ → P6-3 已删（完整构建）。

## P6 多用户之后的服务端收尾（2026-10-15）

网关签名身份（CB-040）上线后，上游那套「企业」权限模型不再有用：身份来自网关，权限在每个接口里按本人 / 主人 / 管理员判断。朋友账号的界面入口 2026-10-15 起默认隐藏（`CHISABOT_ACCOUNTS_UI`，多用户以后再做），签名身份与按人隔离保留。

| PR | 内容 | 保留 |
|---|---|---|
| P6-1 | 删 `server/src/admin/`（`gate.ts` 每个 `/api/*` 前的能力开关闸门、`controls.ts`、`capabilities.ts`、`settings-store.ts`、`routes.ts` = `/api/admin/enterprise/*`）：能力开关（生产 0 行，全是默认允许）、模型允许名单与每轮 `model_usage` 记录、电脑动作的企业覆盖层（`setPolicyOverlay`）、MCP 允许名单、网络策略表、动作录制、长期不用的电脑自动停止、离职（offboard）、无头回合的 `headlessTurnRefusal`、审计 OpenTelemetry 导出（`telemetry/`）、`auth/sso-required.ts`；`/api/admin/people`（列表 / 改角色 / 移除 + 离职，前端早已没有入口；朋友账号由网关管理）；`auth/index.ts` 的「强制 SSO」改为恒 false（P6-2 再删整段）。审计类型里这些模块写的类型去掉（旧行照常显示） | `enterprise_settings` 表：现在只是 `model_connection`（默认模型）/ `model_fallbacks`（备用模型）两行的 KV，`model-settings.ts` / `model-fallback-settings.ts` 本来就直接读写，不经过企业控制。电脑网络策略：电脑在收到策略前拒绝一切连接，所以照旧在每次动作前和每 30 秒推一次 `allow_all`（`computer/policy-network.ts` 的 `NO_NETWORK_POLICY` / `startEgressPolicyPush`，和上游「没有组织策略行」时一样）。例行任务审计包装挪到 `routines/audit-store.ts`，`runtimeRun` 挪到 `agents/runtime-path.ts`（行为不变）。表 `capability_settings`、`network_policies`、`action_records`、`model_usage` 留到 P5 |
| P6-2 | 删 Better Auth SSO / SCIM 插件（`@better-auth/sso`、`@better-auth/scim` 的接入）、`auth/scim.ts`、`auth/identity-provider-store.ts`、`auth/encrypt-sso-config.ts`、`app.ts` 里 `/api/auth/*` 的身份提供者分支、`auth/index.ts` 的强制 SSO / break-glass；前端 `ssoClient` 与 sign 页「公司邮箱」框。审计类型 `identity_provider.*`、`session.break_glass`、`person.*provisioned` 去掉（旧行照常显示） | Better Auth 本身（会话、`users` / `user_roles`）、网关签名身份；`sso_providers` 等表留到 P5。依赖包本身在 P6-3 从 package.json 删 |
| P6-3 | 删 `worker/`（根 workspaces、Dockerfile、`deploy/Dockerfile.zh` 不再拷它的 package.json）、`scripts/setup-learning*.ts`、`scripts/self-hosted-learning*.ts`、`docs/automatic-learning.md`；依赖 `@better-auth/sso`、`@better-auth/scim`、`@better-auth/expo`（连同 `auth/index.ts` 的 Expo 插件与 `chisabotmobile://` 信任来源）、4 个 `@opentelemetry/*`；`bun.lock` 重生成 → 依赖指纹变化，部署是完整构建 | `learning_*` 等表、`shared/learning.ts` |
| P6-4 | 上游桌面端（`desktop/`，P3 已删）留下的服务端部分：Better Auth `electron` 插件与 `/api/auth/desktop` 交接页（`auth/native-browser.ts`，依赖 `@better-auth/electron`）；组织登录 `auth/organization.ts` / `organization-store.ts`（`CHISABOT_ORGANIZATION_AUTH_URL`，`local` 模式从不使用；现在设了会拒绝启动，而不是悄悄退回单用户）；原生文件夹代理 `server/src/host-access/`（`/api/host-access/*`、`host_*` 工具、审批里的 host 分支，只有上游桌面端轮询 `/desktop/next`）和管理页「云端浏览器」里的文件夹区块（`lib/computers/host-access.ts`）。`.env.example` / `docs/configuration.md` 去掉 OpenTag / Twilio / Expo / setup-learning 说明，`WORKER_SHARED_SECRET` 说明改成容器内定时任务扫描 | 审批的 `hostCommands` 策略列与类型（表结构不动）；`desktop-connection-failure.ts`（模型 / Intelligence 连接失败提示仍挂着）；聊天里的 `HostAccessHint`（在 chat-transcript.tsx，归聊天统一那条线，之后一起删）。**例行任务（routines）与 `chisabot_schedules`（§55）重叠**：两者生产都是 0 行，但 routines 仍被机器人工具 `builtin-routines`、`/routines` 页、IM / 面板 / 本地智能体的 initiator 引用，不算死代码 → 合并放到 P4c |

## P4c 合并重复系统（2026-10-15 起）

### P4c-1 上游 Routines → ChisaBot 定时任务（§55）

两套「到点让机器人做事」：上游 Routines（`routines` / `routine_runs`，按频道发、只有 cron、最少 15 分钟，机器人工具 `create_routine` 等，`/api/routines`、`/internal/routines/run` + `WORKER_SHARED_SECRET` 的进程内每分钟扫描，宿主机 `chisabot-zh-routines.timer` + `fire-routines.ts`）和 ChisaBot 定时任务（`chisabot_schedules`，对话里设、一次性 / 周期、回到原对话、IM 推回，`schedule_*` 工具，设置 → 定时任务）。生产两边都是 0 行；只留定时任务。

| 删掉 | 处理 |
|---|---|
| `server/src/routines/` 的 store / routes / runner / schedule / sweep / audit-store，`server/scripts/fire-routines.ts`，`deploy/chisabot-zh-routines.{service,timer}`，`docs/routines.md`，11 个只测它们的测试 | 删。`/api/routines/*`、`/internal/routines/run` 不再挂载（`createApp` 留两个位置空位）；进程内扫描、`WORKER_SHARED_SECRET` / `CHISABOT_ROUTINES_WORKER` 不再读 |
| 机器人工具 `create_routine` / `list_routines` / `update_routine` / `delete_routine` | 删；内置传输改名 `plugins/builtin-triggers.ts`，只剩职责的触发器工具。目录键 `routines`、传输类型 `builtin-routines` 是存下来的标识，名字不变（标题改「Triggers」） |
| 审计类型 `routine.*`、`routines.dispatch_refused`、`routines.run_requested` | 不再写（旧行照常显示） |

**挪走而不是删：** 无头回合的运行器（IM、面板刷新、后台任务、工作流、定时任务、审批续跑都用它）从 `routines/run-turn.ts` 挪到 `server/src/turns/run-turn.ts`，类型 `TurnRunner` / `DrawnComponent` 在 `turns/types.ts`；`shared/routine-firing.ts`（到点消息的外框，聊天里画成一行）不变。审计里无头回合的 initiator 仍是 `routine`（数据格式）。

**改读定时任务：** 机器人资料「动态」的定时项、重置 / 删除机器人提示里的「N 个定时任务」改读 `chisabot_schedules`（重置会取消这个机器人为你设的进行中 / 已暂停任务）；`ResetPlan.routines` 改名 `schedules`。`/routines` 早已重定向到 `/settings/schedules`（P1），保留。

**保留：** `routines` / `routine_runs` / `routine_sweeps` 表和 drizzle 定义、迁移（P5 再决定）；删机器人时这些表的行照旧随外键级联。

## 新版本前的功能精简（2026-10-16，DESIGN.md §74）

用户：「遍历审查chisabot的全部功能…没有必要的进行隐藏或者删除」。审查表在 PR 描述里。

- **隐藏（可恢复）**：工作流、插件与 MCP、权限规则、上游 UI 组件目录 → `CHISABOT_EXTRAS`（默认空 = 全藏；`all` 全开）。入口不显示、旧地址回设置、工作流不再给机器人工具；接口、表、数据都在。
- **删除（死代码）**：上游「在对话里建机器人」（`save_bot` 卡片和三个只读前端工具，只对装了 `bot-creator` 技能的机器人出现，中文部署包没有这个技能）。
- **新建机器人**改成两格（名称 + 它做什么），见 §74.2。

