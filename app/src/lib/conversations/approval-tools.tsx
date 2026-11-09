import { useMemo } from "react";
import type { z } from "zod";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { type ToolRenderProps, useRenderTool } from "@/lib/chat/renderers";
import { lineOnlyRender } from "./tool-renderers";

export async function neverThrow<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T | { ok: false; reason: string }> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) throw error;
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    console.warn("[chisabot] frontend tool failed", message);
    return {
      ok: false,
      reason: message ? `这一步没有成功：${message}` : "这一步没有成功。",
    };
  }
}

/**
 * §102：长动作的响应先以 200 开始、结果流式写出，原来的状态码（202 等待、4xx/5xx 错误）放在正文的 `status`。
 * 普通响应没有这个字段，照旧用 HTTP 状态码。
 */
export function effectiveStatus(httpStatus: number, payload: unknown): number {
  return httpStatus === 200 &&
    payload &&
    typeof payload === "object" &&
    "status" in payload &&
    typeof (payload as { status: unknown }).status === "number"
    ? (payload as { status: number }).status
    : httpStatus;
}

/** Computer execution and authorization belong to the server; this hook only draws results. */
export function useComputerToolRenderer<S extends z.ZodType>(tool: {
  name: string;
  parameters: S;
  lineOnly?: boolean;
  render?: (props: ToolRenderProps<z.infer<S>>) => React.ReactNode;
}) {
  const render = useMemo(() => {
    const Original = tool.render;
    const Renderer = (props: ToolRenderProps<z.infer<S>>) => (
      <InlineApproval
        toolCallId={props.toolCallId}
        fallback={Original ? <Original {...props} /> : null}
      />
    );
    return tool.lineOnly ? lineOnlyRender(Renderer) : Renderer;
  }, [tool.render, tool.lineOnly]);
  useRenderTool({ name: tool.name, parameters: tool.parameters, render });
}
