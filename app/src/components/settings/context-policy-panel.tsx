import { IconAdjustments, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorCard } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import {
  contextPoliciesQueryOptions,
  contextPolicyKeys,
  defaultSummaryThresholdFor,
  deleteContextPolicy,
  formatTokenShorthand,
  type ModelContextPolicyOverride,
  parseTokenShorthand,
  saveContextPolicy,
  validateContextPolicy,
} from "@/lib/context-policy";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";

/**
 * 按模型覆写上下文容量与摘要阈值管理面板（挂载于 `/admin/models`）。
 * 支持填写 `1M`、`400K`、`128000` 等简写并实时校验 `summaryThresholdTokens < contextWindowTokens`。
 */

export function evaluateContextPolicyDraft(draft: {
  modelId: string;
  contextWindowRaw: string;
  summaryThresholdRaw: string;
}): {
  valid: boolean;
  error: string | null;
  contextWindowTokens: number | null;
  summaryThresholdTokens: number | null;
} {
  const modelId = draft.modelId.trim();
  const contextWindowTokens = parseTokenShorthand(draft.contextWindowRaw);
  const summaryRaw = draft.summaryThresholdRaw.trim();
  const parsedSummary = summaryRaw ? parseTokenShorthand(summaryRaw) : null;

  if (!modelId) {
    return {
      valid: false,
      error: "请填写或选择需要覆写的模型 ID。",
      contextWindowTokens,
      summaryThresholdTokens: parsedSummary,
    };
  }
  if (/\s/u.test(modelId)) {
    return {
      valid: false,
      error: "模型 ID 不能包含空白字符。",
      contextWindowTokens,
      summaryThresholdTokens: parsedSummary,
    };
  }
  if (contextWindowTokens === null) {
    return {
      valid: false,
      error: "上下文容量格式无效（示例：1M、400K、128000）。",
      contextWindowTokens: null,
      summaryThresholdTokens: parsedSummary,
    };
  }
  if (summaryRaw && parsedSummary === null) {
    return {
      valid: false,
      error:
        "摘要阈值格式无效（示例：700K、280K、90000，留空按 70% 自动计算）。",
      contextWindowTokens,
      summaryThresholdTokens: null,
    };
  }

  const verdict = validateContextPolicy({
    contextWindowTokens,
    summaryThresholdTokens: parsedSummary ?? undefined,
  });
  if (!verdict.ok) {
    return {
      valid: false,
      error: verdict.error,
      contextWindowTokens,
      summaryThresholdTokens: parsedSummary,
    };
  }
  return {
    valid: true,
    error: null,
    contextWindowTokens: verdict.value.contextWindowTokens,
    summaryThresholdTokens: verdict.value.summaryThresholdTokens,
  };
}

function ContextPolicyEditor({
  policies,
}: {
  policies: readonly ModelContextPolicyOverride[];
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery(modelCatalogQueryOptions());
  const [modelId, setModelId] = useState("");
  const [contextWindowRaw, setContextWindowRaw] = useState("200K");
  const [summaryThresholdRaw, setSummaryThresholdRaw] = useState("140K");
  const [removingId, setRemovingId] = useState<string | null>(null);

  const check = evaluateContextPolicyDraft({
    modelId,
    contextWindowRaw,
    summaryThresholdRaw,
  });

  const saveAction = useAsyncAction(
    async () => {
      if (
        !check.valid ||
        check.contextWindowTokens === null ||
        check.summaryThresholdTokens === null
      ) {
        throw new Error(check.error ?? "请先修正无效参数。");
      }
      await saveContextPolicy({
        modelId: modelId.trim(),
        contextWindowTokens: check.contextWindowTokens,
        summaryThresholdTokens: check.summaryThresholdTokens,
      });
      toast.success(`已保存模型「${modelId.trim()}」的上下文策略。`);
      setModelId("");
      await queryClient.invalidateQueries({ queryKey: contextPolicyKeys.all });
    },
    { errorToast: (error) => error.message },
  );

  async function handleRemove(targetModelId: string) {
    if (removingId) return;
    setRemovingId(targetModelId);
    try {
      await deleteContextPolicy(targetModelId);
      toast.success(`已移除「${targetModelId}」的上下文覆写。`);
      await queryClient.invalidateQueries({ queryKey: contextPolicyKeys.all });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "移除失败");
    } finally {
      setRemovingId(null);
    }
  }

  function loadIntoForm(entry: ModelContextPolicyOverride) {
    setModelId(entry.modelId);
    setContextWindowRaw(formatTokenShorthand(entry.contextWindowTokens));
    setSummaryThresholdRaw(formatTokenShorthand(entry.summaryThresholdTokens));
  }

  const catalogModels = catalog.data?.models ?? [];

  const formTouched =
    Boolean(modelId.trim()) ||
    contextWindowRaw !== "200K" ||
    summaryThresholdRaw !== "140K";

  return (
    <div className="media-card-stack" data-testid="context-policy-panel">
      <form
        autoComplete="off"
        className="media-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (check.valid && saveAction.state !== "pending") {
            void saveAction.run();
          }
        }}
      >
        <div className="im-form">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="im-field" htmlFor="ctx-policy-model">
              <span className="im-field-l">{"模型 ID"}</span>
              <Input
                className="font-mono"
                data-testid="ctx-policy-model"
                id="ctx-policy-model"
                list="ctx-policy-catalog-models"
                onChange={(event) => setModelId(event.target.value)}
                placeholder="例如 claude-sonnet-4"
                spellCheck={false}
                value={modelId}
              />
              <datalist id="ctx-policy-catalog-models">
                {catalogModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </datalist>
            </label>

            <label className="im-field" htmlFor="ctx-policy-window">
              <span className="im-field-l">
                {"上下文容量（支持 1M / 400K）"}
              </span>
              <Input
                className="font-mono"
                data-testid="ctx-policy-window"
                id="ctx-policy-window"
                onChange={(event) => setContextWindowRaw(event.target.value)}
                placeholder="例如 1M、400K、128000"
                spellCheck={false}
                value={contextWindowRaw}
              />
              {check.contextWindowTokens !== null ? (
                <span className="im-field-h">
                  {`= ${check.contextWindowTokens.toLocaleString("en-US")} tokens`}
                </span>
              ) : null}
            </label>

            <label className="im-field" htmlFor="ctx-policy-summary">
              <span className="im-field-l">
                {"摘要触发阈值（留空默认 70%）"}
              </span>
              <Input
                className="font-mono"
                data-testid="ctx-policy-summary"
                id="ctx-policy-summary"
                onChange={(event) => setSummaryThresholdRaw(event.target.value)}
                placeholder={
                  check.contextWindowTokens !== null
                    ? `默认 ${formatTokenShorthand(defaultSummaryThresholdFor(check.contextWindowTokens))}`
                    : "例如 700K、280K"
                }
                spellCheck={false}
                value={summaryThresholdRaw}
              />
              {check.summaryThresholdTokens !== null ? (
                <span className="im-field-h">
                  {`= ${check.summaryThresholdTokens.toLocaleString("en-US")} tokens`}
                </span>
              ) : null}
            </label>
          </div>

          {check.error && formTouched ? (
            <p
              className="text-destructive text-xs"
              data-testid="ctx-policy-error"
              role="alert"
            >
              {check.error}
            </p>
          ) : null}

          <div className="media-actions">
            <Button
              data-testid="ctx-policy-save"
              disabled={!check.valid}
              feedback="save"
              state={saveAction.state}
              type="submit"
            >
              <IconPlus className="size-4" />
              {"保存覆写"}
            </Button>
          </div>
        </div>
      </form>

      <div className="media-body border-t">
        {policies.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {
              "暂未配置按模型上下文覆写，当前全部模型使用网关目录声明值或内置默认窗口。"
            }
          </p>
        ) : (
          <div className="space-y-2" data-testid="ctx-policy-list">
            {policies.map((entry) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                key={entry.modelId}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <IconAdjustments className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono font-medium">
                      {entry.modelId}
                    </span>
                  </div>
                  <div className="font-mono text-muted-foreground text-xs">
                    {`上下文容量：${formatTokenShorthand(entry.contextWindowTokens)}（${entry.contextWindowTokens.toLocaleString("en-US")}） · 摘要阈值：${formatTokenShorthand(entry.summaryThresholdTokens)}（${entry.summaryThresholdTokens.toLocaleString("en-US")}）`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    onClick={() => loadIntoForm(entry)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {"编辑"}
                  </Button>
                  <Button
                    aria-label={`删除模型 ${entry.modelId} 的上下文覆写`}
                    disabled={removingId === entry.modelId}
                    onClick={() => void handleRemove(entry.modelId)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash className="size-4" />
                    {"移除"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 挂载于 `/admin/models` 的「上下文容量与摘要阈值」管理区。 */
export function ContextPolicyPanel() {
  const query = useQuery(contextPoliciesQueryOptions());
  return (
    <div className="media-anchor" id="context-policy">
      <PageSection
        description="当上游网关未上报或错报模型上下文窗口时，可按模型 ID 手动覆写容量与长对话摘要触发阈值（支持 1M / 400K 简写，保存后优先生效）。"
        settingItem="models.context-policy"
        title="上下文容量与摘要阈值"
      >
        {query.isPending ? (
          <PageSkeleton rows={3} />
        ) : query.error || !query.data ? (
          <ErrorCard
            action={
              <Button onClick={() => query.refetch()} variant="outline">
                {"重试"}
              </Button>
            }
            title={query.error?.message ?? "无法加载上下文容量策略"}
          />
        ) : (
          <ContextPolicyEditor policies={query.data} />
        )}
      </PageSection>
    </div>
  );
}
