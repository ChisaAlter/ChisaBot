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
  /** 适配器在已安装的 Hermes 里检测到的模型能力（桥接层初始化后才有）。 */
  modelControls?: { fallback: boolean; maxOutputTokens: boolean };
  error?: string;
};

/**
 * 「备用模型」设置在 Hermes 内核下是否不生效：只有内核是 Hermes、且适配器明确检测到这个 Hermes 版本
 * 不支持备用模型链时才返回提示；没检测到（桥接还没初始化、读不到状态）一律不下结论。
 */
export function hermesFallbackUnsupportedNote(
  status: RuntimeKernelStatus | undefined,
): string | null {
  if (
    status?.kernel !== "hermes" ||
    status.hermes?.modelControls?.fallback !== false
  )
    return null;
  return "检测到当前 Hermes 版本不支持备用模型链，这里的设置在 Hermes 内核下不生效（内置内核照常生效）。";
}

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
