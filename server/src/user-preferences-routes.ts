import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_SOUNDS,
} from "../../shared/notifications";
import type { AgentActor } from "./agents/profile-types";
import type { AppVariables } from "./auth/guards";
import { mapPrimaryAgentError } from "./settings/primary-agent-routes";
import type { UserPreferencesStore } from "./user-preferences";

/*
 * Each preference is optional so one control can save its own without restating the others, and
 * the merge in Postgres keeps the rest. Strict, so an unknown key is refused rather than stored, and
 * at least one key, so an empty body is a mistake rather than a no-op write.
 */
const preferencesPatch = z
  .strictObject({
    messageListEmphasis: z.enum(["agent", "thread"]).optional(),
    mainBotId: z.string().min(1).max(200).nullable().optional(),
    brandAccent: z.string().trim().max(24).optional(),
    brandRest: z.string().trim().max(24).optional(),
    notificationFrequency: z.enum(NOTIFICATION_FREQUENCIES).optional(),
    notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export type UserPreferencesRoutesOptions = {
  validateMainBot?: (actor: AgentActor, agentId: string) => Promise<unknown>;
};

export function userPreferencesRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: UserPreferencesStore,
  options?: UserPreferencesRoutesOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.get("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    return context.json({
      preferences: await store.read(context.var.actor.id),
    });
  });
  app.patch("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    const parsed = preferencesPatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        {
          error:
            "Choose agent or thread for message list emphasis, a Bot id (or null) for the main Bot, or a brand name of at most 24 characters per part.",
        },
        400,
      );
    }
    if (typeof parsed.data.mainBotId === "string" && options?.validateMainBot) {
      try {
        await options.validateMainBot(context.var.actor, parsed.data.mainBotId);
      } catch (error) {
        const mapped = mapPrimaryAgentError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    }
    return context.json({
      preferences: await store.patch(context.var.actor.id, parsed.data),
    });
  });
  return app;
}
