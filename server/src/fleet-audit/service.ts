import { z } from "zod";
import type { AgentModelService } from "../agents/model-selection";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { LoadAgentsForActor } from "../conversation-runtime";
import type { Database } from "../db/client";
import type { ModelCatalogService } from "../model-catalog";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import {
  type FleetAuditBotRow,
  type FleetAuditData,
  formatAuditReport,
  workloadHintsOf,
} from "./audit";

/**
 * 车队模型审计（fleet_audit）：一个只读工具，把这个人的 bot「车队」摊开给机器人看——
 * 每个 bot 的职责、生效模型、定时任务和频道活动，加上可用模型目录，机器人据此评估
 * 「谁的模型配贵了 / 配弱了 / 缺能力」并给可执行的换模型建议（DESIGN.md §50 一脉：
 * 证据由服务端给，结论由模型下）。
 *
 * 不改任何配置：建议落在对话里，用户在 bot 资料页 / 设置 → 模型 里自己拍板。
 */
export function createFleetAudit(deps: {
  database: Database;
  loadAgents: LoadAgentsForActor;
  actorFor: (userId: string) => Promise<AgentActor>;
  profiles: AgentProfileStore;
  agentModels: AgentModelService;
  resolveDefaultModel: () => Promise<string>;
  catalog: ModelCatalogService;
}) {
  const sql = deps.database.$client as {
    unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T>;
  };

  type ScheduleRow = {
    agent_id: string;
    title: string;
    instruction: string;
    status: string;
    run_count: number;
    last_status: string | null;
  };
  /** 每个 bot 名下还没结束的定时任务（这个表是 schedules 服务开机建的，读不到就当没有）。 */
  async function schedules(owner: string): Promise<Map<string, ScheduleRow[]>> {
    const rows = await sql
      .unsafe<ScheduleRow[]>(
        `SELECT agent_id, title, instruction, status, run_count, last_status FROM chisabot_schedules
         WHERE owner_user_id = $1 AND status IN ('active', 'paused') ORDER BY created_at DESC LIMIT 400`,
        [owner],
      )
      .catch(() => [] as ScheduleRow[]);
    const byAgent = new Map<string, ScheduleRow[]>();
    for (const row of rows) {
      const list = byAgent.get(row.agent_id);
      if (list) list.push(row);
      else byAgent.set(row.agent_id, [row]);
    }
    return byAgent;
  }

  /** 每个 bot 出现在几个「这个人也在」的频道里（删除的频道不算）。 */
  async function channelCounts(
    owner: string,
    agentIds: string[],
  ): Promise<Map<string, number>> {
    if (!agentIds.length) return new Map();
    const rows = await sql
      .unsafe<{ agent_id: string; n: number }[]>(
        `SELECT ca.agent_id, count(DISTINCT ca.channel_id)::int AS n
         FROM channel_agents ca
         JOIN channel_memberships cm ON cm.channel_id = ca.channel_id AND cm.user_id = $1
         JOIN channels c ON c.id = ca.channel_id AND c.deleted_at IS NULL
         WHERE ca.agent_id = ANY(string_to_array($2, chr(31)))
         GROUP BY ca.agent_id`,
        [owner, agentIds.join("")],
      )
      .catch(() => [] as { agent_id: string; n: number }[]);
    return new Map(rows.map((row) => [row.agent_id, Number(row.n)]));
  }

  async function collect(owner: string): Promise<FleetAuditData> {
    const actor = await deps.actorFor(owner);
    const roster = await deps.loadAgents(actor);
    const ids = roster.map((agent) => agent.id);
    const [profiles, scheduleMap, channels, catalog, modelRows] =
      await Promise.all([
        deps.profiles
          .list(actor)
          .catch(() => [] as Awaited<ReturnType<AgentProfileStore["list"]>>),
        schedules(owner),
        channelCounts(owner, ids),
        deps.catalog.list().catch(() => null),
        // 逐个取生效模型（agentModels 会带上 override / 默认 / canManage / available）。
        Promise.all(
          roster.map(async (agent) => {
            try {
              return [
                agent.id,
                await deps.agentModels.get(actor, agent.id),
              ] as const;
            } catch {
              return [agent.id, null] as const;
            }
          }),
        ),
      ]);
    const profileMap = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    const modelMap = new Map(modelRows);
    const catalogById = new Map(
      (catalog?.models ?? []).map((entry) => [entry.id, entry]),
    );
    const bots: FleetAuditBotRow[] = [];
    const remote: FleetAuditData["remote"] = [];
    const tombstones: FleetAuditData["tombstones"] = [];
    for (const agent of roster) {
      if (agent.type === "unavailable") {
        tombstones.push({ id: agent.id, name: agent.name });
        continue;
      }
      const profile = profileMap.get(agent.id);
      if (agent.type !== "built_in") {
        remote.push({ id: agent.id, name: profile?.name ?? agent.name });
        continue;
      }
      const state = modelMap.get(agent.id);
      const entry = state ? catalogById.get(state.model) : undefined;
      const agentSchedules = (scheduleMap.get(agent.id) ?? []).map((row) => ({
        title: row.title,
        status: row.status,
        runCount: row.run_count,
        lastStatus: row.last_status,
        instruction: row.instruction,
      }));
      const evidence = `${profile?.title ?? ""} ${profile?.roleDescription ?? ""} ${agentSchedules
        .map((row) => `${row.title} ${row.instruction}`)
        .join(" ")}`;
      bots.push({
        id: agent.id,
        name: profile?.name ?? agent.name,
        title: profile?.title ?? "",
        roleDescription: profile?.roleDescription ?? "",
        model: state?.available ? state.model : null,
        modelSource: state?.overrideModel ? "override" : "default",
        capabilities: entry
          ? {
              ...(entry.contextWindow
                ? { contextWindow: entry.contextWindow }
                : {}),
              ...(entry.supportsImages !== undefined
                ? { supportsImages: entry.supportsImages }
                : {}),
              ...(entry.supportsFiles !== undefined
                ? { supportsFiles: entry.supportsFiles }
                : {}),
              ...(entry.supportsTools !== undefined
                ? { supportsTools: entry.supportsTools }
                : {}),
            }
          : null,
        missingFromCatalog: Boolean(
          catalog && state?.model && !catalogById.has(state.model),
        ),
        canManage: state?.canManage ?? false,
        schedules: agentSchedules,
        channelCount: channels.get(agent.id) ?? 0,
        workloadHints: workloadHintsOf(evidence),
      });
    }
    const defaultModel =
      [...modelMap.values()].find((state) => state?.defaultModel)
        ?.defaultModel ?? (await deps.resolveDefaultModel().catch(() => null));
    return {
      defaultModel,
      catalog: catalog
        ? catalog.models.map((entry) => ({
            id: entry.id,
            label: entry.label,
            ...(entry.contextWindow
              ? { contextWindow: entry.contextWindow }
              : {}),
            ...(entry.supportsImages !== undefined
              ? { supportsImages: entry.supportsImages }
              : {}),
            ...(entry.supportsFiles !== undefined
              ? { supportsFiles: entry.supportsFiles }
              : {}),
            ...(entry.supportsTools !== undefined
              ? { supportsTools: entry.supportsTools }
              : {}),
          }))
        : null,
      catalogStale: Boolean(catalog?.stale),
      bots,
      remote,
      tombstones,
    };
  }

  function tools(owner: string): GrantedTool[] {
    return [
      {
        name: "fleet_audit",
        ref: "fleet/fleet_audit",
        description:
          "审计用户的机器人车队：列出每个 bot 的职责、正在用的模型（覆盖或部署默认）、定时任务与频道活动，以及当前可用的模型目录；用来评估「谁的模型配贵了 / 配弱了 / 缺能力」，输出带具体换模型建议的报告。只读，不改任何配置。用户说「审计车队」「模型合不合适」「谁在用贵的模型」「省 token」「模型体检」时用。",
        parameters: z
          .object({
            agentId: z
              .string()
              .max(200)
              .optional()
              .describe("只看一个 bot 时填它的 id；不填审整个车队"),
          })
          .strict(),
        async execute(args) {
          const parsed = z
            .object({ agentId: z.string().max(200).optional() })
            .safeParse(args ?? {});
          if (!parsed.success)
            return `${REFUSAL_MARKER} fleet_audit 参数不对。`;
          const data = await collect(owner);
          const agentId = parsed.data.agentId?.trim();
          if (
            agentId &&
            ![...data.bots, ...data.remote].some((bot) => bot.id === agentId)
          )
            return `${REFUSAL_MARKER} 没有叫「${agentId}」的 bot（可能已删除或你看不到）。`;
          return formatAuditReport(data, agentId || undefined);
        },
      },
    ];
  }

  return { tools };
}
export type FleetAudit = ReturnType<typeof createFleetAudit>;
