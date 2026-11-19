import {
  IconBrain,
  IconFlask,
  IconRefresh,
  IconRoute,
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, ErrorCard, SettingRow } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  type AdaptiveRoutingPolicy,
  type DryRunRoutingResult,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
  type ResolvedReasoningEffort,
  type RoutingDecisionSource,
  type RoutingEffortSetting,
  routingLogsQueryOptions,
  routingPolicyQueryOptions,
  runRoutingDryRun,
  saveRoutingPolicy,
  TASK_DIFFICULTIES,
  TASK_DIFFICULTY_LABELS,
  type TaskDifficulty,
  workbenchKeys,
} from "@/lib/admin-workbench";

const DEFAULT_EFFORT_OPTIONS: readonly ResolvedReasoningEffort[] = [
  "default",
  ...REASONING_EFFORTS,
];

const TIER_EFFORT_OPTIONS: readonly RoutingEffortSetting[] = [
  "auto",
  "default",
  ...REASONING_EFFORTS,
];

const SOURCE_LABELS: Record<RoutingDecisionSource, string> = {
  rule: "确定性规则",
  classifier: "轻量模型分类",
  manual: "手动固定",
  fallback: "故障降级规则",
};

function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

function RoutingPolicyForm({ current }: { current: AdaptiveRoutingPolicy }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdaptiveRoutingPolicy>(() =>
    structuredClone(current),
  );
  const [dryRunText, setDryRunText] = useState("");
  const [dryRunResult, setDryRunResult] = useState<DryRunRoutingResult | null>(
    null,
  );

  const logsQuery = useQuery(routingLogsQueryOptions({ limit: 50 }));

  const saveAction = useAsyncAction(
    async () => {
      const saved = await saveRoutingPolicy(draft);
      setDraft(structuredClone(saved));
      toast.success("自适应路由策略已保存，下一轮对话起生效。");
      await queryClient.invalidateQueries({
        queryKey: workbenchKeys.routingPolicy,
      });
    },
    { errorToast: (error) => error.message },
  );

  const dryRunAction = useAsyncAction(
    async () => {
      const trimmed = dryRunText.trim();
      if (!trimmed) {
        throw new Error("请先输入一段模拟用户提问再试跑。");
      }
      const result = await runRoutingDryRun({ text: trimmed, recordLog: true });
      setDryRunResult(result);
      await queryClient.invalidateQueries({
        queryKey: ["admin-workbench", "routing-logs"],
      });
    },
    { errorToast: (error) => error.message },
  );

  function updateTier(
    tier: TaskDifficulty,
    patch: Partial<{ model: string; effort: RoutingEffortSetting }>,
  ) {
    setDraft((prev) => ({
      ...prev,
      routes: {
        ...prev.routes,
        [tier]: {
          ...prev.routes[tier],
          ...patch,
        },
      },
    }));
  }

  return (
    <div className="space-y-6" data-testid="adaptive-routing-panel">
      <Card className="p-5 space-y-5">
        <div className="space-y-4">
          <SettingRow
            description="手动模式固定使用默认模型；自适应模式按任务难度自动匹配模型与思考预算（摘要会话自动跳过）。"
            title={
              <span className="inline-flex items-center gap-2">
                <IconRoute className="size-4" />
                {"路由模式"}
              </span>
            }
          >
            <Select
              onValueChange={(value) => {
                if (value === "manual" || value === "adaptive") {
                  setDraft((prev) => ({ ...prev, mode: value }));
                }
              }}
              value={draft.mode}
            >
              <SelectTrigger
                aria-label="路由模式"
                className="w-48"
                id="routing-mode-select"
              >
                <SelectValue>
                  {draft.mode === "adaptive"
                    ? "自适应难度路由"
                    : "手动固定模型"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">手动固定模型</SelectItem>
                <SelectItem value="adaptive">自适应难度路由</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            description="手动模式或未指定思考预算时使用的默认 reasoning_effort 档位。"
            title={
              <span className="inline-flex items-center gap-2">
                <IconBrain className="size-4" />
                {"默认思考强度"}
              </span>
            }
          >
            <Select
              onValueChange={(value) => {
                if (
                  DEFAULT_EFFORT_OPTIONS.includes(
                    value as ResolvedReasoningEffort,
                  )
                ) {
                  setDraft((prev) => ({
                    ...prev,
                    defaultEffort: value as ResolvedReasoningEffort,
                  }));
                }
              }}
              value={draft.defaultEffort}
            >
              <SelectTrigger
                aria-label="默认思考强度"
                className="w-48"
                id="routing-default-effort"
              >
                <SelectValue>
                  {REASONING_EFFORT_LABELS[draft.defaultEffort]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DEFAULT_EFFORT_OPTIONS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {REASONING_EFFORT_LABELS[effort]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            description="仅取最近 3 条用户纯文本，按 SHA-256 缓存；可选调用当前已配置通道中的轻量模型（10 秒超时失败自动降级规则且不缓存）。"
            title="难度分类方式"
          >
            <Select
              onValueChange={(value) => {
                if (value === "rule" || value === "model") {
                  setDraft((prev) => ({ ...prev, classifierMode: value }));
                }
              }}
              value={draft.classifierMode}
            >
              <SelectTrigger
                aria-label="难度分类方式"
                className="w-56"
                id="routing-classifier-mode"
              >
                <SelectValue>
                  {draft.classifierMode === "model"
                    ? "轻量模型分类（超时降级规则）"
                    : "零延迟确定性规则"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rule">零延迟确定性规则</SelectItem>
                <SelectItem value="model">
                  轻量模型分类（超时降级规则）
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          {draft.classifierMode === "model" ? (
            <label
              className="block space-y-1.5"
              htmlFor="routing-classifier-model"
            >
              <span className="font-medium text-sm">
                {
                  "轻量分类模型 ID（复用当前已配置模型通道，绝不直连外部专有服务）"
                }
              </span>
              <Input
                className="font-mono"
                id="routing-classifier-model"
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    classifierModel: event.target.value.trim() || null,
                  }))
                }
                placeholder="例如 gpt-4.1-mini / deepseek-chat / qwen3-8b"
                spellCheck={false}
                value={draft.classifierModel ?? ""}
              />
            </label>
          ) : null}
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="font-medium text-sm">
            {"难度档位 → 模型与思考强度映射"}
          </div>
          <div className="space-y-3">
            {TASK_DIFFICULTIES.map((tier) => {
              const meta = TASK_DIFFICULTY_LABELS[tier];
              const route = draft.routes[tier];
              const modelInputId = `routing-tier-model-${tier}`;
              const effortSelectId = `routing-tier-effort-${tier}`;
              return (
                <div
                  className="grid grid-cols-1 gap-3 rounded-xl border p-3.5 md:grid-cols-[1.2fr_1.5fr_1fr]"
                  key={tier}
                >
                  <div className="space-y-0.5">
                    <div className="font-medium text-sm">{meta.label}</div>
                    <div className="text-muted-foreground text-xs">
                      {meta.description}
                    </div>
                  </div>
                  <label className="space-y-1" htmlFor={modelInputId}>
                    <span className="text-muted-foreground text-xs">
                      {"目标模型 ID（留空沿用主模型）"}
                    </span>
                    <Input
                      className="font-mono text-xs"
                      id={modelInputId}
                      onChange={(event) =>
                        updateTier(tier, { model: event.target.value })
                      }
                      placeholder="留空沿用默认主模型"
                      spellCheck={false}
                      value={route.model}
                    />
                  </label>
                  <label className="space-y-1" htmlFor={effortSelectId}>
                    <span className="text-muted-foreground text-xs">
                      {"思考强度"}
                    </span>
                    <Select
                      onValueChange={(value) => {
                        if (
                          TIER_EFFORT_OPTIONS.includes(
                            value as RoutingEffortSetting,
                          )
                        ) {
                          updateTier(tier, {
                            effort: value as RoutingEffortSetting,
                          });
                        }
                      }}
                      value={route.effort}
                    >
                      <SelectTrigger className="w-full" id={effortSelectId}>
                        <SelectValue>
                          {REASONING_EFFORT_LABELS[route.effort]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TIER_EFFORT_OPTIONS.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {REASONING_EFFORT_LABELS[effort]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <span className="text-muted-foreground text-xs">
            {draft.updatedAt
              ? `上次保存：${formatDateTime(draft.updatedAt)}`
              : "当前使用默认策略，尚未手动保存。"}
          </span>
          <Button
            feedback="save"
            onClick={() => void saveAction.run()}
            state={saveAction.state}
            type="button"
          >
            {"保存路由策略"}
          </Button>
        </div>
      </Card>

      {/* Dry-Run 试跑器 */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-2 font-medium text-sm">
          <IconFlask className="size-4" />
          {"Dry-Run 路由试跑器"}
        </div>
        <label className="block space-y-1.5" htmlFor="routing-dry-run-input">
          <span className="text-muted-foreground text-xs">
            {
              "输入任意用户任务文本，即时验证难度判定、目标模型、思考预算与厂商参数映射（绝不发送系统提示词或图片）。"
            }
          </span>
          <Textarea
            id="routing-dry-run-input"
            onChange={(event) => setDryRunText(event.target.value)}
            placeholder="例如：请对分布式事务与状态机死锁路径做 BFS 穷举验证并给出架构改进方案…"
            rows={3}
            value={dryRunText}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!dryRunText.trim()}
            feedback="test"
            onClick={() => void dryRunAction.run()}
            state={dryRunAction.state}
            type="button"
            variant="outline"
          >
            {"立即试跑"}
          </Button>
          <Button
            onClick={() =>
              setDryRunText("你好，帮我把这句话翻译成英文：今天天气很好。")
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {"填入日常示例"}
          </Button>
          <Button
            onClick={() =>
              setDryRunText(
                "请做跨模块系统架构设计与分布式一致性状态机形式化验证，排查并发死锁根因。",
              )
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {"填入专家示例"}
          </Button>
        </div>

        {dryRunResult ? (
          <div
            className="rounded-xl border bg-muted/30 p-4 space-y-2 text-xs"
            data-testid="routing-dry-run-result"
          >
            <div className="flex flex-wrap items-center gap-2 font-medium text-sm">
              <span>{`难度：${TASK_DIFFICULTY_LABELS[dryRunResult.decision.difficulty].label}`}</span>
              <span>{"·"}</span>
              <span className="font-mono">
                {dryRunResult.decision.model || "默认主模型"}
              </span>
              <span>{"·"}</span>
              <span>{`思考：${REASONING_EFFORT_LABELS[dryRunResult.decision.effort]}`}</span>
              <span className="rounded bg-background px-2 py-0.5 text-muted-foreground text-xs">
                {`${SOURCE_LABELS[dryRunResult.decision.source]} · ${Math.round(dryRunResult.decision.confidence * 100)}% · ${dryRunResult.decision.elapsedMs} ms`}
              </span>
            </div>
            <p className="text-muted-foreground">
              {dryRunResult.ruleSignals.reason}
            </p>
            <div className="font-mono text-muted-foreground">
              {`SHA-256: ${dryRunResult.inputHash.slice(0, 16)} · 厂商参数: ${JSON.stringify(dryRunResult.decision.providerParams)}`}
            </div>
            {dryRunResult.decision.fallbackReason ? (
              <p className="text-destructive">
                {`降级原因：${dryRunResult.decision.fallbackReason}`}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* 30 天路由决策日志 */}
      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium text-sm">{"近 30 天路由决策日志"}</div>
            <p className="text-muted-foreground text-xs">
              {
                "仅记录脱敏摘要、难度、命中模型、思考强度、决策来源与耗时；超过 30 天自动清理。"
              }
            </p>
          </div>
          <Button
            disabled={logsQuery.isFetching}
            onClick={() => void logsQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh className="size-3.5" />
            {"刷新"}
          </Button>
        </div>

        {logsQuery.isPending ? (
          <PageSkeleton rows={3} />
        ) : logsQuery.error ? (
          <ErrorCard
            description={logsQuery.error.message}
            title="无法读取路由决策日志"
          />
        ) : (logsQuery.data?.items.length ?? 0) === 0 ? (
          <PageEmpty>
            {"暂无路由决策记录，可先使用上方 Dry-Run 试跑器测试。"}
          </PageEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{"时间"}</th>
                  <th className="py-2 pr-3 font-medium">{"难度"}</th>
                  <th className="py-2 pr-3 font-medium">{"命中模型"}</th>
                  <th className="py-2 pr-3 font-medium">{"思考强度"}</th>
                  <th className="py-2 pr-3 font-medium">{"来源 / 耗时"}</th>
                  <th className="py-2 font-medium">{"脱敏摘要"}</th>
                </tr>
              </thead>
              <tbody>
                {(logsQuery.data?.items ?? []).map((entry) => (
                  <tr className="border-b last:border-b-0" key={entry.id}>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground tabular-nums">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 font-medium">
                      {entry.difficulty}
                      {entry.dryRun ? " (试跑)" : ""}
                    </td>
                    <td className="py-2.5 pr-3 font-mono">{entry.model}</td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      {REASONING_EFFORT_LABELS[entry.effort]}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      {`${SOURCE_LABELS[entry.source]} · ${Math.round(entry.confidence * 100)}% · ${entry.elapsedMs}ms`}
                    </td>
                    <td className="max-w-xs truncate py-2.5">
                      <div>{entry.taskSummary || "—"}</div>
                      {entry.fallbackReason ? (
                        <div className="text-destructive">
                          {`降级：${entry.fallbackReason}`}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export function AdaptiveRoutingPanel() {
  const policyQuery = useQuery(routingPolicyQueryOptions());

  return (
    <PageSection
      description="按日常 / 推理 / 专家三档任务自动匹配模型与 6 档思考预算，提供 Dry-Run 试跑器与 30 天可审计路由日志。"
      settingItem="workbench.adaptive-routing"
      title="自适应难度路由与思考预算"
    >
      {policyQuery.isPending ? (
        <PageSkeleton rows={4} />
      ) : policyQuery.error || !policyQuery.data ? (
        <ErrorCard
          action={
            <Button
              onClick={() => void policyQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={policyQuery.error?.message ?? "无法加载自适应路由策略。"}
          title="自适应路由策略暂时不可用"
        />
      ) : (
        <RoutingPolicyForm
          current={policyQuery.data}
          key={policyQuery.data.updatedAt ?? "initial"}
        />
      )}
    </PageSection>
  );
}
