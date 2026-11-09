import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
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
import { useBotOnScreen } from "@/lib/kept-visible";
import {
  type PublishedSandboxed,
  publishedSandboxedQueryOptions,
} from "@/lib/sandboxed/queries";
import {
  NOT_SHOWN,
  NOT_SHOWN_TAIL,
} from "../../../../shared/component-markers";

/**
 * Browser-authored components use the same component grants as compiled gallery components, but
 * render published runtime markup in the SDK sandbox.
 */
export function SandboxedTools() {
  // Grants are fetched only once a surface has declared its Bot; the placeholder is not one the
  // server knows, and asking would 404 on every poll.
  const declared = useDeclaredBotId();
  const { data: published } = useQuery(publishedSandboxedQueryOptions());
  // 这个机器人的聊天被外壳藏着时不轮询授权（DESIGN.md §98.3）；调用时服务端照样再查。
  const declaredOnScreen = useBotOnScreen(declared);
  const { data: granted } = useQuery({
    ...agentComponentsQueryOptions(declared),
    ...(declaredOnScreen ? {} : { refetchInterval: false as const }),
  });

  const held = new Map(
    (granted ?? []).map((component: GrantedComponent) => [
      component.name,
      component.description,
    ]),
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

/** Convert an author's JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(schema: Record<string, unknown>) {
  try {
    const converted = z.fromJSONSchema(schema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {
    // Unreadable author schemas fall back to permissive arguments and server-side checks.
  }
  return z.object({}).catchall(z.unknown());
}

function SandboxedTool({
  component,
  description,
}: {
  component: PublishedSandboxed;
  description: string | undefined;
}) {
  const isHeld = description !== undefined;

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
    parameters: parametersFor(component.argumentSchema),
    render,
  });

  return null;
}
