import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isValidPrimaryAgentId } from "../../../shared/validators/primary-agent";
import {
  PrimaryAgentError,
  PrimaryAgentPausedError,
  type PrimaryAgentService,
  type PrimaryAgentStatus,
} from "../agents/primary-agent-service";
import type { AgentActor } from "../agents/profile-types";
import { serializeAgentDto } from "../agents/routes";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";

const putPrimaryAgentSchema = z
  .strictObject({
    agentId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (!isValidPrimaryAgentId(value.agentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "请提供有效的 Agent ID。",
      });
    }
  });

export type CreatePrimaryAgentRoutesOptions = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  primaryAgentService?: PrimaryAgentService;
  managedAgentEndpoint?: string;
  auditStore?: AuditStore;
};

function serializeStatus(
  actor: AgentActor,
  status: PrimaryAgentStatus,
  managedAgentEndpoint?: string,
) {
  return {
    configuredAgentId: status.configuredAgentId,
    isPaused: status.isPaused,
    primaryAgent: status.primaryAgent
      ? serializeAgentDto(actor, status.primaryAgent, managedAgentEndpoint)
      : null,
    resolution: status.resolution,
  };
}

export function mapPrimaryAgentError(
  context: Context,
  error: unknown,
): Response | null {
  if (error instanceof PrimaryAgentPausedError) {
    return context.json(
      {
        error: error.message,
        code: error.code,
        agentId: error.agentId,
      },
      409,
    );
  }
  if (error instanceof PrimaryAgentError) {
    return context.json(
      {
        error: error.message,
        code: error.code,
      },
      error.status,
    );
  }
  return null;
}

function logPrimaryAgentAudit(
  actorId: string,
  targetAgentId: string | null,
  previousAgentId: string | null,
  context: Context,
) {
  const clientIp =
    context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    context.req.header("x-real-ip") ||
    undefined;
  console.info(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      event: "audit.preferences.primary_agent_changed",
      actorId,
      targetAgentId,
      previousAgentId,
      ...(clientIp ? { clientIp } : {}),
    }),
  );
}

async function recordPrimaryAgentAudit(
  auditStore: AuditStore | undefined,
  actorId: string,
  targetAgentId: string | null,
  previousAgentId: string | null,
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType: "configuration.changed",
    targetType: "user_preferences",
    targetId: actorId,
    actorUserId: actorId,
    payload: {
      change: targetAgentId ? "primary_agent_set" : "primary_agent_cleared",
      targetAgentId,
      previousAgentId,
    },
  });
}

export function createPrimaryAgentRoutes(
  options: CreatePrimaryAgentRoutesOptions,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser);

  routes.get("/", async (context) => {
    if (!options.primaryAgentService) {
      return context.json(
        {
          error: "主 Agent 服务暂时不可用。",
          code: "STORAGE_UNAVAILABLE",
        },
        503,
      );
    }
    try {
      const status = await options.primaryAgentService.getStatus(
        context.var.actor,
      );
      return context.json(
        serializeStatus(
          context.var.actor,
          status,
          options.managedAgentEndpoint,
        ),
      );
    } catch (error) {
      const mapped = mapPrimaryAgentError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  routes.put("/", async (context) => {
    if (!options.primaryAgentService) {
      return context.json(
        {
          error: "主 Agent 偏好设置暂时无法写入，请稍后重试。",
          code: "STORAGE_UNAVAILABLE",
        },
        503,
      );
    }
    const parsed = putPrimaryAgentSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: "请提供有效的 Agent ID。",
          code: "BAD_REQUEST",
        },
        400,
      );
    }
    try {
      const actor = context.var.actor;
      const { previousAgentId, status } =
        await options.primaryAgentService.setPrimaryAgent(
          actor,
          parsed.data.agentId,
        );
      logPrimaryAgentAudit(
        actor.id,
        parsed.data.agentId,
        previousAgentId,
        context,
      );
      await recordPrimaryAgentAudit(
        options.auditStore,
        actor.id,
        parsed.data.agentId,
        previousAgentId,
      );
      return context.json(
        serializeStatus(actor, status, options.managedAgentEndpoint),
      );
    } catch (error) {
      const mapped = mapPrimaryAgentError(context, error);
      if (mapped) return mapped;
      return context.json(
        {
          error: "主 Agent 偏好设置暂时无法写入，请稍后重试。",
          code: "STORAGE_UNAVAILABLE",
        },
        503,
      );
    }
  });

  routes.delete("/", async (context) => {
    if (!options.primaryAgentService) {
      return context.json(
        {
          error: "主 Agent 偏好设置暂时无法写入，请稍后重试。",
          code: "STORAGE_UNAVAILABLE",
        },
        503,
      );
    }
    try {
      const actor = context.var.actor;
      const { previousAgentId, status } =
        await options.primaryAgentService.clearPrimaryAgent(actor);
      logPrimaryAgentAudit(actor.id, null, previousAgentId, context);
      await recordPrimaryAgentAudit(
        options.auditStore,
        actor.id,
        null,
        previousAgentId,
      );
      return context.json(
        serializeStatus(actor, status, options.managedAgentEndpoint),
      );
    } catch (error) {
      const mapped = mapPrimaryAgentError(context, error);
      if (mapped) return mapped;
      return context.json(
        {
          error: "主 Agent 偏好设置暂时无法写入，请稍后重试。",
          code: "STORAGE_UNAVAILABLE",
        },
        503,
      );
    }
  });

  return routes;
}
