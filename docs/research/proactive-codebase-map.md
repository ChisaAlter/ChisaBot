# 主动任务中心：现有代码与接入位置

核对日期：2026-11-06。依据当前分支源码；`docs/architecture.md` 的旧版本说明仅作导航。本次只做代码映射，没有执行集成验证。

## 建议：扩展现有运行器，增加统一任务域

ChisaBot 已有后台模型回合、持久队列、事件触发、工作流、审批恢复、设备 Agent 和个人信息源。任务中心应复用这些执行与权限入口，增加统一的任务、来源、计划、成果和 Outbox 视图。无需再引入独立模型代理服务器、第二套密钥库或第二套登录。

发现与执行需要分开：现有 `proactive:` 发起者刻意只能读，不能写工具、调用浏览器或委派其他 Bot。保留这个契约；任务执行采用有明确权限和计划的执行上下文。L1–L5 表示独立完成程度，不是权限提升等级。即便任务评为 L5，邮件发送、发布等受控步骤仍由具体授权决定。

## 可直接复用的模块

| 能力 | 当前源码与接口 | 任务中心用法和约束 |
|---|---|---|
| 服务装配与认证 | `server/src/index.ts`；`app.ts` 的额外 routes；`auth/guards.ts` | 新域在 index 中注入数据库、actor、Bot 解析及执行器；路由统一使用 `requireUser`，查询按 owner 过滤。 |
| PostgreSQL | `server/src/db/client.ts`：`createDatabase`；`db/schema/` | 复用现有数据库。ChisaBot 自有表有启动 `ensure()` 建表惯例，上游表走 Drizzle migration。新增表需登记数据模型并支持备份。 |
| 持久后台队列 | `server/src/work/queue.ts`：`createWorkQueue`，`offer/claim/renew/finish/release/purge`；`db/schema/work.ts` | `kind/key` 唯一；领取带租约和 attempts；可延迟执行与限制重试。发现事件、任务行、排队应同事务提交，避免只存任务却未排队。不可把第二次 claim 当作第一次执行，外部效果要复核。 |
| 不重叠的扫描 | `server/src/work/loop.ts`：`repeatAfterEach` | 一次 sweep 完成后才排下一次，避免长任务导致 setInterval 无界并发。共享数据库中仍须租约/CAS，单进程定时器不能代替分布式领取。 |
| 真实 Agent 回合 | `server/src/turns/types.ts`：`TurnRunner`；`turns/run-turn.ts`：`createTurnRunner` | 参数含 owner、agent、thread、instruction、initiator、signal、runId、onText；返回 replyText/components。index 的 `governedTurnRunner` 复用模型、工具、暂停和审核。本地模式使用 `localBackend.client/runner`，不需要 Intelligence 云服务。 |
| Bot 权限与模型 | `agents/runtime-agents.ts`、`agent-resolver.ts`、`profile-store.ts`、`model-selection.ts` | 每次按 actor 加载可用 Bot 和凭据；不要缓存其他用户的 endpoint 或把部署 token 发给用户自有 endpoint。 |
| 现有工作流 | `workflows/engine.ts`：`createWorkflowEngine`，`start/approve/cancel/recover/view`；`shared/workflows.ts` | 已支持角色绑定、步骤、相邻同 group 并行、技能、输入、输出交接、工具约束、token/时长/步骤限制和审批。每步独立临时对话，软删除后成果仍保留在 workflow run。它是阶段式并行，不是任意依赖 DAG。 |
| 工作流工具约束 | `workflows/policy.ts`：`registerStepPolicy`、`restrictToolsForWorkflow`、`filterHeadlessForWorkflow` | 同时过滤提供给模型的工具和实际执行；未登记的 workflow initiator 拒绝全部。任务规划不能靠提示词实现权限隔离。 |
| 长期职责与触发 | `responsibilities/types.ts/store.ts/engine.ts/triggers.ts` | 已有职责 active/paused/completed、运行 queued/running/waiting/succeeded/failed/skipped、成功条件、进度、事件去重。事件、run ledger、work_items 同事务。GitHub/Slack/Linear/Sentry/PagerDuty/Email/Webhook 有各自鉴权入口。可作为长期跟进底座，但需补 Inbox 分类与任务决策域。 |
| 后台子任务 | `workers/service.ts`：`createWorkerService.start/get/updatePlan`；`thread-inbox.ts` | 适合聊天内委派，结果回父对话，有并发上限、停止和进度；只有 localBackend 下装配。不是统一任务中心，也没有完整任意依赖图。 |
| 设备本地 Agent | `local-agents/service.ts`：`start/stop/applyChanges/settingsFor/saveSettings`；`shared/local-agents.ts`；`pc/src/agent-runtime/` | 已接 builtin/Claude/Codex/OpenCode/Gemini/Aider，设备进度回传、diff、应用/放弃、权限档位。Pi/DSH/Super-Agent 尚不在种类枚举；适配应沿此路径或远端 AG-UI/Mastra 路径，保留设备权限。 |
| CLI 隔离 | `pc/src/agent-runtime/cli-agents.js`、`sandbox.js`、`detect.js`；`shared/local-agents.ts` | readonly/workspace/full 取设备与任务较严者；worktree/copy 是待应用副本，非系统沙箱；bwrap/sandbox-exec/docker/podman 为系统隔离；wsl 只表示运行位置。需要在具体平台验证执行与停止。 |
| MCP 与连接器 | `plugins/store.ts/tools.ts/mcp.ts/transport.ts/composio.ts` | MCP 使用 Streamable HTTP，工具按用户授权、策略、审计后执行；供应商错误与部署拒绝分开。调用结果经 `markUntrusted` 标记。Codex 当前连接器会话不能当作后台服务凭据。 |
| Skills | `skills-chisa/tools.ts`、`plugins/selection.ts`、`plugins/store.ts` | 复用已授权技能目录和两阶段工具选择；workflow 亦能带库中技能。不要为任务中心另建技能格式。 |
| 邮件、日历、通知 | `personal-sources/service.ts`：`status/listEvents/listEmails/checkProactiveUpdates/pushNotifyMessage/triggerInboundWebhook` | ICS/IMAP、SMTP、通知 Webhook，敏感字段加密存库。任务发现宜调用具体 read API 并保留错误。`checkProactiveUpdates` 将邮件/日历异常变为空列表，不适合作为来源健康依据。 |
| GitHub | `github/service.ts`：`tools/status/guidance/decide/actionById` | 已有读仓库/Issue/PR/文件及写入提案确认。`api/read` 是内部函数，外部采集需通过受限工具或正式扩展服务接口，不能直接读取库中 token。 |
| 个人上下文 | `memory-notes/service.ts`：`context/search/create/update`；`index.ts` 的 context 注入 | 共享个人记忆支持按 Bot 开关、主题和每日记录；新任务上下文引用来源及更新时间，避免从任务原文直接覆盖已确认偏好。 |
| 用户确认 | `confirmations/service.ts`：`wrap/check/decide/list/setResume/setOnOpened` | 后台回合产生 deferred 卡片；用户决定后可重启同线程，通过参数摘要匹配的一次性 grant 继续。Outbox 应呈现这些具体动作，不能批准一个泛化“全权限任务”来跳过工具确认。 |
| 连接器审批 | `approvals/service.ts/store.ts/execute.ts/question-resume.ts` | 已有审批 snapshot/continuation 与 `HeadlessToolSuspension`，工作流/职责能暂停等待并恢复。需统一显示与任务关联，避免再造一个与实际执行脱节的批准状态。 |
| 工具与运行记录 | `audit.ts`、`computer/activity-store.ts`、`local-conversations.ts` | local run control `observe(threadId, listener)` 可订阅 AG-UI 事件；对话/事件持久化可回看工具调用。看板引用任务 run/thread ID，避免另存密钥或完整敏感参数副本。 |
| 现有 UI | `app/src/routes/_authed/_app/workflows.*`、`approvals.tsx`、`settings/schedules.tsx`、`settings/connected-accounts/` | 复用运行状态和详情组件；统一任务中心应有独立可发现入口与 Inbox/Outbox/运行/来源健康，而不要求用户进入多个隐藏 extras 页面。 |

## 关键接线位置

`index.ts` 已按下列关系装配，可在同一位置注入新服务：

1. `memoryNotes`、`personalSources` 和 `github` 初始化；普通 Bot 的工具经 `confirmations.wrap(...)` 注册。
2. `routineIntelligence` / `routineAgentRunner` 在 local 模式指向本地持久会话后端；`governedTurnRunner` 共享实际 Bot 构造和 computer 权限。
3. `workflowEngineInstance = createWorkflowEngine(...)` 注入 `channelStore.create/softDelete`、`agentProfileStore.get` 和 `pluginStore.listSkills`。
4. `responsibilityEngine` 使用 work queue；审批 sweep 将已批准动作恢复到职责等待运行。
5. 额外路由数组注册 `/api/personal-sources`、`/api/schedules`、`/api/local-agents` 等；shutdown 停止各 sweep。

新任务域建议持有任务身份、owner、来源去重键、类别、优先级、L1–L5 评估与理由、状态、Bot/executor、依赖、验收条件、run/thread/workflow 关联、成果引用和错误。执行记录、审批记录继续使用各自现有权威表；Outbox 是任务关联的待决策集合。

## 需要真正补齐的行为

- **统一发现与去重**：个人源有读取工具，职责有事件入口，但没有完成本需求的统一巡检→候选→Inbox 分类闭环。每源应保存游标/外部 ID、上次成功、下一次扫描、错误；无连接和故障不能显示为“没有待办”。
- **自动规划和可执行性判断**：现有工作流由定义驱动。需要把目标、上下文、工具及授权转为可验证的计划和 L 等级，并说明需要人工的环节；不能只按任务关键词打等级。
- **依赖与并行**：现有 workflow 的相邻并行组可覆盖阶段计划。若生成任意 `dependsOn`，必须检查不存在节点、环和跨 owner 依赖，并按就绪依赖调度。
- **恢复与重试**：workflow `recover()` 将过期运行标为失败；worker/local Agent 也会记录中断，不意味着自动续做已完成步骤。新任务层须保留完成节点并判断重试是否会重复外部副作用。不可将“重启后变红”描述为成功恢复执行。
- **持续跟进**：职责 engine 单次运行结束并不等于任务完成；要按交付条件决定继续、等待来源、请求决策或交付，保留可恢复 checkpoint。
- **准确计费**：workflow 的 token 预算含估算；`ops-budget.ts` 是运行错误预算，并非模型费用额度。成本看板应区分真实 usage、估算和未知值。
- **真实信息源验收**：personal-sources 中仍有 demo IMAP、SMTP、Webhook 路径。验收必须排除 simulated 返回；外部连接的真实授权、读取及失败反馈分别验证。
- **长期运行**：应用进程存活时后台 sweep 可运行；无人值守开机启动、重启恢复、数据库备份/迁移与源授权续期仍需具体部署验证。

## 完成时应观察到的结果

| 场景 | 决定性证据 |
|---|---|
| 真实来源发现 | 已连接邮件/日历/仓库或授权本地项目产生一个有来源与去重键的 Inbox 任务；再次扫描不重复。 |
| 自主执行 | 一个真实可安全执行的任务经过分类、计划、工具调用和成果验证，产生可打开的交付物。 |
| HITL | 具体对外动作进入 Outbox，批准前无外部副作用；批准一次后按同一内容执行一次；拒绝不执行。 |
| 并行依赖 | 两个独立步骤并行完成，依赖它们的步骤在前置完成后启动；失败阻断依赖并显示原因。 |
| 异常恢复 | 服务在已知任务阶段中断后重启，保留成果/等待项，安全恢复可重试步骤；未确认外部动作不盲目重发。 |
| 权限与来源异常 | 越权 owner、未配置执行器、撤销连接均给出准确状态；不回退为“成功”或空 Inbox。 |
| 看板与后台部署 | 宽/窄/暗色实际渲染和主要操作可用；后台服务有真实进程、健康入口及启动恢复路径。 |

本映射仅支持上述接入判断，不能代替实现后的实际环境证据。
