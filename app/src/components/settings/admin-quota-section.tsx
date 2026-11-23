import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { QuotaMetricBlock } from "@/components/settings/quota-progress";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useExternalConnection } from "@/hooks";
import type { GatewayAccount } from "@/lib/accounts";
import { objectConnectionKey } from "@/lib/connection-key";
import { useRetainedValue } from "@/lib/motion";
import {
  adminQuotasQueryOptions,
  formatTokenCount,
  hasAnyQuotaLimit,
  type QuotaFormDraft,
  type QuotaFormErrors,
  type QuotaOverviewRow,
  quotaDraftFromRecord,
  useUpdateUserQuotaMutation,
  validateQuotaForm,
} from "@/lib/quotas";

type AdminQuotaSectionProps = {
  gatewayAccounts?: readonly GatewayAccount[];
};

function resolveUserMeta(
  row: QuotaOverviewRow,
  accountById: Map<string, GatewayAccount>,
) {
  const account = accountById.get(row.userId);
  const displayName =
    row.displayName?.trim() || account?.displayName || row.userId;
  const email = row.email?.trim() || null;
  const role = row.role ?? account?.role ?? null;
  const isAdminRole = role === "admin";
  return { displayName, email, role, isAdminRole };
}

/** 管理员账号页中的 Token 与请求配额管理面板（单机 / 多账号环境均可用）。 */
export function AdminQuotaSection({ gatewayAccounts }: AdminQuotaSectionProps) {
  const quotasQuery = useQuery(adminQuotasQueryOptions());
  const [editingRow, setEditingRow] = useState<QuotaOverviewRow | null>(null);
  const accountById = new Map(
    (gatewayAccounts ?? []).map((account) => [account.id, account] as const),
  );
  const rows = quotasQuery.data ?? [];
  const editingMeta = editingRow
    ? resolveUserMeta(editingRow, accountById)
    : null;

  return (
    <>
      <QuotaEditDialog
        displayName={editingMeta?.displayName ?? ""}
        isAdminRole={editingMeta?.isAdminRole ?? false}
        onClose={() => setEditingRow(null)}
        row={editingRow}
      />
      <PageSection
        action={
          <RefreshButton
            onRefresh={async () => {
              const result = await quotasQuery.refetch();
              if (result.isError) throw result.error;
            }}
            size="sm"
            variant="outline"
          />
        }
        description="查看各账号当日与本月模型 Token 与请求消耗，并设置每日 / 每月上限（留空表示不限，按 UTC 日 / 月重置）。"
        settingItem="accounts.quotas"
        title="Token 与请求配额管理"
      >
        {quotasQuery.isPending ? (
          <PageSkeleton rows={3} />
        ) : quotasQuery.isError ? (
          <ErrorCard
            action={
              <Button
                className="mt-2"
                onClick={() => void quotasQuery.refetch()}
                size="sm"
                variant="outline"
              >
                {"重试"}
              </Button>
            }
            description={quotasQuery.error.message}
            title="配额与用量暂时无法读取"
          />
        ) : rows.length === 0 ? (
          <PageEmpty>{"暂无用户配额或用量记录。"}</PageEmpty>
        ) : (
          <Card className="mem-card divide-y divide-border/60">
            {rows.map((row) => {
              const { displayName, email, role, isAdminRole } = resolveUserMeta(
                row,
                accountById,
              );
              const limited = hasAnyQuotaLimit(row.quota);
              const bypassEnabled = Boolean(row.quota?.bypassAdmin);
              const subtitleParts: string[] = [];
              if (email) subtitleParts.push(email);
              if (displayName !== row.userId || !email) {
                subtitleParts.push(`ID: ${row.userId}`);
              }

              return (
                <div className="p-4 space-y-3.5" key={row.userId}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {displayName}
                        </span>
                        {role === "admin" ? (
                          <span className="magpie-badge text-xs">
                            {"管理员"}
                          </span>
                        ) : role === "user" ? (
                          <span className="device-cap-chip is-off text-xs">
                            {"成员"}
                          </span>
                        ) : null}
                        {bypassEnabled ? (
                          <span className="magpie-badge is-ok text-xs">
                            {isAdminRole ? "管理员豁免生效" : "允许管理员豁免"}
                          </span>
                        ) : (
                          <span className="device-cap-chip is-ask text-xs">
                            {isAdminRole
                              ? "管理员不豁免（受限）"
                              : limited
                                ? "按配额限制"
                                : "暂未设限"}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {subtitleParts.join(" · ")}
                      </p>
                    </div>
                    <Button
                      onClick={() => setEditingRow(row)}
                      size="sm"
                      variant="outline"
                    >
                      {"配置配额"}
                    </Button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <QuotaMetricBlock
                      detail={`输入 ${formatTokenCount(row.usage.dailyInputTokens)} · 输出 ${formatTokenCount(row.usage.dailyOutputTokens)} · 缓存读取 ${formatTokenCount(row.usage.dailyCacheReadTokens)}`}
                      label="每日 Token"
                      limit={row.quota?.dailyTokenLimit}
                      used={row.usage.dailyTotalTokens}
                    />
                    <QuotaMetricBlock
                      detail={`输入 ${formatTokenCount(row.usage.monthlyInputTokens)} · 输出 ${formatTokenCount(row.usage.monthlyOutputTokens)} · 缓存读取 ${formatTokenCount(row.usage.monthlyCacheReadTokens)}`}
                      label="每月 Token"
                      limit={row.quota?.monthlyTokenLimit}
                      used={row.usage.monthlyTotalTokens}
                    />
                    <QuotaMetricBlock
                      detail={`本月累计 ${formatTokenCount(row.usage.monthlyRequests)} 次`}
                      label="每日请求次数"
                      limit={row.quota?.dailyRequestLimit}
                      unit=" 次"
                      used={row.usage.dailyRequests}
                    />
                  </div>

                  {row.usage.byModel.length > 0 ? (
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {`常用模型：${row.usage.byModel
                        .slice(0, 3)
                        .map(
                          (item) =>
                            `${item.model}（本月 ${formatTokenCount(item.monthlyTokens)}）`,
                        )
                        .join("、")}`}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </Card>
        )}
      </PageSection>
    </>
  );
}

function QuotaEditDialog({
  row,
  displayName,
  isAdminRole,
  onClose,
}: {
  row: QuotaOverviewRow | null;
  displayName: string;
  isAdminRole: boolean;
  onClose: () => void;
}) {
  const saveQuota = useUpdateUserQuotaMutation();
  const retainedDisplayName = useRetainedValue(row ? displayName : null) ?? displayName;
  const [draft, setDraft] = useState<QuotaFormDraft>(() =>
    quotaDraftFromRecord(row?.quota ?? null),
  );
  const [errors, setErrors] = useState<QuotaFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resetMutation = saveQuota.reset;
  useExternalConnection(row ? objectConnectionKey(row) : false, () => {
    setDraft(quotaDraftFromRecord(row?.quota ?? null));
    setErrors({});
    setSubmitError(null);
    resetMutation();
  });

  function updateField(
    field: "dailyTokenLimit" | "monthlyTokenLimit" | "dailyRequestLimit",
    value: string,
  ) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSubmitError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!row || saveQuota.isPending) return;
    const validation = validateQuotaForm(draft);
    if (!validation.ok) {
      setErrors(validation.errors);
      setSubmitError("请先修正标出的字段。");
      return;
    }
    setErrors({});
    setSubmitError(null);
    try {
      await saveQuota.mutateAsync({
        userId: row.userId,
        input: validation.input,
      });
      toast.success(`已更新「${displayName}」的配额设置`);
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "无法保存用户配额设置。",
      );
    }
  }

  const busy = saveQuota.isPending;

  return (
    <Dialog
      onOpenChange={(open) => (open ? null : onClose())}
      open={Boolean(row)}
    >
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{`配置配额 · ${retainedDisplayName}`}</DialogTitle>
          <DialogDescription>
            {"设置该用户的每日、每月模型配额上限；留空表示不限制。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <DialogBody className="im-form mt-2 space-y-4">
            <FieldGroup>
              <Field data-invalid={Boolean(errors.dailyTokenLimit)}>
                <FieldLabel htmlFor="quota-daily-tokens">
                  {"每日 Token 上限"}
                </FieldLabel>
                <Input
                  aria-invalid={Boolean(errors.dailyTokenLimit)}
                  disabled={busy}
                  id="quota-daily-tokens"
                  inputMode="numeric"
                  onChange={(event) =>
                    updateField("dailyTokenLimit", event.target.value)
                  }
                  placeholder="留空表示不限"
                  value={draft.dailyTokenLimit}
                />
                <FieldDescription>
                  {
                    "按每日总 Token（输入 + 输出 + 缓存读取）统计，UTC 00:00 重置。"
                  }
                </FieldDescription>
                <FieldError>{errors.dailyTokenLimit}</FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.monthlyTokenLimit)}>
                <FieldLabel htmlFor="quota-monthly-tokens">
                  {"每月 Token 上限"}
                </FieldLabel>
                <Input
                  aria-invalid={Boolean(errors.monthlyTokenLimit)}
                  disabled={busy}
                  id="quota-monthly-tokens"
                  inputMode="numeric"
                  onChange={(event) =>
                    updateField("monthlyTokenLimit", event.target.value)
                  }
                  placeholder="留空表示不限"
                  value={draft.monthlyTokenLimit}
                />
                <FieldDescription>
                  {"按自然月总 Token 统计，每月 1 日 UTC 00:00 重置。"}
                </FieldDescription>
                <FieldError>{errors.monthlyTokenLimit}</FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.dailyRequestLimit)}>
                <FieldLabel htmlFor="quota-daily-requests">
                  {"每日请求次数上限"}
                </FieldLabel>
                <Input
                  aria-invalid={Boolean(errors.dailyRequestLimit)}
                  disabled={busy}
                  id="quota-daily-requests"
                  inputMode="numeric"
                  onChange={(event) =>
                    updateField("dailyRequestLimit", event.target.value)
                  }
                  placeholder="留空表示不限"
                  value={draft.dailyRequestLimit}
                />
                <FieldDescription>
                  {"限制每日模型对话请求总次数，留空表示不限。"}
                </FieldDescription>
                <FieldError>{errors.dailyRequestLimit}</FieldError>
              </Field>
            </FieldGroup>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
              <div className="space-y-0.5">
                <div className="font-medium text-sm">{"允许管理员豁免"}</div>
                <p className="text-muted-foreground text-xs">
                  {isAdminRole
                    ? "开启后，该管理员账号不受上述 Token 与请求次数限制。"
                    : "开启后，若该账号拥有管理员权限，将跳过上述配额拦截。"}
                </p>
              </div>
              <Switch
                aria-label="允许管理员豁免"
                checked={draft.bypassAdmin}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setDraft((previous) => ({
                    ...previous,
                    bypassAdmin: Boolean(checked),
                  }));
                  setSubmitError(null);
                }}
              />
            </div>

            {submitError ? (
              <p className="text-destructive text-sm" role="alert">
                {submitError}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              disabled={busy}
              onClick={onClose}
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? "保存中…" : "保存配额"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
