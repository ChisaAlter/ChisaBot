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
  agentId?: string;
  render: (props: ToolRenderProps<any>) => ReactNode;
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
  agentId?: string;
  parameters?: S;
  render: (props: ToolRenderProps<z.infer<S>>) => ReactNode;
}) {
  const registry = useContext(Registry);
  const key = useMemo(() => Symbol(tool.name), [tool.name]);
  useEffect(
    () => registry?.register(key, tool as RegisteredToolRenderer),
    [registry, key, tool.name, tool.agentId, tool.render],
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
      (entry) => entry.name === toolCall.function.name,
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
  ToolRenderProps<T> & { respond?: (answer: unknown) => Promise<void> };
function InteractionCard({
  render: Render,
  ...props
}: ToolRenderProps<any> & {
  render: (props: InteractionRenderProps<any>) => ReactNode;
}) {
  const cache = useQueryClient();
  const key = ["conversation-interaction", props.toolCallId];
  const interaction = useQuery({
    queryKey: key,
    enabled: props.result === undefined && props.status !== "inProgress",
    refetchInterval: props.result === undefined ? 1000 : false,
    queryFn: async () =>
      (
        await client(
          `/api/conversation-interactions/${encodeURIComponent(props.toolCallId)}`,
        )
      ).json() as Promise<{ status: string; answer: unknown }>,
  });
  const result =
    props.result ??
    (interaction.data?.status === "answered"
      ? typeof interaction.data.answer === "string"
        ? interaction.data.answer
        : JSON.stringify(interaction.data.answer)
      : undefined);
  const respond =
    interaction.data?.status === "pending"
      ? async (answer: unknown) => {
          await client(
            `/api/conversation-interactions/${encodeURIComponent(props.toolCallId)}`,
            { method: "POST", body: { answer } },
          );
          await cache.invalidateQueries({ queryKey: key });
        }
      : undefined;
  return <Render {...props} result={result} respond={respond} />;
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
