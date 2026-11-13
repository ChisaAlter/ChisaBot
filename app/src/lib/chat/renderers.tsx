import type { Message, ToolCall } from "@ag-ui/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parse as parsePartial } from "partial-json";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { z } from "zod";
import { client } from "@/lib/client";
import type { ContinuationView } from "../../../../shared/confirmations";
import { continuationIsActive } from "./continuation";
import { useConversationScope } from "./conversation-scope";
import { type SandboxContent, SandboxSurface } from "./sandbox-surface";

export type ToolRenderProps<T = Record<string, unknown>> = {
  parameters: Partial<T>;
  args: Partial<T>;
  result?: string;
  toolCallId: string;
  status: "inProgress" | "executing" | "complete";
};
export type RegisteredToolRenderer = {
  name: string;
  match?: (toolName: string) => boolean;
  agentId?: string;
  /** Method syntax on purpose: each renderer narrows its own args; the registry holds them all. */
  render(props: ToolRenderProps): ReactNode;
};
class RenderRegistry {
  private entries = new Map<symbol, RegisteredToolRenderer>();
  private listeners = new Set<() => void>();
  snapshot: readonly RegisteredToolRenderer[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  read = () => this.snapshot;
  register(key: symbol, renderer: RegisteredToolRenderer) {
    this.entries.set(key, renderer);
    this.changed();
    return () => {
      this.entries.delete(key);
      this.changed();
    };
  }
  private changed() {
    this.snapshot = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}
const Registry = createContext<RenderRegistry | null>(null);
const empty: readonly RegisteredToolRenderer[] = [];
const noopSubscribe = () => () => {};
const emptyRead = () => empty;
export function ToolRendererProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(() => new RenderRegistry(), []);
  return <Registry.Provider value={registry}>{children}</Registry.Provider>;
}
export function useRegisteredToolRenderers() {
  const registry = useContext(Registry);
  return useSyncExternalStore(
    registry?.subscribe ?? noopSubscribe,
    registry?.read ?? emptyRead,
    emptyRead,
  );
}
export function useRenderTool<S extends z.ZodType>(tool: {
  name: string;
  match?: (toolName: string) => boolean;
  agentId?: string;
  parameters?: S;
  render: (props: ToolRenderProps<z.infer<S>>) => ReactNode;
}) {
  const registry = useContext(Registry);
  const key = useMemo(() => Symbol(tool.name), [tool.name]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tool 的字段已逐项列出，对象本身身份不用算
  useEffect(
    () => registry?.register(key, tool as RegisteredToolRenderer),
    [registry, key, tool.name, tool.match, tool.agentId, tool.render],
  );
}
function DrawTool({
  renderer,
  toolCall,
  result,
}: {
  renderer: RegisteredToolRenderer;
  toolCall: ToolCall;
  result?: string;
}) {
  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(toolCall.function.arguments), complete: true };
    } catch {
      try {
        return {
          value: parsePartial(toolCall.function.arguments),
          complete: false,
        };
      } catch {
        return { value: {}, complete: false };
      }
    }
  }, [toolCall.function.arguments]);
  const args =
    parsed.value && typeof parsed.value === "object" ? parsed.value : {};
  return createElement(renderer.render, {
    parameters: args,
    args,
    result,
    toolCallId: toolCall.id,
    status:
      result !== undefined
        ? "complete"
        : parsed.complete
          ? "executing"
          : "inProgress",
  });
}
export function useRenderToolCall() {
  const registry = useRegisteredToolRenderers();
  const scope = useConversationScope();
  return ({
    toolCall,
    toolMessage,
  }: {
    toolCall: ToolCall;
    toolMessage?: {
      id: string;
      role: string;
      toolCallId: string;
      content: string;
    };
  }) => {
    const exact = registry.filter(
      (entry) =>
        entry.name === toolCall.function.name ||
        entry.match?.(toolCall.function.name) === true,
    );
    const renderer =
      exact.find((entry) => entry.agentId === scope?.agentId) ??
      exact.find((entry) => !entry.agentId) ??
      exact[0] ??
      registry.find((entry) => entry.name === "*");
    return renderer ? (
      <DrawTool
        key={toolCall.id}
        renderer={renderer}
        toolCall={toolCall}
        result={toolMessage?.content}
      />
    ) : null;
  };
}
export const ACTIVITY_RENDERERS = [
  { activityType: "open-generative-ui" },
] as const;
export function useRenderActivityMessage() {
  return {
    renderActivityMessage: (message: Message) =>
      message.role === "activity" &&
      message.activityType === "open-generative-ui" ? (
        <SandboxSurface content={message.content as SandboxContent} />
      ) : null,
  };
}

export type InteractionRenderProps<T = Record<string, unknown>> =
  ToolRenderProps<T> & {
    respond?: (answer: unknown) => Promise<void>;
    continuation?: ContinuationView;
    retryContinuation?: () => Promise<void>;
  };
type InteractionState = {
  status: string;
  answer: unknown;
  continuation?: ContinuationView;
};
function InteractionCard({
  render: Render,
  ...props
}: ToolRenderProps & {
  render(props: InteractionRenderProps): ReactNode;
}) {
  const cache = useQueryClient();
  const key = ["conversation-interaction", props.toolCallId];
  const interaction = useQuery<InteractionState>({
    queryKey: key,
    enabled: props.status !== "inProgress",
    refetchInterval: (query) =>
      (query.state.data?.status !== "answered" && props.result === undefined) ||
      continuationIsActive(query.state.data?.continuation)
        ? 1000
        : false,
    queryFn: async ({ signal }): Promise<InteractionState> =>
      (
        await client(
          `/api/conversation-interactions/${encodeURIComponent(props.toolCallId)}`,
          { signal, fallback: "无法读取这张卡片的处理状态" },
        )
      ).json(),
  });
  const result =
    props.result ??
    (interaction.data?.status === "answered"
      ? typeof interaction.data.answer === "string"
        ? interaction.data.answer
        : JSON.stringify(interaction.data.answer)
      : undefined);
  const respond =
    props.result === undefined && interaction.data?.status === "pending"
      ? async (answer: unknown) => {
          await client(
            `/api/conversation-interactions/${encodeURIComponent(props.toolCallId)}`,
            {
              method: "POST",
              body: { answer },
              fallback: "回答未能提交，请重试",
            },
          );
          await cache.invalidateQueries({ queryKey: key });
        }
      : undefined;
  const retryContinuation =
    interaction.data?.continuation?.state === "failed" &&
    interaction.data.continuation.retryable
      ? async () => {
          try {
            await client(
              `/api/conversation-interactions/${encodeURIComponent(props.toolCallId)}/retry`,
              { method: "POST", fallback: "继续处理未能提交，请重试" },
            );
            cache.setQueryData<InteractionState>(key, (current) =>
              current
                ? {
                    ...current,
                    continuation: { state: "queued" },
                  }
                : current,
            );
          } finally {
            await cache.invalidateQueries({ queryKey: key });
          }
        }
      : undefined;
  return (
    <Render
      {...props}
      result={result}
      respond={respond}
      continuation={interaction.data?.continuation}
      retryContinuation={retryContinuation}
    />
  );
}
export function useInteractionRenderer<S extends z.ZodType>(tool: {
  name: string;
  parameters: S;
  render: (props: InteractionRenderProps<z.infer<S>>) => ReactNode;
}) {
  const render = useMemo(
    () => (props: ToolRenderProps<z.infer<S>>) => (
      <InteractionCard {...props} render={tool.render} />
    ),
    [tool.render],
  );
  useRenderTool({ ...tool, render });
}
