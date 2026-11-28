import type { AbstractAgent } from "@ag-ui/client";
import type {
  ModelScenario,
  ScenarioRoute,
  ScenarioRouteEventInput,
} from "../../../shared/model-scenario-routing";
import type { AuditInitiator } from "../audit";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type HandoffForRun,
  type LoadAgentsForActor,
  type LoadAttachment,
  type LoadInstructions,
  type LoadToolsForBot,
  type MarkAttachmentsSent,
  type RuntimeModel,
  type RuntimeModelConnection,
  type RuntimeModelPolicy,
  type RuntimeModelResolver,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../conversation-runtime";
import type { ModelProxyQuotaOptions } from "../conversations/model-connection-proxy";
import type { ToolImagePart } from "../conversations/tool-images";
import type { LoadPersonalMemory } from "../memory/tools";
import type { PromptWorkbenchStore } from "../prompts/workbench-store";
import type { UsageBreakdownService } from "../quotas/usage-breakdown";
import type { AdaptiveRouter } from "./adaptive-router";
import type { ModelObservationService } from "./model-observation";
import type { AgentActor } from "./profile-types";

export type AgentResolutionContext = {
  initiator?: AuditInitiator;
  depth?: number;
  /** 群聊回合：装配工具时私密记忆按群聊隔离（memory-notes 的 isGroupChat 视图）。 */
  isGroupChat?: boolean;
};

export class CoworkerUnavailableError extends Error {}

export type ActorAgentResolver = {
  resolveAgentsForActor(
    actor: AgentActor,
    context?: AgentResolutionContext,
  ): Promise<Record<string, AbstractAgent>>;
  resolveAgentForActor(
    actor: AgentActor,
    agentId: string,
    context?: AgentResolutionContext,
  ): Promise<AbstractAgent>;
};

export type ActorAgentResolverDependencies = {
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey: () => Promise<string | null>;
  /** Read model, endpoint and secret together, once for each turn. */
  resolveConnection?: RuntimeModelResolver;
  /** Shares this BOT's exact choice with the policy check for the same turn. */
  resolveConnectionForAgent?: (
    agentId: string,
  ) => Promise<RuntimeModelConnection>;
  stallGuard?: StallGuard;
  loadToolsForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    options?: { isGroupChat?: boolean },
  ) => LoadToolsForBot;
  signRunForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => SignRun;
  computerGuidance?: string;
  loadVendors?: () => Promise<readonly string[]>;
  selectionForActor?: (actorId: string) => ToolSelection;
  agentFetch?: AgentFetch;
  /**
   * What a Bot may reach past itself for, resolved for whoever is asking.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => HandoffForRun;
  loadInstructionsForActor?: (actorId: string) => LoadInstructions;
  loadAttachmentForActor?: (actorId: string) => LoadAttachment;
  markAttachmentsSentForActor?: (actorId: string) => MarkAttachmentsSent;
  loadPersonalMemoryForActor?: (
    actorId: string,
    getAvailableToolNames?: (botId: string) => ReadonlySet<string> | undefined,
  ) => LoadPersonalMemory;
  quota?: Omit<ModelProxyQuotaOptions, "userId" | "isAdmin">;
  describeImageForActor?: (
    actorId: string,
  ) => (agentId: string, part: ToolImagePart) => Promise<string | null>;
  adaptiveRouter?: AdaptiveRouter;
  scenarioFor?: (scenario: ModelScenario) => Promise<ScenarioRoute>;
  scenarioLog?: (event: ScenarioRouteEventInput) => Promise<void> | void;
  modelObserver?: Pick<ModelObservationService, "isEnabled" | "record">;
  usageBreakdown?: Pick<UsageBreakdownService, "record">;
  promptWorkbench?: PromptWorkbenchStore;
};

/**
 * Resolves the coworkers available to one ChisaBot actor.
 *
 * Every surface enters through this boundary so it shares the same visibility, grants, assertions,
 * skill selection, and endpoint dial policy for a person.
 */
export function createActorAgentResolver(
  deps: ActorAgentResolverDependencies,
): ActorAgentResolver {
  const resolveRegisteredAgents = async (
    actor: AgentActor,
    registered: Awaited<ReturnType<LoadAgentsForActor>>,
    /**
     * Build only this Bot, when the caller already knows which one it wants.
     *
     * The roster is still read in full, so a Bot this person cannot see is still absent. The others
     * are simply neither built nor asked what they hold, which is a query per Bot a headless turn
     * or a Slack thread has no use for.
     */
    onlyAgentId?: string,
    context?: AgentResolutionContext,
  ) => {
    const usesBuiltInModel = registered.some(
      (agent) =>
        agent.type === "built_in" &&
        (onlyAgentId === undefined || agent.id === onlyAgentId),
    );
    const connection = usesBuiltInModel
      ? await deps.resolveConnection?.()
      : undefined;
    const quotaPolicy: ModelProxyQuotaOptions | undefined = deps.quota
      ? {
          ...deps.quota,
          userId: actor.id,
          isAdmin: actor.role === "admin",
        }
      : undefined;
    const describeImageForAgent = deps.describeImageForActor?.(actor.id);
    const runtimePolicy: RuntimeModelPolicy | undefined =
      connection?.pooledKeys ||
      connection?.keyPool ||
      connection?.poolId ||
      quotaPolicy ||
      describeImageForAgent ||
      deps.adaptiveRouter ||
      deps.scenarioFor ||
      deps.scenarioLog ||
      deps.modelObserver ||
      deps.usageBreakdown ||
      deps.promptWorkbench
        ? {
            ...(connection?.pooledKeys
              ? { pooledKeys: connection.pooledKeys }
              : {}),
            ...(connection?.keyPool ? { keyPool: connection.keyPool } : {}),
            ...(connection?.poolId ? { poolId: connection.poolId } : {}),
            ...(quotaPolicy ? { quota: quotaPolicy } : {}),
            ...(describeImageForAgent ? { describeImageForAgent } : {}),
            ...(deps.adaptiveRouter
              ? { adaptiveRouter: deps.adaptiveRouter }
              : {}),
            ...(deps.scenarioFor ? { scenarioFor: deps.scenarioFor } : {}),
            ...(deps.scenarioLog ? { scenarioLog: deps.scenarioLog } : {}),
            ...(deps.modelObserver
              ? { modelObserver: deps.modelObserver }
              : {}),
            ...(deps.usageBreakdown
              ? { usageBreakdown: deps.usageBreakdown }
              : {}),
            ...(deps.promptWorkbench
              ? { promptWorkbench: deps.promptWorkbench }
              : {}),
          }
        : undefined;
    // 单次解析作用域内共享当轮实际装载的工具名集合，供 requiresTools 技能动态隐身使用，杜绝跨上下文串味。
    const turnToolsByBot = new Map<string, ReadonlySet<string>>();
    const baseLoadTools = deps.loadToolsForActor?.(
      actor.id,
      context?.initiator,
      { isGroupChat: context?.isGroupChat },
    );
    const scopedLoadTools: LoadToolsForBot | undefined = baseLoadTools
      ? async (botId) => {
          const loaded = await baseLoadTools(botId);
          turnToolsByBot.set(
            botId,
            new Set(loaded.flatMap((t) => [t.name, t.ref])),
          );
          return loaded;
        }
      : undefined;
    return resolveRuntimeAgents(
      () => Promise.resolve(registered),
      connection?.model ?? deps.model,
      connection ? async () => connection.apiKey : deps.resolveModelApiKey,
      deps.stallGuard,
      scopedLoadTools,
      deps.signRunForActor?.(actor.id, context?.initiator, context?.depth),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
      deps.handoffForActor?.(actor.id, context?.initiator, context?.depth),
      onlyAgentId,
      deps.loadInstructionsForActor?.(actor.id),
      context?.initiator,
      deps.loadAttachmentForActor?.(actor.id),
      deps.markAttachmentsSentForActor?.(actor.id),
      undefined, // 位置占位参数
      deps.loadPersonalMemoryForActor?.(actor.id, (botId) =>
        turnToolsByBot.get(botId),
      ),
      deps.resolveConnectionForAgent,
      // The self-map's one fact about the person: may they approve an admin action.
      { isAdmin: actor.role === "admin" },
      runtimePolicy,
    );
  };

  const resolveAgentsForActor = async (
    actor: AgentActor,
    context?: AgentResolutionContext,
  ) =>
    resolveRegisteredAgents(
      actor,
      await deps.loadAgents(actor),
      undefined,
      context,
    );

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId, context) {
      const registered = await deps.loadAgents(actor);
      if (!registered.some((agent) => agent.id === agentId)) {
        throw new CoworkerUnavailableError(
          `Coworker ${agentId} is unavailable to this user.`,
        );
      }

      const agents = await resolveRegisteredAgents(
        actor,
        registered,
        agentId,
        context,
      );
      const agent = Object.hasOwn(agents, agentId)
        ? agents[agentId]
        : undefined;
      if (!agent) {
        throw new CoworkerUnavailableError(
          `Coworker ${agentId} is unavailable to this user.`,
        );
      }
      return agent;
    },
  };
}
