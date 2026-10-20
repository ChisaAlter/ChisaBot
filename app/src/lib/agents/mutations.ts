import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { channelKeys } from "@/lib/channels/queries";
import { forgetStoredPanelBot } from "@/lib/panels/active-bot";
import {
  type AgentProfile,
  type AgentVisibility,
  agentApiPath,
  agentKeys,
} from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "机器人操作失败，请稍后重试。";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; pinned: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.pinned ? "pin" : "unpin"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(agentApiPath(agentId), {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: (_result, agentId) => forgetDeletedBot(queryClient, agentId),
  });
}

/**
 * After a Bot is deleted, every cached trace of it goes, without a reload.
 *
 * Drops it from every roster list at once so the sidebar, the 机器人 list and the 至： picker stop
 * showing it this frame, throws away every query keyed by its id (its profile, panels, lifecycle,
 * reset plan), then refetches the rest: conversations it was in, the main-Bot preference the server
 * cleared, attention badges.
 */
export async function forgetDeletedBot(
  queryClient: QueryClient,
  agentId: string,
) {
  forgetStoredPanelBot(agentId);
  queryClient.setQueriesData<AgentProfile[]>(
    { queryKey: [...agentKeys.all, "list"] },
    (list) => (Array.isArray(list) ? list.filter((agent) => agent.id !== agentId) : list),
  );
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey.some(
        (part) =>
          part === agentId ||
          (typeof part === "string" && part.includes(agentId)),
      ),
  });
  // 只刷新跟机器人列表 / 会话有关的数据，而且不等它回来（DESIGN.md §34.6）：以前这里让整个缓存全部重取，
  // 删一个机器人会同时打出几十个请求、主线程忙一阵，看起来像「卡了一下」。
  void queryClient.invalidateQueries({ queryKey: agentKeys.all });
  void queryClient.invalidateQueries({ queryKey: channelKeys.all });
}

/**
 * Issue this coworker a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a coworker that already has one rotates it, which is how a
 * leaked token is retired.
 */
export function issueCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<string> =>
      client(`${agentApiPath(agentId)}/callback-token`, "token", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The coworker may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`${agentApiPath(agentId)}/callback-token`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
