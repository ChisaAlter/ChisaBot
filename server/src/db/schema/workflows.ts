import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

/**
 * 工作流（docs/workflows.md）。预设在代码里（server/src/workflows/presets/*.md），这里只存每个人
 * 自己的工作流和所有运行。定义整份存成 JSON（与 WORKFLOW.md 前言一一对应）。
 */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    /** 从哪个预设 / 工作流复制来的，或 import。 */
    origin: text("origin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workflows_owner_idx").on(t.ownerUserId)],
);

/** 一次运行。definition 是开始时的快照，之后改工作流不影响正在跑或跑完的运行。 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    workflowName: text("workflow_name").notNull(),
    definition: jsonb("definition").notNull(),
    inputs: jsonb("inputs").notNull(),
    /** 角色 key → 机器人 id。 */
    bindings: jsonb("bindings").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    /** WorkflowStepState[]，包在 { steps } 里。 */
    state: jsonb("state").notNull(),
    output: text("output"),
    error: text("error"),
    stepMode: text("step_mode").notNull().default("auto"),
    resumeTokenHash: text("resume_token_hash"),
    resumeReason: text("resume_reason"),
    resumeExpiresAt: timestamp("resume_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workflow_runs_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("workflow_runs_status_idx").on(t.status),
    uniqueIndex("workflow_runs_resume_token_idx").on(t.resumeTokenHash),
  ],
);

/** 运行内的审计：开始、每步开始/结束、约束拦截、审批决定、结束。 */
export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    stepId: text("step_id"),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (t) => [index("workflow_run_events_run_idx").on(t.runId, t.at)],
);
