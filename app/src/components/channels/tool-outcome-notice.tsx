import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useExternalConnection } from "@/hooks";
import type { ConversationSession } from "@/lib/chat/session-client";
import { client } from "@/lib/client";
import { DURATION_MS, usePresenceMount, useRetainedValue } from "@/lib/motion";
import type {
  ToolOutcomeResolution,
  UnknownToolOperation,
} from "../../../../shared/conversations";

const instanceIds = new WeakMap<object, number>();
let nextInstanceId = 1;

function instanceKey(value: object): number {
  const existing = instanceIds.get(value);
  if (existing !== undefined) return existing;
  const created = nextInstanceId++;
  instanceIds.set(value, created);
  return created;
}

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
  useExternalConnection(
    `${instanceKey(agent)}\0${instanceKey(cache)}`,
    () => {
      const subscription = agent.subscribe({
        onRunFinishedEvent: () => {
          void cache.invalidateQueries({
            queryKey: ["conversation-operations", agent.threadId],
          });
        },
      });
      return () => subscription.unsubscribe();
    },
  );
  const operation = query.data?.[0];
  const hasOperation = Boolean(operation);
  const retainedOperation = useRetainedValue(operation ?? null);
  const presence = usePresenceMount(hasOperation, DURATION_MS.collapse);
  if (query.isError && !operation)
    return (
      <div
        className="to-card ch-content-enter mb-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--line-strong)] p-3 text-sm"
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
  const shown = operation ?? retainedOperation;
  if (!presence.mounted || !shown) return null;
  return (
    <SmoothCollapse open={hasOperation} unmountOnExit>
      <OutcomeForm
        active={hasOperation}
        key={shown.id}
        operation={shown}
        endpoint={endpoint}
        onResolved={(continued) => {
          void cache.invalidateQueries({ queryKey: key });
          onResolved(continued);
        }}
      />
    </SmoothCollapse>
  );
}

function OutcomeForm({
  active,
  operation,
  endpoint,
  onResolved,
}: {
  active: boolean;
  operation: UnknownToolOperation;
  endpoint: string;
  onResolved: (continued: boolean) => void;
}) {
  const [outcome, setOutcome] = useState<ToolOutcomeResolution["outcome"] | "">(
    "",
  );
  const [note, setNote] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      className="to-card mb-3 rounded-xl border border-[var(--line-strong)] p-3 text-sm"
      aria-label={active ? "核对操作结果" : undefined}
    >
      <h3 className="font-medium">这一步的结果需要你核对</h3>
      <p className="mt-1 text-muted-foreground">
        查看目标服务或文件的实际状态，再记录结果。
      </p>
      <details
        className="mt-2"
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer py-1">查看操作内容</summary>
        <SmoothCollapse open={detailsOpen}>
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
        </SmoothCollapse>
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
            className="min-h-10 rounded-lg border border-input bg-[var(--glass-2)] px-2"
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
