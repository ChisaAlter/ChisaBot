/**
 * Wave 4 白盒调优与可观测工作台前端 API 封装。
 * 严格统一通过 `@/lib/client` 发起请求，严禁裸 `fetch`。
 */

import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  HarnessFlags,
  HarnessSettingsView,
  ModelObservationSnapshot,
  UsageBreakdownResponse,
} from "../../../shared/admin-workbench";
import type {
  AdaptiveRoutingPolicy,
  DryRunRoutingResult,
  RoutingDecisionSource,
  RoutingLogEntry,
  RoutingProviderKind,
  TaskDifficulty,
} from "../../../shared/model-routing";
import type {
  PromptRole,
  PromptRoleDetail,
  PromptRoleSummary,
} from "../../../shared/prompt-workbench";

export * from "../../../shared/admin-workbench";
export * from "../../../shared/model-routing";
export * from "../../../shared/prompt-workbench";

export const workbenchKeys = {
  all: ["admin-workbench"] as const,
  routingPolicy: ["admin-workbench", "routing-policy"] as const,
  routingLogs: (params?: {
    limit?: number;
    difficulty?: TaskDifficulty;
    source?: RoutingDecisionSource;
  }) => ["admin-workbench", "routing-logs", params ?? {}] as const,
  promptRoles: ["admin-workbench", "prompt-roles"] as const,
  promptDetail: (role: PromptRole) =>
    ["admin-workbench", "prompt-detail", role] as const,
  harness: ["admin-workbench", "harness"] as const,
  observation: ["admin-workbench", "observation"] as const,
  usageBreakdown: (tz: string) =>
    ["admin-workbench", "usage-breakdown", tz] as const,
};

export function detectBrowserTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved?.trim() || "UTC";
  } catch {
    return "UTC";
  }
}

export function fetchRoutingPolicy(
  signal?: AbortSignal,
): Promise<AdaptiveRoutingPolicy> {
  return client<AdaptiveRoutingPolicy>("/api/admin/routing/policy", "policy", {
    fallback: "无法加载自适应路由策略",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
}

export function saveRoutingPolicy(
  policy: AdaptiveRoutingPolicy,
): Promise<AdaptiveRoutingPolicy> {
  return client<AdaptiveRoutingPolicy>("/api/admin/routing/policy", "policy", {
    method: "PUT",
    body: policy,
    fallback: "无法保存自适应路由策略",
  });
}

export type RoutingLogsResponse = {
  items: RoutingLogEntry[];
  total: number;
};

export async function fetchRoutingLogs(
  params?: {
    limit?: number;
    difficulty?: TaskDifficulty;
    source?: RoutingDecisionSource;
  },
  signal?: AbortSignal,
): Promise<RoutingLogsResponse> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.difficulty) search.set("difficulty", params.difficulty);
  if (params?.source) search.set("source", params.source);
  const query = search.toString();
  const path = query
    ? `/api/admin/routing/logs?${query}`
    : "/api/admin/routing/logs";
  const response = await client(path, {
    fallback: "无法加载路由决策日志",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as Partial<RoutingLogsResponse>;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: typeof data.total === "number" ? data.total : 0,
  };
}

export function runRoutingDryRun(input: {
  text: string;
  providerKind?: RoutingProviderKind;
  recordLog?: boolean;
}): Promise<DryRunRoutingResult> {
  return client<DryRunRoutingResult>("/api/admin/routing/dry-run", "result", {
    method: "POST",
    body: input,
    fallback: "路由试跑失败",
  });
}

export function fetchPromptRoles(
  signal?: AbortSignal,
): Promise<PromptRoleSummary[]> {
  return client<PromptRoleSummary[]>("/api/admin/prompts", "roles", {
    fallback: "无法加载系统提示词角色列表",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
}

export function fetchPromptDetail(
  role: PromptRole,
  signal?: AbortSignal,
): Promise<PromptRoleDetail> {
  return client<PromptRoleDetail>(
    `/api/admin/prompts/${encodeURIComponent(role)}`,
    "prompt",
    {
      fallback: "无法加载该角色的提示词详情",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    },
  );
}

export function savePromptRole(
  role: PromptRole,
  input: {
    digest: string;
    expectedRevision: number;
    content?: string;
    restore?: "original" | "previous";
  },
): Promise<PromptRoleDetail> {
  return client<PromptRoleDetail>(
    `/api/admin/prompts/${encodeURIComponent(role)}`,
    "prompt",
    {
      method: "PUT",
      body: input,
      fallback: "无法保存系统提示词",
    },
  );
}

export async function fetchHarnessSettings(
  signal?: AbortSignal,
): Promise<HarnessSettingsView> {
  const response = await client("/api/admin/harness", {
    fallback: "无法加载 Harness 能力开关",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return (await response.json()) as HarnessSettingsView;
}

export async function saveHarnessSettings(
  flags: Partial<HarnessFlags>,
): Promise<HarnessSettingsView> {
  const response = await client("/api/admin/harness", {
    method: "PUT",
    body: flags,
    fallback: "无法保存 Harness 能力开关",
  });
  return (await response.json()) as HarnessSettingsView;
}

export async function fetchModelObservation(
  signal?: AbortSignal,
): Promise<ModelObservationSnapshot> {
  const response = await client("/api/admin/observation", {
    fallback: "无法加载模型脱敏观测记录",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return (await response.json()) as ModelObservationSnapshot;
}

export async function toggleModelObservation(
  enabled: boolean,
): Promise<ModelObservationSnapshot> {
  const response = await client("/api/admin/observation/toggle", {
    method: "PUT",
    body: { enabled },
    fallback: "无法切换模型观测开关",
  });
  return (await response.json()) as ModelObservationSnapshot;
}

export async function clearModelObservation(): Promise<ModelObservationSnapshot> {
  const response = await client("/api/admin/observation", {
    method: "DELETE",
    fallback: "无法清空模型观测记录",
  });
  return (await response.json()) as ModelObservationSnapshot;
}

export function fetchUsageBreakdown(
  tz: string,
  signal?: AbortSignal,
): Promise<UsageBreakdownResponse> {
  const encoded = encodeURIComponent(tz || "UTC");
  return client<UsageBreakdownResponse>(
    `/api/usage/breakdown?tz=${encoded}`,
    "breakdown",
    {
      fallback: "无法加载细分用量账本",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    },
  );
}

export function routingPolicyQueryOptions() {
  return queryOptions({
    queryKey: workbenchKeys.routingPolicy,
    queryFn: ({ signal }) => fetchRoutingPolicy(signal),
    staleTime: 15_000,
  });
}

export function routingLogsQueryOptions(params?: {
  limit?: number;
  difficulty?: TaskDifficulty;
  source?: RoutingDecisionSource;
}) {
  return queryOptions({
    queryKey: workbenchKeys.routingLogs(params),
    queryFn: ({ signal }) => fetchRoutingLogs(params, signal),
    staleTime: 5_000,
  });
}

export function promptRolesQueryOptions() {
  return queryOptions({
    queryKey: workbenchKeys.promptRoles,
    queryFn: ({ signal }) => fetchPromptRoles(signal),
    staleTime: 15_000,
  });
}

export function promptDetailQueryOptions(role: PromptRole) {
  return queryOptions({
    queryKey: workbenchKeys.promptDetail(role),
    queryFn: ({ signal }) => fetchPromptDetail(role, signal),
    staleTime: 5_000,
  });
}

export function harnessSettingsQueryOptions() {
  return queryOptions({
    queryKey: workbenchKeys.harness,
    queryFn: ({ signal }) => fetchHarnessSettings(signal),
    staleTime: 15_000,
  });
}

export function modelObservationQueryOptions() {
  return queryOptions({
    queryKey: workbenchKeys.observation,
    queryFn: ({ signal }) => fetchModelObservation(signal),
    staleTime: 3_000,
  });
}

export function usageBreakdownQueryOptions(tz: string) {
  return queryOptions({
    queryKey: workbenchKeys.usageBreakdown(tz),
    queryFn: ({ signal }) => fetchUsageBreakdown(tz, signal),
    staleTime: 15_000,
  });
}
