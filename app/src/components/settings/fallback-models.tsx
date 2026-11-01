import { IconArrowDown, IconArrowUp, IconX } from "@tabler/icons-react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, ListRow } from "@/components/ui/skyglass";
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { hermesFallbackUnsupportedNote, runtimeKernelQueryOptions } from "@/lib/runtime-kernel";

/**
 * 设置 → 模型 →「备用模型」（DESIGN.md §61）：主模型额度用完或暂时不可用时，按这个顺序换下一个。
 * 留空 = 不指定（自动挑同一平台的其它模型，或部署环境变量 CHISABOT_MODEL_FALLBACKS）。
 */

export const MAX_FALLBACK_MODELS = 8;
const fallbackKey = ["admin", "model-fallbacks"] as const;

async function call(method: "GET" | "PUT", body?: unknown, signal?: AbortSignal): Promise<{ models: string[] }> {
  const response = await fetch("/api/admin/model-fallbacks", {
    method,
    credentials: "include",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const parsed = (await response.json().catch(() => null)) as { models?: string[]; error?: string } | null;
  if (!response.ok || !parsed || !Array.isArray(parsed.models)) throw new Error(parsed?.error || (method === "GET" ? "无法加载备用模型" : "保存失败，请重试"));
  return { models: parsed.models };
}

export function fallbackModelsQueryOptions() {
  return queryOptions({ queryKey: fallbackKey, queryFn: ({ signal }) => call("GET", undefined, signal) });
}

/** 上移 / 下移 / 删除，纯函数便于测试。 */
export function moveModel(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function FallbackModelsCard({ mainModel }: { mainModel: string }) {
  const queryClient = useQueryClient();
  const saved = useQuery(fallbackModelsQueryOptions());
  const catalog = useQuery(modelCatalogQueryOptions());
  // 只在适配器明确检测到不支持时才说「不生效」（有依据，不猜）。
  const kernel = useQuery({ ...runtimeKernelQueryOptions(), refetchInterval: false });
  const unsupported = hermesFallbackUnsupportedNote(kernel.data);
  const [list, setList] = useState<string[]>([]);
  const [pick, setPick] = useState<string>("");
  useEffect(() => {
    if (saved.data) setList(saved.data.models);
  }, [saved.data]);
  const labels = useMemo(() => new Map((catalog.data?.models ?? []).map((m) => [m.id, m.label || m.id])), [catalog.data]);
  const addable = (catalog.data?.models ?? []).filter((m) => m.id !== mainModel && !list.includes(m.id));
  const dirty = JSON.stringify(list) !== JSON.stringify(saved.data?.models ?? []);
  const save = useAsyncAction(
    async () => {
      const result = await call("PUT", { models: list });
      setList(result.models);
      queryClient.setQueryData(fallbackKey, result);
    },
    { errorToast: (error) => error.message },
  );

  if (saved.isPending) return <p className="mt-4 text-muted-foreground text-sm" role="status">{"正在加载…"}</p>;
  if (saved.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {saved.error.message}
      </p>
    );

  return (
    <div className="fb-models" data-testid="fallback-models">
      {unsupported ? (
        <p className="mb-3 text-muted-foreground text-sm" data-testid="fallback-hermes-unsupported">
          {unsupported}
        </p>
      ) : null}
      <Card className="fb-list">
        {list.length === 0 ? (
          <p className="fb-empty">{"还没有指定。主模型用不了时，自动挑同一平台的其它模型。"}</p>
        ) : (
          list.map((id, index) => (
            <ListRow
              actions={
                <>
                  <Button aria-label="上移" disabled={index === 0} onClick={() => setList(moveModel(list, index, -1))} size="icon-sm" type="button" variant="ghost">
                    <IconArrowUp />
                  </Button>
                  <Button aria-label="下移" disabled={index === list.length - 1} onClick={() => setList(moveModel(list, index, 1))} size="icon-sm" type="button" variant="ghost">
                    <IconArrowDown />
                  </Button>
                  <Button aria-label="移除" onClick={() => setList(list.filter((m) => m !== id))} size="icon-sm" type="button" variant="ghost">
                    <IconX />
                  </Button>
                </>
              }
              data-testid="fallback-row"
              icon={<span className="fb-rank">{index + 1}</span>}
              key={id}
              sub={labels.has(id) ? <span className="font-mono">{id}</span> : <span>{`${id} · 目录里暂时没有这个模型`}</span>}
              title={labels.get(id) ?? id}
            />
          ))
        )}
      </Card>
      <div className="fb-actions">
        <Select
          disabled={list.length >= MAX_FALLBACK_MODELS || addable.length === 0}
          onValueChange={(value) => {
            if (typeof value === "string" && value) setList((previous) => (previous.includes(value) ? previous : [...previous, value]));
            setPick("");
          }}
          value={pick}
        >
          <SelectTrigger aria-label="添加备用模型" className="fb-add" data-testid="fallback-add">
            <SelectValue>{list.length >= MAX_FALLBACK_MODELS ? `最多 ${MAX_FALLBACK_MODELS} 个` : "＋ 添加备用模型"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {addable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button data-testid="fallback-save" disabled={!dirty && save.state === "idle"} feedback="save" onClick={() => void save.run()} state={save.state} type="button">
          {"保存"}
        </Button>
      </div>
    </div>
  );
}
