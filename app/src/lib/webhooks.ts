import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  WEBHOOK_RULE_QUOTA_PER_USER,
  WEBHOOK_RUN_STATUS_LABELS,
  WEBHOOK_RUN_STATUSES,
  WEBHOOK_TRIGGER_KINDS,
  WEBHOOK_VENDOR_META,
  type WebhookRuleView,
  type WebhookRulesListResponse,
  type WebhookRunStatus,
  type WebhookRunView,
  type WebhookRunsListResponse,
  type WebhookTriggerKind,
  type WebhookVendorMeta,
} from "../../../shared/webhooks";

export {
  WEBHOOK_RULE_QUOTA_PER_USER,
  WEBHOOK_RUN_STATUS_LABELS,
  WEBHOOK_RUN_STATUSES,
  WEBHOOK_TRIGGER_KINDS,
  WEBHOOK_VENDOR_META,
  type WebhookRuleView,
  type WebhookRulesListResponse,
  type WebhookRunStatus,
  type WebhookRunView,
  type WebhookRunsListResponse,
  type WebhookTriggerKind,
  type WebhookVendorMeta,
};

export const webhookKeys = {
  all: ["webhooks"] as const,
  rules: ["webhooks", "rules"] as const,
  runs: (filter?: { triggerId?: string; status?: WebhookRunStatus }) =>
    [
      "webhooks",
      "runs",
      filter?.triggerId ?? "",
      filter?.status ?? "",
    ] as const,
};

export type CreateWebhookRuleInput = {
  title: string;
  agentId: string;
  instruction: string;
  kind: WebhookTriggerKind;
  repository?: string;
  eventTypes?: string[];
  fieldFilter?: { path: string; equals: string };
  secret?: string;
};

export function webhooksQueryOptions() {
  return queryOptions({
    queryKey: webhookKeys.rules,
    queryFn: async ({ signal }): Promise<WebhookRulesListResponse> => {
      const response = await client("/api/webhooks", {
        signal,
        fallback: "无法加载 Webhook 规则列表。",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as WebhookRulesListResponse | null;
      if (!payload || !Array.isArray(payload.rules)) {
        throw new Error("Webhook 规则响应格式无效。");
      }
      return payload;
    },
  });
}

export function webhookRunsQueryOptions(filter?: {
  triggerId?: string;
  status?: WebhookRunStatus;
  limit?: number;
}) {
  return queryOptions({
    queryKey: webhookKeys.runs(filter),
    queryFn: async ({ signal }): Promise<WebhookRunsListResponse> => {
      const params = new URLSearchParams();
      if (filter?.triggerId) params.set("triggerId", filter.triggerId);
      if (filter?.status) params.set("status", filter.status);
      if (filter?.limit) params.set("limit", String(filter.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const response = await client(`/api/webhooks/runs${suffix}`, {
        signal,
        fallback: "无法加载 Webhook 执行流水。",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as WebhookRunsListResponse | null;
      if (!payload || !Array.isArray(payload.runs)) {
        throw new Error("Webhook 执行流水响应格式无效。");
      }
      return payload;
    },
  });
}

export async function createWebhookRule(
  input: CreateWebhookRuleInput,
): Promise<{ rule: WebhookRuleView; secret: string | null }> {
  const response = await client("/api/webhooks", {
    method: "POST",
    body: input,
    fallback: "创建 Webhook 规则失败，请重试。",
  });
  const payload = (await response.json().catch(() => null)) as {
    rule?: WebhookRuleView;
    secret?: string | null;
  } | null;
  if (!payload?.rule) {
    throw new Error("创建 Webhook 规则返回格式无效。");
  }
  return { rule: payload.rule, secret: payload.secret ?? null };
}

export async function toggleWebhookRule(
  triggerId: string,
  enabled: boolean,
): Promise<{ rule: WebhookRuleView; cancelledRuns: number }> {
  const response = await client(
    `/api/webhooks/${encodeURIComponent(triggerId)}/enabled`,
    {
      method: "PATCH",
      body: { enabled },
      fallback: enabled ? "启用 Webhook 规则失败。" : "停用 Webhook 规则失败。",
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    rule?: WebhookRuleView;
    cancelledRuns?: number;
  } | null;
  if (!payload?.rule) {
    throw new Error("更新 Webhook 开关返回格式无效。");
  }
  return {
    rule: payload.rule,
    cancelledRuns: Number(payload.cancelledRuns ?? 0),
  };
}

export async function rotateWebhookSecret(
  triggerId: string,
  pastedSecret?: string,
): Promise<{ rule: WebhookRuleView; secret: string | null }> {
  const response = await client(
    `/api/webhooks/${encodeURIComponent(triggerId)}/rotate-secret`,
    {
      method: "POST",
      body: pastedSecret?.trim() ? { secret: pastedSecret.trim() } : {},
      fallback: "重置 Webhook 签名密钥失败。",
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    rule?: WebhookRuleView;
    secret?: string | null;
  } | null;
  if (!payload?.rule) {
    throw new Error("重置 Webhook 密钥返回格式无效。");
  }
  return { rule: payload.rule, secret: payload.secret ?? null };
}

export async function deleteWebhookRule(
  triggerId: string,
): Promise<{ deleted: true; cancelledRuns: number }> {
  const response = await client(
    `/api/webhooks/${encodeURIComponent(triggerId)}`,
    {
      method: "DELETE",
      fallback: "删除 Webhook 规则失败。",
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    deleted?: boolean;
    cancelledRuns?: number;
  } | null;
  return {
    deleted: true,
    cancelledRuns: Number(payload?.cancelledRuns ?? 0),
  };
}
