import { useRenderTool } from "@/lib/chat/renderers";
import type { Spec } from "@json-render/react";
import { memo, useContext, useMemo } from "react";
import { z } from "zod";
import {
  inspectRenderUiSpec,
  parseRenderUiSpec,
  RENDER_UI_TOOL,
  sanitizeRenderUiSpec,
} from "../../../../shared/json-render/catalog";
import { pruneEmptySections } from "../../../../shared/json-render/empty-sections";
import { ToolLine } from "@/components/channels/tool-line";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { JsonRenderSurface, RenderUiPlaceholder, useRenderUiIdlePreload } from "./render-ui-preload";
import { type CardCheck, registerCardCheck, ToolTurnEndedContext } from "./tool-renderers";

/**
 * 机器人用 `render_ui` 画出的界面（json-render，取代 A2UI）。
 *
 * RENDER ONLY：工具在服务器上执行（server/src/generative-ui/render-ui.ts），那边按同一份目录校验规范。
 * 这里把工具调用的参数画出来：参数是 json-render 的 SpecStream（JSONL），流式到达时每写完一行就多画
 * 一块，所以界面边生成边出现；结束后再完整校验一次，与服务器的结论一致。
 *
 * 只在部署打开 generativeUi 时挂载（provider.tsx），与服务器是否提供这个工具是同一个开关。
 */
const parameters = z.object({
  title: z.string().optional(),
  spec: z.string().optional(),
});

/**
 * 生成完（有了结果）以后画什么：被拒绝或格式有误 → 一行「格式有误」（过程行，不是卡片）；规范画不出任何东西
 * （没有根节点，或剪掉空区块后什么都不剩）→ 不画；否则画这张界面。RenderUiCall 和「这一轮算不算有回答」用同一个函数。
 */
type RenderUiFinal =
  | { kind: "failed"; issues: readonly string[] }
  | { kind: "empty" }
  | { kind: "card"; spec: Spec };

export function renderUiFinal(source: string | undefined, result: string | undefined): RenderUiFinal {
  const verdict = inspectRenderUiSpec(source ?? "");
  const refused = typeof result === "string" && result.startsWith(REFUSAL_MARKER);
  if (refused || !verdict.ok) return { kind: "failed", issues: verdict.ok ? [] : verdict.issues };
  // 先宽容处理（跳过坏节点、修正参数别名），与服务器校验的是同一份；写完后剪掉空区块。
  const spec = source ? pruneEmptySections(sanitizeRenderUiSpec(parseRenderUiSpec(source, false))?.spec ?? null) : null;
  return spec?.root && spec.elements?.[spec.root] ? { kind: "card", spec } : { kind: "empty" };
}

function specArgument(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { spec?: unknown } | null;
    return typeof parsed?.spec === "string" ? parsed.spec : undefined;
  } catch {
    return undefined;
  }
}

/** render_ui 完成后画没画出卡片（格式有误的那一行、画不出东西的都不算）。 */
export const renderUiDrawsCard: CardCheck = registerCardCheck([RENDER_UI_TOOL], ({ args, result }) => renderUiFinal(specArgument(args), result).kind === "card");

/**
 * 格式有误那一行的说法：这一轮还在跑时机器人几乎总会马上改好再调一次（「会修正后重新生成」）；这一轮已经结束时没有下一次了，
 * 下面挂着「这一轮没有回答」和重试，不能再说机器人会重新生成（复审 #404 第四轮）。
 */
export function renderUiFailedDetail(turnEnded: boolean): string {
  return turnEnded ? "界面格式有误，没能显示" : "格式有误，机器人会修正后重新生成";
}

export function RenderUiTool() {
  // 渲染面空闲时预载；历史里已有 render_ui 卡片时 ChatTranscript 会更早立即预载（useRenderUiPreload）。
  useRenderUiIdlePreload();
  useRenderTool({
    name: RENDER_UI_TOOL,
    parameters,
    render: ({ parameters: given, status, result, toolCallId }) => (
      <RenderUiCall
        result={typeof result === "string" ? result : undefined}
        spec={typeof given?.spec === "string" ? given.spec : undefined}
        streaming={status !== "complete"}
        title={typeof given?.title === "string" ? given.title : undefined}
        toolCallId={typeof toolCallId === "string" ? toolCallId : undefined}
      />
    ),
  });
  return null;
}

const RenderUiCall = memo(function RenderUiCall({
  spec: source,
  title,
  streaming,
  result,
  toolCallId,
}: {
  spec?: string;
  title?: string;
  streaming: boolean;
  result?: string;
  toolCallId?: string;
}) {
  // 流式时每写完一行就多画一块（还没写完的列表本来就是空的，不剪空区块）；写完后按 renderUiFinal 画。
  const partial = useMemo(
    () => (streaming && source ? (sanitizeRenderUiSpec(parseRenderUiSpec(source, true))?.spec ?? null) : null),
    [source, streaming],
  );
  const final = useMemo(() => (streaming ? null : renderUiFinal(source, result)), [source, streaming, result]);
  const turnEnded = useContext(ToolTurnEndedContext);

  if (final?.kind === "failed") {
    /*
     * 一行，不是红色大卡片：格式错误的调用会把问题列表还给机器人，它几乎总是马上改好再调一次，
     * 所以这是一次「没成功的尝试」，不是需要用户处理的错误。原始问题收在展开里。
     */
    return (
      <ToolLine detail={renderUiFailedDetail(turnEnded)} failed label={"生成界面"}>
        <pre className="whitespace-pre-wrap font-mono">
          {final.issues.length > 0 ? final.issues.join("\n") : (result ?? "")}
        </pre>
      </ToolLine>
    );
  }

  const spec = final ? (final.kind === "card" ? final.spec : null) : partial;
  if (!spec?.root || !spec.elements?.[spec.root]) {
    return streaming ? <RenderUiPlaceholder /> : null;
  }

  return <JsonRenderSurface spec={spec} streaming={streaming} title={title} toolCallId={toolCallId} />;
});
