import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createAgentModelService,
  ModelSelectionError,
} from "../src/agents/model-selection";
import {
  createAgentProfileStore,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  deploymentPackages,
  users,
} from "../src/db/schema";
import {
  type LoadedTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profiles = createAgentProfileStore(database, undefined);
const ids = {
  bots: [] as string[],
  users: [] as string[],
  packages: [] as string[],
};
let catalogFails = false;
const catalog = {
  list: async () => {
    if (catalogFails)
      throw new Error("private upstream response must never escape");
    return {
      models: ["gateway/default", "vendor/full/model-id", "vendor/second"].map(
        (id) => ({ id, label: id, provider: "vendor" }),
      ),
      fetchedAt: 1,
    };
  },
};
const service = createAgentModelService({
  database,
  profiles,
  resolveDefaultModel: async () => "gateway/default",
  catalog,
});

afterEach(async () => {
  catalogFails = false;
  for (const id of ids.bots.splice(0))
    await database.delete(agents).where(eq(agents.id, id));
  for (const id of ids.packages.splice(0))
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, id));
  for (const id of ids.users.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

async function actor(role: "admin" | "user" = "user"): Promise<AgentActor> {
  const id = `model-selection-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, name: "Test", email: `${id}@example.test` });
  ids.users.push(id);
  return { id, role };
}

async function bot(
  owner: AgentActor | null,
  options: { system?: boolean; remote?: boolean; override?: unknown } = {},
) {
  const id = `model-selection-bot-${randomUUID()}`;
  let packageId: string | undefined;
  if (options.system) {
    const [row] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: randomUUID(),
        sourcePath: "test",
        checksum: randomUUID(),
      })
      .returning();
    packageId = row!.id;
    ids.packages.push(packageId);
  }
  await database.insert(agents).values({
    id,
    name: "Test",
    type: options.remote ? "remote_ag_ui" : "built_in",
    configuration: options.remote
      ? { endpoint: "https://example.test/ag-ui" }
      : { systemPrompt: "Reply." },
    override: options.override,
    packageId,
  });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: owner?.id ?? null,
    title: "Test",
    roleDescription: "Reply.",
    avatarSeed: id,
    visibility: "public",
  });
  ids.bots.push(id);
  return id;
}

test("the owner changes only the persistent model and clearing it inherits the live default", async () => {
  const owner = await actor();
  const id = await bot(owner, { override: { futureSetting: { keep: true } } });
  expect(await service.get(owner, id)).toMatchObject({
    model: "gateway/default",
    overrideModel: null,
    canManage: true,
    available: true,
  });
  expect(await service.set(owner, id, "vendor/full/model-id")).toMatchObject({
    model: "vendor/full/model-id",
    overrideModel: "vendor/full/model-id",
  });
  const [row] = await database.select().from(agents).where(eq(agents.id, id));
  expect(row!.configuration).toEqual({ systemPrompt: "Reply." });
  expect(row!.override).toEqual({
    futureSetting: { keep: true },
    model: "vendor/full/model-id",
  });
  expect(await service.resolveModel(id)).toBe("vendor/full/model-id");
  await service.set(owner, id, null);
  expect(await service.resolveModel(id)).toBeNull();
  const [cleared] = await database
    .select()
    .from(agents)
    .where(eq(agents.id, id));
  expect(cleared!.override).toEqual({ futureSetting: { keep: true } });
});

test("a public BOT is readable by teammates but only owner/admin may select its model", async () => {
  const owner = await actor();
  const teammate = await actor();
  const admin = await actor("admin");
  const id = await bot(owner);
  expect((await service.get(teammate, id)).canManage).toBe(false);
  await expect(
    service.set(teammate, id, "vendor/second"),
  ).rejects.toMatchObject({ status: 403 });
  await service.set(admin, id, "vendor/second");
  expect((await service.get(owner, id)).model).toBe("vendor/second");
});

test("administrator model selection on system BOTs leaves protected profile editing unchanged", async () => {
  const admin = await actor("admin");
  const member = await actor();
  const id = await bot(null, { system: true });
  await expect(service.set(member, id, "vendor/second")).rejects.toMatchObject({
    status: 403,
  });
  await service.set(admin, id, "vendor/second");
  await expect(
    profiles.update(admin, id, {
      name: "Changed",
      title: "Test",
      roleDescription: "Changed",
      visibility: "public",
    }),
  ).rejects.toBeInstanceOf(ProtectedAgentError);
});

test("remote, deleted and hidden private BOTs never become locally model selectable", async () => {
  const owner = await actor();
  const outsider = await actor();
  const remote = await bot(owner, { remote: true });
  expect(await service.get(owner, remote)).toMatchObject({
    available: false,
    canManage: false,
  });
  await expect(
    service.set(owner, remote, "vendor/second"),
  ).rejects.toMatchObject({ status: 409 });
  const id = await bot(owner);
  await database
    .update(agentProfiles)
    .set({ visibility: "private" })
    .where(eq(agentProfiles.agentId, id));
  await expect(service.get(outsider, id)).rejects.toMatchObject({
    status: 404,
  });
  await database
    .update(agentProfiles)
    .set({ deletedAt: new Date() })
    .where(eq(agentProfiles.agentId, id));
  await expect(service.set(owner, id, null)).rejects.toMatchObject({
    status: 404,
  });
});

test("failed catalog saves preserve selection; removed selected IDs stay visibly unavailable", async () => {
  const owner = await actor();
  const id = await bot(owner, { override: { model: "vendor/second" } });
  await expect(service.set(owner, id, "not-in-catalog")).rejects.toMatchObject({
    status: 400,
  });
  catalogFails = true;
  await expect(
    service.set(owner, id, "vendor/full/model-id"),
  ).rejects.toBeInstanceOf(ModelSelectionError);
  expect((await service.get(owner, id)).model).toBe("vendor/second");
  expect(await service.resolveModel(id)).toBe("vendor/second");
  catalogFails = false;
  await database
    .update(agents)
    .set({ override: { model: "removed/full/model" } })
    .where(eq(agents.id, id));
  expect(await service.get(owner, id)).toMatchObject({
    model: "removed/full/model",
    overrideModel: "removed/full/model",
    available: true,
  });
});

test("clearing an override remains available during a catalog outage", async () => {
  const owner = await actor();
  const id = await bot(owner, { override: { model: "vendor/second" } });
  catalogFails = true;
  expect(await service.set(owner, id, null)).toMatchObject({
    model: "gateway/default",
    overrideModel: null,
    available: true,
  });
});

test("a duplicated locally executed BOT inherits its model choice without sharing future changes", async () => {
  const owner = await actor();
  const id = await bot(owner, {
    override: { model: "vendor/full/model-id", futureSetting: true },
  });
  const duplicate = await profiles.duplicate(owner, id);
  ids.bots.push(duplicate.id);
  expect(await service.resolveModel(duplicate.id)).toBe("vendor/full/model-id");
  await service.set(owner, duplicate.id, "vendor/second");
  expect(await service.resolveModel(id)).toBe("vendor/full/model-id");
});

test("system choices survive package synchronization and are loaded into the next runtime roster", async () => {
  const admin = await actor("admin");
  const id = `model-selection-package-${randomUUID()}`;
  const loaded: LoadedTenantPackage = {
    tenantId: `model-selection-tenant-${randomUUID()}`,
    productName: "Test",
    stylesheet: null,
    agents: [
      {
        id,
        name: "Test",
        title: "Test",
        roleDescription: "Reply.",
        type: "built_in",
        configuration: { systemPrompt: "Original." },
        skills: [],
      },
    ],
    omittedAgentIds: [],
    channels: [],
    model: {
      provider: "openai",
      defaultModel: "gateway/default",
      credentialSecretRef: "unused",
    },
    knowledgeSources: [],
    skills: [],
    themeCss: "",
    sourcePath: "/test/model-selection",
    checksum: randomUUID(),
  };
  const seeded = await synchronizeTenantPackage(database, loaded);
  ids.packages.push(seeded.id);
  ids.bots.push(id);
  await service.set(admin, id, "vendor/full/model-id");
  loaded.agents[0]!.configuration = { systemPrompt: "Package updated." };
  await synchronizeTenantPackage(database, loaded);
  expect(await service.resolveModel(id)).toBe("vendor/full/model-id");
  const roster = await createRuntimeAgentLoader(database)(admin);
  expect(roster.find((agent) => agent.id === id)).toMatchObject({
    type: "built_in",
    model: "vendor/full/model-id",
    systemPrompt: "Package updated.",
  });
});

test("model mutation never borrows a second connection from a single-connection test pool", async () => {
  const owner = await actor();
  const id = await bot(owner);
  const single = createDatabase(databaseUrl, { max: 1 });
  const selected = createAgentModelService({
    database: single,
    profiles: createAgentProfileStore(single, undefined),
    catalog,
    resolveDefaultModel: async () => "gateway/default",
  });
  try {
    expect((await selected.set(owner, id, "vendor/second")).model).toBe(
      "vendor/second",
    );
  } finally {
    await single.$client.close();
  }
}, 5000);

test("a queued model mutation rechecks ownership after a concurrent owner transfer commits", async () => {
  const owner = await actor();
  const nextOwner = await actor();
  const id = await bot(owner, {
    override: { model: "vendor/second", retain: true },
  });
  const application = `agent_model_lock_${randomUUID()}`;
  const namedUrl = new URL(databaseUrl);
  namedUrl.searchParams.set("application_name", application);
  const named = createDatabase(namedUrl.toString(), { max: 1 });
  const selected = createAgentModelService({
    database: named,
    profiles: createAgentProfileStore(named, undefined),
    catalog,
    resolveDefaultModel: async () => "gateway/default",
  });
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transfer = database.transaction(async (transaction) => {
    await transaction
      .update(agents)
      .set({ updatedAt: new Date() })
      .where(eq(agents.id, id));
    await transaction
      .update(agentProfiles)
      .set({ ownerUserId: nextOwner.id })
      .where(eq(agentProfiles.agentId, id));
    acquired();
    await hold;
  });
  try {
    await held;
    const mutation = selected.set(owner, id, "vendor/full/model-id").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await database.execute(
        sql`SELECT pid FROM pg_stat_activity WHERE application_name = ${application} AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      if (rows.length) {
        blocked = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    release();
    await transfer;
    expect(await mutation).toMatchObject({ error: { status: 403 } });
    const [row] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, id));
    expect(row!.override).toEqual({ model: "vendor/second", retain: true });
  } finally {
    release();
    await transfer.catch(() => {});
    await named.$client.close();
  }
}, 10000);
