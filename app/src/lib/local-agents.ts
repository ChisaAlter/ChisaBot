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
  ACTIVE_LOCAL_TASK,
  type DeviceAgentSettings,
  LOCAL_AGENT_RESULT_MARKER,
  type LocalAgentLine,
  type LocalAgentTaskView,
} from "../../../shared/local-agents";

/**
 * 本地 agent（docs/local-agents.md；服务器 server/src/local-agents/service.ts）在界面上的数据：
 * 对话里的任务卡片（有任务在跑时每 1.2 秒取一次）、设备的档位 / 本地 agent 设置。
 */

const FALLBACK = "本地 agent 暂时不可用，请重试。";

export const localAgentKeys = {
  all: ["local-agents"] as const,
  thread: (threadId: string) => ["local-agents", "thread", threadId] as const,
  /** 所有设备的本地 agent 设置（按前缀整组失效用）。 */
  devices: () => ["local-agents", "device"] as const,
  device: (deviceId: string) => ["local-agents", "device", deviceId] as const,
  task: (taskId: string) => ["local-agents", "task", taskId] as const,
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
