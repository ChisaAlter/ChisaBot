import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type UserQuotaRecord = {
  userId: string;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  dailyRequestLimit: number | null;
  bypassAdmin: boolean;
  updatedBy: string;
  updatedAt: string;
};

export type ModelUsageRow = {
  model: string;
  dailyTokens: number;
  dailyRequests: number;
  monthlyTokens: number;
  monthlyRequests: number;
};

export type UsageAggregate = {
  dailyInputTokens: number;
  dailyOutputTokens: number;
  dailyCacheReadTokens: number;
  dailyTotalTokens: number;
  dailyRequests: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyCacheReadTokens: number;
  monthlyTotalTokens: number;
  monthlyRequests: number;
  byModel: ModelUsageRow[];
};

export type QuotaOverviewRow = {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  quota: UserQuotaRecord | null;
  usage: UsageAggregate;
};

export type UserQuotaSummary = {
  userId: string;
  isAdmin: boolean;
  bypassed: boolean;
  day: string;
  month: string;
  resetAtUtc: string;
  quota: UserQuotaRecord | null;
  usage: UsageAggregate;
};

export type UpdateUserQuotaInput = {
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  dailyRequestLimit: number | null;
  bypassAdmin?: boolean;
};

export type UpdateUserQuotaVariables = {
  userId: string;
  input: UpdateUserQuotaInput;
};

export type QuotaFormDraft = {
  dailyTokenLimit: string;
  monthlyTokenLimit: string;
  dailyRequestLimit: string;
  bypassAdmin: boolean;
};

export type QuotaFormErrors = Partial<
  Record<"dailyTokenLimit" | "monthlyTokenLimit" | "dailyRequestLimit", string>
>;

export const quotaKeys = {
  all: ["quotas"] as const,
  adminList: () => [...quotaKeys.all, "admin"] as const,
  me: () => [...quotaKeys.all, "me"] as const,
};

export function adminQuotasQueryOptions() {
  return queryOptions({
    queryKey: quotaKeys.adminList(),
    queryFn: async ({ signal }): Promise<QuotaOverviewRow[]> => {
      const quotas = await client<QuotaOverviewRow[]>(
        "/api/admin/quotas",
        "quotas",
        {
          signal,
          fallback: "无法加载用户配额与用量。",
        },
      );
      return Array.isArray(quotas) ? quotas : [];
    },
  });
}

export function myQuotaQueryOptions() {
  return queryOptions({
    queryKey: quotaKeys.me(),
    queryFn: ({ signal }): Promise<UserQuotaSummary> =>
      client<UserQuotaSummary>("/api/me/quota", "summary", {
        signal,
        fallback: "无法加载个人配额与用量。",
      }),
  });
}

export function updateUserQuotaMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      userId,
      input,
    }: UpdateUserQuotaVariables): Promise<UserQuotaRecord> =>
      client<UserQuotaRecord>(
        `/api/admin/quotas/${encodeURIComponent(userId)}`,
        "quota",
        {
          method: "PUT",
          body: input,
          fallback: "无法保存用户配额设置。",
        },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: quotaKeys.adminList() }),
        queryClient.invalidateQueries({ queryKey: quotaKeys.me() }),
      ]);
    },
  });
}

export function useUpdateUserQuotaMutation() {
  const queryClient = useQueryClient();
  return useMutation(updateUserQuotaMutationOptions(queryClient));
}

const TOKEN_NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");

/** 千分位格式化 Token / 请求次数，非有限数或负数归零。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return TOKEN_NUMBER_FORMAT.format(Math.round(value));
}

export function formatQuotaLimit(
  limit: number | null | undefined,
  unit = "",
): string {
  if (limit === null || limit === undefined) return "不限";
  return `${formatTokenCount(limit)}${unit}`;
}

export type QuotaProgress = {
  percent: number | null;
  tone: "ok" | "warn" | "danger" | "unlimited";
  exceeded: boolean;
};

export function computeQuotaProgress(
  used: number,
  limit: number | null | undefined,
): QuotaProgress {
  if (limit === null || limit === undefined) {
    return { percent: null, tone: "unlimited", exceeded: false };
  }
  const normalizedUsed = Number.isFinite(used) && used > 0 ? used : 0;
  if (limit <= 0) {
    return { percent: 100, tone: "danger", exceeded: true };
  }
  const ratio = normalizedUsed / limit;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  if (normalizedUsed >= limit) {
    return { percent: 100, tone: "danger", exceeded: true };
  }
  if (ratio >= 0.8) {
    return { percent, tone: "warn", exceeded: false };
  }
  return { percent, tone: "ok", exceeded: false };
}

export type QuotaLimitParseResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** 解析单个配额上限输入：空字符串视为 null（不限），仅接受非负安全整数。 */
export function parseQuotaLimitInput(raw: string): QuotaLimitParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "请输入大于或等于 0 的整数，留空表示不限。" };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, error: "请输入有效范围内的非负整数。" };
  }
  return { ok: true, value: parsed };
}

export function quotaDraftFromRecord(
  record: UserQuotaRecord | null,
): QuotaFormDraft {
  return {
    dailyTokenLimit:
      record?.dailyTokenLimit !== null && record?.dailyTokenLimit !== undefined
        ? String(record.dailyTokenLimit)
        : "",
    monthlyTokenLimit:
      record?.monthlyTokenLimit !== null &&
      record?.monthlyTokenLimit !== undefined
        ? String(record.monthlyTokenLimit)
        : "",
    dailyRequestLimit:
      record?.dailyRequestLimit !== null &&
      record?.dailyRequestLimit !== undefined
        ? String(record.dailyRequestLimit)
        : "",
    bypassAdmin: record?.bypassAdmin ?? false,
  };
}

export type QuotaValidationResult =
  | { ok: true; input: UpdateUserQuotaInput }
  | { ok: false; errors: QuotaFormErrors };

export function validateQuotaForm(
  draft: QuotaFormDraft,
): QuotaValidationResult {
  const dailyToken = parseQuotaLimitInput(draft.dailyTokenLimit);
  const monthlyToken = parseQuotaLimitInput(draft.monthlyTokenLimit);
  const dailyRequest = parseQuotaLimitInput(draft.dailyRequestLimit);
  const errors: QuotaFormErrors = {};
  if (!dailyToken.ok) errors.dailyTokenLimit = dailyToken.error;
  if (!monthlyToken.ok) errors.monthlyTokenLimit = monthlyToken.error;
  if (!dailyRequest.ok) errors.dailyRequestLimit = dailyRequest.error;
  if (!dailyToken.ok || !monthlyToken.ok || !dailyRequest.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      dailyTokenLimit: dailyToken.value,
      monthlyTokenLimit: monthlyToken.value,
      dailyRequestLimit: dailyRequest.value,
      bypassAdmin: draft.bypassAdmin,
    },
  };
}

export function hasAnyQuotaLimit(record: UserQuotaRecord | null): boolean {
  if (!record) return false;
  return (
    record.dailyTokenLimit !== null ||
    record.monthlyTokenLimit !== null ||
    record.dailyRequestLimit !== null
  );
}

export function formatQuotaResetUtc(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}
