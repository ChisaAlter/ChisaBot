import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  deploymentPackages,
  pluginGrants,
  skills,
  skillTools,
} from "../src/db/schema";
import {
  deleteGrantsForAgent,
  sweepPackageOrphans,
} from "../src/package-orphans";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// 瘦身 P2：开机孤儿清理 + 删机器人收回授权（docs/slimming.md）。
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made = {
  agents: [] as string[],
  skills: [] as string[],
  channels: [] as string[],
  packages: [] as string[],
};

afterEach(async () => {
  if (made.channels.length)
    await database
      .delete(channels)
      .where(inArray(channels.id, made.channels.splice(0)));
  if (made.skills.length) {
    const ids = made.skills.splice(0);
    await database.delete(skillTools).where(inArray(skillTools.skillId, ids));
    await database.delete(skills).where(inArray(skills.id, ids));
  }
  if (made.agents.length)
    await database
      .delete(agents)
      .where(inArray(agents.id, made.agents.splice(0)));
  if (made.packages.length)
    await database
      .delete(deploymentPackages)
      .where(inArray(deploymentPackages.id, made.packages.splice(0)));
});
afterAll(async () => {
  await database.$client.close();
});

async function bot(deleted: boolean, packageId: string | null = null) {
  const id = `orphan-${randomUUID().slice(0, 8)}`;
  made.agents.push(id);
  await database
    .insert(agents)
    .values({
      id,
      name: id,
      type: "built_in",
      configuration: { systemPrompt: "x" },
      packageId,
    });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: null,
    title: "t",
    roleDescription: "r",
    avatarSeed: id,
    visibility: "public",
    deletedAt: deleted ? new Date() : null,
  });
  return id;
}

async function skill(
  slug: string,
  owner: string | null,
  origin: "catalogue" | "yours" = "catalogue",
) {
  made.skills.push(slug);
  await database.insert(skills).values({
    id: slug,
    ownerUserId: owner,
    slug,
    title: slug,
    summary: "s",
    instructions: "i",
    origin,
    installedBy: null,
  });
}

async function onlyPackage() {
  const others = await database
    .select({ id: deploymentPackages.id })
    .from(deploymentPackages);
  if (others.length > 0) return null;
  const [row] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: `t-${randomUUID().slice(0, 8)}`,
      sourcePath: "/x",
      checksum: "c",
    })
    .returning();
  made.packages.push(row!.id);
  return row!.id;
}

describe("开机孤儿清理", () => {
  test("授给已删除机器人的授权被删，活着的机器人的授权保留", async () => {
    const live = await bot(false);
    const gone = await bot(true);
    await database.insert(pluginGrants).values([
      { kind: "skill", ref: "x", agentId: live, grantedBy: "test" },
      { kind: "skill", ref: "x", agentId: gone, grantedBy: "test" },
      { kind: "mcp", ref: "y", agentId: gone, grantedBy: "test" },
    ]);
    const result = await sweepPackageOrphans(database, {
      packageId: randomUUID(),
      skillSlugs: [],
      channelIds: [],
    });
    expect(result?.grants).toBeGreaterThanOrEqual(2);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, gone)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, live)),
    ).toHaveLength(1);
  });

  test("删机器人时收回它的授权", async () => {
    const id = await bot(false);
    await database
      .insert(pluginGrants)
      .values({ kind: "skill", ref: "x", agentId: id, grantedBy: "test" });
    await deleteGrantsForAgent(database, id);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, id)),
    ).toHaveLength(0);
  });

  test("包里删掉的包技能和没用过的包频道被删，用户自己的技能、包里还在的保留", async () => {
    const packageId = await onlyPackage();
    if (!packageId) {
      console.warn("skipped: test database already holds a deployment package");
      return;
    }
    const keep = `keep-${randomUUID().slice(0, 6)}`;
    const drop = `drop-${randomUUID().slice(0, 6)}`;
    const mine = `mine-${randomUUID().slice(0, 6)}`;
    await skill(keep, null);
    await skill(drop, null);
    await skill(mine, null, "yours");
    await database
      .insert(skillTools)
      .values({ skillId: drop, ref: "a/b", declaredBy: null });
    const owner = await bot(false);
    await database
      .insert(pluginGrants)
      .values({
        kind: "skill",
        ref: drop,
        agentId: owner,
        grantedBy: "tenant-package",
      });
    const kept = `ch-keep-${randomUUID().slice(0, 6)}`;
    const old = `ch-old-${randomUUID().slice(0, 6)}`;
    made.channels.push(kept, old);
    await database.insert(channels).values([
      {
        id: kept,
        name: kept,
        description: "d",
        allowedGroups: ["all"],
        packageId,
      },
      {
        id: old,
        name: old,
        description: "d",
        allowedGroups: ["all"],
        packageId,
      },
    ]);
    await database
      .insert(channelAgents)
      .values({ channelId: old, agentId: owner });

    const result = await sweepPackageOrphans(database, {
      packageId,
      skillSlugs: [keep],
      channelIds: [kept],
    });
    expect(result?.skills).toContain(drop);
    expect(result?.skills).not.toContain(keep);
    expect(result?.skills).not.toContain(mine);
    const left = (
      await database
        .select({ slug: skills.slug })
        .from(skills)
        .where(inArray(skills.slug, [keep, drop, mine]))
    )
      .map((r) => r.slug)
      .sort();
    expect(left).toEqual([keep, mine].sort());
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, drop)),
    ).toHaveLength(0);
    expect(result?.channels).toEqual([old]);
    expect(
      (
        await database
          .select({ id: channels.id })
          .from(channels)
          .where(inArray(channels.id, [kept, old]))
      ).map((r) => r.id),
    ).toEqual([kept]);
  });

  test("CHISABOT_ORPHAN_SWEEP=0 时什么都不做", async () => {
    process.env.CHISABOT_ORPHAN_SWEEP = "0";
    try {
      expect(
        await sweepPackageOrphans(database, {
          packageId: randomUUID(),
          skillSlugs: [],
          channelIds: [],
        }),
      ).toBeNull();
    } finally {
      delete process.env.CHISABOT_ORPHAN_SWEEP;
    }
  });
});
