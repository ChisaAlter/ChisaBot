import { IconRefresh } from "@tabler/icons-react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useMemo } from "react";
import type { ModelCatalogEntry } from "../../../../shared/model-selection";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "@/components/ui/combobox";
import { useModelSelectionSaving, useModelSelectionSync } from "@/lib/model-selection/hooks";
import { refreshModelsMutationOptions, saveAgentModelMutationOptions } from "@/lib/model-selection/mutations";
import { agentModelQueryOptions, modelCatalogQueryOptions, modelSelectionKeys } from "@/lib/model-selection/queries";
import { ModelPicker } from "@/components/agents/model-picker";

type ModelOption = ModelCatalogEntry & { missing?: boolean };
const labelOf = (option: ModelOption) => !option.id ? option.label : option.label === option.id ? option.id : `${option.label} · ${option.id}`;

/**
 * Chat and settings both edit this BOT's one saved model; no connection credential reaches here.
 * `compact` is the composer's pill + popover (`ModelPicker`); the full row is for settings screens.
 */
function BotModelSelectorImpl({ agentId, compact = false, disabled = false, bare = false }: { agentId: string; compact?: boolean; disabled?: boolean; /** 只要选择框（资料页的设置行自己有标题和说明，DESIGN.md §47）。 */ bare?: boolean }) {
  if (compact) return <ModelPicker agentId={agentId} disabled={disabled} />;
  return <BotModelSettingsRow agentId={agentId} bare={bare} disabled={disabled} />;
}

function BotModelSettingsRow({ agentId, disabled = false, bare = false }: { agentId: string; disabled?: boolean; bare?: boolean }) {
  const compact = false;
  const queryClient = useQueryClient();
  const state = useQuery(agentModelQueryOptions(agentId));
  const catalog = useQuery(modelCatalogQueryOptions());
  const save = useMutation(saveAgentModelMutationOptions(queryClient, agentId));
  const refresh = useMutation(refreshModelsMutationOptions(queryClient));
  const saving = useModelSelectionSaving(agentId);
  const refreshing = useIsMutating({ mutationKey: modelSelectionKeys.refresh }) > 0;
  useModelSelectionSync();
  const options = useMemo((): ModelOption[] => {
    const models: ModelOption[] = catalog.data?.models ?? [];
    if (!state.data) return models;
    // 部署默认那一项显示模型的名字（目录里的 label），不是原始 id（C8，DESIGN.md §71.4）。
    const defaultName = models.find((item) => item.id === state.data?.defaultModel)?.label || state.data.defaultModel;
    const inherited: ModelOption = { id: "", label: `部署默认（${defaultName}）`, provider: "" };
    if (state.data.overrideModel && !models.some((item) => item.id === state.data?.overrideModel)) {
      return [inherited, { id: state.data.overrideModel, label: state.data.overrideModel, provider: "", missing: true }, ...models];
    }
    return [inherited, ...models];
  }, [catalog.data, state.data]);
  const selected = options.find((item) => item.id === (state.data?.overrideModel ?? "")) ?? null;
  const selectedLabel = selected ? labelOf(selected) : "";
  const modelMissing = state.data?.available && catalog.data && !catalog.data.models.some((item) => item.id === state.data?.model);

  if (state.isPending) return <p className="py-1 text-xs text-muted-foreground" role="status">加载模型设置…</p>;
  if (!state.data) return <div className="flex items-center gap-2"><p className="text-xs text-destructive" role="alert">{state.error?.message ?? "无法加载模型设置。"}</p><Button type="button" variant="ghost" size="xs" onClick={() => void state.refetch()}>重试</Button></div>;

  return (
    <div className={compact ? "min-w-0 pt-2" : "min-w-0"}>
      <div className="flex min-w-0 items-center gap-2">
        {bare ? null : <span className="shrink-0 text-xs text-muted-foreground">模型</span>}
        <Combobox
          items={options}
          value={selected}
          itemToStringLabel={labelOf}
          itemToStringValue={(item: ModelOption) => item.id}
          isItemEqualToValue={(item: ModelOption, value: ModelOption) => item.id === value.id}
          disabled={disabled || saving || !state.data.available || !state.data.canManage || !catalog.data}
          onValueChange={(next) => {
            if (!next || next.missing || next.id === (state.data?.overrideModel ?? "")) return;
            if (queryClient.isMutating({ mutationKey: modelSelectionKeys.save(agentId) }) > 0) return;
            save.mutate(next.id || null);
          }}
        >
          <Button aria-label="模型选择" title={selectedLabel} type="button" variant={compact ? "ghost" : "outline"} size="sm" render={<ComboboxTrigger />} nativeButton className="min-w-0 flex-1 justify-between" disabled={disabled || saving || !state.data.available || !state.data.canManage || !catalog.data}><span className="truncate">{state.data.available ? selectedLabel : "外部 BOT"}</span></Button>
          <ComboboxContent className="min-w-64 max-w-[min(34rem,calc(100vw-2rem))]" side="top">
            <ComboboxInput aria-label="搜索模型" placeholder="搜索模型名称…" showTrigger={false} className="w-full" />
            <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
            <ComboboxList>{(item: ModelOption) => <ComboboxItem key={item.id} value={item} disabled={item.missing}>
              <div className="flex min-w-0 flex-col"><span className="break-all">{labelOf(item)}</span>{item.provider ? <span className="text-xs text-muted-foreground">{item.providerName ?? item.provider}</span> : null}</div>
            </ComboboxItem>}</ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button aria-label="刷新模型列表" title="刷新 Magpie 模型列表" type="button" size="icon-xs" variant="ghost" disabled={disabled || saving || (refreshing && refresh.status !== "pending")} mutation={refresh} onClick={() => refresh.mutate()}><IconRefresh /></Button>
        {catalog.data && !bare ? <span className="shrink-0 text-xs text-muted-foreground">{catalog.data.models.length} 个模型</span> : null}
      </div>
      {saving ? <p className="pt-1 text-xs text-muted-foreground" role="status">正在保存模型…</p> : null}
      {modelMissing ? <p className="pt-1 text-xs text-destructive" role="alert">当前模型 {state.data.model} 已不可用，请重新选择。</p> : null}
      {save.error || refresh.error || catalog.error || state.error ? <p className="pt-1 text-xs text-destructive" role="alert">{save.error?.message ?? refresh.error?.message ?? catalog.error?.message ?? state.error?.message}</p> : null}
      {!state.data.available ? <p className="pt-1 text-xs text-muted-foreground">此外部 BOT 的模型由其服务管理。</p>   : !compact && !saving && !bare ? <p className="pt-1 text-xs text-muted-foreground">{state.data.canManage ? "与聊天输入框同步，下一轮使用所选模型。" : "只有此 BOT 的拥有者或管理员可以更改模型。"}</p> : null}
    </div>
  );
}

/** 流式时父组件每个 token 都会重渲；props 没变就跳过（jank FIX-PLAN §5 / P2-1）。 */
BotModelSelectorImpl.displayName = "BotModelSelector";
export const BotModelSelector = memo(BotModelSelectorImpl);
