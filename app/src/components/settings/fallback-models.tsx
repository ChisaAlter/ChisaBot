import { IconArrowDown, IconArrowUp, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useMutationFeedback } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { saveFallbackModelsMutationOptions } from "@/lib/model-settings/mutations";
import { fallbackModelsQueryOptions } from "@/lib/model-settings/queries";

/**
 * 设置 → 模型 →「备用模型」（DESIGN.md §61）：主模型额度用完或暂时不可用时，按这个顺序换下一个。
 * 留空 = 不指定（自动挑同一平台的其它模型，或部署环境变量 CHISABOT_MODEL_FALLBACKS）。
 */

export const MAX_FALLBACK_MODELS = 8;

/** 上移 / 下移 / 删除，纯函数便于测试。 */
export function moveModel(
  list: readonly string[],
  index: number,
  delta: -1 | 1,
): string[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length)
    return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function FallbackModelsCard({ mainModel }: { mainModel: string }) {
  const queryClient = useQueryClient();
  const saved = useQuery(fallbackModelsQueryOptions());
  const catalog = useQuery(modelCatalogQueryOptions());
  const [draft, setDraft] = useState<string[] | null>(null);
  const list = draft ?? saved.data?.models ?? [];
  const [pick, setPick] = useState<string>("");
  const labels = useMemo(
    () =>
      new Map((catalog.data?.models ?? []).map((m) => [m.id, m.label || m.id])),
    [catalog.data],
  );
  const available = new Set(
    (catalog.data?.models ?? [])
      .filter((m) => m.supportsTools !== false)
      .map((m) => m.id),
  );
  const checked = Boolean(catalog.data?.models.length && !catalog.data.stale);
  const addable = (catalog.data?.models ?? []).filter(
    (m) =>
      m.supportsTools !== false && m.id !== mainModel && !list.includes(m.id),
  );
  const dirty =
    JSON.stringify(list) !== JSON.stringify(saved.data?.models ?? []);
  const save = useMutation(saveFallbackModelsMutationOptions(queryClient));
  const saveState = useMutationFeedback(save);
  const submit = () => {
    const sent = list;
    save.mutate(sent, {
      // 保存期间仍可调整顺序；响应只清掉本次提交的草稿，保留后续修改。
      onSuccess: () =>
        setDraft((current) => (current === sent ? null : current)),
      onError: (error: Error) => toast.error(error.message),
    });
  };

  if (saved.isPending)
    return (
      <p className="mt-4 text-muted-foreground text-sm" role="status">
        {"正在加载…"}
      </p>
    );
  if (saved.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {saved.error.message}
      </p>
    );

  return (
    <div className="fb-models" data-testid="fallback-models">
      {checked && list.length > 0 && list.every((id) => !available.has(id)) ? (
        <p className="mb-3 text-muted-foreground text-sm" role="status">
          {"当前指定的备用模型都不可用，暂时只使用主模型。请移除后重新选择。"}
        </p>
      ) : null}
      <Card className="fb-list">
        {list.length === 0 ? (
          <p className="fb-empty">
            {"还没有指定。主模型用不了时，自动挑同一平台的其它模型。"}
          </p>
        ) : (
          list.map((id, index) => (
            <ListRow
              actions={
                <>
                  <Button
                    aria-label="上移"
                    disabled={index === 0}
                    onClick={() => setDraft(moveModel(list, index, -1))}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconArrowUp />
                  </Button>
                  <Button
                    aria-label="下移"
                    disabled={index === list.length - 1}
                    onClick={() => setDraft(moveModel(list, index, 1))}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconArrowDown />
                  </Button>
                  <Button
                    aria-label="移除"
                    onClick={() => setDraft(list.filter((m) => m !== id))}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconX />
                  </Button>
                </>
              }
              data-testid="fallback-row"
              icon={<span className="fb-rank">{index + 1}</span>}
              key={id}
              sub={
                checked && !available.has(id) ? (
                  <span>{`${id} · 当前不可用，已跳过`}</span>
                ) : (
                  <span className="font-mono">{id}</span>
                )
              }
              title={labels.get(id) ?? id}
            />
          ))
        )}
      </Card>
      <div className="fb-actions">
        <Select
          disabled={list.length >= MAX_FALLBACK_MODELS || addable.length === 0}
          onValueChange={(value) => {
            if (typeof value === "string" && value && !list.includes(value))
              setDraft([...list, value]);
            setPick("");
          }}
          value={pick}
        >
          <SelectTrigger
            aria-label="添加备用模型"
            className="fb-add"
            data-testid="fallback-add"
          >
            <SelectValue>
              {list.length >= MAX_FALLBACK_MODELS
                ? `最多 ${MAX_FALLBACK_MODELS} 个`
                : "＋ 添加备用模型"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {addable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          data-testid="fallback-save"
          disabled={!dirty && saveState === "idle"}
          feedback="save"
          onClick={submit}
          state={saveState}
          type="button"
        >
          {"保存"}
        </Button>
      </div>
    </div>
  );
}
