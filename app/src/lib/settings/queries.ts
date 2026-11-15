import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { AgentProfile } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import type {
  PrimaryAgentEnvelope,
  PrimaryAgentResolution,
  PrimaryAgentResolutionStatus,
} from "../../../../shared/validators/primary-agent";

/**
 * How much one person may say, in characters.
 *
 * The server owns this rule and refuses past it; this copy exists so the box can count down rather
 * than let somebody write four paragraphs and find out on save. A drift between the two therefore
 * shows up as a refusal with the server's own sentence on it, which is the safe direction for a
 * duplicated number to fail in.
 */
export const INSTRUCTIONS_LIMIT = 4000;

export const settingsKeys = {
  all: ["settings"] as const,
  instructions: () => [...settingsKeys.all, "instructions"] as const,
  preferences: (userId: string | undefined) =>
    [...settingsKeys.all, "preferences", userId] as const,
};

export type { PrimaryAgentResolution, PrimaryAgentResolutionStatus };
export type PrimaryAgentResponse = PrimaryAgentEnvelope<AgentProfile>;

export const primaryAgentKeys = {
  all: ["primary-agent"] as const,
  current: (userId?: string) =>
    ["primary-agent", "current", userId ?? "anonymous"] as const,
};

/** "" means this person has written none. There is no separate absent state to draw. */
export function instructionsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.instructions(),
    queryFn: async (): Promise<string> =>
      client("/api/settings/instructions", "instructions", {
        fallback: "无法加载您的常驻指令",
      }),
  });
}

export function primaryAgentQueryOptions(userId?: string) {
  return queryOptions({
    queryKey: primaryAgentKeys.current(userId),
    enabled: Boolean(userId),
    queryFn: async ({ signal }): Promise<PrimaryAgentResponse> => {
      const fallback = "无法加载主 Agent 设置";
      // 不可传解包 key 参数：此处需完整保留 configuredAgentId / isPaused / primaryAgent / resolution 整包。
      const response = await client("/api/settings/primary-agent", {
        signal,
        fallback,
      });
      const body = (await response
        .json()
        .catch(() => null)) as PrimaryAgentResponse | null;
      if (!body || typeof body !== "object" || !("resolution" in body)) {
        throw new Error(fallback);
      }
      return body;
    },
    staleTime: 0,
  });
}

export const PRIMARY_AGENT_SYNC_CHANNEL = "chisabot-main-bot-sync";

const TAB_SYNC_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`;

export type PrimaryAgentSyncMessage = {
  type?: string;
  userId?: string;
  mainBotId?: string | null;
  senderTabId?: string;
};

/** 跨标签页广播主 Agent 变更，同账号其他标签页收到后立即失效关联缓存。 */
export function broadcastPrimaryAgentChange(
  userId: string,
  mainBotId: string | null,
): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(PRIMARY_AGENT_SYNC_CHANNEL);
    channel.postMessage({
      type: "primary-agent-changed",
      userId,
      mainBotId,
      senderTabId: TAB_SYNC_ID,
    } satisfies PrimaryAgentSyncMessage);
    channel.close();
  } catch {
    // 浏览器限制或无可用通信通道时静默退避。
  }
}

export function installPrimaryAgentSync(queryClient: QueryClient): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  try {
    const channel = new BroadcastChannel(PRIMARY_AGENT_SYNC_CHANNEL);
    channel.onmessage = (event: MessageEvent<PrimaryAgentSyncMessage>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.senderTabId && data.senderTabId === TAB_SYNC_ID) return;
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      void queryClient.invalidateQueries({ queryKey: primaryAgentKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    };
    return () => {
      channel.close();
    };
  } catch {
    return () => {};
  }
}
