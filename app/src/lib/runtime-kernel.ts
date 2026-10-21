import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 管理后台 → 系统更新 里的「执行内核」状态。
 *
 * 部署级配置，不按机器人切换：所有 built_in 机器人共用同一个执行循环。这里只读，而且只拿到
 * 桥接自己公开的健康快照（不含 token、地址之外的凭据或任何运行内容）。
 */
export type HermesKernelHealth = {
  ok: boolean | null;
  configured: boolean;
  reachable?: boolean;
  healthy?: boolean;
  initialized?: boolean;
  hostTools?: boolean;
  persistentState?: boolean;
  generation?: number;
  sessions?: number;
  error?: string;
};

export type RuntimeKernelStatus = {
  kernel: "hermes" | "builtin";
  hermes: HermesKernelHealth | null;
};

export const runtimeKernelKeys = {
  status: ["runtime-kernel", "status"] as const,
};

export function runtimeKernelQueryOptions() {
  return queryOptions({
    queryKey: runtimeKernelKeys.status,
    queryFn: async ({ signal }) => {
      const response = await client("/api/admin/runtime-kernel", {
        fallback: "无法读取执行内核状态。",
        signal,
      });
      return (await response.json()) as RuntimeKernelStatus;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
  });
}
