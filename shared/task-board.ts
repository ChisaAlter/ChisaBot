import { z } from "zod";
import { TASK_HORIZON_LANES, TASK_RISKS } from "./task-center";

export * from "./task-board-core";

export const boardIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const cardIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]*-\d+$/);

export const taskScheduleInputSchema = z
  .object({
    lane: z.enum(TASK_HORIZON_LANES).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    start: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.lane !== undefined ||
      value.priority !== undefined ||
      value.start !== undefined,
    { message: "请至少指定目标泳道、优先级或启动动作。" },
  );
export type TaskScheduleInput = z.infer<typeof taskScheduleInputSchema>;

export const boardInitInputSchema = z
  .object({
    rootPath: z.string().trim().min(1).max(1000),
  })
  .strict();

export const boardMoveInputSchema = z
  .object({
    boardId: boardIdSchema,
    baseRevision: revisionSchema,
    cardId: cardIdSchema,
    targetLane: z.enum(TASK_HORIZON_LANES),
    beforeCardId: cardIdSchema.nullable().optional(),
  })
  .strict();

export const boardCardUpdateInputSchema = z
  .object({
    boardId: boardIdSchema,
    baseRevision: revisionSchema,
    cardId: cardIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(64_000),
  })
  .strict();

export const boardCardCreateInputSchema = z
  .object({
    boardId: boardIdSchema,
    baseRevision: revisionSchema,
    title: z.string().trim().min(1).max(200),
    lane: z.enum(TASK_HORIZON_LANES),
    size: z.string().trim().max(40).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    body: z.string().max(32_000).optional(),
  })
  .strict();

export const boardCheckboxInputSchema = z
  .object({
    boardId: boardIdSchema,
    baseRevision: revisionSchema,
    cardId: cardIdSchema,
    checkboxIndex: z.number().int().min(0).max(500),
    checked: z.boolean(),
  })
  .strict();

export const boardDocWriteInputSchema = z
  .object({
    boardId: boardIdSchema,
    baseRevision: revisionSchema,
    relFile: z.string().trim().min(1).max(260),
    content: z.string().max(400_000),
  })
  .strict();

export const boardDispatchInputSchema = z
  .object({
    boardId: boardIdSchema,
    cardId: cardIdSchema,
    executor: z.string().trim().min(1).max(100).default("bot"),
    agentId: z.string().trim().min(1).max(128).nullable().optional(),
    workspace: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
      .nullable()
      .optional(),
    level: z
      .union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ])
      .default(3),
    risk: z.enum(TASK_RISKS).default("internal"),
    start: z.boolean().default(true),
  })
  .strict();

export type BoardInitInput = z.infer<typeof boardInitInputSchema>;
export type BoardMoveInput = z.infer<typeof boardMoveInputSchema>;
export type BoardCardUpdateInput = z.infer<typeof boardCardUpdateInputSchema>;
export type BoardCardCreateInput = z.infer<typeof boardCardCreateInputSchema>;
export type BoardCheckboxInput = z.infer<typeof boardCheckboxInputSchema>;
export type BoardDocWriteInput = z.infer<typeof boardDocWriteInputSchema>;
export type BoardDispatchInput = z.infer<typeof boardDispatchInputSchema>;
