import type { AgentProfile } from "./queries";

/**
 * /bots 列表「由『X』创建」徽章的那行字。
 *
 * `createdByAgentId` 是个 id，人读的是名字：从同一份名册解析（创建者是 bot 时它也在列表里）。
 * 创建者不在名册——被删了或不可见——如实说「另一个机器人」而不是露一个 id；人建的返回 null，
 * 不画徽章。
 */
export function createdByLabel(
  agent: Pick<AgentProfile, "createdByAgentId">,
  roster: readonly { id: string; name: string }[],
): string | null {
  const creatorId = agent.createdByAgentId;
  if (!creatorId) return null;
  const name = roster.find((bot) => bot.id === creatorId)?.name;
  return `由「${name ?? "另一个机器人"}」创建`;
}
