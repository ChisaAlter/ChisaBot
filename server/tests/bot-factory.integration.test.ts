import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  CREATE_BOT_TOOL,
  createBotFactory,
  createBotFactoryQueries,
} from "../src/agents/bot-factory";
import type { RunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createCoworkerService } from "../src/agents/service";
import { createAuditStore } from "../src/audit";
import { createDatabase, type Database } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  users,
} from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

/**
 * The per-user cap and the per-person advisory lock against a real PostgreSQL.
 *
 * The unit harness fakes `within`, which is exactly where the two bugs lived: the recount ran
 * after the profile row landed (the cap held at 19 of 20), and a `pg_advisory_xact_lock` wait
 * cancelled by `lock_timeout` surfaced as a raw driver error with no audit row. Neither is
 * visible without the real lock and the real count.
 */
const databaseUrl = testDatabaseUrl();
// Wider than TEST_POOL on purpose: the concurrency test needs parallel transactions actually
// reaching the advisory lock, which a two-connection pool turns back into a queue.
const database = createDatabase(databaseUrl, { max: 8, idleTimeout: 1 });
const auditStore = createAuditStore(database);
const store = createAgentProfileStore(database, undefined);
const coworker = createCoworkerService({ store, auditStore });

const prefix = `bot-factory-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

afterAll(async () => {
  // plugin_grants and agent_profiles cascade off agents; audit rows are append-only and stay.
  for (const agentId of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
  await database.$client.close();
});

async function createUser() {
  const userId = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test` });
  createdUserIds.push(userId);
  return userId;
}

/** A person-made Bot (no `created_by_agent_id`, depth 0) that may use the factory. */
async function createCreatorBot(ownerUserId: string) {
  const agentId = `${prefix}-creator-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name: "Factory Bot",
    type: "built_in",
    configuration: { systemPrompt: "You make other Bots." },
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId,
    title: "Factory Bot",
    roleDescription: "You make other Bots.",
    avatarSeed: agentId,
    visibility: "private",
  });
  return agentId;
}

const actorFor = async (userId: string) => ({
  id: userId,
  role: "user" as const,
  email: `${userId}@example.test`,
});

/**
 * The same insert the plugin store's `grant` makes, executor included — the birth grants'
 * foreign key is why `within` runs after the `agents` row.
 */
async function grant(
  kind: "bot",
  ref: string,
  agentId: string,
  by: string,
  executor?: { insert: Database["insert"] },
) {
  await (executor ?? database)
    .insert(pluginGrants)
    .values({ kind, ref, agentId, grantedBy: by })
    .onConflictDoUpdate({
      target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
      set: { grantedBy: by, updatedAt: new Date() },
    });
}

function factoryFor(caps: { maxDepth: number; maxPerUser: number }) {
  return createBotFactory({
    queries: createBotFactoryQueries(database),
    queriesWithin: (executor) => createBotFactoryQueries(executor),
    coworker,
    actorFor,
    caps,
    auditStore,
    grant,
    pause: async () => 0,
  });
}

function assertion(userId: string, botId: string): RunAssertion {
  return {
    botId,
    actorId: userId,
    runId: randomUUID(),
    threadId: randomUUID(),
    depth: 0,
  };
}

function createArgs(index: number) {
  return {
    name: `Factory-made ${index}`,
    title: `Helper ${index}`,
    roleDescription: `Answer helpfully, number ${index}.`,
  };
}

async function refusalsFor(botId: string) {
  const rows = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "bot.factory_refused"),
        eq(auditEvents.targetId, botId),
      ),
    );
  return rows.map((row) => (row.payload as { reason?: string }).reason);
}

/** The same predicate `countForUser` evaluates — the number the cap compares against. */
async function managedCount(userId: string) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.ownerUserId, userId),
        isNotNull(agentProfiles.createdByAgentId),
        isNull(agentProfiles.deletedAt),
      ),
    );
  return row?.count ?? 0;
}

describe("the per-user cap, counted under the lock", () => {
  test("with maxPerUser 20 the 20th create succeeds and the 21st is refused", async () => {
    const userId = await createUser();
    const botId = await createCreatorBot(userId);
    const factory = factoryFor({ maxDepth: 1, maxPerUser: 20 });
    const from = assertion(userId, botId);

    for (let i = 1; i <= 20; i++) {
      const result = await factory.call({
        name: CREATE_BOT_TOOL,
        args: createArgs(i),
        run: from,
      });
      expect(result?.isError).toBe(false);
    }
    expect(await managedCount(userId)).toBe(20);

    const refused = await factory.call({
      name: CREATE_BOT_TOOL,
      args: createArgs(21),
      run: from,
    });
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("No Bot was created");
    expect(await managedCount(userId)).toBe(20);
    expect(await refusalsFor(botId)).toContain("per_user_cap");
  });

  test("with maxPerUser 1 exactly one is allowed", async () => {
    const userId = await createUser();
    const botId = await createCreatorBot(userId);
    const factory = factoryFor({ maxDepth: 1, maxPerUser: 1 });
    const from = assertion(userId, botId);

    const first = await factory.call({
      name: CREATE_BOT_TOOL,
      args: createArgs(1),
      run: from,
    });
    expect(first?.isError).toBe(false);

    const second = await factory.call({
      name: CREATE_BOT_TOOL,
      args: createArgs(2),
      run: from,
    });
    expect(second?.isError).toBe(true);
    expect(await managedCount(userId)).toBe(1);
    expect(await refusalsFor(botId)).toContain("per_user_cap");
  });

  test("30 concurrent creates never exceed the cap", async () => {
    const userId = await createUser();
    const botId = await createCreatorBot(userId);
    const factory = factoryFor({ maxDepth: 1, maxPerUser: 20 });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        factory.call({
          name: CREATE_BOT_TOOL,
          args: createArgs(i),
          run: assertion(userId, botId),
        }),
      ),
    );
    const succeeded = results.filter((r) => r && !r.isError);
    const refused = results.filter((r) => r?.isError);
    expect(succeeded.length).toBe(20);
    expect(refused.length).toBe(10);
    // Every refusal is a sentence the model can say — never a leaked driver error.
    for (const result of refused) {
      expect(result?.text).toContain("No Bot was created");
      expect(result?.text).not.toMatch(/lock timeout|canceling statement/i);
    }
    expect(await managedCount(userId)).toBe(20);
    // And every refusal left its audit row.
    const reasons = await refusalsFor(botId);
    expect(reasons.length).toBe(10);
    for (const reason of reasons) {
      expect(["per_user_cap", "busy"]).toContain(reason);
    }
  });
});

describe("contention on the per-person lock", () => {
  test("a create that loses the lock wait answers busy, and the refusal is audited", async () => {
    const userId = await createUser();
    const botId = await createCreatorBot(userId);
    const factory = factoryFor({ maxDepth: 1, maxPerUser: 20 });

    /*
     * A second driver holds the same advisory key on its own session: the create's
     * `pg_advisory_xact_lock` then waits the full `lock_timeout` (5s, client.ts) and
     * PostgreSQL cancels it — the 55P03 the tool must translate rather than leak.
     */
    const holder = postgres(databaseUrl, { max: 1 });
    const key = `chisabot:bot-factory:${userId}`;
    try {
      await holder`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      const result = await factory.call({
        name: CREATE_BOT_TOOL,
        args: createArgs(1),
        run: assertion(userId, botId),
      });
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain("No Bot was created");
      expect(result?.text).toContain("try again");
      expect(result?.text).not.toMatch(/lock timeout|canceling statement/i);
    } finally {
      await holder`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(
        () => {},
      );
      await holder.end();
    }

    // Nothing was written for the Bot — the transaction rolled back — but the refusal was.
    expect(await managedCount(userId)).toBe(0);
    expect(await refusalsFor(botId)).toEqual(["busy"]);
  }, 15_000);
});
