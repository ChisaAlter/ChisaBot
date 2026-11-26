import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import {
  type BotLifecycle,
  type BotNotify,
  botLifecycleKeys,
  botPath,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
} from "./queries";

const FALLBACK = "机器人操作失败，请稍后重试。";

/** Everything here moves badges, Activity and state together, so all of it is refetched. */
function invalidateLifecycle(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: botLifecycleKeys.all });
}

export function setBotPausedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      paused: boolean;
    }): Promise<BotLifecycle> =>
      client(
        `${botPath(variables.agentId)}/${variables.paused ? "pause" : "resume"}`,
        "lifecycle",
        { method: "POST", fallback: FALLBACK },
      ),
    onSuccess: () => invalidateLifecycle(queryClient),
    onError: (error, variables) => {
      if (typeof window === "undefined") return;
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : variables.paused
            ? "暂停机器人失败，请稍后重试。"
            : "恢复机器人运行失败，请稍后重试。",
      );
    },
  });
}

export function setBotNotifyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      notify: BotNotify;
    }): Promise<BotLifecycle> =>
      client(`${botPath(variables.agentId)}/notifications`, "lifecycle", {
        method: "PUT",
        body: { notify: variables.notify },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateLifecycle(queryClient),
    onError: (error) => {
      if (typeof window === "undefined") return;
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "更新通知设置失败，请稍后重试。",
      );
    },
  });
}

export function resetBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<ResetPlan> =>
      client(`${botPath(agentId)}/reset`, "deleted", {
        method: "POST",
        body: { confirm: true },
        fallback: "无法重置此机器人",
      }),
    onSuccess: async () => {
      await invalidateLifecycle(queryClient);
      // Conversations were deleted; the roster has to drop them.
      await queryClient.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

export function stopHandoffMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; id: string }) => {
      await client(`${botPath(variables.agentId)}/activity/handoffs/stop`, {
        method: "POST",
        body: { id: variables.id },
        fallback: "无法停止委派任务",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function cancelFollowUpMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; id: string }) => {
      await client(`${botPath(variables.agentId)}/follow-ups/cancel`, {
        method: "POST",
        body: { id: variables.id },
        fallback: "无法取消后续",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function setUpdateRoutingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      kind: UpdateKind;
      transports: UpdateTransport[] | "all";
    }) => {
      await client(`/api/bots/routing/${variables.kind}`, {
        method: "PUT",
        body: { transports: variables.transports },
        fallback: "无法保存更新去向",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}
