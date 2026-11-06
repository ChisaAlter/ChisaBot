# Task center core contract

Core implementation and routes are available. `bun x tsc --noEmit --project server/tsconfig.json` passed on 2026-11-06 after implementation. PostgreSQL behavior verification is next; environment inventory reports local PostgreSQL absent. Root should provision the isolated database and provide its non-secret test entry point. Shared contract is `shared/task-center.ts`; root owns `server/src/task-center/runtime.ts` and `sources.ts`.

`createTaskCenter(database, options)` options:

```ts
collect(ownerUserId: string, source: TaskCenterSource): Promise<TaskDiscovery[]>
execute(task: TaskCenterTask, context: TaskExecutionContext): Promise<TaskExecutionResult>
plan?(task: TaskCenterTask, context: TaskContext, signal: AbortSignal): Promise<TaskPlan>
notify?(ownerUserId: string, decision: TaskCenterDecision): Promise<void>
capabilities?(ownerUserId: string): Promise<TaskCapability[]>
botAvailable?(ownerUserId: string, agentId: string): Promise<boolean>
concurrency?: number // default 2 per owner
```

Return: `ensure`, `routes(requireUser)`, `start`, `stop`, `sweep`, `snapshot(owner)`, `listTasks(owner)`, `getTask(owner,id)`, `createTask(owner,input)`, `controlTask(owner,id,action)`, `listDecisions(owner)`, `decide(owner,id,approved)`, `listSources(owner)`, `createSource(owner,input)`, `updateSource(owner,id,patch)`, `scanSource(owner,id)`, `getContext(owner)`, `setContext(owner,input)`, `taskEvents(owner,id)`, `capabilities(owner)`.

HTTP prefix `/api/task-center`: GET `/`; GET/POST `/tasks`; GET `/tasks/:id` returns `{task,events,children}`; POST `/tasks/:id/{start,pause,resume,retry,cancel}` returns `{task}`; GET `/outbox`; POST `/outbox/:id/decide` `{approved:boolean}`; GET/POST `/sources`; PATCH `/sources/:id`; POST `/sources/:id/scan`; GET/PUT `/context`; GET `/capabilities`.

All list envelopes `{tasks}`, `{outbox}`, `{sources}`, `{context}`, `{capabilities}`. Snapshot is `TaskCenterSnapshot`. POST `/tasks` creates Inbox entry; explicit start enqueues it. Sources auto-start only read/internal tasks when enabled. Sensitive/external/publish tasks require immutable Outbox approval, regardless of L1–L5. Source config contains non-secret references; runtime credentials stay in existing vault/connections.

## 部署与生产验证（2026-11-06）

- 部署：main @ `6a290afc` 经 chisabot-updater 快速更新上线（`auto-202611060433-6a290af`），约 2 分钟，含备份 + 健康检查。
- 生产 E2E：19/19 通过——上下文 PUT/GET、L3 经 governedTurnRunner 真实执行（真实摘要 + 事件）、external 风险进 `waiting_approval`、Outbox 审批后放行完成、decision 通知成功、tasks/messages 两类巡检源扫描入 Inbox、容器重启后租约恢复并 `succeeded`。
- E2E 抓到并已修复的两个真缺陷：
  1. `9d04002`：Bun SQL `unsafe` 不把 JS 数组编码成 `text[]`（空 dependencies → malformed array literal）→ 全部改 `string_to_array($n, chr(31))`。
  2. `6a290af`：回合被宿主工具网关 5xx 异常终止后线程被标 `paused/held`，重试沿用同一线程永久 409「保留的消息已暂停」→ 线程按尝试序号独立（`taskThreadId` = `task-center:<id>:<tag>:<attempt>`）。生产注入 paused 回归验证：attempt 1 409 → `retry_scheduled` → attempt 2 新线程真实执行 `succeeded`。
- 回归测试：`task thread identity` 用例钉住按尝试换线程的不变量。
- 本机运维通道：回环 `127.0.0.1:3001` + `x-chisabot-local-caller` 头（值 = `CHISABOT_GATEWAY_SECRET`）免会话调 API。

### 第二轮补齐（`d37eadf2` + `1702da69`，已上线 `auto-202611060641-1702da6`）

- 交付物：`execute` 把回合画出的组件映射成 `TaskArtifact`（`componentArtifacts`），生产验证 `showBarChart` → 可预览/下载 artifact。
- 用量：从 `openbot_local_events` 的 `RUN_FINISHED` → `metadata.contextUsage` 读真实 token（`sum(...)::int`，bigint 会吐字符串）；生产验证 `{modelCalls:1, inputTokens:46571, outputTokens:314}` 全 number。
- 已学到：`learn` 终态回调（成功 + 终态失败）→ `appendLearned` 追加履历行（超 5000 字丢最旧），人工六字段不动；生产验证两行正确累积。
- 注：Bun SQL `unsafe` 对 `JSON.stringify` 过的 jsonb 参数存在双重编码（库存 `"[]"`/`"{}"` 字符串），`taskView` 的 `json()` 双向解析恰好抵消——无功能影响，未动。

### 第三轮：A–E 五线补齐（`3df9df08`，已上线 `auto-202611060741-3df9df0`）

生产验证（2026-11-06，x-chisabot-local-caller 通道）：

- **A**：`PUT /roots` `/workspace` 入库 → `GET /roots` 返回 → `source:documents` 能力 `available:true`（DB 目录即时生效，无需 env）。
- **C**：L1 任务 `VERIFY-MEM` succeeded → `chisabot_memory_notes` 出现 `任务·VERIFY-MEM …` project 笔记 + `learned` 履历正确累积。
- **E**：`GET /tasks/:id/trace` → 1 个执行线程、18 事件、usage `{modelCalls:1, inputTokens:71187, outputTokens:1445}`。
- **B**：`executor=local-agent:codex` 任务 → 真实创建 `chisabot_local_agent_tasks`（设备 `Ayase`、codex、workspace 档）——派发链路走通；两次尝试失败原因是**设备上 codex 自身 oauth token_revoked**（设备环境/凭据问题，非派发代码）。能力面板 `executor:local-agent` `available:true`。
- **D**：external 任务进 `waiting_approval`，decision `notificationError=null`——站内行+IM 查询路径跑通无报错；生产无已连 IM 会话，实际推送未触达（代码路径已验，真实送达待有 IM 连接时复验）。
- 修复：E2E 抓到 `local-agent:<kind>` 后缀形式不进委派分支（严格等值判断）→ `isLocalAgentExecutor` 前缀匹配 + 回归测试。

- **A 授权目录进设置**：`task-center/roots.ts`（`chisabot_task_center_roots`，owner 主键去重、`taskCenterRootPath` 校验拒绝相对路径/穿越/凭据样式、50 个上限）+ `GET/PUT/DELETE /api/task-center/roots`（routes 第三参 `deps` 可选注入）；`index.ts` 的 `localRoots` 变 owner 级异步 = env ∪ DB；UI 在源设置页加「授权目录」区块。
- **B local-agent 执行器**：`task-center/local-agent-runner.ts`（`executor=local-agent` 或 `local-agent:codex` 指定 agent → `localAgents.start` 委派 → 轮询 `chisabot_local_agent_tasks` 终态 → diff 文件映射 artifacts；取消信号触发 stop；设备挑选/权限档位/隔离/审批/并发全走 local-agents 既有闸门）。UI：面板栏首位内置卡 `agents-rail-card.tsx`（折叠态存 preference-storage），设备在线/档位三档/agent 检测徽标/重新检测，复用 `/api/local-agents` 与 `/api/devices`。
- **C 真记忆**：`learn` 终态回调同时往 memory-notes 写 `project` 笔记（subject=`任务·<标题>`，同名自动合并）；`memoryBrief` 按标题+类目 `memoryNotes.search` 取 6 条注入执行指令；frameTask 加一句引导执行回合自己用 memory_save。
- **D IM 触达**：`recordNotice` 站内行之外，查 `chisabot_im_chats`（owner+agent、private、有 last_inbound）最近活跃私聊，`imService.pushToThread(privateOnly)` 推送；无 IM 会话静默跳过。
- **E 执行轨迹**：`task-center/trace.ts`（`task-center:<id>:*` 线程 → openbot_local_events → 按尝试分组投影工具调用/文本/用量，`GET /tasks/:id/trace`）；任务详情页第三 tab「执行轨迹」运行中 30s 轮询。
- 测试：roots 6 例 + trace 6 例 + executor 路由 2 例，共 31/31；双 typecheck 绿。
- 仍未接：委派任务的设备上 codex/claude 凭据需各自有效（生产 Ayase 上 codex oauth 过期）；预算门 / 线程清理 / 机会研判 / 源健康告警是下一阶段。
