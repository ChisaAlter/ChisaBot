import {
  isValidPrimaryAgentId,
  type PrimaryAgentErrorCode,
  type PrimaryAgentFallbackReason,
  type PrimaryAgentResolution,
} from "../../../shared/validators/primary-agent";
import type { UserPreferencesStore } from "../user-preferences";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

export class PrimaryAgentError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 503;
  readonly code: PrimaryAgentErrorCode;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409 | 422 | 503,
    code: PrimaryAgentErrorCode,
  ) {
    super(message);
    this.name = "PrimaryAgentError";
    this.status = status;
    this.code = code;
  }
}

export class PrimaryAgentValidationError extends PrimaryAgentError {
  constructor(message = "请提供有效的 Agent ID。") {
    super(message, 400, "BAD_REQUEST");
    this.name = "PrimaryAgentValidationError";
  }
}

export class PrimaryAgentForbiddenError extends PrimaryAgentError {
  constructor(message = "您没有权限将该 Agent 设为主 Agent。") {
    super(message, 403, "FORBIDDEN");
    this.name = "PrimaryAgentForbiddenError";
  }
}

export class PrimaryAgentNotFoundError extends PrimaryAgentError {
  constructor(message = "该 Agent 不存在或已被删除。") {
    super(message, 404, "AGENT_NOT_FOUND");
    this.name = "PrimaryAgentNotFoundError";
  }
}

export class PrimaryAgentPausedError extends PrimaryAgentError {
  readonly agentId: string;
  readonly agentName: string | undefined;

  constructor(agentId: string, agentName?: string) {
    const label = agentName ? `「${agentName}」` : "";
    super(
      `主 Agent${label}当前处于暂停状态，请先恢复运行或指定其他 Agent 发起会话。`,
      409,
      "AGENT_PAUSED",
    );
    this.name = "PrimaryAgentPausedError";
    this.agentId = agentId;
    this.agentName = agentName;
  }
}

export class NoAvailablePrimaryAgentError extends PrimaryAgentError {
  constructor(message = "系统当前无可用的 Agent，请先创建或激活一个 Agent。") {
    super(message, 422, "NO_AVAILABLE_AGENT");
    this.name = "NoAvailablePrimaryAgentError";
  }
}

export type PrimaryAgentStatus = {
  configuredAgentId: string | null;
  isPaused: boolean;
  primaryAgent: AgentProfile | null;
  resolution: PrimaryAgentResolution;
};

export type PrimaryAgentServiceDeps = {
  userPreferences: UserPreferencesStore;
  agentProfileStore: Pick<
    AgentProfileStore,
    "get" | "list" | "ensureDefaultBot"
  > &
    Partial<Pick<AgentProfileStore, "record">>;
  isPaused?: (userId: string, agentId: string) => Promise<boolean>;
  actorForUser?: (userId: string) => Promise<AgentActor>;
};

export type PrimaryAgentService = ReturnType<typeof createPrimaryAgentService>;

export function createPrimaryAgentService(deps: PrimaryAgentServiceDeps) {
  const checkPaused = async (userId: string, agentId: string) =>
    deps.isPaused ? await deps.isPaused(userId, agentId) : false;

  const scheduleSelfHealClear = (userId: string, invalidAgentId: string) => {
    const clearCas = deps.userPreferences.clearMainBotIfMatches;
    if (!clearCas) return;
    queueMicrotask(() => {
      void clearCas(userId, invalidAgentId).catch((error) => {
        console.warn(
          JSON.stringify({
            type: "primary-agent-self-heal-failed",
            userId,
            invalidAgentId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
  };

  const classifyMissing = async (
    agentId: string,
  ): Promise<"FORBIDDEN" | "DELETED_OR_MISSING"> => {
    if (!deps.agentProfileStore.record) return "DELETED_OR_MISSING";
    const raw = await deps.agentProfileStore.record(agentId);
    return raw && !raw.deleted ? "FORBIDDEN" : "DELETED_OR_MISSING";
  };

  const pickRosterCandidate = async (
    userId: string,
    roster: readonly AgentProfile[],
  ): Promise<{ agent: AgentProfile; paused: boolean } | null> => {
    if (roster.length === 0) return null;
    for (const candidate of roster) {
      if (!(await checkPaused(userId, candidate.id))) {
        return { agent: candidate, paused: false };
      }
    }
    const first = roster[0];
    return first ? { agent: first, paused: true } : null;
  };

  const validateCandidate = async (
    actor: AgentActor,
    agentId: string,
  ): Promise<AgentProfile> => {
    if (!isValidPrimaryAgentId(agentId)) {
      throw new PrimaryAgentValidationError();
    }
    const profile = await deps.agentProfileStore.get(actor, agentId);
    if (!profile) {
      const reason = await classifyMissing(agentId);
      if (reason === "FORBIDDEN") {
        throw new PrimaryAgentForbiddenError();
      }
      throw new PrimaryAgentNotFoundError();
    }
    if (await checkPaused(actor.id, agentId)) {
      throw new PrimaryAgentPausedError(profile.id, profile.name);
    }
    return profile;
  };

  const getStatus = async (
    actor: AgentActor,
    options: { allowSeed?: boolean } = {},
  ): Promise<PrimaryAgentStatus> => {
    const prefs = await deps.userPreferences.read(actor.id);
    const configuredId = prefs.mainBotId;
    let fallbackReason: PrimaryAgentFallbackReason | undefined;
    let preserveHiddenConfiguredId: string | null = null;

    if (configuredId) {
      const profile = await deps.agentProfileStore.get(actor, configuredId);
      if (!profile) {
        fallbackReason = await classifyMissing(configuredId);
        scheduleSelfHealClear(actor.id, configuredId);
      } else if (profile.hidden) {
        // 隐藏仅折叠客户端视角；绝不清空数据库中既有的 mainBotId 配置。
        preserveHiddenConfiguredId = configuredId;
        fallbackReason = "HIDDEN";
      } else {
        const paused = await checkPaused(actor.id, configuredId);
        return {
          configuredAgentId: configuredId,
          isPaused: paused,
          primaryAgent: profile,
          resolution: {
            status: "configured",
            fallbackUsed: false,
            ...(paused ? { reason: "PAUSED" as const } : {}),
          },
        };
      }
    } else {
      fallbackReason = "NOT_CONFIGURED";
    }

    let roster = await deps.agentProfileStore.list(actor, false);
    const picked = await pickRosterCandidate(actor.id, roster);
    if (picked) {
      return {
        configuredAgentId: preserveHiddenConfiguredId,
        isPaused: picked.paused,
        primaryAgent: picked.agent,
        resolution: {
          status: "fallback_roster",
          fallbackUsed: true,
          ...(fallbackReason ? { reason: fallbackReason } : {}),
        },
      };
    }

    if (
      options.allowSeed !== false &&
      deps.agentProfileStore.ensureDefaultBot
    ) {
      let seeded = false;
      try {
        seeded = await deps.agentProfileStore.ensureDefaultBot(actor);
      } catch {
        seeded = false;
      }
      roster = await deps.agentProfileStore.list(actor, false);
      const seededPick = await pickRosterCandidate(actor.id, roster);
      if (seededPick) {
        const refreshedPrefs = await deps.userPreferences.read(actor.id);
        return {
          configuredAgentId:
            preserveHiddenConfiguredId ?? refreshedPrefs.mainBotId,
          isPaused: seededPick.paused,
          primaryAgent: seededPick.agent,
          resolution: {
            status: seeded ? "fallback_seeded" : "fallback_roster",
            fallbackUsed: true,
            ...(fallbackReason && !seeded ? { reason: fallbackReason } : {}),
          },
        };
      }
    }

    return {
      configuredAgentId: preserveHiddenConfiguredId,
      isPaused: false,
      primaryAgent: null,
      resolution: {
        status: "none",
        fallbackUsed: false,
        ...(fallbackReason ? { reason: fallbackReason } : {}),
      },
    };
  };

  const setPrimaryAgent = async (
    actor: AgentActor,
    agentId: string,
  ): Promise<{
    previousAgentId: string | null;
    status: PrimaryAgentStatus;
  }> => {
    const profile = await validateCandidate(actor, agentId);
    const previousAgentId = (await deps.userPreferences.read(actor.id))
      .mainBotId;
    await deps.userPreferences.patch(actor.id, { mainBotId: profile.id });
    return {
      previousAgentId,
      status: {
        configuredAgentId: profile.id,
        isPaused: false,
        primaryAgent: profile,
        resolution: {
          status: "configured",
          fallbackUsed: false,
        },
      },
    };
  };

  const clearPrimaryAgent = async (
    actor: AgentActor,
  ): Promise<{
    previousAgentId: string | null;
    status: PrimaryAgentStatus;
  }> => {
    const previousAgentId = (await deps.userPreferences.read(actor.id))
      .mainBotId;
    await deps.userPreferences.patch(actor.id, { mainBotId: null });
    // 解绑时不触发 ensureDefaultBot 自动播种，确保 mainBotId 确定保持为 null。
    const status = await getStatus(actor, { allowSeed: false });
    return { previousAgentId, status };
  };

  const resolveForChannelCreation = async (
    actor: AgentActor,
  ): Promise<AgentProfile> => {
    const prefs = await deps.userPreferences.read(actor.id);
    if (prefs.mainBotId) {
      const configured = await deps.agentProfileStore.get(
        actor,
        prefs.mainBotId,
      );
      if (!configured) {
        scheduleSelfHealClear(actor.id, prefs.mainBotId);
      } else if (!configured.hidden) {
        if (await checkPaused(actor.id, configured.id)) {
          throw new PrimaryAgentPausedError(configured.id, configured.name);
        }
        return configured;
      }
    }

    let roster = await deps.agentProfileStore.list(actor, false);
    if (roster.length === 0 && deps.agentProfileStore.ensureDefaultBot) {
      try {
        await deps.agentProfileStore.ensureDefaultBot(actor);
      } catch {
        throw new NoAvailablePrimaryAgentError();
      }
      roster = await deps.agentProfileStore.list(actor, false);
    }

    const picked = await pickRosterCandidate(actor.id, roster);
    if (!picked) {
      throw new NoAvailablePrimaryAgentError();
    }
    if (picked.paused) {
      throw new PrimaryAgentPausedError(picked.agent.id, picked.agent.name);
    }
    return picked.agent;
  };

  const resolveForBackground = async (
    ownerUserId: string,
  ): Promise<string | null> => {
    const actor: AgentActor = deps.actorForUser
      ? await deps.actorForUser(ownerUserId)
      : { id: ownerUserId, role: "user" };
    const prefs = await deps.userPreferences.read(ownerUserId);
    if (prefs.mainBotId) {
      const configured = await deps.agentProfileStore.get(
        actor,
        prefs.mainBotId,
      );
      if (!configured) {
        scheduleSelfHealClear(ownerUserId, prefs.mainBotId);
      } else if (
        !configured.hidden &&
        !(await checkPaused(ownerUserId, configured.id))
      ) {
        return configured.id;
      }
    }
    const roster = await deps.agentProfileStore.list(actor, false);
    const picked = await pickRosterCandidate(ownerUserId, roster);
    return picked?.agent.id ?? null;
  };

  return {
    validateCandidate,
    getStatus: (actor: AgentActor) => getStatus(actor),
    setPrimaryAgent,
    clearPrimaryAgent,
    resolveForChannelCreation,
    resolveForBackground,
  };
}
