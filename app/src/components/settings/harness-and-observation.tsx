import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconChartBar,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { ContentEnter } from "@/components/ui/motion-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  ErrorCard,
  SettingRow,
  StatTile,
} from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  clearModelObservation,
  detectBrowserTimeZone,
  type HarnessFlagKey,
  harnessSettingsQueryOptions,
  modelObservationQueryOptions,
  saveHarnessSettings,
  toggleModelObservation,
  USAGE_KIND_LABELS,
  USAGE_KINDS,
  usageBreakdownQueryOptions,
  workbenchKeys,
} from "@/lib/admin-workbench";

type UsageWindowKey = "today" | "last7Days" | "last30Days";

const WINDOW_LABELS: Record<UsageWindowKey, string> = {
  today: "今日",
  last7Days: "近 7 天",
  last30Days: "近 30 天",
};

const COMMON_TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "UTC",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
] as const;

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 本地时区 + 按用途（kind）+ 思考 Token（reasoning）细分用量卡片。
 * 可独立挂载在「配额与用量」页以及「白盒调优工作台」。
 */
export function UsageBreakdownCard({
  settingItem,
}: {
  settingItem?: string;
} = {}) {
  const browserTz = detectBrowserTimeZone();
  const [timeZone, setTimeZone] = useState<string>(browserTz);
  const [windowKey, setWindowKey] = useState<UsageWindowKey>("today");
  const breakdownQuery = useQuery(usageBreakdownQueryOptions(timeZone));

  const tzOptions = COMMON_TIMEZONES.includes(
    browserTz as (typeof COMMON_TIMEZONES)[number],
  )
    ? [...COMMON_TIMEZONES]
    : [browserTz, ...COMMON_TIMEZONES];

  const activeWindow = breakdownQuery.data?.[windowKey];

  return (
    <PageSection
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(value) => {
              if (typeof value === "string" && value.trim()) {
                setTimeZone(value);
              }
            }}
            value={timeZone}
          >
            <SelectTrigger
              aria-label="统计时区"
              className="w-44"
              id="usage-breakdown-tz"
            >
              <SelectValue>{timeZone}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {tzOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={breakdownQuery.isFetching}
            onClick={() => void breakdownQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh className="size-3.5" />
            {"刷新"}
          </Button>
        </div>
      }
      description="按本地 IANA 时区切分自然日，单独拆解思考 Token（reasoning）与五类用途（对话 / 摘要 / 分类 / 审查 / 测试）。"
      settingItem={settingItem}
      title="本地时区与思考 Token 细分用量"
    >
      <div className="space-y-4" data-testid="usage-breakdown-card">
        <div className="flex flex-wrap gap-2">
          {(["today", "last7Days", "last30Days"] as const).map((key) => (
            <Button
              key={key}
              onClick={() => setWindowKey(key)}
              size="sm"
              type="button"
              variant={windowKey === key ? "default" : "outline"}
            >
              {WINDOW_LABELS[key]}
            </Button>
          ))}
        </div>

        {breakdownQuery.isPending ? (
          <PageSkeleton rows={3} />
        ) : breakdownQuery.error || !activeWindow ? (
          <ErrorCard
            description={
              breakdownQuery.error?.message ?? "暂时无法加载细分用量数据。"
            }
            title="细分用量账本不可用"
          />
        ) : (
          <ContentEnter className="space-y-4" key={windowKey}>
            <div className="text-muted-foreground text-xs tabular-nums">
              {`时区：${breakdownQuery.data.timeZone} · 窗口：${activeWindow.startDay} 至 ${activeWindow.endDay}`}
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                delta={`共 ${formatNumber(activeWindow.totals.requests)} 次调用`}
                icon={<IconChartBar className="size-4" />}
                label="总计 Token"
                value={formatNumber(activeWindow.totals.totalTokens)}
              />
              <StatTile
                label="输入 Token"
                value={formatNumber(activeWindow.totals.inputTokens)}
              />
              <StatTile
                label="输出 Token"
                value={formatNumber(activeWindow.totals.outputTokens)}
              />
              <StatTile
                delta="独立计量的深度思考开销"
                label="思考 Token"
                tone={
                  activeWindow.totals.reasoningTokens > 0 ? "warn" : undefined
                }
                value={formatNumber(activeWindow.totals.reasoningTokens)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-4 space-y-2.5">
                <div className="font-medium text-sm">
                  {"按用途（kind）拆分"}
                </div>
                <div className="space-y-1.5 text-xs">
                  {USAGE_KINDS.map((kind) => {
                    const bucket = activeWindow.byKind[kind];
                    return (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                        key={kind}
                      >
                        <div className="font-medium">
                          {USAGE_KIND_LABELS[kind]}
                          <span className="ml-1.5 font-mono text-muted-foreground">
                            {kind}
                          </span>
                        </div>
                        <div className="text-muted-foreground tabular-nums">
                          {`${formatNumber(bucket.totalTokens)} tok（思考 ${formatNumber(bucket.reasoningTokens)}）· ${bucket.requests} 次`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              <Card className="p-4 space-y-2.5">
                <div className="font-medium text-sm">{"按模型拆分"}</div>
                {activeWindow.byModel.length === 0 ? (
                  <PageEmpty>{"当前时间窗口暂无模型调用记录。"}</PageEmpty>
                ) : (
                  <div className="space-y-1.5 text-xs">
                    {activeWindow.byModel.map((row) => (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                        key={row.modelId}
                      >
                        <span className="truncate font-mono font-medium">
                          {row.modelId}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {`入 ${formatNumber(row.inputTokens)} / 出 ${formatNumber(row.outputTokens)} / 思 ${formatNumber(row.reasoningTokens)} · ${row.requests} 次`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </ContentEnter>
        )}
      </div>
    </PageSection>
  );
}

/**
 * Harness 7 项高影响 AI 能力热开关台 + 按需脱敏抓包观测器 + 本地时区细分用量总览。
 */
export function HarnessAndObservationPanel() {
  const queryClient = useQueryClient();
  const harnessQuery = useQuery(harnessSettingsQueryOptions());
  const observationQuery = useQuery(modelObservationQueryOptions());
  const [pendingKey, setPendingKey] = useState<HarnessFlagKey | null>(null);

  const toggleObservationAction = useAsyncAction(
    async () => {
      const nextEnabled = !(observationQuery.data?.enabled ?? false);
      const updated = await toggleModelObservation(nextEnabled);
      queryClient.setQueryData(workbenchKeys.observation, updated);
      toast.success(
        updated.enabled
          ? "已开启按需脱敏模型观测（环形缓冲 100 条）。"
          : "已关闭模型请求观测。",
      );
    },
    { errorToast: (error) => error.message },
  );

  const clearObservationAction = useAsyncAction(
    async () => {
      const updated = await clearModelObservation();
      queryClient.setQueryData(workbenchKeys.observation, updated);
      toast.success("已清空脱敏观测缓存。");
    },
    { errorToast: (error) => error.message },
  );

  async function handleToggleFlag(key: HarnessFlagKey, checked: boolean) {
    setPendingKey(key);
    try {
      const updated = await saveHarnessSettings({ [key]: checked });
      queryClient.setQueryData(workbenchKeys.harness, updated);
      toast.success("能力开关已实时生效。");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "能力开关保存失败。",
      );
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="space-y-8" data-testid="harness-and-observation">
      {/* Harness 7 项高影响 AI 能力开关台 */}
      <PageSection
        description="集中热控 7 项高影响 AI 能力开关，无需重启即可实时生效。"
        settingItem="workbench.harness-observation"
        title="Harness 能力开关台与脱敏观测"
      >
        <div className="space-y-6">
          <Card className="p-5 space-y-3" data-testid="harness-switches-card">
            <div className="flex items-center gap-2 font-medium text-sm">
              <IconAdjustmentsHorizontal className="size-4" />
              {"7 项内置高影响能力热开关"}
            </div>
            {harnessQuery.isPending ? (
              <PageSkeleton rows={4} />
            ) : harnessQuery.error || !harnessQuery.data ? (
              <ErrorCard
                description={
                  harnessQuery.error?.message ?? "无法读取 Harness 能力开关。"
                }
                title="能力开关暂时不可用"
              />
            ) : (
              <div className="divide-y">
                {harnessQuery.data.descriptors.map((descriptor) => {
                  const checked = harnessQuery.data.flags[descriptor.key];
                  return (
                    <div
                      className="py-3 first:pt-1 last:pb-1"
                      key={descriptor.key}
                    >
                      <SettingRow
                        description={descriptor.description}
                        title={
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span>{descriptor.title}</span>
                            {descriptor.consumesTokens ? (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 text-xs dark:text-amber-300">
                                {"消耗 Token"}
                              </span>
                            ) : null}
                          </span>
                        }
                      >
                        <Switch
                          aria-label={descriptor.title}
                          checked={checked}
                          disabled={pendingKey === descriptor.key}
                          onCheckedChange={(next) =>
                            void handleToggleFlag(descriptor.key, next)
                          }
                        />
                      </SettingRow>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 按需脱敏抓包观测器 */}
          <Card className="p-5 space-y-4" data-testid="model-observation-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 font-medium text-sm">
                  <IconActivity className="size-4" />
                  {"按需脱敏模型请求观测器"}
                  <span className="rounded border px-2 py-0.5 font-mono text-muted-foreground text-xs">
                    {`${observationQuery.data?.count ?? 0} / ${observationQuery.data?.capacity ?? 100}`}
                  </span>
                </div>
                <p className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
                  <IconShieldCheck className="size-3.5 shrink-0" />
                  {
                    "绝不记录 API Key、Authorization 或思维链原文；入参图片仅记录 SHA-256 摘要，环形缓冲最多保留 100 条。"
                  }
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  aria-label="开启脱敏模型观测"
                  checked={Boolean(observationQuery.data?.enabled)}
                  disabled={toggleObservationAction.state === "pending"}
                  onCheckedChange={() => void toggleObservationAction.run()}
                />
                <Button
                  disabled={observationQuery.isFetching}
                  onClick={() => void observationQuery.refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <IconRefresh className="size-3.5" />
                  {"刷新"}
                </Button>
                <Button
                  disabled={
                    clearObservationAction.state === "pending" ||
                    (observationQuery.data?.count ?? 0) === 0
                  }
                  onClick={() => void clearObservationAction.run()}
                  size="sm"
                  state={clearObservationAction.state}
                  type="button"
                  variant="outline"
                >
                  <IconTrash className="size-3.5" />
                  {"清空"}
                </Button>
              </div>
            </div>

            {observationQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : observationQuery.error || !observationQuery.data ? (
              <ErrorCard
                description={
                  observationQuery.error?.message ??
                  "无法读取模型脱敏观测记录。"
                }
                title="观测器数据不可用"
              />
            ) : observationQuery.data.items.length === 0 ? (
              <PageEmpty>
                {observationQuery.data.enabled
                  ? "观测器已开启，等待下一次模型调用写入脱敏记录。"
                  : "观测器当前已关闭（零开销）。需要排障时再手动开启即可。"}
              </PageEmpty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">{"时间"}</th>
                      <th className="py-2 pr-3 font-medium">{"模型 / 思考"}</th>
                      <th className="py-2 pr-3 font-medium">{"状态 / 耗时"}</th>
                      <th className="py-2 pr-3 font-medium">
                        {"工具 / 图片摘要"}
                      </th>
                      <th className="py-2 font-medium">{"脱敏摘要"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observationQuery.data.items.map((item) => (
                      <tr className="border-b last:border-b-0" key={item.id}>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground tabular-nums">
                          {formatDateTime(item.recordedAt)}
                        </td>
                        <td className="py-2.5 pr-3 font-mono">
                          <div>{item.model}</div>
                          <div className="text-muted-foreground">
                            {`${item.provider}${item.effort ? ` · ${item.effort}` : ""}`}
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums">
                          <div>{item.status ?? "ERR"}</div>
                          <div className="text-muted-foreground">
                            {`${item.durationMs} ms`}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          {item.tools.length > 0 ? (
                            <div className="font-mono">
                              {item.tools
                                .slice(0, 4)
                                .map((tool) =>
                                  tool.durationMs !== undefined
                                    ? `${tool.name}(${tool.durationMs}ms)`
                                    : tool.name,
                                )
                                .join(", ")}
                              {item.tools.length > 4
                                ? ` +${item.tools.length - 4}`
                                : ""}
                            </div>
                          ) : null}
                          {item.images.length > 0 ? (
                            <div className="font-mono text-muted-foreground">
                              {item.images
                                .map(
                                  (img) =>
                                    `img:${img.sha256.slice(0, 10)}(${img.bytes}B)`,
                                )
                                .join(" ")}
                            </div>
                          ) : null}
                          {item.tools.length === 0 && item.images.length === 0
                            ? "—"
                            : null}
                        </td>
                        <td className="max-w-xs truncate py-2.5">
                          {item.redactedSummary || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </PageSection>

      <UsageBreakdownCard />
    </div>
  );
}
