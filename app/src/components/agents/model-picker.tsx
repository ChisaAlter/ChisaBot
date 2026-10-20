import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { IconCheck, IconChevronDown, IconRefresh, IconSearch, IconSparkles } from "@tabler/icons-react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ModelCatalog, ModelCatalogEntry } from "../../../../shared/model-selection";
import { useModelSelectionSaving, useModelSelectionSync } from "@/lib/model-selection/hooks";
import { refreshModelsMutationOptions, saveAgentModelMutationOptions } from "@/lib/model-selection/mutations";
import { agentModelQueryOptions, modelCatalogQueryOptions, modelSelectionKeys } from "@/lib/model-selection/queries";
import { cn } from "@/lib/utils";
import { FEEDBACK_PRESETS, useMutationFeedback } from "@/components/ui/async-action";
import { AsyncContent } from "@/components/ui/button";

type Option = ModelCatalogEntry & { missing?: boolean; inherited?: boolean };
type Health = "ok" | "bad" | "off" | "unknown";
type Group = { value: string; label: string; items: Option[]; health?: Health };

/** Gateway readiness of a provider: Magpie's own "ready" flag, when the catalog carries it. */
function healthOf(provider: string, catalog: ModelCatalog | undefined): Health {
  const row = catalog?.providers?.find((item) => item.id === provider);
  if (!row) return "unknown";
  if (!row.enabled) return "off";
  return row.ready ? "ok" : "bad";
}
const HEALTH_TEXT: Record<Health, string> = { ok: "提供方就绪", bad: "提供方未就绪", off: "提供方已停用", unknown: "提供方状态未知" };

/** A small status light; shared by the picker and 管理后台 → 模型平台 Magpie. */
export function HealthDot({ health }: { health: Health }) {
  if (health === "unknown") return null;
  return <span aria-label={HEALTH_TEXT[health]} className={`model-health-dot is-${health}`} role="img" title={HEALTH_TEXT[health]} />;
}

/** A model id's last path segment, which is what a person recognises ("mimo-v2.6-flash-free"). */
function tailOf(id: string) {
  return id.slice(id.lastIndexOf("/") + 1) || id;
}

/** The name a pill can afford: the catalog label when it has one, otherwise the id's tail. */
function shortName(id: string, models: readonly ModelCatalogEntry[]) {
  const entry = models.find((model) => model.id === id);
  if (entry && entry.label && entry.label !== entry.id) return entry.label;
  return tailOf(id);
}

function providerOf(id: string, models: readonly ModelCatalogEntry[]) {
  return models.find((model) => model.id === id)?.provider || (id.includes("/") ? id.slice(0, id.indexOf("/")) : "");
}

const PROVIDER_HUES = [212, 262, 168, 28, 330, 190, 140, 0];
function hueOf(provider: string) {
  let hash = 0;
  for (const char of provider) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROVIDER_HUES[hash % PROVIDER_HUES.length];
}

/** A provider's initial on a soft tinted disc — the "icon" without shipping a logo per vendor. */
export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  if (!provider) {
    return (
      <span className={cn("model-provider-mark", className)} style={{ "--mark-hue": 212 } as React.CSSProperties}>
        <IconSparkles className="size-3" />
      </span>
    );
  }
  return (
    <span className={cn("model-provider-mark", className)} style={{ "--mark-hue": hueOf(provider) } as React.CSSProperties}>
      {provider.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The composer's model control (right side of the toolbar, next to the context ring; DESIGN.md §25):
 * one short pill — provider mark, truncated name, chevron; no 「默认」 badge on the trigger — that opens a frosted popover listing the BOT's
 * models grouped by provider, with search, the deployment default, and the catalog refresh. It
 * edits the same per-BOT saved model as the full `BotModelSelector` used in settings.
 */
export function ModelPicker({ agentId, disabled = false }: { agentId: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const state = useQuery(agentModelQueryOptions(agentId));
  const catalog = useQuery(modelCatalogQueryOptions());
  const save = useMutation(saveAgentModelMutationOptions(queryClient, agentId));
  const refresh = useMutation(refreshModelsMutationOptions(queryClient));
  const refreshState = useMutationFeedback(refresh);
  const saving = useModelSelectionSaving(agentId);
  const refreshing = useIsMutating({ mutationKey: modelSelectionKeys.refresh }) > 0;
  const [open, setOpen] = useState(false);
  useModelSelectionSync();

  const models = catalog.data?.models ?? [];
  const groups = useMemo((): Group[] => {
    if (!state.data) return [];
    const result: Group[] = [];
    const head: Option[] = [{ id: "", label: "部署默认", provider: "", inherited: true }];
    if (state.data.overrideModel && !models.some((item) => item.id === state.data?.overrideModel)) {
      head.push({ id: state.data.overrideModel, label: state.data.overrideModel, provider: "", missing: true });
    }
    result.push({ value: "__default", label: "默认", items: head });
    const byProvider = new Map<string, Option[]>();
    const names = new Map<string, string>();
    for (const model of models) {
      const key = model.provider || "其他";
      byProvider.set(key, [...(byProvider.get(key) ?? []), model]);
      if (model.providerName && !names.has(key)) names.set(key, model.providerName);
    }
    for (const [provider, items] of byProvider)
      result.push({ value: provider, label: names.get(provider) ?? provider, items, health: healthOf(provider, catalog.data) });
    return result;
  }, [models, state.data, catalog.data]);

  const allOptions = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selected = allOptions.find((item) => item.id === (state.data?.overrideModel ?? "")) ?? null;

  if (state.isPending) {
    return <span aria-label="正在加载模型" className="model-pill model-pill-loading" role="status"><span className="model-pill-shimmer" /></span>;
  }
  if (!state.data) {
    return (
      <button className="model-pill model-pill-warn" onClick={() => void state.refetch()} title={state.error?.message ?? "无法加载模型设置"} type="button">
        <span className="truncate">模型加载失败 · 重试</span>
      </button>
    );
  }
  if (!state.data.available) {
    return <span className="model-pill model-pill-static" title="此外部 BOT 的模型由其服务管理。"><ProviderMark provider="" /><span className="truncate">外部 BOT</span></span>;
  }

  const effective = state.data.model;
  const effectiveProvider = providerOf(effective, models);
  const modelMissing = Boolean(catalog.data && !models.some((item) => item.id === effective));
  const locked = disabled || saving || !state.data.canManage || !catalog.data;
  const error = save.error?.message ?? refresh.error?.message ?? catalog.error?.message;
  const pillTitle = [
    state.data.overrideModel ? effective : `部署默认 · ${state.data.defaultModel}`,
    !state.data.canManage ? "只有此 BOT 的拥有者或管理员可以更改模型" : "",
    modelMissing ? "当前模型已不可用，请重新选择" : "",
  ].filter(Boolean).join("\n");

  return (
    <ComboboxPrimitive.Root
      items={groups}
      value={selected}
      open={open}
      onOpenChange={setOpen}
      itemToStringLabel={(item: Option) => (item.inherited ? `部署默认 ${state.data?.defaultModel ?? ""}` : `${item.label} ${item.id} ${item.provider}`)}
      itemToStringValue={(item: Option) => item.id}
      isItemEqualToValue={(item: Option, value: Option) => item.id === value.id}
      disabled={locked}
      onValueChange={(next: Option | null) => {
        if (!next || next.missing || next.id === (state.data?.overrideModel ?? "")) return;
        if (queryClient.isMutating({ mutationKey: modelSelectionKeys.save(agentId) }) > 0) return;
        save.mutate(next.id || null);
        setOpen(false);
      }}
    >
      <ComboboxPrimitive.Trigger
        aria-label="模型选择"
        className={cn("model-pill", modelMissing && "model-pill-warn", saving && "model-pill-busy")}
        title={pillTitle}
        type="button"
      >
        <ProviderMark provider={effectiveProvider} />
        <span className="model-pill-name truncate">{shortName(effective, models)}</span>
        {/*
          被下线的模型要一眼看得出来（2026-10-20）：以前只有颜色和 tooltip，发送照样失败。
          现在药丸上直接写「已失效」，配合发送前的拦截。
        */}
        {modelMissing ? <span className="model-pill-tag">已失效</span> : null}
        {healthOf(effectiveProvider, catalog.data) === "bad" ? <HealthDot health="bad" /> : null}
        {saving ? <IconRefresh className="size-3 shrink-0 animate-spin opacity-60" /> : <IconChevronDown className="model-pill-chevron" />}
      </ComboboxPrimitive.Trigger>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner align="end" className="isolate z-50" side="top" sideOffset={8}>
          <ComboboxPrimitive.Popup className="model-popover">
            <div className="model-popover-search">
              <IconSearch className="size-4 shrink-0 opacity-50" />
              <ComboboxPrimitive.Input aria-label="搜索模型" className="model-popover-input" placeholder="搜索模型或提供方…" />
            </div>
            <ComboboxPrimitive.Empty className="model-popover-empty">没有匹配的模型</ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="model-popover-list">
              {(group: Group) => (
                <ComboboxPrimitive.Group className="model-popover-group" items={group.items} key={group.value}>
                  <ComboboxPrimitive.GroupLabel className="model-popover-label">
                    {group.value === "__default" ? group.label : <><ProviderMark className="model-provider-mark-sm" provider={group.value} /><span className="truncate">{group.label}</span>{group.health ? <HealthDot health={group.health} /> : null}{group.label !== group.value ? <span className="model-popover-label-id">{group.value}</span> : null}</>}
                  </ComboboxPrimitive.GroupLabel>
                  <ComboboxPrimitive.Collection>
                    {(item: Option) => (
                      <ComboboxPrimitive.Item className="model-popover-item" disabled={item.missing} key={item.id || "__inherit"} value={item}>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{item.inherited ? "部署默认" : item.missing ? tailOf(item.id) : item.label || tailOf(item.id)}</span>
                            {/* 「默认」标签从输入框的按钮挪到这里：标出部署默认指向的那个模型。 */}
                            {!item.inherited && !item.missing && item.id && item.id === state.data?.defaultModel ? <span className="model-pill-tag">默认</span> : null}
                          </span>
                          <span className="model-popover-sub truncate">
                            {item.inherited ? state.data?.defaultModel : item.missing ? "已不在模型列表中" : item.id}
                          </span>
                        </span>
                        <ComboboxPrimitive.ItemIndicator className="model-popover-check">
                          <IconCheck className="size-4" />
                        </ComboboxPrimitive.ItemIndicator>
                      </ComboboxPrimitive.Item>
                    )}
                  </ComboboxPrimitive.Collection>
                </ComboboxPrimitive.Group>
              )}
            </ComboboxPrimitive.List>
            <div className="model-popover-footer">
              <span className="truncate">{error ? <span className="text-destructive">{error}</span> : catalog.data ? `${catalog.data.source === "magpie" ? "Magpie · " : ""}共 ${models.length} 个模型${catalog.data.stale ? " · 网关暂不可用，显示上次列表" : " · 下一轮生效"}` : "正在加载模型列表…"}</span>
              <button
                aria-busy={refreshState === "pending" || undefined}
                className="model-popover-refresh async-raw"
                data-btn-state={refreshState}
                disabled={saving || refreshing}
                onClick={() => refresh.mutate()}
                title="刷新 Magpie 模型列表"
                type="button"
              >
                <AsyncContent labels={FEEDBACK_PRESETS.refresh} state={refreshState}>
                  <IconRefresh className="size-3.5" />
                  {"刷新"}
                </AsyncContent>
              </button>
            </div>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
