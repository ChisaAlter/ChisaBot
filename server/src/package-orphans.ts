import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "./db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels as channelTable,
  chisabotChannelMappings,
  deploymentPackages,
  pluginGrants,
  skills as skillTable,
  skillTools,
} from "./db/schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

/**
 * 孤儿数据清理（瘦身 P2，docs/slimming.md）。开机在部署包同步的同一个事务里跑一次，幂等；
 * `CHISABOT_ORPHAN_SWEEP=0` 关掉。只删「已经没有主人」的行，从不碰用户自己的东西：
 *
 * 1. 部署包不再声明的包技能（`origin = catalogue`、没有主人）连同它的工具声明和授权。用户自己写的技能
 *    （有 owner、或 origin 不是 catalogue）不动，哪怕同名。
 * 2. 部署包不再声明的包频道 —— 只在它没有任何成员、没有映射（从没被当成对话用过）时删；
 *    被用过的留着（那是历史对话）。
 * 3. 授给已删除 / 不存在的机器人的插件与技能授权（`plugin_grants`）。
 *
 * 1 和 2 只在库里只有这一个部署包时做：技能表按名字全局共享、不记是哪个包种的，库里有多个包（例如测试库）时
 * 分不清哪个技能是「这个包不要了」，宁可不删。
 */
export async function sweepPackageOrphans(
  executor: Executor,
  input: { packageId: string; skillSlugs: string[]; channelIds: string[] },
) {
  if (process.env.CHISABOT_ORPHAN_SWEEP === "0") return null;

  const packages = await executor
    .select({ id: deploymentPackages.id })
    .from(deploymentPackages)
    .limit(2);
  const onlyPackage =
    packages.length === 1 && packages[0]?.id === input.packageId;

  const staleSkills = onlyPackage
    ? await executor
        .select({ id: skillTable.id, slug: skillTable.slug })
        .from(skillTable)
        .where(
          and(
            eq(skillTable.origin, "catalogue"),
            isNull(skillTable.ownerUserId),
            input.skillSlugs.length > 0
              ? notInArray(skillTable.slug, input.skillSlugs)
              : undefined,
          ),
        )
    : [];
  const staleSkillIds = staleSkills.map((skill) => skill.id);
  if (staleSkillIds.length > 0) {
    await executor
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          inArray(pluginGrants.ref, staleSkillIds),
        ),
      );
    await executor
      .delete(skillTools)
      .where(inArray(skillTools.skillId, staleSkillIds));
    await executor
      .delete(skillTable)
      .where(inArray(skillTable.id, staleSkillIds));
  }

  const used = or(
    sql`exists (select 1 from ${channelMemberships} where ${channelMemberships.channelId} = ${channelTable.id})`,
    sql`exists (select 1 from ${chisabotChannelMappings} where ${chisabotChannelMappings.channelId} = ${channelTable.id})`,
  );
  const staleChannels = onlyPackage
    ? await executor
        .select({ id: channelTable.id })
        .from(channelTable)
        .where(
          and(
            eq(channelTable.packageId, input.packageId),
            input.channelIds.length > 0
              ? notInArray(channelTable.id, input.channelIds)
              : undefined,
            sql`not (${used})`,
          ),
        )
    : [];
  const staleChannelIds = staleChannels.map((channel) => channel.id);
  if (staleChannelIds.length > 0) {
    await executor
      .delete(channelAgents)
      .where(inArray(channelAgents.channelId, staleChannelIds));
    await executor
      .delete(channelTable)
      .where(inArray(channelTable.id, staleChannelIds));
  }

  const grants = await executor
    .delete(pluginGrants)
    .where(
      sql`not exists (select 1 from ${agentProfiles} where ${agentProfiles.agentId} = ${pluginGrants.agentId} and ${agentProfiles.deletedAt} is null)`,
    )
    .returning({ agentId: pluginGrants.agentId });

  const result = {
    type: "package-orphan-sweep",
    skills: staleSkills.map((skill) => skill.slug),
    channels: staleChannelIds,
    grants: grants.length,
  };
  if (result.skills.length || result.channels.length || result.grants)
    console.log(JSON.stringify(result));
  return result;
}

/** 删机器人时顺手收回它的插件 / 技能授权（软删除的机器人用不到它们）。 */
export async function deleteGrantsForAgent(
  executor: Executor,
  agentId: string,
) {
  await executor.delete(pluginGrants).where(eq(pluginGrants.agentId, agentId));
}
