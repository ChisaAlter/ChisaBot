import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useRef } from "react";
import * as z from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { RefusedCard } from "@/components/gallery/refused";
import { useRenderTool } from "@/lib/chat/renderers";
import { SandboxSurface } from "@/lib/chat/sandbox-surface";
import {
  agentComponentsQueryOptions,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useDeclaredBotId } from "@/lib/conversations/active-bot";
import { useBotOnScreen, useKeptVisibility } from "@/lib/kept-visible";
import {
  type PublishedSandboxed,
  publishedSandboxedQueryOptions,
} from "@/lib/sandboxed/queries";
import {
  NOT_SHOWN,
  NOT_SHOWN_TAIL,
} from "../../../../shared/component-markers";

const PUBLISHED_SANDBOXED_POLL_MS = 30_000;
const AGENT_COMPONENTS_POLL_MS = 45_000;

/**
 * Browser-authored components use the same component grants as compiled gallery components, but
 * render published runtime markup in the SDK sandbox.
 */
export function SandboxedTools() {
  // Grants are fetched only once a surface has declared its Bot; the placeholder is not one the
  // server knows, and asking would 404 on every poll.
  const declared = useDeclaredBotId();
  // 仅门控 refetchInterval（用非重渲 useKeptVisibility，避免切频道重渲或翻转 enabled 导致重发请求）。
  const visibility = useKeptVisibility();
  const declaredOnScreen = useBotOnScreen(declared);
  const declaredOnScreenRef = useRef(declaredOnScreen);
  declaredOnScreenRef.current = declaredOnScreen;
  const { data: published } = useQuery({
    ...publishedSandboxedQueryOptions(),
    refetchInterval: () =>
      visibility.get() && declaredOnScreenRef.current
        ? PUBLISHED_SANDBOXED_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  });
  const { data: granted } = useQuery({
    ...agentComponentsQueryOptions(declared),
    refetchInterval: () =>
      visibility.get() && declaredOnScreenRef.current
        ? AGENT_COMPONENTS_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  });

  const held = useMemo(
    () =>
      new Map(
        (granted ?? []).map((component: GrantedComponent) => [
          component.name,
          component.description,
        ]),
      ),
    [granted],
  );

  return (
    <>
      {(published ?? []).map((component) => (
        <SandboxedTool
          component={component}
          description={held.get(component.name)}
          key={component.name}
        />
      ))}
    </>
  );
}

const parametersCache = new WeakMap<Record<string, unknown>, z.ZodObject>();

/** Convert an author's JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(schema: Record<string, unknown>) {
  const cached = parametersCache.get(schema);
  if (cached) return cached;
  let result: z.ZodObject;
  try {
    const converted = z.fromJSONSchema(schema as never);
    result =
      converted instanceof z.ZodObject
        ? converted
        : z.object({}).catchall(z.unknown());
  } catch {
    // Unreadable author schemas fall back to permissive arguments and server-side checks.
    result = z.object({}).catchall(z.unknown());
  }
  parametersCache.set(schema, result);
  return result;
}

const SandboxedTool = memo(function SandboxedTool({
  component,
  description,
}: {
  component: PublishedSandboxed;
  description: string | undefined;
}) {
  const isHeld = description !== undefined;
  const parameters = useMemo(
    () => parametersFor(component.argumentSchema),
    [component.argumentSchema],
  );

  const render = useCallback(
    // Sandboxed tools are server-owned: a refused call is answered by the server, and its stored
    // result (`Not shown: …`) is the only record that survives a reload.
    (props: {
      args?: Record<string, unknown>;
      status?: string;
      result?: string;
    }) => {
      if (props.result?.startsWith(NOT_SHOWN)) {
        const lead = `${NOT_SHOWN}${component.name}. `;
        const reason = (
          props.result.startsWith(lead)
            ? props.result.slice(lead.length)
            : props.result.slice(NOT_SHOWN.length)
        ).replace(NOT_SHOWN_TAIL, "");
        return <RefusedCard reason={reason} title={component.name} />;
      }
      if (!isHeld) {
        return (
          <RefusedCard
            reason={`${component.name} is not available to this Bot at the moment. An administrator grants components per Bot.`}
            title={component.name}
          />
        );
      }

      // Wait for complete arguments because sandbox source is injected once per keyed instance.
      if (props.status !== "complete") {
        return <ToolLine label={"绘制"} detail={component.name} running />;
      }

      return (
        <div className="my-2">
          <SandboxSurface
            content={{
              css: component.css,
              cssComplete: true,
              html: [component.html],
              htmlComplete: true,
              jsFunctions: `window.__args = ${JSON.stringify(props.args ?? {})};\n${component.jsFunctions}`,
              jsFunctionsComplete: true,
              generating: false,
            }}
            key={JSON.stringify(props.args ?? {})}
          />
        </div>
      );
    },
    [component, isHeld],
  );

  useRenderTool({
    name: component.name,
    parameters,
    render,
  });

  return null;
});
