import {
  IconChevronRight,
  IconFlask,
  IconRefresh,
  IconRoute,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ErrorCard } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  dryRunScenarioMutationOptions,
  saveScenarioRoutingMutationOptions,
} from "@/lib/scenario-routing/mutations";
import {
  scenarioRouteLogsQueryOptions,
  scenarioRoutingConfigQueryOptions,
} from "@/lib/scenario-routing/queries";
import {
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
  type RoutingEffortSetting,
} from "../../../../shared/model-routing";
import {
  defaultScenarioRoute,
  MODEL_SCENARIO_LABELS,
  MODEL_SCENARIOS,
  type ModelScenario,
  type ModelScenarioRoutingConfig,
  type ScenarioDryRunResult,
  type ScenarioRoute,
  type ScenarioRouteEvent,
  scenarioRouteOverrides,
  validateScenarioRoutingConfig,
} from "../../../../shared/model-scenario-routing";

const EFFORT_OPTIONS: readonly RoutingEffortSetting[] = [
  "default",
  "auto",
  ...REASONING_EFFORTS,
];

/** useAdaptive 只对链式语义的消费方有意义（契约文档）。 */
const ADAPTIVE_SCENARIOS = new Set<ModelScenario>([
  "chat",
  "summarization",
  "subagent",
]);

const OUTCOME_LABELS: Record<ScenarioRouteEvent["outcome"], string> = {
  inherited: "继承",
  resolved: "命中",
  fallback: "降级接管",
  failed: "失败",
};

function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

function cloneConfig(config: ModelScenarioRoutingConfig) {
  return structuredClone({
    version: 1 as const,
    scenarios: config.scenarios,
  });
}

function ScenarioEditorDialog({
  scenario,
  draft,
  onChange,
  onClose,
}: {
  scenario: ModelScenario | null;
  draft: ModelScenarioRoutingConfig;
  onChange: (scenario: ModelScenario, route: ScenarioRoute | null) => void;
  onClose: () => void;
}) {
  if (!scenario) return null;
  const meta = MODEL_SCENARIO_LABELS[scenario];
  const route = draft.scenarios[scenario] ?? defaultScenarioRoute();
  const overrides = scenarioRouteOverrides(route);

  function patch(partial: Partial<ScenarioRoute>) {
    if (!scenario) return;
    onChange(scenario, { ...route, ...partial });
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{meta.label}</DialogTitle>
          <DialogDescription>
            {meta.description}
            {"；所有字段留空 / 继承时行为与未配置完全一致。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="block space-y-1.5" htmlFor="scenario-model">
            <span className="font-medium text-sm">
              {"主模型 ID（留空继承当前默认解析链）"}
            </span>
            <Input
              className="font-mono"
              id="scenario-model"
              onChange={(event) => patch({ model: event.target.value.trim() })}
              placeholder="例如 deepseek/deepseek-chat"
              spellCheck={false}
              value={route.model}
            />
          </label>
          <label className="block space-y-1.5" htmlFor="scenario-fallbacks">
            <span className="font-medium text-sm">
              {
                "备用模型链（每行一个，最多 8 个；只要有一行就整体替代全局备用链）"
              }
            </span>
            <Textarea
              className="font-mono text-xs"
              id="scenario-fallbacks"
              onChange={(event) =>
                patch({
                  fallbacks: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 8),
                })
              }
              placeholder="留空继承全局备用链"
              rows={3}
              spellCheck={false}
              value={route.fallbacks.join("\n")}
            />
          </label>
          <label className="block space-y-1.5" htmlFor="scenario-effort">
            <span className="font-medium text-sm">{"思考强度"}</span>
            <Select
              onValueChange={(value) =>
                patch({ effort: value as RoutingEffortSetting })
              }
              value={route.effort}
            >
              <SelectTrigger className="w-full" id="scenario-effort">
                <SelectValue>
                  {REASONING_EFFORT_LABELS[route.effort] ?? route.effort}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {REASONING_EFFORT_LABELS[effort] ?? effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5" htmlFor="scenario-timeout">
              <span className="font-medium text-sm">
                {"超时 ms（空 = 不覆盖）"}
              </span>
              <Input
                id="scenario-timeout"
                inputMode="numeric"
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const value = Number(raw);
                  patch({
                    timeoutMs:
                      raw && Number.isFinite(value) ? Math.round(value) : null,
                  });
                }}
                placeholder="1000–600000"
                spellCheck={false}
                value={route.timeoutMs === null ? "" : String(route.timeoutMs)}
              />
            </label>
            <label className="block space-y-1.5" htmlFor="scenario-maxtokens">
              <span className="font-medium text-sm">
                {"输出上限（空 = 不覆盖）"}
              </span>
              <Input
                id="scenario-maxtokens"
                inputMode="numeric"
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const value = Number(raw);
                  patch({
                    maxTokens:
                      raw && Number.isFinite(value) ? Math.round(value) : null,
                  });
                }}
                placeholder="1–200000"
                spellCheck={false}
                value={route.maxTokens === null ? "" : String(route.maxTokens)}
              />
            </label>
          </div>
          {ADAPTIVE_SCENARIOS.has(scenario) ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <div className="space-y-0.5">
                <div className="font-medium text-sm">
                  {"场景内仍走自适应难度路由"}
                </div>
                <div className="text-muted-foreground text-xs">
                  {"关掉后链首直接是场景主模型，不再做难度分类。"}
                </div>
              </div>
              <Switch
                aria-label="场景内仍走自适应难度路由"
                checked={route.useAdaptive}
                onCheckedChange={(checked) => patch({ useAdaptive: checked })}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter className="mt-2">
          <Button
            disabled={!overrides.length}
            onClick={() => {
              onChange(scenario, null);
              onClose();
            }}
            size="sm"
            variant="ghost"
          >
            {"清空全部覆盖"}
          </Button>
          <Button onClick={onClose} size="sm">
            {"完成"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DryRunResultView({ result }: { result: ScenarioDryRunResult }) {
  return (
    <div
      className="space-y-3 rounded-xl border bg-muted/30 p-4"
      data-testid="scenario-dry-run-result"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{"决议链"}</span>
        <span className="font-mono text-xs">
          {result.chain.join("  →  ") || "（空）"}
        </span>
      </div>
      <div className="grid gap-1 text-muted-foreground text-xs sm:grid-cols-2">
        <div>
          {"接线状态："}
          {result.wiringNote}
        </div>
        <div>
          {"思考强度："}
          {result.effort}
        </div>
        {result.timeoutMs !== null ? (
          <div>
            {"超时覆盖："}
            {result.timeoutMs}
            {"ms"}
          </div>
        ) : null}
        {result.maxTokens !== null ? (
          <div>
            {"输出上限覆盖："}
            {result.maxTokens}
          </div>
        ) : null}
      </div>
      <div className="space-y-1 border-t pt-2">
        {result.trace.map((line) => (
          <div className="text-muted-foreground text-xs" key={line}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function ScenarioRoutingForm({
  current,
}: {
  current: ModelScenarioRoutingConfig;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => cloneConfig(current));
  const [editing, setEditing] = useState<ModelScenario | null>(null);
  const [dryRunScenario, setDryRunScenario] = useState<ModelScenario>("chat");
  const [logScenario, setLogScenario] = useState<ModelScenario | "all">("all");

  const save = useMutation(saveScenarioRoutingMutationOptions(queryClient));
  const dryRun = useMutation(dryRunScenarioMutationOptions());
  const logs = useQuery(
    scenarioRouteLogsQueryOptions({
      scenario: logScenario === "all" ? null : logScenario,
      limit: 50,
    }),
  );

  const dirty =
    JSON.stringify(draft.scenarios) !== JSON.stringify(current.scenarios);

  function updateRoute(scenario: ModelScenario, route: ScenarioRoute | null) {
    setDraft((prev) => {
      const scenarios = { ...prev.scenarios };
      if (route === null || scenarioRouteOverrides(route).length === 0) {
        delete scenarios[scenario];
      } else {
        scenarios[scenario] = route;
      }
      return { ...prev, scenarios };
    });
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-muted-foreground text-sm">
            {dirty
              ? "有未保存的修改——保存前可以用下方 Dry-run 先试跑这份草稿。"
              : "配置与线上一致；空配置 = 全部场景继承当前行为。"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={!dirty || save.isPending}
              onClick={() => setDraft(cloneConfig(current))}
              size="sm"
              variant="ghost"
            >
              {"放弃修改"}
            </Button>
            <Button
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate(draft, {
                  onSuccess: () =>
                    toast.success("场景路由配置已保存，下一轮对话起生效。"),
                  onError: (error) => toast.error(error.message),
                })
              }
              size="sm"
            >
              {save.isPending ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
        <PageRows>
          {MODEL_SCENARIOS.map((scenario, index) => {
            const meta = MODEL_SCENARIO_LABELS[scenario];
            const route = draft.scenarios[scenario];
            const overrides = route ? scenarioRouteOverrides(route) : [];
            return (
              <div key={scenario}>
                {index > 0 ? <Separator /> : null}
                <Item
                  data-testid={`scenario-row-${scenario}`}
                  onClick={() => setEditing(scenario)}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{meta.label}</ItemTitle>
                    <ItemDescription>
                      {overrides.length
                        ? `覆盖 ${overrides.length} 项：${overrides.join(" / ")}${route?.model ? `，主模型 ${route.model}` : ""}`
                        : "全部继承默认行为"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 font-medium text-sm">
          <IconFlask className="size-4" />
          {"Dry-run 试跑（用当前草稿，不保存、不调用任何模型）"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(value) => setDryRunScenario(value as ModelScenario)}
            value={dryRunScenario}
          >
            <SelectTrigger aria-label="试跑场景" className="w-64">
              <SelectValue>
                {MODEL_SCENARIO_LABELS[dryRunScenario].label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MODEL_SCENARIOS.map((scenario) => (
                <SelectItem key={scenario} value={scenario}>
                  {MODEL_SCENARIO_LABELS[scenario].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={dryRun.isPending}
            onClick={() => {
              let config: ModelScenarioRoutingConfig;
              try {
                config = validateScenarioRoutingConfig(draft);
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "草稿配置非法。",
                );
                return;
              }
              dryRun.mutate(
                { scenario: dryRunScenario, config },
                { onError: (error) => toast.error(error.message) },
              );
            }}
            size="sm"
            variant="outline"
          >
            {dryRun.isPending ? "试跑中…" : "试跑"}
          </Button>
        </div>
        {dryRun.data ? <DryRunResultView result={dryRun.data} /> : null}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium text-sm">
            {"决策日志（30 天保留；只记有覆盖生效、降级或失败的事件）"}
          </div>
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(value) =>
                setLogScenario(value as ModelScenario | "all")
              }
              value={logScenario}
            >
              <SelectTrigger aria-label="日志场景过滤" className="w-52">
                <SelectValue>{"全部场景"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{"全部场景"}</SelectItem>
                {MODEL_SCENARIOS.map((scenario) => (
                  <SelectItem key={scenario} value={scenario}>
                    {MODEL_SCENARIO_LABELS[scenario].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={logs.isFetching}
              onClick={() => void logs.refetch()}
              size="sm"
              variant="ghost"
            >
              <IconRefresh className="size-4" />
              {"刷新"}
            </Button>
          </div>
        </div>
        {logs.isPending ? (
          <PageSkeleton rows={3} />
        ) : logs.error ? (
          <ErrorCard
            description={logs.error.message}
            title="决策日志暂时不可用"
          />
        ) : !logs.data?.items.length ? (
          <PageEmpty>
            {
              "还没有决策事件。配置了场景覆盖或跑一次 Dry-run 后，这里会出现记录。"
            }
          </PageEmpty>
        ) : (
          <div className="space-y-2">
            {logs.data.items.map((event) => (
              <div
                className="rounded-xl border px-3.5 py-2.5 text-xs"
                key={event.id}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-muted-foreground">
                    {formatDateTime(event.createdAt)}
                  </span>
                  <span className="font-medium">
                    {MODEL_SCENARIO_LABELS[event.scenario]?.label ??
                      event.scenario}
                  </span>
                  <span>{OUTCOME_LABELS[event.outcome]}</span>
                  {event.dryRun ? (
                    <span className="rounded bg-muted px-1.5 py-0.5">
                      {"试跑"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-muted-foreground">
                  {event.chain.join(" → ") || "（空链）"}
                  {event.chosenModel ? `　命中 ${event.chosenModel}` : ""}
                </div>
                {event.detail ? (
                  <div className="mt-1 text-muted-foreground">
                    {event.detail}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <ScenarioEditorDialog
          draft={draft}
          onChange={updateRoute}
          onClose={() => setEditing(null)}
          scenario={editing}
        />
      ) : null}
    </div>
  );
}

/**
 * 场景化模型路由面板（PR3）：十一个场景的覆盖编辑、用当前草稿做 Dry-run 试跑、
 * 30 天决策日志。挂载在白盒调优工作台，与自适应难度路由面板并列——那边管「难度怎么分」，
 * 这边管「场景怎么选」。
 */
export function ScenarioRoutingPanel() {
  const configQuery = useQuery(scenarioRoutingConfigQueryOptions());

  return (
    <PageSection
      description="聊天、审批审查、标题、摘要、图像理解等十一个场景各自独立指定主模型、备用链、思考强度与输出上限；空配置与升级前完全一致。"
      settingItem="workbench.scenario-routing"
      title="场景化模型路由"
    >
      {configQuery.isPending ? (
        <PageSkeleton rows={4} />
      ) : configQuery.error || !configQuery.data ? (
        <ErrorCard
          action={
            <Button
              onClick={() => void configQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={configQuery.error?.message ?? "无法加载场景路由配置。"}
          title="场景路由配置暂时不可用"
        />
      ) : (
        <ScenarioRoutingForm
          current={configQuery.data}
          key={configQuery.data.updatedAt ?? "initial"}
        />
      )}
    </PageSection>
  );
}
