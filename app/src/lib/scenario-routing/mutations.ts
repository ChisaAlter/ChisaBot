import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  ModelScenario,
  ModelScenarioRoutingConfig,
  ScenarioDryRunResult,
} from "../../../../shared/model-scenario-routing";
import { scenarioRoutingKeys } from "./queries";

const FALLBACK = "场景路由操作失败，请稍后重试。";

export function saveScenarioRoutingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      input: ModelScenarioRoutingConfig,
    ): Promise<ModelScenarioRoutingConfig> =>
      client("/api/admin/scenario-routing", "scenario routing config", {
        method: "PUT",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: scenarioRoutingKeys.all }),
  });
}

/**
 * Dry-run 是一次性动作而非缓存读取：结果只对当时那份（假设性或当前）配置有意义，
 * 所以走 mutation 而不是 query——与自适应路由面板的试跑一致。
 */
export function dryRunScenarioMutationOptions() {
  return mutationOptions({
    mutationFn: (input: {
      scenario: ModelScenario;
      config?: ModelScenarioRoutingConfig;
    }): Promise<ScenarioDryRunResult> =>
      client("/api/admin/scenario-routing/dry-run", "scenario dry-run", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
  });
}
