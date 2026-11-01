import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";

/**
 * 设置 → 模型 →「摘要模型」：Hermes 内核下长对话压缩前文时，用哪个模型把较早的轮次写成摘要。
 * 不选 = 跟随这一轮的主模型（服务器不写死任何模型）。摘要失败时只裁剪，不会挡住回答。
 */

const summaryKey = ["admin", "history-summary-model"] as const;
/** Select 里「跟随主模型」那一项的值（不是模型 id）。 */
export const FOLLOW_MAIN_MODEL = "__follow-main__";

async function call(
  method: "GET" | "PUT",
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ model: string | null }> {
  const response = await fetch("/api/admin/history-summary-model", {
    method,
    credentials: "include",
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    ...(signal ? { signal } : {}),
  });
  const parsed = (await response.json().catch(() => null)) as {
    model?: string | null;
    error?: string;
  } | null;
  if (
    !response.ok ||
    !parsed ||
    (parsed.model !== null && typeof parsed.model !== "string")
  )
    throw new Error(
      parsed?.error ||
        (method === "GET" ? "无法加载摘要模型" : "保存失败，请重试"),
    );
  return { model: parsed.model ?? null };
}

export function historySummaryModelQueryOptions() {
  return queryOptions({
    queryKey: summaryKey,
    queryFn: ({ signal }) => call("GET", undefined, signal),
  });
}

export function HistorySummaryModelCard() {
  const queryClient = useQueryClient();
  const saved = useQuery(historySummaryModelQueryOptions());
  const catalog = useQuery(modelCatalogQueryOptions());
  const [value, setValue] = useState<string>(FOLLOW_MAIN_MODEL);
  useEffect(() => {
    if (saved.data) setValue(saved.data.model ?? FOLLOW_MAIN_MODEL);
  }, [saved.data]);
  const models = catalog.data?.models ?? [];
  const current = saved.data?.model ?? FOLLOW_MAIN_MODEL;
  const known =
    value === FOLLOW_MAIN_MODEL || models.some((m) => m.id === value);
  const save = useAsyncAction(
    async () => {
      const result = await call("PUT", {
        model: value === FOLLOW_MAIN_MODEL ? null : value,
      });
      queryClient.setQueryData(summaryKey, result);
    },
    { errorToast: (error) => error.message },
  );

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
            typeof next === "string" && next && setValue(next)
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
          disabled={value === current && save.state === "idle"}
          feedback="save"
          onClick={() => void save.run()}
          state={save.state}
          type="button"
        >
          {"保存"}
        </Button>
      </div>
    </div>
  );
}
