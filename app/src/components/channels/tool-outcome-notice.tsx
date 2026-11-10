import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { ConversationSession } from "@/lib/chat/session-client";
import { client } from "@/lib/client";
import type {
  ToolOutcomeResolution,
  UnknownToolOperation,
} from "../../../../shared/conversations";

/** Uses persisted operations, so the same decision remains available after reopening a chat. */
export function ToolOutcomeNotice({
  agent,
  ready,
  onResolved,
}: {
  agent: ConversationSession;
  ready: boolean;
  onResolved: (continued: boolean) => void;
}) {
  const cache = useQueryClient();
  const endpoint = `/api/conversations/${encodeURIComponent(agent.threadId)}/operations`;
  const key = ["conversation-operations", agent.threadId];
  const query = useQuery({
    queryKey: key,
    enabled: ready,
    queryFn: async ({ signal }) => {
      const response = await client(endpoint, {
        signal,
        fallback: "无法读取待核对操作。",
      });
      return ((await response.json()) as { operations: UnknownToolOperation[] })
        .operations;
    },
    refetchInterval: (state) => (state.state.data?.length ? 5000 : false),
  });
  useEffect(() => {
    const subscription = agent.subscribe({
      onRunFinishedEvent: () => {
        void cache.invalidateQueries({
          queryKey: ["conversation-operations", agent.threadId],
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, cache]);
  const operation = query.data?.[0];
  if (query.isError && !operation)
    return (
      <div
        className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--line-strong)] bg-[var(--glass-1)] p-3 text-sm"
        role="alert"
      >
        <span>无法读取待核对操作。</span>
        <Button
          variant="outline"
          size="sm"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重试
        </Button>
      </div>
    );
  if (!operation) return null;
  return (
    <OutcomeForm
      key={operation.id}
      operation={operation}
      endpoint={endpoint}
      onResolved={(continued) => {
        void cache.invalidateQueries({ queryKey: key });
        onResolved(continued);
      }}
    />
  );
}

function OutcomeForm({
  operation,
  endpoint,
  onResolved,
}: {
  operation: UnknownToolOperation;
  endpoint: string;
  onResolved: (continued: boolean) => void;
}) {
  const [outcome, setOutcome] = useState<ToolOutcomeResolution["outcome"] | "">(
    "",
  );
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: async (resolution: ToolOutcomeResolution) => {
      const response = await client(
        `${endpoint}/${encodeURIComponent(operation.id)}/resolve`,
        {
          method: "POST",
          body: resolution,
          fallback: "核对结果未保存。",
        },
      );
      return response.json() as Promise<{ continued: boolean }>;
    },
    onSuccess: ({ continued }) => {
      toast.success(
        continued ? "核对结果已记录，任务继续。" : "核对结果已记录。",
      );
      onResolved(continued);
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <section
      className="mb-3 rounded-xl border border-[var(--line-strong)] bg-[var(--glass-1)] p-3 text-sm"
      aria-label="核对操作结果"
    >
      <h3 className="font-medium">这一步的结果需要你核对</h3>
      <p className="mt-1 text-muted-foreground">
        查看目标服务或文件的实际状态，再记录结果。
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer py-1">查看操作内容</summary>
        <p className="mt-1 break-all">{operation.toolName}</p>
        <dl className="mt-2 space-y-2">
          {operation.details.map((detail) => (
            <div key={detail.label}>
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
        {operation.error ? (
          <p className="mt-2 break-words text-muted-foreground">
            {operation.error}
          </p>
        ) : null}
      </details>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (outcome && note.trim())
            resolve.mutate({
              outcome,
              note: note.trim(),
              continue: operation.canContinue,
            });
        }}
      >
        <label className="flex flex-col gap-1">
          <span>实际结果</span>
          <select
            className="min-h-10 rounded-lg border border-input bg-background px-2"
            value={outcome}
            onChange={(event) =>
              setOutcome(event.target.value as typeof outcome)
            }
            required
            disabled={resolve.isPending}
          >
            <option value="">请选择核对结果</option>
            <option value="completed">操作已经完成</option>
            <option value="not_executed">操作没有执行</option>
            <option value="failed">操作未完成（说明已产生的影响）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>核对说明</span>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={2000}
            required
            disabled={resolve.isPending}
            placeholder="例如：已在目标系统看到发送成功的记录。"
          />
        </label>
        <Button
          className="self-start"
          type="submit"
          disabled={!outcome || !note.trim()}
          mutation={resolve}
          feedback="save"
        >
          {operation.canContinue ? "记录并继续" : "记录结果"}
        </Button>
      </form>
    </section>
  );
}
