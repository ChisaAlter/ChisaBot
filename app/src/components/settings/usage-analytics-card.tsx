import { IconChartBar, IconDownload, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContentEnter } from "@/components/ui/motion-primitives";
import { Card, ErrorCard, StatTile } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import {
  downloadUsageCsv,
  fetchUsageDetailPage,
  type UsageAnalyticsBucket,
  type UsageDetailEvent,
  usageExtendedQueryOptions,
} from "@/lib/admin-workbench";
import { currentUserQueryOptions } from "@/lib/auth/queries";

type DimensionKey =
  | "byProvider"
  | "byAgent"
  | "byScenario"
  | "byModel"
  | "byKind";

const DIMENSION_LABELS: Record<DimensionKey, string> = {
  byProvider: "按提供商",
  byAgent: "按机器人",
  byScenario: "按场景",
  byModel: "按模型",
  byKind: "按用途",
};

const RANGE_PRESETS = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const;

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "未收录单价";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

function formatMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

function DetailDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [events, setEvents] = useState<UsageDetailEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadMutation = useMutation({
    mutationFn: (before?: string) =>
      fetchUsageDetailPage({ limit: 50, ...(before ? { before } : {}) }),
    onSuccess: (page, before) => {
      setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
      setHasMore(page.hasMore);
      setLoaded(true);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next && !loaded && !loadMutation.isPending)
          loadMutation.mutate(undefined);
      }}
      open={open}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{"请求明细（metadata-only）"}</DialogTitle>
          <DialogDescription>
            {"只含元数据——本账本从不记录任何 prompt / 输入 / 输出内容。"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          {events.length === 0 && loadMutation.isPending ? (
            <PageSkeleton rows={3} />
          ) : events.length === 0 ? (
            <PageEmpty>{"窗口内没有用量事件。"}</PageEmpty>
          ) : (
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">时间</th>
                  <th className="py-1.5 text-left font-medium">场景/用途</th>
                  <th className="py-1.5 text-left font-medium">模型</th>
                  <th className="py-1.5 text-right font-medium">Token</th>
                  <th className="py-1.5 text-right font-medium">耗时</th>
                  <th className="py-1.5 text-left font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr className="border-b border-border/40" key={event.id}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {formatTime(event.createdAt)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {event.scenario || event.kind}
                      {event.agentId ? ` · ${event.agentId}` : ""}
                    </td>
                    <td className="py-1.5 pr-2">{event.modelId}</td>
                    <td className="py-1.5 pr-2 text-right">
                      {formatNumber(event.inputTokens + event.outputTokens)}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {formatMs(event.durationMs)}
                    </td>
                    <td className="py-1.5">
                      {event.status === "error" ? (
                        <span className="text-destructive">
                          {event.errorKind || "失败"}
                        </span>
                      ) : (
                        "成功"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {hasMore ? (
          <div className="flex justify-center pt-2">
            <Button
              disabled={loadMutation.isPending}
              onClick={() => {
                const last = events[events.length - 1];
                if (last) loadMutation.mutate(last.createdAt);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {loadMutation.isPending ? "加载中…" : "加载更多"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * CB-146 用量分析深化卡片：provider/agent/scenario/model/kind 维度分组 +
 * 失败率与耗时分布 + 成本估算 + metadata-only 明细 + 管理员 CSV 导出。
 */
export function UsageAnalyticsCard({
  settingItem,
}: {
  settingItem?: string;
} = {}) {
  const [days, setDays] = useState<number>(30);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const customRange = since.trim() !== "";
  const queryParams = customRange
    ? { since: since.trim(), ...(until.trim() ? { until: until.trim() } : {}) }
    : { days };
  const extendedQuery = useQuery(usageExtendedQueryOptions(queryParams));
  const [dimension, setDimension] = useState<DimensionKey>("byProvider");
  const [detailOpen, setDetailOpen] = useState(false);
  const isAdmin = useQuery(currentUserQueryOptions()).data?.role === "admin";

  const exportAction = useAsyncAction(() =>
    downloadUsageCsv(days).then(() => toast.success("CSV 已开始下载")),
  );

  const report = extendedQuery.data?.analytics ?? null;
  const window_ = extendedQuery.data?.window ?? null;
  const buckets: UsageAnalyticsBucket[] = report ? report[dimension] : [];

  return (
    <PageSection
      action={
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Button
              disabled={exportAction.state === "pending"}
              onClick={() => void exportAction.run()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconDownload className="size-3.5" />
              {"导出 CSV"}
            </Button>
          ) : null}
          <Button
            onClick={() => setDetailOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {"请求明细"}
          </Button>
          <Button
            disabled={extendedQuery.isFetching}
            onClick={() => void extendedQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh className="size-3.5" />
            {"刷新"}
          </Button>
        </div>
      }
      description="按提供商 / 机器人 / 场景 / 模型 / 用途维度分组，失败率与耗时分布，成本为内置单价表估算（未收录模型不计入并标注覆盖率）；明细与导出绝不包含任何 prompt / 输入 / 输出内容。"
      settingItem={settingItem}
      title="用量分析（维度 · 成本 · 失败率）"
    >
      <div className="space-y-4" data-testid="usage-analytics-card">
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((preset) => (
            <Button
              key={preset.days}
              onClick={() => {
                setDays(preset.days);
                setSince("");
                setUntil("");
              }}
              size="sm"
              type="button"
              variant={
                !customRange && days === preset.days ? "default" : "outline"
              }
            >
              {preset.label}
            </Button>
          ))}
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <label htmlFor="usage-analytics-since">自</label>
            <input
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              id="usage-analytics-since"
              onChange={(event) => setSince(event.target.value)}
              type="date"
              value={since}
            />
            <label htmlFor="usage-analytics-until">至</label>
            <input
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              id="usage-analytics-until"
              onChange={(event) => setUntil(event.target.value)}
              type="date"
              value={until}
            />
          </div>
        </div>

        {extendedQuery.isPending ? (
          <PageSkeleton rows={3} />
        ) : extendedQuery.error || !report ? (
          <ErrorCard
            description={
              extendedQuery.error?.message ?? "暂时无法加载用量分析数据。"
            }
            title="用量分析不可用"
          />
        ) : (
          <ContentEnter className="space-y-4" key={JSON.stringify(queryParams)}>
            <div className="text-muted-foreground text-xs tabular-nums">
              {`窗口事件 ${formatNumber(window_?.eventCount ?? 0)} 条`}
              {window_?.truncated ? "（已截断至最新 1 万条）" : ""}
              {report.summary.costUsd !== null
                ? ` · 成本估算覆盖 ${formatPercent(report.summary.costCoverage)} 请求`
                : ""}
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                delta={`共 ${formatNumber(report.summary.requests)} 次调用`}
                icon={<IconChartBar className="size-4" />}
                label="总 Token"
                value={formatNumber(
                  report.summary.inputTokens + report.summary.outputTokens,
                )}
              />
              <StatTile
                delta={`${formatNumber(report.summary.errors)} 次失败`}
                label="失败率"
                tone={report.summary.failureRate > 0.05 ? "warn" : undefined}
                value={formatPercent(report.summary.failureRate)}
              />
              <StatTile
                delta="内置单价表估算"
                label="成本估算"
                value={formatCost(report.summary.costUsd)}
              />
              <StatTile
                delta={`p95 ${formatMs(report.summary.latency.p95Ms)} · 峰值 ${formatMs(report.summary.latency.maxMs)}`}
                label="耗时 p50"
                value={formatMs(report.summary.latency.p50Ms)}
              />
            </div>

            <Card className="p-4 space-y-2.5">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(DIMENSION_LABELS) as DimensionKey[]).map(
                  (key) => (
                    <Button
                      key={key}
                      onClick={() => setDimension(key)}
                      size="sm"
                      type="button"
                      variant={dimension === key ? "default" : "outline"}
                    >
                      {DIMENSION_LABELS[key]}
                    </Button>
                  ),
                )}
              </div>
              {buckets.length === 0 ? (
                <PageEmpty>
                  {
                    "窗口内该维度没有用量事件——轻量单次调用（标题/审查/建议）目前不记账。"
                  }
                </PageEmpty>
              ) : (
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1.5 text-left font-medium">
                        {DIMENSION_LABELS[dimension].slice(1)}
                      </th>
                      <th className="py-1.5 text-right font-medium">调用</th>
                      <th className="py-1.5 text-right font-medium">失败</th>
                      <th className="py-1.5 text-right font-medium">Token</th>
                      <th className="py-1.5 text-right font-medium">
                        成本估算
                      </th>
                      <th className="py-1.5 text-right font-medium">均耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buckets.slice(0, 20).map((bucket) => (
                      <tr
                        className="border-b border-border/40"
                        key={bucket.key}
                      >
                        <td className="max-w-48 truncate py-1.5 pr-2">
                          {bucket.key}
                        </td>
                        <td className="py-1.5 text-right">
                          {formatNumber(bucket.requests)}
                        </td>
                        <td className="py-1.5 text-right">
                          {bucket.errors > 0 ? (
                            <span className="text-destructive">
                              {formatNumber(bucket.errors)}
                            </span>
                          ) : (
                            "0"
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          {formatNumber(
                            bucket.inputTokens + bucket.outputTokens,
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          {formatCost(bucket.costUsd)}
                        </td>
                        <td className="py-1.5 text-right">
                          {formatMs(bucket.avgDurationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </ContentEnter>
        )}
      </div>
      <DetailDialog onOpenChange={setDetailOpen} open={detailOpen} />
    </PageSection>
  );
}
