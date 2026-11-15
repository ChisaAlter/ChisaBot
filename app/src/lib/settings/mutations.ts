import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../../../shared/user-preferences";
import {
  broadcastPrimaryAgentChange,
  type PrimaryAgentResponse,
  primaryAgentKeys,
  settingsKeys,
} from "./queries";

/**
 * Save, or clear by saving nothing.
 *
 * A PUT of the whole text rather than a patch, because there is one field and its new value is the
 * whole of what changed. What comes back is what was stored — the server trims — so the cache is
 * seeded from the reply rather than from what was sent, and a box that had trailing whitespace in it
 * settles to what the database actually holds.
 */
export function saveInstructionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (instructions: string): Promise<string> =>
      client("/api/settings/instructions", "instructions", {
        method: "PUT",
        body: { instructions },
        fallback: "您的常驻指令无法保存",
      }),
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsKeys.instructions(), saved),
  });
}

function findCachedAgentProfile(
  queryClient: QueryClient,
  agentId: string,
): AgentProfile | null {
  const lists = queryClient.getQueriesData<AgentProfile[]>({
    queryKey: [...agentKeys.all, "list"],
  });
  for (const [, list] of lists) {
    const hit = Array.isArray(list)
      ? list.find((item) => item.id === agentId)
      : undefined;
    if (hit) return hit;
  }
  return (
    queryClient.getQueryData<AgentProfile>(agentKeys.detail(agentId)) ?? null
  );
}

export function setPrimaryAgentMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  return mutationOptions({
    mutationFn: async (
      agentId: string | null,
    ): Promise<PrimaryAgentResponse> => {
      if (!userId) throw new Error("登录以保存您的偏好设置。");
      if (agentId === null) {
        const res = await client("/api/settings/primary-agent", {
          method: "DELETE",
          fallback: "无法取消主 Agent 设置",
        });
        return (await res.json()) as PrimaryAgentResponse;
      }
      const res = await client("/api/settings/primary-agent", {
        method: "PUT",
        body: { agentId },
        fallback: "无法保存主 Agent 设置",
      });
      return (await res.json()) as PrimaryAgentResponse;
    },
    onMutate: async (newAgentId) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.all });
      await queryClient.cancelQueries({ queryKey: primaryAgentKeys.all });

      const prefKey = settingsKeys.preferences(userId);
      const primaryAgentKey = primaryAgentKeys.current(userId);

      const previousPreferences =
        queryClient.getQueryData<UserPreferences>(prefKey);
      const previousPrimaryAgent =
        queryClient.getQueryData<PrimaryAgentResponse>(primaryAgentKey);

      queryClient.setQueryData<UserPreferences>(prefKey, {
        ...(previousPreferences ?? DEFAULT_USER_PREFERENCES),
        mainBotId: newAgentId,
      });

      if (newAgentId === null) {
        queryClient.setQueryData<PrimaryAgentResponse>(primaryAgentKey, {
          configuredAgentId: null,
          isPaused: false,
          primaryAgent: null,
          resolution: { status: "none", fallbackUsed: false },
        });
      } else {
        const targetProfile = findCachedAgentProfile(queryClient, newAgentId);
        queryClient.setQueryData<PrimaryAgentResponse>(primaryAgentKey, {
          configuredAgentId: newAgentId,
          isPaused: false,
          primaryAgent: targetProfile,
          resolution: { status: "configured", fallbackUsed: false },
        });
      }

      return {
        prefKey,
        primaryAgentKey,
        hadPreviousPreferences: previousPreferences !== undefined,
        previousPreferences,
        hadPreviousPrimaryAgent: previousPrimaryAgent !== undefined,
        previousPrimaryAgent,
      };
    },
    onError: (_error, _newAgentId, context) => {
      if (!context) return;
      if (context.hadPreviousPreferences) {
        queryClient.setQueryData(context.prefKey, context.previousPreferences);
      } else {
        queryClient.removeQueries({ queryKey: context.prefKey, exact: true });
      }
      if (context.hadPreviousPrimaryAgent) {
        queryClient.setQueryData(
          context.primaryAgentKey,
          context.previousPrimaryAgent,
        );
      } else {
        queryClient.removeQueries({
          queryKey: context.primaryAgentKey,
          exact: true,
        });
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(primaryAgentKeys.current(userId), saved);
    },
    onSettled: (_data, error, newAgentId) => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      void queryClient.invalidateQueries({ queryKey: primaryAgentKeys.all });
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      if (!error && userId) {
        broadcastPrimaryAgentChange(userId, newAgentId ?? null);
      }
    },
  });
}
