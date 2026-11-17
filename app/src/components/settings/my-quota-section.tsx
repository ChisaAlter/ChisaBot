import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { QuotaMetricBlock } from "@/components/settings/quota-progress";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Separator } from "@/components/ui/separator";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import {
  formatQuotaResetUtc,
  formatTokenCount,
  hasAnyQuotaLimit,
  myQuotaQueryOptions,
} from "@/lib/quotas";

/** 通用设置页中的个人模型配额与用量只读卡片。 */
export function MyQuotaSection() {
  const quotaQuery = useQuery(myQuotaQueryOptions());
  const summary = quotaQuery.data;
  const limited = summary ? hasAnyQuotaLimit(summary.quota) : false;

  return (
    <PageSection
      action={
        <RefreshButton
          onRefresh={async () => {
            const result = await quotaQuery.refetch();
            if (result.isError) throw result.error;
          }}
          size="sm"
          variant="outline"
        />
      }
      description="查看当前账号今日与本月模型 Token、请求次数及分模型消耗明细。"
      settingItem="quota.my-quota"
      title="我的模型配额与用量"
    >
      {quotaQuery.isPending ? (
        <PageSkeleton rows={3} />
      ) : quotaQuery.isError ? (
        <ErrorCard
          action={
            <Button
              className="mt-2"
              onClick={() => void quotaQuery.refetch()}
              size="sm"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={quotaQuery.error.message}
          title="个人配额与用量暂时无法读取"
        />
      ) : !summary ? (
        <PageEmpty>{"暂无用量统计。"}</PageEmpty>
      ) : (
        <div className="space-y-4">
          <Card className="mem-card p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {summary.bypassed ? (
                <span className="magpie-badge is-ok text-xs">
                  {"管理员豁免"}
                </span>
              ) : !limited ? (
                <span className="device-cap-chip is-off text-xs">{"不限"}</span>
              ) : (
                <span className="magpie-badge text-xs">{"按配额限制"}</span>
              )}
              <span className="min-w-0 text-muted-foreground text-xs">
                {summary.bypassed
                  ? "当前账号为管理员且已开启豁免，不受配额上限拦截。"
                  : !limited
                    ? "管理员暂未对当前账号设置 Token 或请求上限。"
                    : "达到每日或每月上限后将暂停新的模型调用。"}
              </span>
            </div>
            <div className="text-muted-foreground text-xs tabular-nums">
              {`统计周期：${summary.day} · 本月 ${summary.month} · UTC 重置 ${formatQuotaResetUtc(summary.resetAtUtc)}`}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <QuotaMetricBlock
                detail={`输入 ${formatTokenCount(summary.usage.dailyInputTokens)} · 输出 ${formatTokenCount(summary.usage.dailyOutputTokens)} · 缓存读取 ${formatTokenCount(summary.usage.dailyCacheReadTokens)}`}
                label="今日 Token"
                limit={summary.bypassed ? null : summary.quota?.dailyTokenLimit}
                used={summary.usage.dailyTotalTokens}
              />
              <QuotaMetricBlock
                detail={`输入 ${formatTokenCount(summary.usage.monthlyInputTokens)} · 输出 ${formatTokenCount(summary.usage.monthlyOutputTokens)} · 缓存读取 ${formatTokenCount(summary.usage.monthlyCacheReadTokens)}`}
                label="本月 Token"
                limit={
                  summary.bypassed ? null : summary.quota?.monthlyTokenLimit
                }
                used={summary.usage.monthlyTotalTokens}
              />
              <QuotaMetricBlock
                detail={`本月累计 ${formatTokenCount(summary.usage.monthlyRequests)} 次`}
                label="今日请求数"
                limit={
                  summary.bypassed ? null : summary.quota?.dailyRequestLimit
                }
                unit=" 次"
                used={summary.usage.dailyRequests}
              />
            </div>
          </Card>

          <div className="space-y-2">
            <h3 className="font-medium text-muted-foreground text-xs">
              {`分模型明细 · ${summary.usage.byModel.length}`}
            </h3>
            {summary.usage.byModel.length === 0 ? (
              <PageEmpty>{"当前周期暂无模型调用记录。"}</PageEmpty>
            ) : (
              <PageRows>
                {summary.usage.byModel.map((row, index) => (
                  <Fragment key={row.model}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle className="font-mono text-xs sm:text-sm">
                          {row.model}
                        </ItemTitle>
                        <ItemDescription className="tabular-nums">
                          {`今日 ${formatTokenCount(row.dailyTokens)} Token · ${formatTokenCount(row.dailyRequests)} 次请求`}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="text-muted-foreground text-xs tabular-nums">
                        {`本月 ${formatTokenCount(row.monthlyTokens)} Token · ${formatTokenCount(row.monthlyRequests)} 次`}
                      </ItemActions>
                    </Item>
                  </Fragment>
                ))}
              </PageRows>
            )}
          </div>
        </div>
      )}
    </PageSection>
  );
}
