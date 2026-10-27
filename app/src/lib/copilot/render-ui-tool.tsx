import { useRenderTool } from "@copilotkit/react-core/v2";
import { createStateStore, JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { memo, useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import {
  inspectRenderUiSpec,
  parseRenderUiSpec,
  RENDER_UI_TOOL,
  sanitizeRenderUiSpec,
} from "../../../../shared/json-render/catalog";
import { pruneEmptySections } from "../../../../shared/json-render/empty-sections";
import { ToolLine } from "@/components/channels/tool-line";
import { useConversation } from "@/lib/copilot/conversation";
import { jsonRenderRegistry } from "@/lib/copilot/json-render/registry";
import { ChoiceProvider, choiceOptionsOf, copyText, openInNewTab, RichUiProvider } from "@/lib/copilot/json-render/rich-context";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";

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

/** 与最终卡片同形状的骨架（DESIGN.md §1 层级 ②），第一块内容到达后原地淡入替换。 */
function RenderUiPlaceholder() {
  return (
    <div aria-busy="true" aria-label={"正在生成界面"} className="jr-surface jr-placeholder" role="status">
      <div className="jr-card">
        <div className="jr-card-h">
          <span className="jr-skel-title" />
        </div>
        <div className="jr-card-b">
          <span className="jr-skel-line" />
          <span className="jr-skel-line is-short" />
        </div>
      </div>
      <span className="jr-placeholder-label">{"正在生成界面…"}</span>
    </div>
  );
}

/** 把规范里的 /state 顶层键同步进这张界面的状态（只在生成过程中；生成完毕后状态归用户的输入所有）。 */
function topLevelPointers(state: Record<string, unknown> | undefined) {
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state ?? {})) {
    updates[`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`] = value;
  }
  return updates;
}

function JsonRenderSurface({
  spec,
  streaming,
  title,
  toolCallId,
}: {
  spec: Spec;
  streaming: boolean;
  title?: string;
  toolCallId?: string;
}) {
  const conversation = useConversation();
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // 互斥选项（CB-090）：这张界面里的 choice 按钮，和对话记录里这张界面之后用户说的第一句话。
  const choiceOptions = useMemo(
    () => choiceOptionsOf(spec.elements as Record<string, { type?: string; props?: unknown }> | undefined),
    [spec.elements],
  );
  const answered =
    !streaming && toolCallId && choiceOptions.length > 0 ? (conversation?.replyAfter?.(toolCallId) ?? null) : null;

  // 每张界面一个状态仓库；表单输入写在这里，不会影响别的消息里的界面。
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per surface on purpose.
  const store = useMemo(() => createStateStore({ ...(spec.state ?? {}) }), []);
  const settled = useRef(!streaming);
  useEffect(() => {
    if (settled.current) return;
    store.update(topLevelPointers(spec.state as Record<string, unknown> | undefined));
    if (!streaming) settled.current = true;
  }, [spec.state, streaming, store]);

  const handlers = useMemo(
    () => ({
      send_message: (params: Record<string, unknown>) => {
        const ask = conversationRef.current?.ask;
        // `text` 是目录里的参数名；个别模型写成 message / content，照样发出去而不是让按钮没反应。
        const said = [params.text, params.message, params.content].find(
          (value): value is string => typeof value === "string" && value.trim() !== "",
        );
        const base = said?.trim() ?? "";
        if (!ask || !base) return;
        const path = typeof params.includeState === "string" ? params.includeState : "";
        const attached = path ? store.get(path) : undefined;
        ask(
          attached === undefined
            ? base
            : `${base}\n\n\`\`\`json\n${JSON.stringify(attached, null, 2)}\n\`\`\``,
        );
      },
      open_link: (params: Record<string, unknown>) => {
        const url = typeof params.url === "string" ? params.url : "";
        if (!/^https?:\/\//i.test(url)) return;
        window.open(url, "_blank", "noopener,noreferrer");
      },
      copy_text: (params: Record<string, unknown>) => {
        if (typeof params.text === "string" && params.text) void copyText(params.text);
      },
      // 对话里的界面没有「刷新」：只有右栏面板会重新取数。
      refresh_panel: () => {},
    }),
    [store],
  );
  // 列表行 / 磁贴上的 ask（替用户发一句话）走同一个对话。
  const rich = useMemo(
    () => ({
      surface: "chat" as const,
      openLink: openInNewTab,
      copy: copyText,
      ask: conversation?.ask ? (text: string) => conversationRef.current?.ask(text) : undefined,
    }),
    [conversation?.ask],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
    <div
      aria-busy={streaming || undefined}
      aria-label={title || "机器人生成的界面"}
      className="jr-surface"
      data-streaming={streaming || undefined}
      role="region"
    >
      <RichUiProvider value={rich}>
        <ChoiceProvider ask={rich.ask} initial={answered} options={choiceOptions}>
          <JSONUIProvider handlers={handlers} registry={jsonRenderRegistry} store={store}>
            <Renderer loading={streaming} registry={jsonRenderRegistry} spec={spec} />
          </JSONUIProvider>
        </ChoiceProvider>
      </RichUiProvider>
    </div>
  );
}
