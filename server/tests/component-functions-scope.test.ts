import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { dataFunction } from "../src/components/functions";
import { createComponentRoutes } from "../src/components/routes";
import {
  type ComponentStore,
  createComponentStore,
} from "../src/components/store";
import type { Database } from "../src/db/client";

const dialect = new PgDialect();

type CapturedQuery = { sql: string; params: unknown[] };

function fakeAuditDatabase(
  auditRows: Array<{
    bot: string | null;
    eventType: string;
    reason: string | null;
    at: string;
  }>,
  profiles: Array<{
    agentId: string;
    ownerUserId: string | null;
    visibility: "public" | "private";
    deletedAt: Date | null;
  }>,
) {
  const queries: CapturedQuery[] = [];
  const database = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      const normalized = compiled.sql.replace(/\s+/g, " ").toLowerCase();

      const hasProfileScope =
        normalized.includes("agent_profiles") &&
        normalized.includes("owner_user_id") &&
        normalized.includes("visibility") &&
        normalized.includes("deleted_at is null");

      const visibleBots = (actorId: string) =>
        new Set(
          profiles
            .filter(
              (profile) =>
                profile.deletedAt === null &&
                (profile.visibility === "public" ||
                  profile.ownerUserId === actorId),
            )
            .map((profile) => profile.agentId),
        );

      const scopedActorId = hasProfileScope
        ? compiled.params.find(
            (param): param is string => typeof param === "string",
          )
        : undefined;

      const filtered = auditRows.filter((row) => {
        if (!scopedActorId) return true;
        if (!row.bot) return false;
        return visibleBots(scopedActorId).has(row.bot);
      });

      if (normalized.includes("group by 1")) {
        const counts = new Map<string, number>();
        for (const row of filtered) {
          if (!row.bot) continue;
          counts.set(row.bot, (counts.get(row.bot) ?? 0) + 1);
        }
        return [...counts.entries()].map(([bot, actions]) => ({
          bot,
          actions,
        }));
      }

      return filtered.map((row) => ({
        at: row.at,
        bot: row.bot,
        what: row.eventType,
        reason: row.reason,
      }));
    },
  } as unknown as Database;

  return { database, queries };
}

describe("component data functions actor scoping", () => {
  const auditFixture = [
    {
      bot: "bot-a-private",
      eventType: "component.refused",
      reason: "A private refusal",
      at: "2026-11-24T00:00:01Z",
    },
    {
      bot: "bot-b-private",
      eventType: "computer.action_refused",
      reason: "B secret refusal",
      at: "2026-11-24T00:00:02Z",
    },
    {
      bot: "bot-public",
      eventType: "bot.declined",
      reason: "Public refusal",
      at: "2026-11-24T00:00:03Z",
    },
    {
      bot: "bot-deleted",
      eventType: "component.refused",
      reason: "Deleted bot refusal",
      at: "2026-11-24T00:00:04Z",
    },
    {
      bot: null,
      eventType: "computer.action_refused",
      reason: "Deployment-wide refusal",
      at: "2026-11-24T00:00:05Z",
    },
  ];

  const profileFixture = [
    {
      agentId: "bot-a-private",
      ownerUserId: "user-a",
      visibility: "private" as const,
      deletedAt: null,
    },
    {
      agentId: "bot-b-private",
      ownerUserId: "user-b",
      visibility: "private" as const,
      deletedAt: null,
    },
    {
      agentId: "bot-public",
      ownerUserId: "user-b",
      visibility: "public" as const,
      deletedAt: null,
    },
    {
      agentId: "bot-deleted",
      ownerUserId: "user-a",
      visibility: "private" as const,
      deletedAt: new Date("2026-11-23T00:00:00Z"),
    },
  ];

  test("botActivity scopes non-admin callers to bots they can access", async () => {
    const fn = dataFunction("botActivity");
    expect(fn).toBeDefined();
    if (!fn) return;

    const { database } = fakeAuditDatabase(auditFixture, profileFixture);
    const userA: AgentActor = { id: "user-a", role: "user" };
    const result = (await fn.run(database, { days: 7 }, userA)) as {
      days: number;
      rows: Array<{ bot: string; actions: number }>;
    };

    expect(result.rows.map((row) => row.bot).sort()).toEqual([
      "bot-a-private",
      "bot-public",
    ]);
  });

  test("recentRefusals hides other users' private bots and null-bot rows from non-admins", async () => {
    const fn = dataFunction("recentRefusals");
    expect(fn).toBeDefined();
    if (!fn) return;

    const { database } = fakeAuditDatabase(auditFixture, profileFixture);
    const userA: AgentActor = { id: "user-a", role: "user" };
    const result = (await fn.run(database, { limit: 20 }, userA)) as {
      rows: Array<{ bot: string | null; reason: string | null }>;
    };

    expect(result.rows.map((row) => row.bot).sort()).toEqual([
      "bot-a-private",
      "bot-public",
    ]);
  });

  test("admin callers still see deployment-wide botActivity and recentRefusals", async () => {
    const activityFn = dataFunction("botActivity");
    const refusalFn = dataFunction("recentRefusals");
    expect(activityFn).toBeDefined();
    expect(refusalFn).toBeDefined();
    if (!activityFn || !refusalFn) return;

    const { database } = fakeAuditDatabase(auditFixture, profileFixture);
    const admin: AgentActor = { id: "admin-1", role: "admin" };

    const activity = (await activityFn.run(database, { days: 7 }, admin)) as {
      rows: Array<{ bot: string; actions: number }>;
    };
    expect(activity.rows.map((row) => row.bot).sort()).toEqual([
      "bot-a-private",
      "bot-b-private",
      "bot-deleted",
      "bot-public",
    ]);

    const refusals = (await refusalFn.run(database, { limit: 20 }, admin)) as {
      rows: Array<{ bot: string | null }>;
    };
    expect(refusals.rows).toHaveLength(5);
  });

  test("POST /api/components/:name/call forwards caller actor to store.callFunction", async () => {
    const { database } = fakeAuditDatabase(auditFixture, profileFixture);
    const realStore = createComponentStore(database);
    const store: ComponentStore = {
      ...realStore,
      decide: async () => ({ allowed: true, description: "Published." }),
      mayCall: async () => true,
    };

    let activeActor: AuthenticatedActor = {
      id: "user-a",
      email: "a@chisabot.test",
      role: "user",
    };
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", activeActor);
      await next();
    };

    const app = new Hono().route(
      "/api/components",
      createComponentRoutes(store, requireUser, undefined, async () => true),
    );

    const userResponse = await app.request(
      "http://chisabot.local/api/components/activityChart/call",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bot-a-private",
          function: "recentRefusals",
          args: { limit: 20 },
        }),
      },
    );
    expect(userResponse.status).toBe(200);
    const userPayload = (await userResponse.json()) as {
      allowed: boolean;
      data: { rows: Array<{ bot: string | null }> };
    };
    expect(userPayload.allowed).toBe(true);
    expect(userPayload.data.rows.map((row) => row.bot).sort()).toEqual([
      "bot-a-private",
      "bot-public",
    ]);

    activeActor = {
      id: "admin-1",
      email: "admin@chisabot.test",
      role: "admin",
    };
    const adminResponse = await app.request(
      "http://chisabot.local/api/components/activityChart/call",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bot-a-private",
          function: "recentRefusals",
          args: { limit: 20 },
        }),
      },
    );
    expect(adminResponse.status).toBe(200);
    const adminPayload = (await adminResponse.json()) as {
      allowed: boolean;
      data: { rows: Array<{ bot: string | null }> };
    };
    expect(adminPayload.data.rows).toHaveLength(5);
  });
});
