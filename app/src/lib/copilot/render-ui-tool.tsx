import { useRenderTool } from "@copilotkit/react-core/v2";
import { memo, useMemo } from "react";
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
import { JsonRenderSurface, RenderUiPlaceholder } from "./render-ui-preload";

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

export function RenderUiTool() {
  // 渲染面何时预载由聊天页决定（useRenderUiPreload）：有 render_ui 历史立即、否则空闲时。
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
  // 先宽容处理（跳过坏节点、修正参数别名），与服务器校验的是同一份。
  const spec = useMemo(
    // 流式时还没写完的列表本来就是空的，只在写完后剪掉空区块。
    () => {
      const parsed = source ? (sanitizeRenderUiSpec(parseRenderUiSpec(source, streaming))?.spec ?? null) : null;
      return streaming ? parsed : pruneEmptySections(parsed);
    },
    [source, streaming],
  );
  const verdict = useMemo(
    () => (streaming ? null : inspectRenderUiSpec(source ?? "")),
    [source, streaming],
  );
  const refused = typeof result === "string" && result.startsWith(REFUSAL_MARKER);

  if (!streaming && (refused || (verdict && !verdict.ok))) {
    /*
     * 一行，不是红色大卡片：格式错误的调用会把问题列表还给机器人，它几乎总是马上改好再调一次，
     * 所以这是一次「没成功的尝试」，不是需要用户处理的错误。原始问题收在展开里。
     */
    const issues = verdict && !verdict.ok ? verdict.issues : [];
    return (
      <ToolLine detail={"格式有误，机器人会修正后重新生成"} failed label={"生成界面"}>
        <pre className="whitespace-pre-wrap font-mono">
          {issues.length > 0 ? issues.join("\n") : (result ?? "")}
        </pre>
      </ToolLine>
    );
  }

  if (!spec?.root || !spec.elements?.[spec.root]) {
    return streaming ? <RenderUiPlaceholder /> : null;
  }

  return <JsonRenderSurface spec={spec} streaming={streaming} title={title} toolCallId={toolCallId} />;
});
