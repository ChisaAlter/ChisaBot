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
