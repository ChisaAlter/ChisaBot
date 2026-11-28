import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  ModelScenarioRoutingConfig,
  ScenarioRouteEvent,
} from "../../../../shared/model-scenario-routing";

/**
 * 场景化模型路由的服务端形状。配置是整表读写（PUT 提交完整的 scenarios 对象）；
 * 决策日志只读，服务器按时间倒序返回，浏览器不重新推导。
 */

export type ScenarioRouteLogsResponse = {
  items: ScenarioRouteEvent[];
  total: number;
};

export const scenarioRoutingKeys = {
  all: ["scenario-routing"] as const,
  config: () => ["scenario-routing", "config"] as const,
  logs: (scenario: string | null) =>
    ["scenario-routing", "logs", { scenario }] as const,
};

export function scenarioRoutingConfigQueryOptions() {
  return queryOptions({
    queryKey: scenarioRoutingKeys.config(),
    queryFn: (): Promise<ModelScenarioRoutingConfig> =>
      client("/api/admin/scenario-routing", "scenario routing config", {
        fallback: "无法加载场景路由配置。",
      }),
  });
}

export function scenarioRouteLogsQueryOptions(input?: {
  scenario?: string | null;
  limit?: number;
}) {
  const scenario = input?.scenario ?? null;
  return queryOptions({
    queryKey: scenarioRoutingKeys.logs(scenario),
    queryFn: (): Promise<ScenarioRouteLogsResponse> => {
      const params = new URLSearchParams();
      if (scenario) params.set("scenario", scenario);
      params.set("limit", String(input?.limit ?? 50));
      return client(
        `/api/admin/scenario-routing/logs?${params.toString()}`,
        "scenario routing logs",
        { fallback: "无法加载场景路由日志。" },
      );
    },
  });
}
