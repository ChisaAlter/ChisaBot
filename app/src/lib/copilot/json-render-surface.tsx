import { createStateStore, JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { useEffect, useMemo, useRef } from "react";
import { useConversation } from "@/lib/copilot/conversation";
import { jsonRenderRegistry } from "@/lib/copilot/json-render/registry";
import { ChoiceProvider, choiceOptionsOf, copyText, openInNewTab, RichUiProvider } from "@/lib/copilot/json-render/rich-context";

/*
 * 对话里 render_ui 界面的真正渲染（json-render 注册表、图表、表单……）。从 render-ui-tool.tsx 拆出来按需加载：
 * 工具注册（useRenderTool）要在聊天首屏就挂上，但只有机器人真的画了界面才需要这一整套组件（DESIGN.md §41.5）。
 */

/** 把规范里的 /state 顶层键同步进这张界面的状态（只在生成过程中；生成完毕后状态归用户的输入所有）。 */
function topLevelPointers(state: Record<string, unknown> | undefined) {
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state ?? {})) {
    updates[`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`] = value;
  }
  return updates;
}

export function JsonRenderSurface({
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
