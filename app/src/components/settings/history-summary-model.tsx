import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMutationFeedback } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { saveHistorySummaryModelMutationOptions } from "@/lib/model-settings/mutations";
import { historySummaryModelQueryOptions } from "@/lib/model-settings/queries";

/**
 * 设置 → 模型 →「摘要模型」：Hermes 内核下长对话压缩前文时，用哪个模型把较早的轮次写成摘要。
 * 不选 = 跟随这一轮的主模型（服务器不写死任何模型）。摘要失败时只裁剪，不会挡住回答。
 */

/** Select 里「跟随主模型」那一项的值（不是模型 id）。 */
export const FOLLOW_MAIN_MODEL = "__follow-main__";

export function HistorySummaryModelCard() {
  const queryClient = useQueryClient();
  const saved = useQuery(historySummaryModelQueryOptions());
  const catalog = useQuery(modelCatalogQueryOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const models = catalog.data?.models ?? [];
  const current = saved.data?.model ?? FOLLOW_MAIN_MODEL;
  const value = draft ?? current;
  const known =
    value === FOLLOW_MAIN_MODEL || models.some((m) => m.id === value);
  const save = useMutation(saveHistorySummaryModelMutationOptions(queryClient));
  const saveState = useMutationFeedback(save);
  const submit = () => {
    const sent = value;
    save.mutate(sent === FOLLOW_MAIN_MODEL ? null : sent, {
      // 旧保存响应不能覆盖用户在请求期间新选的模型。
      onSuccess: () =>
        setDraft((currentDraft) =>
          currentDraft === sent ? null : currentDraft,
        ),
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
    <div className="fb-models" data-testid="history-summary-model">
      <div className="fb-actions">
        <Select
          onValueChange={(next) =>
            typeof next === "string" && next && setDraft(next)
          }
          value={value}
        >
          <SelectTrigger
            aria-label="摘要模型"
            className="fb-add"
            data-testid="history-summary-model-select"
          >
            <SelectValue>
              {value === FOLLOW_MAIN_MODEL
                ? "跟随主模型"
                : known
                  ? (models.find((m) => m.id === value)?.label ?? value)
                  : `${value} · 目录里暂时没有这个模型`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_MAIN_MODEL}>{"跟随主模型"}</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          data-testid="history-summary-model-save"
          disabled={value === current && saveState === "idle"}
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
