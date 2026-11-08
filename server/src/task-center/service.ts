import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import {
  contextInputSchema,
  needsTaskApproval,
  sourceInputSchema,
  TASK_STATUSES,
  type TaskCapability,
  type TaskCenterDecision,
  type TaskCenterEvent,
  type TaskCenterSnapshot,
  type TaskCenterSource,
  type TaskCenterTask,
  type TaskContext,
  type TaskDiscovery,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type TaskInput,
  type TaskPlan,
  type TaskSourceInput,
  type TaskStatus,
  taskInputSchema,
  validateTaskPlan,
} from "../../../shared/task-center";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { executionDeadline, withCapacityFeedback, CAPACITY_WAIT_MESSAGE } from "../conversations/capacity";
import { createTaskCenterRoutes } from "./routes";
import { BackgroundTurnNeedsReview } from "../turns/durable-outcome";
import { conversationAdmissionClosed } from "../conversations/maintenance";
import { assertTaskEvidence, TaskResultNeedsReview } from "./outcome";

export class TaskCenterError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TaskCenterError";
  }
}
export type TaskCenterOptions = {
  collect: (
    ownerUserId: string,
    source: TaskCenterSource,
  ) => Promise<TaskDiscovery[]>;
  execute: (
    task: TaskCenterTask,
    context: TaskExecutionContext,
  ) => Promise<TaskExecutionResult>;
  plan?: (
    task: TaskCenterTask,
    context: TaskContext,
    signal: AbortSignal,
  ) => Promise<TaskPlan>;
  notify?: (ownerUserId: string, decision: TaskCenterDecision) => Promise<void>;
  /** 任务到达终态（成功或失败）后回写「已学到」的个人上下文；记账失败不影响任务结果。 */
  learn?: (
    ownerUserId: string,
    task: TaskCenterTask,
    outcome: { status: "succeeded" | "failed"; detail: string },
  ) => Promise<void>;
  capabilities?: (ownerUserId: string) => Promise<TaskCapability[]>;
  botAvailable?: (ownerUserId: string, agentId: string) => Promise<boolean>;
  concurrency?: number;
  globalConcurrency?: number;
  /** True resumes the same persisted execution attempt instead of creating another one. */
  hasDurableExecution?: (task: TaskCenterTask) => Promise<boolean>;
};
type Sql = Pick<Database["$client"], "unsafe">;
// biome-ignore lint/suspicious/noExplicitAny: 原生 SQL 行的形状是动态的，逐字段取用。
type Row = Record<string, any>;
const iso = (value: Date | string | null) =>
  value ? new Date(value).toISOString() : null;
const isoReq = (value: Date | string) => new Date(value).toISOString();
const json = <T>(value: T | string): T =>
  typeof value === "string" ? JSON.parse(value) : value;
const terminal = new Set<TaskStatus>(["succeeded", "failed", "cancelled"]);
const leaseSeconds = 90;
const eventLimit = 12000;

function taskView(row: Row): TaskCenterTask {
  const payload = json(row.payload);
  return {
    ...payload,
    workspace: payload.workspace ?? null,
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    parentId: row.parent_id,
    sourceId: row.source_id,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    dependencies: row.dependencies,
    priority: row.priority,
    attempts: row.attempts,
    planPrepared: row.plan_prepared,
    summary: row.summary,
    artifacts: json(row.artifacts),
    usage: json(row.usage),
    error: row.error,
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    nextAttemptAt: isoReq(row.next_attempt_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    version: row.version,
  };
}
function sourceView(row: Row): TaskCenterSource {
  const payload = json(row.payload);
  return {
    ...payload,
    workspace: payload.workspace ?? null,
    id: row.id,
    ownerUserId: row.owner_user_id,
    enabled: row.enabled,
    config: json(row.config),
    nextRunAt: isoReq(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    lastStatus: row.last_status,
    lastError: row.last_error,
    failures: row.failures,
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}
function decisionView(row: Row): TaskCenterDecision {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    taskVersion: row.task_version,
    summary: row.summary,
    proposedAction: json(row.proposed_action),
    status: row.status,
    createdAt: isoReq(row.created_at),
    decidedAt: iso(row.decided_at),
    notificationError: row.notification_error,
  };
}

/** One durable queue for discovery, execution and decisions, using the application's PostgreSQL. */
export function createTaskCenter(
  database: Database,
  options: TaskCenterOptions,
) {
  const sql = database.$client;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));
  const globalConcurrency = Math.max(
    concurrency,
    Math.min(16, options.globalConcurrency ?? 4),
  );
  const instance = randomUUID();
  const controllers = new Map<string, AbortController>();
  const jobs = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  let stopping = false;

  async function ensure() {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_tasks (
      id text PRIMARY KEY, owner_user_id text NOT NULL, payload jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('inbox','queued','planning','running','waiting_dependencies','waiting_approval','paused','succeeded','failed','cancelled')),
      parent_id text, source_id text, source_ref text, source_url text, dependencies text[] NOT NULL DEFAULT '{}',
      priority integer NOT NULL DEFAULT 50, attempts integer NOT NULL DEFAULT 0, plan_prepared boolean NOT NULL DEFAULT false,
      summary text, artifacts jsonb NOT NULL DEFAULT '[]', usage jsonb NOT NULL DEFAULT '{}', error text,
      version integer NOT NULL DEFAULT 1, lease_owner text, lease_expires_at timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    )`);
    await sql.unsafe(
      "CREATE INDEX IF NOT EXISTS chisabot_task_center_due ON chisabot_task_center_tasks(status,next_attempt_at,priority)",
    );
    await sql.unsafe(
      "CREATE INDEX IF NOT EXISTS chisabot_task_center_owner ON chisabot_task_center_tasks(owner_user_id,created_at)",
    );
    await sql.unsafe(
      "CREATE UNIQUE INDEX IF NOT EXISTS chisabot_task_center_discovery ON chisabot_task_center_tasks(owner_user_id,source_id,source_ref) WHERE source_id IS NOT NULL AND source_ref IS NOT NULL",
    );
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_events (
      id text PRIMARY KEY, owner_user_id text NOT NULL, task_id text NOT NULL REFERENCES chisabot_task_center_tasks(id),
      type text NOT NULL, message text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.unsafe(
      "CREATE INDEX IF NOT EXISTS chisabot_task_center_event_task ON chisabot_task_center_events(owner_user_id,task_id,created_at)",
    );
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_decisions (
      id text PRIMARY KEY, owner_user_id text NOT NULL, task_id text NOT NULL REFERENCES chisabot_task_center_tasks(id),
      task_version integer NOT NULL, summary text NOT NULL, proposed_action jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')), notification_error text,
      created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
      UNIQUE(task_id,task_version)
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_sources (
      id text PRIMARY KEY, owner_user_id text NOT NULL, payload jsonb NOT NULL, config jsonb NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT true, next_run_at timestamptz NOT NULL DEFAULT now(), last_run_at timestamptz,
      last_status text NOT NULL DEFAULT 'idle', last_error text, failures integer NOT NULL DEFAULT 0,
      lease_owner text, lease_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_context (
      owner_user_id text PRIMARY KEY, content jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.unsafe(
      "ALTER TABLE chisabot_task_center_context ADD COLUMN IF NOT EXISTS learned text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS learned_at timestamptz",
    );
  }

  async function event(
    owner: string,
    taskId: string,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
    tx: Sql = sql,
  ) {
    const encoded = JSON.stringify(data);
    await tx.unsafe(
      "INSERT INTO chisabot_task_center_events(id,owner_user_id,task_id,type,message,data) VALUES($1,$2,$3,$4,$5,$6::text::jsonb)",
      [
        randomUUID(),
        owner,
        taskId,
        type.slice(0, 100),
        message.slice(0, eventLimit),
        encoded.length <= eventLimit
          ? encoded
          : JSON.stringify({ truncated: true }),
      ],
    );
  }
  async function getTask(
    owner: string,
    id: string,
  ): Promise<TaskCenterTask | null> {
    const [row] = await sql.unsafe<Row[]>(
      "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2",
      [owner, id],
    );
    return row ? taskView(row) : null;
  }
  async function mustTask(owner: string, id: string) {
    const task = await getTask(owner, id);
    if (!task) throw new TaskCenterError("找不到这个任务。", 404);
    return task;
  }
  async function listTasks(owner: string): Promise<TaskCenterTask[]> {
    return (
      await sql.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 500",
        [owner],
      )
    ).map(taskView);
  }
  async function taskEvents(
    owner: string,
    id: string,
  ): Promise<TaskCenterEvent[]> {
    await mustTask(owner, id);
    return (
      await sql.unsafe<Row[]>(
        "SELECT * FROM (SELECT * FROM chisabot_task_center_events WHERE owner_user_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 500) e ORDER BY created_at",
        [owner, id],
      )
    ).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      type: r.type,
      message: r.message,
      data: json(r.data),
      createdAt: isoReq(r.created_at),
    }));
  }
  async function checkBot(owner: string, agentId?: string | null) {
    if (
      agentId &&
      options.botAvailable &&
      !(await options.botAvailable(owner, agentId))
    )
      throw new TaskCenterError("机器人不可用或不属于当前账号。", 403);
  }
  async function insertTask(
    tx: Sql,
    owner: string,
    input: TaskInput,
    extra: {
      id?: string;
      parentId?: string;
      sourceId?: string;
      sourceRef?: string;
      sourceUrl?: string;
      status?: TaskStatus;
    } = {},
  ) {
    const parsed = taskInputSchema.parse(input);
    const dependencies = [...new Set(parsed.dependencies)];
    if (dependencies.length) {
      const found = await tx.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=ANY(string_to_array($2, chr(31)))",
        [owner, dependencies.join("\x1f")],
      );
      if (found.length !== dependencies.length)
        throw new TaskCenterError("依赖任务不存在或不属于当前账号。");
    }
    const { dependencies: _deps, priority, ...payload } = parsed;
    const id = extra.id ?? randomUUID();
    const rows = await tx.unsafe<Row[]>(
      `INSERT INTO chisabot_task_center_tasks
      (id,owner_user_id,payload,status,parent_id,source_id,source_ref,source_url,dependencies,priority)
      VALUES($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,string_to_array($9, chr(31))::text[],$10)
      ON CONFLICT (owner_user_id,source_id,source_ref) WHERE source_id IS NOT NULL AND source_ref IS NOT NULL DO NOTHING RETURNING *`,
      [
        id,
        owner,
        JSON.stringify({
          ...payload,
          agentId: payload.agentId ?? null,
          workspace: payload.workspace ?? null,
        }),
        extra.status ?? "inbox",
        extra.parentId ?? null,
        extra.sourceId ?? null,
        extra.sourceRef ?? null,
        extra.sourceUrl ?? null,
        dependencies.join("\x1f"),
        priority,
      ],
    );
    if (!rows[0]) return null;
    await event(
      owner,
      id,
      "created",
      extra.sourceId ? "巡检发现任务，已进入 Inbox。" : "任务已进入 Inbox。",
      {},
      tx,
    );
    return taskView(rows[0]);
  }
  async function createTask(
    owner: string,
    input: TaskInput,
  ): Promise<TaskCenterTask> {
    await checkBot(owner, input.agentId);
    const task = await sql.begin((tx) => insertTask(tx, owner, input));
    if (!task) throw new TaskCenterError("任务没有创建成功，请重试。");
    return task;
  }
  async function listDecisions(owner: string): Promise<TaskCenterDecision[]> {
    return (
      await sql.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_decisions WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 300",
        [owner],
      )
    ).map(decisionView);
  }
  async function approvedDecision(
    task: TaskCenterTask,
  ): Promise<TaskCenterDecision | null> {
    const [row] = await sql.unsafe<Row[]>(
      "SELECT * FROM chisabot_task_center_decisions WHERE owner_user_id=$1 AND task_id=$2 AND task_version=$3 AND status='approved'",
      [task.ownerUserId, task.id, task.version],
    );
    return row ? decisionView(row) : null;
  }
  async function requestApproval(
    tx: Sql,
    task: TaskCenterTask,
  ): Promise<TaskCenterDecision | null> {
    await tx.unsafe(
      "UPDATE chisabot_task_center_tasks SET status='waiting_approval',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
      [task.ownerUserId, task.id],
    );
    const [row] = await tx.unsafe<Row[]>(
      `INSERT INTO chisabot_task_center_decisions(id,owner_user_id,task_id,task_version,summary,proposed_action,status)
      VALUES($1,$2,$3,$4,$5,$6::text::jsonb,'pending') ON CONFLICT(task_id,task_version) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        task.ownerUserId,
        task.id,
        task.version,
        `${task.title}：此操作需要你确认。`,
        JSON.stringify({
          title: task.title,
          description: task.description,
          executor: task.executor,
          risk: task.risk,
        }),
      ],
    );
    if (row)
      await event(
        task.ownerUserId,
        task.id,
        "approval_requested",
        "已进入 Outbox，等待确认具体操作。",
        { decisionId: row.id },
        tx,
      );
    return row ? decisionView(row) : null;
  }
  async function notify(decision: TaskCenterDecision | null) {
    if (!decision || !options.notify) return;
    try {
      await options.notify(decision.ownerUserId, decision);
    } catch (error) {
      await sql.unsafe(
        "UPDATE chisabot_task_center_decisions SET notification_error=$2 WHERE id=$1 AND owner_user_id=$3",
        [
          decision.id,
          reasonWithoutStatement(error).slice(0, 1500),
          decision.ownerUserId,
        ],
      );
    }
  }
  async function controlTask(
    owner: string,
    id: string,
    action: "start" | "pause" | "resume" | "retry" | "cancel",
  ): Promise<TaskCenterTask> {
    const requested: TaskCenterDecision[] = [];
    await sql.begin(async (tx) => {
      const [row] = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      );
      if (!row) throw new TaskCenterError("找不到这个任务。", 404);
      let task = taskView(row);
      if (action === "cancel" || action === "pause") {
        if (terminal.has(task.status))
          throw new TaskCenterError("任务已经结束。", 409);
        await tx.unsafe(
          `WITH RECURSIVE descendants AS (
          SELECT id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2
          UNION ALL SELECT t.id FROM chisabot_task_center_tasks t JOIN descendants d ON t.parent_id=d.id WHERE t.owner_user_id=$1
        ) UPDATE chisabot_task_center_tasks SET status=$3, lease_owner=NULL,lease_expires_at=NULL,updated_at=now(),
          finished_at=CASE WHEN $3='cancelled' THEN now() ELSE finished_at END
          WHERE owner_user_id=$1 AND id IN (SELECT id FROM descendants) AND status NOT IN ('succeeded','failed','cancelled')`,
          [owner, id, action === "cancel" ? "cancelled" : "paused"],
        );
        if (action === "cancel")
          await tx.unsafe(
            "UPDATE chisabot_task_center_decisions SET status='superseded',decided_at=now() WHERE owner_user_id=$1 AND status='pending' AND task_id IN (SELECT id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND status='cancelled')",
            [owner],
          );
      } else {
        const allowed =
          action === "start"
            ? ["inbox"]
            : action === "retry"
              ? ["failed"]
              : ["paused"];
        if (!allowed.includes(task.status))
          throw new TaskCenterError("当前状态不能执行这个操作。", 409);
        if (action === "retry") {
          const [failure] = await tx.unsafe<{ data: { verifyOnly?: boolean; attempt?: number; version?: number } }[]>(
            "SELECT data FROM chisabot_task_center_events WHERE owner_user_id=$1 AND task_id=$2 AND type='failed' ORDER BY created_at DESC LIMIT 1", [owner, id]);
          const failedResult = failure ? json(failure.data) : null;
          const verifyOnly = failedResult?.verifyOnly === true && failedResult.attempt === task.attempts && failedResult.version === task.version;
          await tx.unsafe(
            "UPDATE chisabot_task_center_tasks SET version=version+$3,attempts=$4,error=NULL,finished_at=NULL WHERE owner_user_id=$1 AND id=$2",
            [owner, id, verifyOnly ? 0 : 1, verifyOnly ? Math.max(0, task.attempts - 1) : 0],
          );
          task = { ...task, version: task.version + (verifyOnly ? 0 : 1), attempts: verifyOnly ? Math.max(0, task.attempts - 1) : 0 };
        }
        // Resuming a parent resumes the children its pause stopped, or the parent would wait on them forever.
        const resumed =
          action === "resume"
            ? (
                await tx.unsafe<Row[]>(
                  `WITH RECURSIVE descendants AS (
              SELECT id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2
              UNION ALL SELECT t.id FROM chisabot_task_center_tasks t JOIN descendants d ON t.parent_id=d.id WHERE t.owner_user_id=$1
            ) SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id IN (SELECT id FROM descendants) AND status='paused' FOR UPDATE`,
                  [owner, id],
                )
              ).map(taskView)
            : [task];
        for (const item of resumed) {
          const [approved] = await tx.unsafe(
            "SELECT id FROM chisabot_task_center_decisions WHERE owner_user_id=$1 AND task_id=$2 AND task_version=$3 AND status='approved'",
            [owner, item.id, item.version],
          );
          if (needsTaskApproval(item.risk) && !approved) {
            const decision = await requestApproval(tx, item);
            if (decision) requested.push(decision);
          } else
            await tx.unsafe(
              "UPDATE chisabot_task_center_tasks SET status=$3,next_attempt_at=now(),error=NULL,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
              [
                owner,
                item.id,
                item.planPrepared && item.dependencies.length
                  ? "waiting_dependencies"
                  : "queued",
              ],
            );
        }
      }
      await event(
        owner,
        id,
        action,
        {
          start: "开始推进任务。",
          pause: "已暂停任务及未完成的子任务。",
          resume: "继续推进任务。",
          retry: "重新尝试任务。",
          cancel: "已取消任务及未完成的子任务。",
        }[action],
        {},
        tx,
      );
    });
    if (action === "pause" || action === "cancel") {
      for (const [taskId, controller] of controllers) {
        const current = await getTask(owner, taskId);
        if (
          current &&
          (current.status === "paused" || current.status === "cancelled")
        )
          controller.abort();
      }
    }
    await Promise.all(requested.map(notify));
    return mustTask(owner, id);
  }
  async function decide(
    owner: string,
    id: string,
    approved: boolean,
  ): Promise<TaskCenterDecision> {
    return sql.begin(async (tx) => {
      const [decision] = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_decisions WHERE owner_user_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      );
      if (!decision) throw new TaskCenterError("找不到这条确认请求。", 404);
      if (decision.status !== "pending")
        throw new TaskCenterError("这条确认请求已经处理。", 409);
      const [task] = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2 FOR UPDATE",
        [owner, decision.task_id],
      );
      if (
        !task ||
        task.version !== decision.task_version ||
        task.status !== "waiting_approval"
      )
        throw new TaskCenterError("任务状态已经改变，请重新查看。", 409);
      const [result] = await tx.unsafe<Row[]>(
        "UPDATE chisabot_task_center_decisions SET status=$3,decided_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING *",
        [owner, id, approved ? "approved" : "rejected"],
      );
      await tx.unsafe(
        "UPDATE chisabot_task_center_tasks SET status=$3,next_attempt_at=now(),finished_at=CASE WHEN $3='cancelled' THEN now() ELSE NULL END,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
        [owner, task.id, approved ? "queued" : "cancelled"],
      );
      await event(
        owner,
        task.id,
        approved ? "approved" : "rejected",
        approved
          ? "你已确认此操作，任务可以继续。"
          : "你已拒绝此操作，任务已取消。",
        { decisionId: id },
        tx,
      );
      if (!result) throw new TaskCenterError("这条确认请求已经处理。", 409);
      return decisionView(result);
    });
  }
  async function getContext(owner: string): Promise<TaskContext> {
    const [row] = await sql.unsafe<Row[]>(
      "SELECT * FROM chisabot_task_center_context WHERE owner_user_id=$1",
      [owner],
    );
    const content = row ? json<Record<string, unknown>>(row.content) : {};
    return {
      ...contextInputSchema.parse(content),
      updatedAt:
        row && Object.keys(content).length ? iso(row.updated_at) : null,
      learned: row?.learned ?? "",
      learnedAt: row ? iso(row.learned_at) : null,
    };
  }
  async function setContext(
    owner: string,
    input: unknown,
  ): Promise<TaskContext> {
    const content = contextInputSchema.parse(input);
    await sql.unsafe(
      "INSERT INTO chisabot_task_center_context(owner_user_id,content) VALUES($1,$2::text::jsonb) ON CONFLICT(owner_user_id) DO UPDATE SET content=excluded.content,updated_at=now()",
      [owner, JSON.stringify(content)],
    );
    return getContext(owner);
  }
  /** The compiled section only; what the person wrote stays exactly as they wrote it. */
  async function setLearned(
    owner: string,
    learned: string,
  ): Promise<TaskContext> {
    await sql.unsafe(
      "INSERT INTO chisabot_task_center_context(owner_user_id,content,learned,learned_at) VALUES($1,'{}'::jsonb,$2,now()) ON CONFLICT(owner_user_id) DO UPDATE SET learned=excluded.learned,learned_at=now()",
      [owner, learned.slice(0, 6000)],
    );
    return getContext(owner);
  }
  async function listSources(owner: string): Promise<TaskCenterSource[]> {
    return (
      await sql.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_sources WHERE owner_user_id=$1 ORDER BY created_at DESC",
        [owner],
      )
    ).map(sourceView);
  }
  function safeSourceConfig(config: Record<string, unknown>) {
    if (JSON.stringify(config).length > 24000)
      throw new TaskCenterError("信息源配置过大。");
    for (const key of Object.keys(config))
      if (
        /(password|secret|token|api.?key|credential)/i.test(key) &&
        !/(ref|id)$/i.test(key)
      )
        throw new TaskCenterError(
          "请在已有连接设置或保险箱保存凭据，这里只填写连接引用。",
        );
  }
  async function createSource(
    owner: string,
    input: TaskSourceInput,
  ): Promise<TaskCenterSource> {
    const parsed = sourceInputSchema.parse(input);
    safeSourceConfig(parsed.config);
    await checkBot(owner, parsed.agentId);
    const { config, enabled, ...payload } = parsed;
    const [row] = await sql.unsafe<Row[]>(
      "INSERT INTO chisabot_task_center_sources(id,owner_user_id,payload,config,enabled) VALUES($1,$2,$3::text::jsonb,$4::text::jsonb,$5) RETURNING *",
      [
        randomUUID(),
        owner,
        JSON.stringify({
          ...payload,
          agentId: payload.agentId ?? null,
          workspace: payload.workspace ?? null,
        }),
        JSON.stringify(config),
        enabled,
      ],
    );
    if (!row) throw new TaskCenterError("信息源没有创建成功，请重试。");
    return sourceView(row);
  }
  async function updateSource(
    owner: string,
    id: string,
    input: Partial<TaskSourceInput>,
  ): Promise<TaskCenterSource> {
    const patch = sourceInputSchema.partial().strict().parse(input);
    if (patch.config) safeSourceConfig(patch.config);
    await checkBot(owner, patch.agentId);
    return sql.begin(async (tx) => {
      const [row] = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_sources WHERE owner_user_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      );
      if (!row) throw new TaskCenterError("找不到这个信息源。", 404);
      if (row.last_status === "running")
        throw new TaskCenterError("巡检正在执行，请结束后再修改配置。", 409);
      const current = sourceView(row);
      const next = sourceInputSchema.parse({
        kind: current.kind,
        label: current.label,
        enabled: current.enabled,
        intervalMinutes: current.intervalMinutes,
        autoStart: current.autoStart,
        agentId: current.agentId,
        executor: current.executor,
        workspace: current.workspace,
        config: current.config,
        ...patch,
      });
      const { config, enabled, ...payload } = next;
      const [updated] = await tx.unsafe<Row[]>(
        "UPDATE chisabot_task_center_sources SET payload=$3::text::jsonb,config=$4::text::jsonb,enabled=$5,next_run_at=CASE WHEN $5 AND NOT enabled THEN now() ELSE next_run_at END,updated_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING *",
        [owner, id, JSON.stringify(payload), JSON.stringify(config), enabled],
      );
      if (!updated)
        throw new TaskCenterError("信息源状态已经变化，请重试。", 409);
      return sourceView(updated);
    });
  }
  async function scanSource(
    owner: string,
    id: string,
  ): Promise<TaskCenterSource> {
    const [row] = await sql.unsafe<Row[]>(
      "UPDATE chisabot_task_center_sources SET next_run_at=now(),updated_at=now() WHERE owner_user_id=$1 AND id=$2 AND last_status<>'running' RETURNING *",
      [owner, id],
    );
    if (!row) throw new TaskCenterError("信息源不存在或正在巡检。", 409);
    // Manual scans also work while the recurring schedule is paused.
    await collectSource(owner, id, true);
    const source = (await listSources(owner)).find((s) => s.id === id);
    if (!source) throw new TaskCenterError("信息源状态已经变化，请重试。", 409);
    return source;
  }
  async function collectSource(owner: string, id: string, manual = false) {
    const [row] = await sql.unsafe<Row[]>(
      `UPDATE chisabot_task_center_sources SET last_status='running',last_run_at=now(),lease_owner=$3,lease_expires_at=now()+interval '5 minutes',updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 AND (enabled OR $4) AND next_run_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING *`,
      [owner, id, instance, manual],
    );
    if (!row) return;
    const source = sourceView(row);
    try {
      const discoveries = await options.collect(owner, source);
      if (!Array.isArray(discoveries) || discoveries.length > 100)
        throw new TaskCenterError("单次巡检最多接收 100 条事项。");
      for (const discovery of discoveries) {
        const { sourceRef, sourceUrl, ...input } = discovery;
        if (
          typeof sourceRef !== "string" ||
          !sourceRef.trim() ||
          sourceRef.length > 1000
        )
          throw new TaskCenterError("巡检结果缺少稳定的来源标识。");
        if (
          sourceUrl &&
          (!/^https?:\/\//i.test(sourceUrl) || !URL.canParse(sourceUrl))
        )
          throw new TaskCenterError("来源链接必须是 HTTP 或 HTTPS 地址。");
        await checkBot(owner, input.agentId ?? source.agentId);
        const task = await sql.begin((tx) =>
          insertTask(
            tx,
            owner,
            {
              ...input,
              agentId: input.agentId ?? source.agentId,
              executor: input.executor ?? source.executor,
              workspace: input.workspace ?? source.workspace,
            },
            { sourceId: id, sourceRef, sourceUrl },
          ),
        );
        if (task && source.autoStart)
          await controlTask(owner, task.id, "start");
      }
      await sql.unsafe(
        "UPDATE chisabot_task_center_sources SET last_status='succeeded',last_error=NULL,failures=0,lease_owner=NULL,lease_expires_at=NULL,next_run_at=now()+($4*interval '1 minute'),updated_at=now() WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3",
        [owner, id, instance, source.intervalMinutes],
      );
    } catch (error) {
      await sql.unsafe(
        "UPDATE chisabot_task_center_sources SET last_status='failed',last_error=$4,failures=failures+1,enabled=CASE WHEN failures>=2 THEN false ELSE enabled END,lease_owner=NULL,lease_expires_at=NULL,next_run_at=now()+($5*interval '1 minute'),updated_at=now() WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3",
        [
          owner,
          id,
          instance,
          reasonWithoutStatement(error).slice(0, 2000),
          source.intervalMinutes,
        ],
      );
    }
  }

  async function recover() {
    await sql.begin(async (tx) => {
      const expired = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_tasks WHERE status IN ('planning','running') AND lease_expires_at<now() FOR UPDATE SKIP LOCKED",
      );
      for (const row of expired) {
        const task = taskView(row);
        if (await options.hasDurableExecution?.(task)) {
          await tx.unsafe("UPDATE chisabot_task_center_tasks SET status='queued',attempts=greatest(attempts-1,0),lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=now(),updated_at=now() WHERE owner_user_id=$1 AND id=$2", [task.ownerUserId, task.id]);
          await event(task.ownerUserId, task.id, "recovered", "正在接回原执行并核对结果。", {}, tx);
          continue;
        }
        const retry =
          !needsTaskApproval(task.risk) && task.attempts < task.maxAttempts;
        await tx.unsafe(
          "UPDATE chisabot_task_center_tasks SET status=$3,error=$4,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=now()+interval '30 seconds',finished_at=CASE WHEN $3='failed' THEN now() ELSE NULL END,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
          [
            task.ownerUserId,
            task.id,
            retry ? "queued" : "failed",
            "执行租约已过期；此前操作结果可能未知。",
          ],
        );
        await event(
          task.ownerUserId,
          task.id,
          "recovered",
          retry
            ? "执行中断，等待重新执行。"
            : "执行中断，需要检查已有成果后手动重试。",
          {},
          tx,
        );
      }
      await tx.unsafe(
        "UPDATE chisabot_task_center_sources SET last_status='failed',last_error='巡检进程中断，将在下次计划时间重试。',lease_owner=NULL,lease_expires_at=NULL,next_run_at=now()+interval '15 minutes' WHERE last_status='running' AND lease_expires_at<now()",
      );
      await tx.unsafe(`UPDATE chisabot_task_center_tasks t SET status='queued',error=NULL,updated_at=now()
        WHERE status='waiting_dependencies' AND NOT EXISTS(SELECT 1 FROM unnest(t.dependencies) dep LEFT JOIN chisabot_task_center_tasks d ON d.id=dep AND d.owner_user_id=t.owner_user_id WHERE d.status IS DISTINCT FROM 'succeeded')`);
      await tx.unsafe(`UPDATE chisabot_task_center_tasks t SET error='依赖任务失败或已取消，请处理依赖后继续。',updated_at=now()
        WHERE status IN ('queued','waiting_dependencies') AND error IS DISTINCT FROM '依赖任务失败或已取消，请处理依赖后继续。' AND EXISTS(SELECT 1 FROM chisabot_task_center_tasks d WHERE d.id=ANY(t.dependencies) AND d.owner_user_id=t.owner_user_id AND d.status IN ('failed','cancelled'))`);
    });
  }
  /** `skipped` means the next due task went to the Outbox instead; the sweep keeps claiming. */
  async function claim(): Promise<TaskCenterTask | "skipped" | null> {
    let requested: TaskCenterDecision | null = null;
    const claimed = await sql.begin(
      async (tx): Promise<TaskCenterTask | "skipped" | null> => {
        await tx.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext('chisabot-task-center-claim'))",
        );
        const [{ count }] = await tx.unsafe<{ count: number }[]>(
          "SELECT count(*)::int AS count FROM chisabot_task_center_tasks WHERE status IN ('planning','running') AND lease_expires_at>now()",
        );
        if (count >= globalConcurrency) return null;
        const [row] = await tx.unsafe<Row[]>(
          `SELECT t.* FROM chisabot_task_center_tasks t WHERE t.status='queued' AND t.next_attempt_at<=now()
        AND NOT EXISTS(SELECT 1 FROM unnest(t.dependencies) dep LEFT JOIN chisabot_task_center_tasks d ON d.id=dep AND d.owner_user_id=t.owner_user_id WHERE d.status IS DISTINCT FROM 'succeeded')
        AND (SELECT count(*) FROM chisabot_task_center_tasks r WHERE r.owner_user_id=t.owner_user_id AND r.status IN ('planning','running') AND r.lease_expires_at>now()) < $1
        ORDER BY t.priority DESC,t.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [concurrency],
        );
        if (!row) return null;
        const task = taskView(row);
        const [approved] = await tx.unsafe(
          "SELECT id FROM chisabot_task_center_decisions WHERE owner_user_id=$1 AND task_id=$2 AND task_version=$3 AND status='approved'",
          [task.ownerUserId, task.id, task.version],
        );
        if (needsTaskApproval(task.risk) && !approved) {
          requested = await requestApproval(tx, task);
          return "skipped";
        }
        const status =
          options.plan && !task.planPrepared && !task.parentId
            ? "planning"
            : "running";
        const [claimed] = await tx.unsafe<Row[]>(
          "UPDATE chisabot_task_center_tasks SET status=$3,attempts=attempts+1,lease_owner=$4,lease_expires_at=now()+($5*interval '1 second'),started_at=COALESCE(started_at,now()),updated_at=now(),error=NULL WHERE owner_user_id=$1 AND id=$2 RETURNING *",
          [task.ownerUserId, task.id, status, instance, leaseSeconds],
        );
        await event(
          task.ownerUserId,
          task.id,
          status,
          status === "planning" ? "正在规划任务。" : "Agent 已开始执行。",
          { attempt: task.attempts + 1, executor: task.executor },
          tx,
        );
        if (!claimed) throw new TaskCenterError("任务在启动时已不存在。", 409);
        return taskView(claimed);
      },
    );
    // Only after commit: the notification links to a decision the person must be able to open.
    await notify(requested);
    return claimed;
  }
  async function applyPlan(
    task: TaskCenterTask,
    plan: TaskPlan,
  ): Promise<boolean> {
    validateTaskPlan(plan);
    if (!plan.steps.length) {
      const rows = await sql.unsafe(
        "UPDATE chisabot_task_center_tasks SET plan_prepared=true,status='running',payload=(CASE WHEN jsonb_typeof(payload)='string' THEN (payload #>> '{}')::jsonb ELSE payload END) || $4::text::jsonb,updated_at=now() WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3 AND status='planning' RETURNING id",
        [task.ownerUserId, task.id, instance, JSON.stringify(plan.completion && !task.completion ? { completion: plan.completion } : {})],
      );
      if (!rows.length) throw new TaskCenterError("任务状态已改变。", 409);
      if (!task.completion && plan.completion) task.completion = plan.completion;
      if (task.completion) await event(task.ownerUserId, task.id, "completion_criteria", `完成条件：${task.completion.criteria}`, { completion: task.completion });
      return false;
    }
    for (const step of plan.steps)
      await checkBot(task.ownerUserId, step.agentId ?? task.agentId);
    const decisions: TaskCenterDecision[] = [];
    await sql.begin(async (tx) => {
      const [current] = await tx.unsafe<Row[]>(
        "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3 AND status='planning' FOR UPDATE",
        [task.ownerUserId, task.id, instance],
      );
      if (!current) throw new TaskCenterError("任务状态已改变。", 409);
      const ids = new Map(plan.steps.map((s) => [s.key, randomUUID()]));
      const inserted = new Set<string>();
      while (inserted.size < plan.steps.length) {
        for (const step of plan.steps.filter(
          (s) =>
            !inserted.has(s.key) &&
            (s.dependsOn ?? []).every((key) => inserted.has(key)),
        )) {
          const { key, dependsOn, ...input } = step;
          const child = await insertTask(
            tx,
            task.ownerUserId,
            {
              ...input,
              agentId: input.agentId ?? task.agentId,
              executor: input.executor ?? task.executor,
              workspace: input.workspace ?? task.workspace,
              dependencies: [
                ...(input.dependencies ?? []),
                ...(dependsOn ?? []).map((key) => {
                  const depId = ids.get(key);
                  if (!depId)
                    throw new TaskCenterError(
                      `计划引用了不存在的步骤「${key}」。`,
                      409,
                    );
                  return depId;
                }),
              ],
            },
            {
              id: (() => {
                const childId = ids.get(key);
                if (!childId)
                  throw new TaskCenterError("计划步骤缺少稳定标识。", 409);
                return childId;
              })(),
              parentId: task.id,
              status: "queued",
            },
          );
          if (child && needsTaskApproval(child.risk)) {
            const decision = await requestApproval(tx, child);
            if (decision) decisions.push(decision);
          }
          inserted.add(key);
        }
      }
      await tx.unsafe(
        "UPDATE chisabot_task_center_tasks SET plan_prepared=true,status='waiting_dependencies',dependencies=string_to_array($3, chr(31))::text[],summary=$4,payload=(CASE WHEN jsonb_typeof(payload)='string' THEN (payload #>> '{}')::jsonb ELSE payload END) || $5::text::jsonb,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
        [
          task.ownerUserId,
          task.id,
          [...task.dependencies, ...ids.values()].join("\x1f"),
          plan.summary.slice(0, eventLimit),
          JSON.stringify(plan.completion && !task.completion ? { completion: plan.completion } : {}),
        ],
      );
      await event(
        task.ownerUserId,
        task.id,
        "planned",
        plan.summary,
        { childIds: [...ids.values()], ...(plan.completion ? { completion: plan.completion } : {}) },
        tx,
      );
    });
    await Promise.all(decisions.map(notify));
    return true;
  }
  async function run(task: TaskCenterTask) {
    const controller = new AbortController();
    controllers.set(task.id, controller);
    const timeout = executionDeadline(task.timeoutSeconds * 1000,
      () => controller.abort(new Error("任务达到执行时限。")),
    );
    let capacityWaiting = false;
    const capacityState = (state: "waiting" | "admitted") => {
      timeout.state(state);
      if ((state === "waiting") === capacityWaiting) return;
      capacityWaiting = state === "waiting";
      const waiting = capacityWaiting;
      void sql.unsafe("UPDATE chisabot_task_center_tasks SET error=$4 WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3", [task.ownerUserId, task.id, instance, capacityWaiting ? CAPACITY_WAIT_MESSAGE : null])
        .then(() => event(task.ownerUserId, task.id, "progress", waiting ? CAPACITY_WAIT_MESSAGE : "已取得后台执行位，继续原任务。"))
        .catch(error => console.warn("task capacity feedback failed", reasonWithoutStatement(error)));
    };
    const heartbeat = setInterval(() => {
      void sql
        .unsafe(
          "UPDATE chisabot_task_center_tasks SET lease_expires_at=now()+($4*interval '1 second') WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3 AND status IN ('planning','running') RETURNING id",
          [task.ownerUserId, task.id, instance, leaseSeconds],
        )
        .then((rows) => {
          if (!rows.length) controller.abort();
        })
        .catch(() => controller.abort());
    }, 20_000);
    try {
      await checkBot(task.ownerUserId, task.agentId);
      const context = await getContext(task.ownerUserId);
      if (task.status === "planning" && options.plan) {
        const plan = await withCapacityFeedback(capacityState, () => options.plan!(task, context, controller.signal));
        controller.signal.throwIfAborted();
        if (await applyPlan(task, plan)) return;
      }
      controller.signal.throwIfAborted();
      const dependencies = task.dependencies.length
        ? (
            await sql.unsafe<Row[]>(
              "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=ANY(string_to_array($2, chr(31)))",
              [task.ownerUserId, task.dependencies.join("\x1f")],
            )
          ).map(taskView)
        : [];
      const result = await withCapacityFeedback(capacityState, async () => options.execute(task, {
        signal: controller.signal,
        context,
        dependencies,
        approval: await approvedDecision(task),
        onEvent: async (entry) => {
          controller.signal.throwIfAborted();
          await event(
            task.ownerUserId,
            task.id,
            entry.type,
            entry.message,
            entry.data,
          );
        },
      }));
      controller.signal.throwIfAborted();
      if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim()
      )
        throw new TaskCenterError("执行器没有交付结果摘要。");
      assertTaskEvidence(task, result);
      if (
        (result.artifacts?.length ?? 0) > 50 ||
        JSON.stringify(result).length > 2_000_000
      )
        throw new TaskCenterError(
          "交付内容过大，请将文件保存在成果目录并返回引用。",
        );
      const settled = await sql.begin(async (tx) => {
        const rows = await tx.unsafe(
          "UPDATE chisabot_task_center_tasks SET status='succeeded',summary=$4,artifacts=$5::text::jsonb,usage=$6::text::jsonb,error=NULL,lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3 AND status='running' RETURNING id",
          [
            task.ownerUserId,
            task.id,
            instance,
            result.summary.slice(0, 64000),
            JSON.stringify(result.artifacts ?? []),
            JSON.stringify(result.usage ?? {}),
          ],
        );
        if (rows.length)
          await event(
            task.ownerUserId,
            task.id,
            "delivered",
            result.evidence?.length ? `成果已核对：${result.evidence.map(item => item.detail).join("；").slice(0, 1000)}` : "结果已交付。",
            {
              artifacts:
                result.artifacts?.map((a) => ({ name: a.name, uri: a.uri })) ??
                [],
              usage: result.usage ?? {},
              evidence: result.evidence ?? [],
              ...(task.completion ? { completion: task.completion } : {}),
            },
            tx,
          );
        return rows.length > 0;
      });
      if (settled) await reportLearn(task, {
        status: "succeeded",
        detail: result.summary,
      });
    } catch (error) {
      let terminalFailure: string | null = null;
      await sql.begin(async (tx) => {
        const [row] = await tx.unsafe<Row[]>(
          "SELECT * FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2 AND lease_owner=$3 AND status IN ('planning','running') FOR UPDATE",
          [task.ownerUserId, task.id, instance],
        );
        if (!row) return;
        // A shutdown is not the task's fault: give the attempt back. An approved outward action may have
        // partly happened, so it waits for a person instead of running again by itself.
        const interrupted = stopping && controller.signal.aborted;
        const retry = error instanceof BackgroundTurnNeedsReview ? false : interrupted
          ? !needsTaskApproval(task.risk)
          : !needsTaskApproval(task.risk) &&
            row.attempts < task.maxAttempts &&
            !controller.signal.aborted;
        const message = interrupted
          ? retry
            ? "服务重启中断了执行，稍后自动继续。"
            : "服务重启中断了已确认的操作，请检查已有结果后手动重试。"
          : reasonWithoutStatement(
              controller.signal.aborted
                ? (controller.signal.reason ?? new Error("任务被中止。"))
                : error,
            ).slice(0, 3000);
        await tx.unsafe(
          "UPDATE chisabot_task_center_tasks SET status=$3,error=$4,attempts=attempts-$6,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=now()+($5*interval '1 second'),finished_at=CASE WHEN $3='failed' THEN now() ELSE NULL END,updated_at=now() WHERE owner_user_id=$1 AND id=$2",
          [
            task.ownerUserId,
            task.id,
            retry ? "queued" : "failed",
            message,
            interrupted ? 5 : Math.min(300, 15 * 2 ** row.attempts),
            interrupted && retry ? 1 : 0,
          ],
        );
        const terminal = interrupted ? false : !retry;
        if (terminal) terminalFailure = message;
        await event(
          task.ownerUserId,
          task.id,
          interrupted ? "recovered" : retry ? "retry_scheduled" : "failed",
          message,
          { attempt: row.attempts, version: task.version, ...(error instanceof TaskResultNeedsReview ? { verifyOnly: true } : {}) },
          tx,
        );
      });
      if (terminalFailure)
        await reportLearn(task, {
          status: "failed",
          detail: terminalFailure,
        });
    } finally {
      timeout.cancel();
      clearInterval(heartbeat);
      controllers.delete(task.id);
    }
  }
  async function reportLearn(
    task: TaskCenterTask,
    outcome: { status: "succeeded" | "failed"; detail: string },
  ) {
    if (!options.learn) return;
    try {
      await options.learn(task.ownerUserId, task, outcome);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "task-center-learn-failed",
          task: task.id,
          reason: reasonWithoutStatement(error).slice(0, 300),
        }),
      );
    }
  }
  async function sweep() {
    if (sweeping || conversationAdmissionClosed()) return;
    sweeping = true;
    try {
      await recover();
      const sources = await sql.unsafe<Row[]>(
        "SELECT owner_user_id,id FROM chisabot_task_center_sources WHERE enabled AND next_run_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY next_run_at LIMIT 4",
      );
      await Promise.all(
        sources.map((s) => collectSource(s.owner_user_id, s.id)),
      );
      for (let i = 0; i < globalConcurrency; i++) {
        const task = await claim();
        if (!task) break;
        if (task === "skipped") continue;
        const job = run(task).catch((error) => {
          console.error("[task-center]", reasonWithoutStatement(error));
        });
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
      }
    } finally {
      sweeping = false;
    }
  }
  function start() {
    if (timer) return;
    stopping = false;
    timer = setInterval(() => {
      void sweep().catch((error) =>
        console.error("[task-center]", reasonWithoutStatement(error)),
      );
    }, 5000);
    void sweep().catch((error) =>
      console.error("[task-center]", reasonWithoutStatement(error)),
    );
  }
  async function stop() {
    stopping = true;
    clearInterval(timer);
    timer = undefined;
    for (const controller of controllers.values())
      controller.abort(new Error("任务中心正在停止。"));
    await Promise.allSettled([...jobs]);
  }
  async function capabilities(owner: string): Promise<TaskCapability[]> {
    return options.capabilities ? options.capabilities(owner) : [];
  }
  async function snapshot(owner: string): Promise<TaskCenterSnapshot> {
    const [tasks, outbox, sources, rows] = await Promise.all([
      listTasks(owner),
      listDecisions(owner),
      listSources(owner),
      sql.unsafe<{ status: TaskStatus; count: number }[]>(
        "SELECT status,count(*)::int AS count FROM chisabot_task_center_tasks WHERE owner_user_id=$1 GROUP BY status",
        [owner],
      ),
    ]);
    const counts = Object.fromEntries(
      TASK_STATUSES.map((s) => [s, 0]),
    ) as Record<TaskStatus, number>;
    for (const row of rows) counts[row.status] = row.count;
    return {
      tasks,
      outbox,
      sources,
      counts,
      running: Boolean(timer),
      concurrency,
    };
  }
  const service = {
    ensure,
    start,
    stop,
    sweep,
    snapshot,
    listTasks,
    getTask,
    createTask,
    controlTask,
    listDecisions,
    decide,
    listSources,
    createSource,
    updateSource,
    scanSource,
    getContext,
    setContext,
    setLearned,
    taskEvents,
    capabilities,
    routes: (requireUser: MiddlewareHandler<{ Variables: AppVariables }>) =>
      createTaskCenterRoutes(service, requireUser),
  };
  return service;
}
export type TaskCenterService = ReturnType<typeof createTaskCenter>;
