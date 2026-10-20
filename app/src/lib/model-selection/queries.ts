import { queryOptions } from "@tanstack/react-query";
import type { AgentModelState, ModelCatalog } from "../../../../shared/model-selection";
import { agentApiPath } from "@/lib/agents/queries";
import { client } from "@/lib/client";

export const modelSelectionKeys = {
  catalog: ["model-selection", "catalog"] as const,
  agents: ["model-selection", "agent"] as const,
  agent: (agentId: string) => ["model-selection", "agent", agentId] as const,
  save: (agentId: string) => ["model-selection", "save", agentId] as const,
  refresh: ["model-selection", "refresh"] as const,
};

export async function loadModelCatalog(refresh = false, signal?: AbortSignal): Promise<ModelCatalog> {
  const response = await client(`/api/models${refresh ? "?refresh=1" : ""}`, {
    fallback: "无法加载模型列表，请重试。", signal,
  });
  return response.json();
}

export function modelCatalogQueryOptions() {
  return queryOptions({
    queryKey: modelSelectionKeys.catalog,
    queryFn: ({ signal }) => loadModelCatalog(false, signal),
    staleTime: 30_000,
  });
}

export function agentModelQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: modelSelectionKeys.agent(agentId),
    queryFn: async ({ signal }): Promise<AgentModelState> => {
      const response = await client(`${agentApiPath(agentId)}/model`, {
        fallback: "无法加载此 BOT 的模型设置。", signal,
      });
      return response.json();
    },
    // 切机器人再切回来不立刻重读（DESIGN.md §83）；改模型走 mutation 会让它失效，回到页面时照旧重读。
    staleTime: 30_000,
  });
}
