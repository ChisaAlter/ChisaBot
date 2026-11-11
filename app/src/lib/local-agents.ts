import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { client } from "@/lib/client";
import {
  type AcpRegistryEntry,
  AGENT_DRIVER_SPECS,
  AGENT_PROVIDER_PRESETS,
  type AgentDriverConfig,
  type AgentDriverKind,
  type AgentEnvironmentSummary,
  type AgentEnvVarInput,
  type AgentInstanceView,
  type AgentProviderPreset,
  type BotAgentGrant,
  type BotAgentGrantMode,
  SERVER_ENVIRONMENT_ID,
} from "../../../shared/agent-providers";
import {
  ACTIVE_LOCAL_TASK,
  type DeviceAgentSettings,
  LOCAL_AGENT_RESULT_MARKER,
  type LocalAgentLine,
  type LocalAgentTaskView,
} from "../../../shared/local-agents";

export type {
  AcpRegistryEntry,
  AgentDriverConfig,
  AgentDriverKind,
  AgentEnvironmentSummary,
  AgentEnvVarInput,
  AgentInstanceView,
  AgentProviderPreset,
  BotAgentGrant,
  BotAgentGrantMode,
};
export { AGENT_DRIVER_SPECS, AGENT_PROVIDER_PRESETS, SERVER_ENVIRONMENT_ID };

/**
 * 本地 agent 与智能体提供方（docs/local-agents.md；server/src/local-agents/service.ts）在界面上的数据：
 * 对话里的任务卡片（有任务在跑时每 1.2 秒取一次）、环境的档位 / 工作区设置、提供方实例管理及 Bot 子代理授权。
 */

const FALLBACK = "本地 agent 暂时不可用，请重试。";
const PROVIDER_FALLBACK = "智能体提供方服务暂时不可用，请重试。";

export const localAgentKeys = {
  all: ["local-agents"] as const,
  thread: (threadId: string) => ["local-agents", "thread", threadId] as const,
  /** 所有设备的本地 agent 设置（按前缀整组失效用）。 */
  devices: () => ["local-agents", "device"] as const,
  device: (deviceId: string) => ["local-agents", "device", deviceId] as const,
  task: (taskId: string) => ["local-agents", "task", taskId] as const,
  presets: () => ["local-agents", "presets"] as const,
  acpRegistry: (query: string) =>
    ["local-agents", "acp-registry", query] as const,
  environments: () => ["local-agents", "environments"] as const,
  environmentSettings: (envId: string) =>
    ["local-agents", "environment-settings", envId] as const,
  instancesAll: () => ["local-agents", "instances"] as const,
  instances: (envId?: string) =>
    ["local-agents", "instances", envId ?? "all"] as const,
  botGrantsAll: () => ["local-agents", "bot-grant"] as const,
  botGrant: (botId: string) => ["local-agents", "bot-grant", botId] as const,
};

export function useThreadLocalTasks(threadId: string | null | undefined) {
  return useQuery({
    queryKey: localAgentKeys.thread(threadId ?? ""),
    enabled: Boolean(threadId),
    queryFn: async (): Promise<LocalAgentTaskView[]> => {
      try {
        return await client(
          `/api/local-agents/threads/${encodeURIComponent(threadId ?? "")}/tasks`,
          "tasks",
          { fallback: FALLBACK },
        );
      } catch {
        // 任务列表读不到时按「没有任务」处理：卡片区什么都不画，比一条错误更不打扰聊天。
        return [];
      }
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((task) =>
        ACTIVE_LOCAL_TASK.includes(task.status),
      )
        ? 1200
        : false,
    refetchOnWindowFocus: true,
    staleTime: 800,
  });
}

export type FullLocalTask = LocalAgentTaskView & {
  task: string;
  transcript: LocalAgentLine[];
};

export function localTaskQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: localAgentKeys.task(taskId),
    queryFn: (): Promise<FullLocalTask> =>
      client(`/api/local-agents/tasks/${encodeURIComponent(taskId)}`, "task", {
        fallback: FALLBACK,
      }),
    staleTime: 1000,
  });
}

/** 停止 / 应用改动 / 放弃改动。完成后刷新卡片。 */
export function useLocalTaskAction(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    async (taskId: string, action: "stop" | "apply" | "discard") => {
      const task = await client<LocalAgentTaskView>(
        `/api/local-agents/tasks/${encodeURIComponent(taskId)}/${action}`,
        "task",
        { method: "POST", fallback: FALLBACK },
      );
      if (threadId)
        await queryClient.invalidateQueries({
          queryKey: localAgentKeys.thread(threadId),
        });
      await queryClient.invalidateQueries({
        queryKey: localAgentKeys.task(taskId),
      });
      return task;
    },
    [threadId, queryClient],
  );
}

export type DeviceAgentState = {
  settings: DeviceAgentSettings;
  effectiveRoots: string[];
  online: boolean;
  tasks: LocalAgentTaskView[];
};

export function deviceAgentQueryOptions(deviceId: string) {
  return queryOptions({
    queryKey: localAgentKeys.device(deviceId),
    queryFn: async (): Promise<DeviceAgentState> =>
      (
        await client(
          `/api/local-agents/devices/${encodeURIComponent(deviceId)}`,
          { fallback: FALLBACK },
        )
      ).json(),
    staleTime: 3000,
  });
}

/** PUT /api/local-agents/devices/:id 接受的字段（settingsPatch.strict 的白名单子集）。 */
export type DeviceAgentPatch = Partial<
  Omit<DeviceAgentSettings, "deviceId" | "detected" | "saved" | "updatedAt">
>;

export async function saveDeviceAgent(
  deviceId: string,
  patch: DeviceAgentPatch,
) {
  return client<DeviceAgentSettings>(
    `/api/local-agents/devices/${encodeURIComponent(deviceId)}`,
    "settings",
    { method: "PUT", body: patch, fallback: FALLBACK },
  );
}

export async function redetectDeviceAgents(
  deviceId: string,
): Promise<{ sent: boolean }> {
  // 「sent」只是服务端把 agent_detect 推给电脑的即时回执；检测结果是节点之后回传的。
  return (
    await client(
      `/api/local-agents/devices/${encodeURIComponent(deviceId)}/detect`,
      {
        method: "POST",
        fallback: FALLBACK,
      },
    )
  ).json();
}

/** 档位 / 设置的写：成功后让这台设备的查询重新拉（服务端算好的字段以服务端为准）。 */
export function updateDeviceAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      deviceId: string;
      patch: DeviceAgentPatch;
    }): Promise<DeviceAgentSettings> =>
      saveDeviceAgent(input.deviceId, input.patch),
    onSuccess: (_settings, input) =>
      queryClient.invalidateQueries({
        queryKey: localAgentKeys.device(input.deviceId),
      }),
  });
}

/**
 * 「重新检测」：POST 只负责把 agent_detect 发给电脑，结果由节点回传（agents_detected）落库；
 * mutation 本身多停一拍再返回，pending 覆盖整个来回，结束后重新拉这台设备的设置。
 */
export function redetectDeviceAgentsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (deviceId: string): Promise<void> => {
      const { sent } = await redetectDeviceAgents(deviceId);
      if (!sent) throw new Error("电脑离线，检测请求没有发出去。");
      await new Promise((resolve) => setTimeout(resolve, 2500));
    },
    onSuccess: (_result, deviceId) =>
      queryClient.invalidateQueries({
        queryKey: localAgentKeys.device(deviceId),
      }),
  });
}

/** 设备的审批（同 设置 → 设备 的「等待你审批」）：任务卡片上直接允许 / 拒绝。 */
export async function decideDeviceApproval(
  approvalId: string,
  decision: "approve" | "deny",
) {
  await client(`/api/devices/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: { decision },
    fallback: "这个审批已经处理过或已过期。",
  });
}

/** 「⟦chisabot:local-agent-result:<id>:<status>⟧\n标题行\n\n正文」拆开。 */
export function parseLocalAgentResult(
  text: string,
): { taskId: string; status: string; headline: string; body: string } | null {
  if (!text.startsWith(LOCAL_AGENT_RESULT_MARKER)) return null;
  const end = text.indexOf("⟧");
  if (end < 0) return null;
  const [taskId = "", status = ""] = text
    .slice(LOCAL_AGENT_RESULT_MARKER.length, end)
    .split(":");
  const rest = text.slice(end + 1).replace(/^\n/, "");
  const [headline = "", ...lines] = rest.split("\n");
  return {
    taskId,
    status,
    headline: headline.trim(),
    body: lines.join("\n").trim(),
  };
}

export { LOCAL_AGENT_RESULT_MARKER };

// ── 智能体提供方实例、环境与 Bot 授权 API ─────────────────────────────

export type EnvironmentSettingsState = {
  settings: DeviceAgentSettings;
  effectiveRoots: string[];
  envRoots: string[];
  online: boolean;
  tasks: LocalAgentTaskView[];
};

export function agentEnvironmentsQueryOptions() {
  return queryOptions({
    queryKey: localAgentKeys.environments(),
    queryFn: (): Promise<AgentEnvironmentSummary[]> =>
      client("/api/local-agents/environments", "environments", {
        fallback: PROVIDER_FALLBACK,
      }),
    staleTime: 5000,
  });
}

export function useAgentEnvironments() {
  return useQuery(agentEnvironmentsQueryOptions());
}

export function environmentSettingsQueryOptions(envId: string) {
  return queryOptions({
    queryKey: localAgentKeys.environmentSettings(envId),
    queryFn: async (): Promise<EnvironmentSettingsState> =>
      (
        await client(
          `/api/local-agents/environments/${encodeURIComponent(envId)}/settings`,
          { fallback: PROVIDER_FALLBACK },
        )
      ).json(),
    staleTime: 3000,
  });
}

export function useEnvironmentSettings(envId: string | null | undefined) {
  return useQuery({
    ...environmentSettingsQueryOptions(envId ?? ""),
    enabled: Boolean(envId),
  });
}

export async function saveEnvironmentSettings(
  envId: string,
  patch: DeviceAgentPatch,
): Promise<DeviceAgentSettings> {
  return client<DeviceAgentSettings>(
    `/api/local-agents/environments/${encodeURIComponent(envId)}/settings`,
    "settings",
    { method: "PUT", body: patch, fallback: PROVIDER_FALLBACK },
  );
}

export async function probeAllEnvironmentInstances(
  envId: string,
): Promise<AgentInstanceView[]> {
  return client<AgentInstanceView[]>(
    `/api/local-agents/environments/${encodeURIComponent(envId)}/probe-all`,
    "instances",
    { method: "POST", fallback: PROVIDER_FALLBACK, timeoutMs: 60_000 },
  );
}

export function agentInstancesQueryOptions(environmentId?: string) {
  const qs = environmentId
    ? `?environmentId=${encodeURIComponent(environmentId)}`
    : "";
  return queryOptions({
    queryKey: localAgentKeys.instances(environmentId),
    queryFn: (): Promise<AgentInstanceView[]> =>
      client(`/api/local-agents/instances${qs}`, "instances", {
        fallback: PROVIDER_FALLBACK,
      }),
    staleTime: 4000,
  });
}

export function useAgentInstances(environmentId?: string) {
  return useQuery(agentInstancesQueryOptions(environmentId));
}

export type CreateAgentInstanceInput = {
  environmentId: string;
  driver: AgentDriverKind;
  name: string;
  slug?: string;
  description?: string;
  enabled?: boolean;
  exposeAsTool?: boolean;
  config?: AgentDriverConfig;
  envVars?: AgentEnvVarInput[];
};

export type UpdateAgentInstancePatch = {
  name?: string;
  slug?: string;
  description?: string;
  enabled?: boolean;
  exposeAsTool?: boolean;
  sortOrder?: number;
  config?: AgentDriverConfig;
  envVars?: AgentEnvVarInput[];
};

export async function createAgentInstance(
  input: CreateAgentInstanceInput,
): Promise<AgentInstanceView> {
  return client<AgentInstanceView>("/api/local-agents/instances", "instance", {
    method: "POST",
    body: input,
    fallback: PROVIDER_FALLBACK,
    timeoutMs: 60_000,
  });
}

export async function updateAgentInstance(
  id: string,
  patch: UpdateAgentInstancePatch,
): Promise<AgentInstanceView> {
  return client<AgentInstanceView>(
    `/api/local-agents/instances/${encodeURIComponent(id)}`,
    "instance",
    { method: "PUT", body: patch, fallback: PROVIDER_FALLBACK },
  );
}

export async function deleteAgentInstance(id: string): Promise<void> {
  await client(`/api/local-agents/instances/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: PROVIDER_FALLBACK,
  });
}

export async function probeAgentInstance(
  id: string,
): Promise<AgentInstanceView> {
  return client<AgentInstanceView>(
    `/api/local-agents/instances/${encodeURIComponent(id)}/probe`,
    "instance",
    { method: "POST", fallback: PROVIDER_FALLBACK, timeoutMs: 60_000 },
  );
}

export type AcpRegistryResponse = {
  entries: AcpRegistryEntry[];
  fromRemote: boolean;
};

export function acpRegistryQueryOptions(query: string, refresh = false) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (refresh) params.set("refresh", "1");
  const qs = params.toString() ? `?${params.toString()}` : "";
  return queryOptions({
    queryKey: localAgentKeys.acpRegistry(query.trim()),
    queryFn: async (): Promise<AcpRegistryResponse> =>
      (
        await client(`/api/local-agents/acp-registry${qs}`, {
          fallback: "无法加载 ACP 智能体目录。",
          timeoutMs: 15_000,
        })
      ).json(),
    staleTime: 60_000,
  });
}

export type BotAgentGrantState = {
  grant: BotAgentGrant;
  instances: AgentInstanceView[];
};

export function botAgentGrantQueryOptions(botId: string) {
  return queryOptions({
    queryKey: localAgentKeys.botGrant(botId),
    queryFn: async (): Promise<BotAgentGrantState> =>
      (
        await client(
          `/api/local-agents/bots/${encodeURIComponent(botId)}/grants`,
          { fallback: PROVIDER_FALLBACK },
        )
      ).json(),
    staleTime: 4000,
  });
}

export function useBotAgentGrant(botId: string | null | undefined) {
  return useQuery({
    ...botAgentGrantQueryOptions(botId ?? ""),
    enabled: Boolean(botId),
  });
}

export async function saveBotAgentGrant(
  botId: string,
  patch: Partial<
    Pick<
      BotAgentGrant,
      | "mode"
      | "instanceIds"
      | "exposeNamedTools"
      | "allowNestedSubagents"
      | "maxDepth"
    >
  >,
): Promise<BotAgentGrant> {
  return client<BotAgentGrant>(
    `/api/local-agents/bots/${encodeURIComponent(botId)}/grants`,
    "grant",
    { method: "PUT", body: patch, fallback: PROVIDER_FALLBACK },
  );
}

export async function invalidateAgentProviderQueries(
  queryClient: QueryClient,
  environmentId?: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: localAgentKeys.instancesAll() }),
    queryClient.invalidateQueries({ queryKey: localAgentKeys.environments() }),
    queryClient.invalidateQueries({ queryKey: localAgentKeys.botGrantsAll() }),
    ...(environmentId
      ? [
          queryClient.invalidateQueries({
            queryKey: localAgentKeys.environmentSettings(environmentId),
          }),
        ]
      : []),
  ]);
}
