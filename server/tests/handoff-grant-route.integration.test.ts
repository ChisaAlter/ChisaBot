import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, pluginGrants } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The authorization panel's write path, end to end: `POST /api/plugins/grants` with
 * `kind: "bot"` — the request `setHandoffGrantMutationOptions` makes — lands in `plugin_grants`,
 * and the desk's read (`botsReachableFrom`, the same call `mayAddress` makes) sees it at once.
 *
 * The route's refusal matrix is covered against a stubbed store in `plugin-routes.test.ts`; this
 * file exists because a stub cannot prove the row the route wrote is the row the desk reads.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => {
      throw new Error("a bot grant never reads credentials");
    },
    create: async () => {
      throw new Error("a bot grant never writes credentials");
    },
    revoke: async () => {
      throw new Error("a bot grant never revokes credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
const ASKER = `panel-asker-${suite}`;
const TARGET = `panel-target-${suite}`;
const ALL = [ASKER, TARGET];

const ADMIN = {
  id: `panel-admin-${suite}`,
  email: "admin@chisabot.test",
  name: "An Administrator",
  image: null,
};

const app = createApp(
  loadConfig(testEnvironment()),
  {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: ADMIN }) },
  } as never,
  { rolesForUser: async () => ["admin" as const] },
  // Positions 4–14 are the other stores; the real one is 15, pluginStore.
  ...(Array.from({ length: 11 }) as never[]),
  store as never,
);

async function clean() {
  await database.delete(pluginGrants).where(inArray(pluginGrants.agentId, ALL));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, ALL));
  await database.delete(agents).where(inArray(agents.id, ALL));
}

beforeEach(async () => {
  await clean();
  for (const [id, name] of [
    [ASKER, "Panel Asker"],
    [TARGET, "Panel Target"],
  ] as const) {
    await database.insert(agents).values({
      id,
      name,
      type: "built_in",
      configuration: { systemPrompt: "Help." },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      name,
      title: "",
      roleDescription: "",
      avatarSeed: id,
      visibility: "private",
    });
  }
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("the handoff panel's grant, written over HTTP", () => {
  test("an administrator's POST is one botsReachableFrom can read", async () => {
    expect(await store.botsReachableFrom(ASKER)).toEqual([]);

    const response = await app.request(
      "http://chisabot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bot", ref: TARGET, agentId: ASKER }),
      },
    );
    expect(response.status).toBe(200);

    // Direction matters here and is easy to swap: `agentId` is the Bot doing the asking.
    expect(await store.botsReachableFrom(ASKER)).toEqual([TARGET]);
    expect(await store.botsReachableFrom(TARGET)).toEqual([]);

    const revoke = await app.request(
      `http://chisabot.test/api/plugins/grants?kind=bot&ref=${TARGET}&agentId=${ASKER}`,
      { method: "DELETE" },
    );
    expect(revoke.status).toBe(200);
    expect(await store.botsReachableFrom(ASKER)).toEqual([]);
  });
});
