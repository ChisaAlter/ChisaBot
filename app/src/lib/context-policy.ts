import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  defaultSummaryThresholdFor,
  formatTokenShorthand,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_SUMMARY_HEADROOM_TOKENS,
  MIN_SUMMARY_THRESHOLD_TOKENS,
  type ModelContextPolicyInput,
  type ModelContextPolicyOverride,
  parseTokenShorthand,
  validateContextPolicy,
} from "../../../shared/context-policy";

export {
  defaultSummaryThresholdFor,
  formatTokenShorthand,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_SUMMARY_HEADROOM_TOKENS,
  MIN_SUMMARY_THRESHOLD_TOKENS,
  type ModelContextPolicyInput,
  type ModelContextPolicyOverride,
  parseTokenShorthand,
  validateContextPolicy,
};

export const contextPolicyKeys = {
  all: ["admin", "context-policies"] as const,
};

export function contextPoliciesQueryOptions() {
  return queryOptions({
    queryKey: contextPolicyKeys.all,
    queryFn: ({ signal }): Promise<ModelContextPolicyOverride[]> =>
      client<ModelContextPolicyOverride[]>(
        "/api/admin/context-policies",
        "policies",
        {
          signal,
          fallback: "无法加载模型上下文容量策略。",
        },
      ),
  });
}

export async function saveContextPolicy(
  input: ModelContextPolicyInput,
): Promise<{
  policy: ModelContextPolicyOverride;
  policies: ModelContextPolicyOverride[];
}> {
  const response = await client("/api/admin/context-policies", {
    method: "PUT",
    body: input,
    fallback: "保存模型上下文策略失败，请重试。",
  });
  const payload = (await response.json().catch(() => null)) as {
    policy?: ModelContextPolicyOverride;
    policies?: ModelContextPolicyOverride[];
  } | null;
  if (!payload?.policy || !Array.isArray(payload.policies)) {
    throw new Error("保存模型上下文策略返回格式无效。");
  }
  return { policy: payload.policy, policies: payload.policies };
}

export async function deleteContextPolicy(
  modelId: string,
): Promise<ModelContextPolicyOverride[]> {
  const response = await client(
    `/api/admin/context-policies?modelId=${encodeURIComponent(modelId)}`,
    {
      method: "DELETE",
      fallback: "移除模型上下文覆写失败，请重试。",
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    policies?: ModelContextPolicyOverride[];
  } | null;
  return Array.isArray(payload?.policies) ? payload.policies : [];
}
