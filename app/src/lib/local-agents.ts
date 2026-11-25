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
  type AgentProbeState,
  type AgentProviderPreset,
  type AntigravityInstallJobStatus,
  type AntigravityInstallJobView,
  type AntigravityInstallStage,
  type AntigravityLoginSessionStatus,
  type AntigravityLoginSessionView,
  type AntigravityLoginStage,
  type AntigravityRuntimeSource,
  type AntigravityRuntimeStatus,
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
  AgentProbeState,
  AgentProviderPreset,
  AntigravityInstallJobStatus,
  AntigravityInstallJobView,
  AntigravityInstallStage,
  AntigravityLoginSessionStatus,
  AntigravityLoginSessionView,
  AntigravityLoginStage,
  AntigravityRuntimeSource,
  AntigravityRuntimeStatus,
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
  antigravityRuntimeAll: () => ["local-agents", "antigravity-runtime"] as const,
  antigravityRuntime: (envId: string) =>
    ["local-agents", "antigravity-runtime", envId] as const,
  antigravityLoginAll: () => ["local-agents", "antigravity-login"] as const,
  antigravityLogin: (instanceId: string) =>
    ["local-agents", "antigravity-login", instanceId] as const,
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

export type ContinueLocalTaskInput = {
  prompt?: string;
  answers?: Record<string, string | string[]>;
  mode?: "wait" | "async";
  waitTimeoutMs?: number;
};

export type ContinueLocalTaskResult = {
  task: LocalAgentTaskView;
  timedOut?: boolean;
};

/** 同上下文多轮续接（POST /api/local-agents/tasks/:id/continue）。完成后刷新线程与任务缓存。 */
export function useContinueLocalTask(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      taskId: string,
      input: ContinueLocalTaskInput,
    ): Promise<ContinueLocalTaskResult> => {
      const response = await client(
        `/api/local-agents/tasks/${encodeURIComponent(taskId)}/continue`,
        {
          method: "POST",
          body: input,
          fallback: FALLBACK,
          ...(input.mode === "wait" ? { timeoutMs: 185_000 } : {}),
        },
      );
      const result = (await response.json()) as ContinueLocalTaskResult;
      if (threadId) {
        await queryClient.invalidateQueries({
          queryKey: localAgentKeys.thread(threadId),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: localAgentKeys.task(taskId),
      });
      return result;
    },
    [threadId, queryClient],
  );
}

/** 提交 needs_input 结构化追问回答（POST /api/local-agents/tasks/:id/answer）。完成后刷新线程与任务缓存。 */
export function useAnswerLocalTask(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      taskId: string,
      answers: Record<string, string | string[]>,
    ): Promise<LocalAgentTaskView> => {
      const task = await client<LocalAgentTaskView>(
        `/api/local-agents/tasks/${encodeURIComponent(taskId)}/answer`,
        "task",
        {
          method: "POST",
          body: { answers },
          fallback: FALLBACK,
        },
      );
      if (threadId) {
        await queryClient.invalidateQueries({
          queryKey: localAgentKeys.thread(threadId),
        });
      }
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
          queryClient.invalidateQueries({
            queryKey: localAgentKeys.antigravityRuntime(environmentId),
          }),
        ]
      : []),
  ]);
}

// ── Antigravity 托管运行时与独立账号登录 API ──────────────────────────────

const ANTIGRAVITY_FALLBACK = "Antigravity 托管服务暂时不可用，请重试。";

export type AntigravityRuntimeState = {
  online: boolean;
  runtime: AntigravityRuntimeStatus | null;
  installJob: AntigravityInstallJobView | null;
  error?: string | null;
};

export type AntigravityInstallInput = {
  force?: boolean;
  version?: string;
};

export type AntigravityLoginInput = {
  authMethodId?: string;
  restart?: boolean;
};

export type AntigravityLoginSubmitInput = {
  code: string;
  sessionId?: string;
};

export type AntigravityLogoutResult = {
  ok: boolean;
  homePath?: string | null;
  probe?: AgentProbeState | null;
  error?: string | null;
};

export async function fetchAntigravityRuntime(
  envId: string,
  checkLatest = false,
): Promise<AntigravityRuntimeState> {
  const qs = checkLatest ? "?checkLatest=1" : "";
  return (
    await client(
      `/api/local-agents/environments/${encodeURIComponent(envId)}/antigravity/runtime${qs}`,
      { fallback: ANTIGRAVITY_FALLBACK },
    )
  ).json();
}

export function antigravityRuntimeQueryOptions(
  envId: string,
  checkLatest = false,
) {
  return queryOptions({
    queryKey: localAgentKeys.antigravityRuntime(envId),
    queryFn: (): Promise<AntigravityRuntimeState> =>
      fetchAntigravityRuntime(envId, checkLatest),
    refetchInterval: (query) =>
      query.state.data?.installJob?.status === "running" ? 1000 : false,
    staleTime: 3000,
  });
}

export function useAntigravityRuntime(
  envId: string | null | undefined,
  options?: {
    enabled?: boolean;
    onInstallSettled?: (job: AntigravityInstallJobView) => void;
  },
) {
  const queryClient = useQueryClient();
  const targetEnvId = envId ?? "";
  const queryKey = localAgentKeys.antigravityRuntime(targetEnvId);
  const onInstallSettled = options?.onInstallSettled;

  return useQuery({
    ...antigravityRuntimeQueryOptions(targetEnvId),
    enabled: Boolean(envId) && (options?.enabled ?? true),
    queryFn: async (): Promise<AntigravityRuntimeState> => {
      const prev = queryClient.getQueryData<AntigravityRuntimeState>(queryKey);
      const next = await fetchAntigravityRuntime(targetEnvId);
      const prevJob = prev?.installJob;
      const nextJob = next.installJob;
      if (
        prevJob?.status === "running" &&
        nextJob &&
        nextJob.status !== "running"
      ) {
        void queryClient.invalidateQueries({
          queryKey: localAgentKeys.instancesAll(),
        });
        void queryClient.invalidateQueries({
          queryKey: localAgentKeys.environments(),
        });
        onInstallSettled?.(nextJob);
      }
      return next;
    },
  });
}

export async function startAntigravityInstall(
  envId: string,
  input: AntigravityInstallInput = {},
): Promise<AntigravityInstallJobView> {
  return client<AntigravityInstallJobView>(
    `/api/local-agents/environments/${encodeURIComponent(envId)}/antigravity/install`,
    "installJob",
    {
      method: "POST",
      body: input,
      fallback: ANTIGRAVITY_FALLBACK,
      timeoutMs: 30_000,
    },
  );
}

export async function cancelAntigravityInstall(
  envId: string,
): Promise<AntigravityInstallJobView | null> {
  return client<AntigravityInstallJobView | null>(
    `/api/local-agents/environments/${encodeURIComponent(envId)}/antigravity/install/cancel`,
    "installJob",
    { method: "POST", fallback: ANTIGRAVITY_FALLBACK },
  );
}

export async function fetchAntigravityLogin(
  instanceId: string,
): Promise<AntigravityLoginSessionView | null> {
  return client<AntigravityLoginSessionView | null>(
    `/api/local-agents/instances/${encodeURIComponent(instanceId)}/antigravity/login`,
    "session",
    { fallback: ANTIGRAVITY_FALLBACK },
  );
}

export function antigravityLoginQueryOptions(instanceId: string) {
  return queryOptions({
    queryKey: localAgentKeys.antigravityLogin(instanceId),
    queryFn: (): Promise<AntigravityLoginSessionView | null> =>
      fetchAntigravityLogin(instanceId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "awaiting_auth" ? 1200 : false;
    },
    staleTime: 1000,
  });
}

export function useAntigravityLogin(
  instanceId: string | null | undefined,
  options?: {
    enabled?: boolean;
    environmentId?: string;
    onLoginSettled?: (session: AntigravityLoginSessionView) => void;
  },
) {
  const queryClient = useQueryClient();
  const targetId = instanceId ?? "";
  const queryKey = localAgentKeys.antigravityLogin(targetId);
  const environmentId = options?.environmentId;
  const onLoginSettled = options?.onLoginSettled;

  return useQuery({
    ...antigravityLoginQueryOptions(targetId),
    enabled: Boolean(instanceId) && (options?.enabled ?? true),
    queryFn: async (): Promise<AntigravityLoginSessionView | null> => {
      const prev = queryClient.getQueryData<AntigravityLoginSessionView | null>(
        queryKey,
      );
      const next = await fetchAntigravityLogin(targetId);
      const wasActive =
        prev?.status === "running" || prev?.status === "awaiting_auth";
      const isTerminal =
        next !== null &&
        next.status !== "running" &&
        next.status !== "awaiting_auth";
      if (wasActive && isTerminal) {
        void invalidateAgentProviderQueries(queryClient, environmentId);
        onLoginSettled?.(next);
      }
      return next;
    },
  });
}

export async function startAntigravityLogin(
  instanceId: string,
  input: AntigravityLoginInput = {},
): Promise<AntigravityLoginSessionView> {
  return client<AntigravityLoginSessionView>(
    `/api/local-agents/instances/${encodeURIComponent(instanceId)}/antigravity/login`,
    "session",
    {
      method: "POST",
      body: input,
      fallback: ANTIGRAVITY_FALLBACK,
      timeoutMs: 30_000,
    },
  );
}

export async function submitAntigravityLoginCode(
  instanceId: string,
  input: AntigravityLoginSubmitInput,
): Promise<AntigravityLoginSessionView> {
  return client<AntigravityLoginSessionView>(
    `/api/local-agents/instances/${encodeURIComponent(instanceId)}/antigravity/login/submit`,
    "session",
    {
      method: "POST",
      body: input,
      fallback: ANTIGRAVITY_FALLBACK,
      timeoutMs: 30_000,
    },
  );
}

export async function cancelAntigravityLogin(
  instanceId: string,
): Promise<AntigravityLoginSessionView | null> {
  return client<AntigravityLoginSessionView | null>(
    `/api/local-agents/instances/${encodeURIComponent(instanceId)}/antigravity/login/cancel`,
    "session",
    { method: "POST", fallback: ANTIGRAVITY_FALLBACK },
  );
}

export async function logoutAntigravityInstance(
  instanceId: string,
): Promise<AntigravityLogoutResult> {
  return (
    await client(
      `/api/local-agents/instances/${encodeURIComponent(instanceId)}/antigravity/logout`,
      { method: "POST", fallback: ANTIGRAVITY_FALLBACK, timeoutMs: 30_000 },
    )
  ).json();
}

export function startAntigravityInstallMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: {
      environmentId: string;
      force?: boolean;
      version?: string;
    }): Promise<AntigravityInstallJobView> =>
      startAntigravityInstall(input.environmentId, {
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
      }),
    onSuccess: (installJob, input) => {
      queryClient.setQueryData<AntigravityRuntimeState>(
        localAgentKeys.antigravityRuntime(input.environmentId),
        (prev) => ({
          online: prev?.online ?? true,
          runtime: prev?.runtime ?? null,
          installJob,
        }),
      );
      if (installJob.status !== "running") {
        void invalidateAgentProviderQueries(queryClient, input.environmentId);
      }
    },
  });
}

export function cancelAntigravityInstallMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (
      environmentId: string,
    ): Promise<AntigravityInstallJobView | null> =>
      cancelAntigravityInstall(environmentId),
    onSuccess: (installJob, environmentId) => {
      queryClient.setQueryData<AntigravityRuntimeState>(
        localAgentKeys.antigravityRuntime(environmentId),
        (prev) => ({
          online: prev?.online ?? true,
          runtime: prev?.runtime ?? null,
          installJob,
        }),
      );
      void queryClient.invalidateQueries({
        queryKey: localAgentKeys.antigravityRuntime(environmentId),
      });
    },
  });
}

export function startAntigravityLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      instanceId: string;
      environmentId?: string;
      authMethodId?: string;
      restart?: boolean;
    }): Promise<AntigravityLoginSessionView> =>
      startAntigravityLogin(input.instanceId, {
        ...(input.authMethodId !== undefined
          ? { authMethodId: input.authMethodId }
          : {}),
        ...(input.restart !== undefined ? { restart: input.restart } : {}),
      }),
    onSuccess: (session, input) => {
      queryClient.setQueryData(
        localAgentKeys.antigravityLogin(input.instanceId),
        session,
      );
      if (session.status !== "running" && session.status !== "awaiting_auth") {
        void invalidateAgentProviderQueries(queryClient, input.environmentId);
      }
    },
  });
}

export function submitAntigravityLoginMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: {
      instanceId: string;
      environmentId?: string;
      code: string;
      sessionId?: string;
    }): Promise<AntigravityLoginSessionView> =>
      submitAntigravityLoginCode(input.instanceId, {
        code: input.code,
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
      }),
    onSuccess: (session, input) => {
      queryClient.setQueryData(
        localAgentKeys.antigravityLogin(input.instanceId),
        session,
      );
      if (session.status !== "running" && session.status !== "awaiting_auth") {
        void invalidateAgentProviderQueries(queryClient, input.environmentId);
      }
    },
  });
}

export function cancelAntigravityLoginMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (
      instanceId: string,
    ): Promise<AntigravityLoginSessionView | null> =>
      cancelAntigravityLogin(instanceId),
    onSuccess: (session, instanceId) => {
      queryClient.setQueryData(
        localAgentKeys.antigravityLogin(instanceId),
        session,
      );
      void queryClient.invalidateQueries({
        queryKey: localAgentKeys.antigravityLogin(instanceId),
      });
    },
  });
}

export function logoutAntigravityMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      instanceId: string;
      environmentId?: string;
    }): Promise<AntigravityLogoutResult> =>
      logoutAntigravityInstance(input.instanceId),
    onSuccess: (_result, input) => {
      queryClient.setQueryData(
        localAgentKeys.antigravityLogin(input.instanceId),
        null,
      );
      void queryClient.invalidateQueries({
        queryKey: localAgentKeys.antigravityLogin(input.instanceId),
      });
      void invalidateAgentProviderQueries(queryClient, input.environmentId);
    },
  });
}
