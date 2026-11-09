import { z } from "zod";

const identity = z.string().min(1).max(512);
export const ConversationBindingSchema = z.object({
  bindingId: identity,
  revision: z.number().int().positive(),
  ownerUserId: identity,
  threadId: identity,
  botId: identity,
  runtimeId: identity,
  sessionId: identity,
});
export type ConversationBinding = z.infer<typeof ConversationBindingSchema>;

export const ConversationCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send"),
    commandId: identity,
    revision: z.number().int().positive(),
    messageId: identity,
    content: z
      .array(
        z
          .object({ type: z.literal("text"), text: z.string().max(200_000) })
          .or(
            z.object({ type: z.literal("attachment"), attachmentId: identity }),
          ),
      )
      .min(1),
    mode: z.enum(["queue", "steer"]).default("queue"),
  }),
  z.object({
    kind: z.literal("stop"),
    commandId: identity,
    revision: z.number().int().positive(),
    runId: identity,
  }),
  z.object({
    kind: z.literal("resume-inbox"),
    commandId: identity,
    revision: z.number().int().positive(),
    sourceIds: z.array(identity).min(1).max(100),
  }),
  z.object({
    kind: z.literal("answer"),
    commandId: identity,
    revision: z.number().int().positive(),
    interactionId: identity,
    answer: z.unknown(),
  }),
]);
export type ConversationCommand = z.infer<typeof ConversationCommandSchema>;
export type ConversationRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed"
  | "interrupted";
export type ConversationReceipt = {
  commandId: string;
  runId: string | null;
  bindingId: string;
  revision: number;
  accepted: true;
  alreadyAccepted: boolean;
};

export type ConversationSourceEvent = {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
};

export type RuntimeToolIdentity = {
  sessionId: string;
  runId: string;
  threadId: string;
  botId: string;
  actorId: string;
  revision: number;
  generation: string;
};
