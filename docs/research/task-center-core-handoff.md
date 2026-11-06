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
