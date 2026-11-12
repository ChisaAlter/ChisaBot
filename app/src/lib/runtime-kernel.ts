import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 管理后台 → 系统更新 里的「执行内核」状态。
 *
 * 部署级配置，不按机器人切换：所有 built_in 机器人共用同一个执行循环。
 */
export type RuntimeKernelStatus = {
  kernel: "builtin" | "dsh";
  dsh?: {
    ok: boolean;
    version?: string;
    sessions?: number;
    running?: number;
    error?: string;
  } | null;
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
