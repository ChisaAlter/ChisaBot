import { z } from "zod";

export const TASK_LEVELS = [1, 2, 3, 4, 5] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];
export const TASK_LEVEL_LABELS: Record<TaskLevel, string> = {
  1: "整理信息",
  2: "分析建议",
  3: "生成成果",
  4: "确认后完成",
  5: "自主交付",
};
export const TASK_STATUSES = [
  "inbox",
  "queued",
  "planning",
  "running",
  "waiting_dependencies",
  "waiting_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_CATEGORIES = [
  "research",
  "development",
  "documents",
  "project",
  "schedule",
  "communication",
  "decision",
  "other",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const TASK_RISKS = [
  "read",
  "internal",
  "external",
  "sensitive",
  "publish",
] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];
export const SOURCE_KINDS = [
  "calendar",
  "email",
  "github",
  "repository",
  "documents",
  "messages",
  "tasks",
  "webhook",
] as const;
export type TaskSourceKind = (typeof SOURCE_KINDS)[number];
export type TaskArtifact = {
  name: string;
  uri?: string;
  content?: string;
  mediaType?: string;
};
export type TaskUsage = {
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};
/** `workspace` capabilities list the repository keys a task may name; `id` is `workspace:<key>`. */
export type TaskCapability = {
  id: string;
  name: string;
  available: boolean;
  detail: string;
  kind: "executor" | "source" | "tool" | "workspace";
  risks?: TaskRisk[];
};
/** The six fields are the person's own words. `learned` is compiled by the task center and never overwrites them. */
export type TaskContext = {
  responsibilities: string;
  projects: string;
  goals: string;
  interests: string;
  habits: string;
  preferences: string;
  updatedAt: string | null;
  learned: string;
  learnedAt: string | null;
};
export type TaskCenterTask = {
  id: string;
  ownerUserId: string;
  agentId: string | null;
  title: string;
  description: string;
  category: TaskCategory;
  level: TaskLevel;
  assessment: string;
  risk: TaskRisk;
  status: TaskStatus;
  executor: string;
  workspace: string | null;
  sourceId: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  parentId: string | null;
  dependencies: string[];
  planPrepared: boolean;
  priority: number;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  summary: string | null;
  artifacts: TaskArtifact[];
  usage: TaskUsage;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  version: number;
};
export type TaskCenterSource = {
  id: string;
  ownerUserId: string;
  kind: TaskSourceKind;
  label: string;
  enabled: boolean;
  intervalMinutes: number;
  autoStart: boolean;
  agentId: string | null;
  executor: string;
  workspace: string | null;
  config: Record<string, unknown>;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "failed";
  lastError: string | null;
  failures: number;
  createdAt: string;
  updatedAt: string;
};
export type TaskCenterDecision = {
  id: string;
  taskId: string;
  ownerUserId: string;
  taskVersion: number;
  summary: string;
  proposedAction: {
    title: string;
    description: string;
    executor: string;
    risk: TaskRisk;
  };
  status: "pending" | "approved" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
  notificationError: string | null;
};
export type TaskCenterEvent = {
  id: string;
  taskId: string;
  type: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
};
/**
 * Events executors add to a task's history, besides the lifecycle events the queue writes
 * (created, planning, running, planned, approval_requested, approved, rejected, retry_scheduled,
 * failed, delivered, recovered, start, pause, resume, retry, cancel).
 */
export type TaskExecutorEvent =
  | {
      type: "tool_call";
      message: string;
      data: { tool: string; phase: "start" | "end"; ok?: boolean };
    }
  | {
      type: "log";
      message: string;
      data: { stream: "stdout" | "stderr" | "info" };
    }
  | {
      type: "progress";
      message: string;
      data?: { done?: number; total?: number };
    }
  | { type: "artifact"; message: string; data: { name: string; uri?: string } };
export type TaskCenterSnapshot = {
  tasks: TaskCenterTask[];
  outbox: TaskCenterDecision[];
  sources: TaskCenterSource[];
  counts: Record<TaskStatus, number>;
  running: boolean;
  concurrency: number;
};

export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(16000),
    agentId: z.string().trim().min(1).max(128).nullable().optional(),
    category: z.enum(TASK_CATEGORIES).default("other"),
    level: z.number().int().min(1).max(5).default(2),
    assessment: z
      .string()
      .max(2000)
      .default("由任务类型、可用工具和当前权限评估；执行权限仍由运行器检查。"),
    risk: z.enum(TASK_RISKS).default("internal"),
    executor: z.string().trim().min(1).max(100).default("bot"),
    workspace: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
      .nullable()
      .optional(),
    priority: z.number().int().min(0).max(100).default(50),
    dependencies: z.array(z.string().min(1).max(128)).max(30).default([]),
    maxAttempts: z.number().int().min(1).max(5).default(3),
    timeoutSeconds: z.number().int().min(10).max(7200).default(900),
  })
  .strict();
export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskDiscovery = TaskInput & {
  sourceRef: string;
  sourceUrl?: string;
};
export type TaskPlanStep = TaskInput & { key: string; dependsOn?: string[] };
export type TaskPlan = { summary: string; steps: TaskPlanStep[] };
export type TaskExecutionResult = {
  summary: string;
  artifacts?: TaskArtifact[];
  usage?: TaskUsage;
};
export type TaskExecutionContext = {
  signal: AbortSignal;
  context: TaskContext;
  dependencies: TaskCenterTask[];
  approval: TaskCenterDecision | null;
  onEvent: (event: {
    type: string;
    message: string;
    data?: Record<string, unknown>;
  }) => Promise<void>;
};
export const sourceInputSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    label: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(15).max(10080).default(60),
    autoStart: z.boolean().default(false),
    agentId: z.string().trim().min(1).max(128).nullable().optional(),
    executor: z.string().trim().min(1).max(100).default("bot"),
    workspace: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
      .nullable()
      .optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type TaskSourceInput = z.input<typeof sourceInputSchema>;
export const contextInputSchema = z
  .object({
    responsibilities: z.string().max(8000).default(""),
    projects: z.string().max(12000).default(""),
    goals: z.string().max(8000).default(""),
    interests: z.string().max(4000).default(""),
    habits: z.string().max(4000).default(""),
    preferences: z.string().max(8000).default(""),
  })
  .strict();

export function needsTaskApproval(risk: TaskRisk): boolean {
  return risk === "external" || risk === "sensitive" || risk === "publish";
}

/** Stable keys allow plans to refer to siblings before database IDs exist. */
export function validateTaskPlan(plan: TaskPlan): void {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length > 20)
    throw new Error("一个计划最多包含 20 个子任务。");
  const keys = new Set<string>();
  for (const step of plan.steps) {
    if (!step.key || keys.has(step.key))
      throw new Error("子任务标识不能为空或重复。");
    keys.add(step.key);
    const { key: _key, dependsOn: _dependsOn, ...input } = step;
    taskInputSchema.parse(input);
  }
  const done = new Set<string>();
  while (done.size < keys.size) {
    const ready = plan.steps.filter(
      (s) =>
        !done.has(s.key) && (s.dependsOn ?? []).every((key) => done.has(key)),
    );
    if (!ready.length) throw new Error("子任务依赖不存在或形成循环。");
    for (const step of ready) done.add(step.key);
  }
}
