import type { Spec } from "@json-render/react";
import { useEffect } from "react";
import { lazyPart } from "@/components/ui/lazy-part";

/**
 * render_ui 的渲染面（json-render-surface，约 28K gz）按需下载，不进入口包，也不在聊天区挂载时立刻下载：
 *
 * - 对话历史里已经有 render_ui 卡片（例如从缓存打开的旧对话）→ 立即下载，不等 /api/capabilities 返回，
 *   卡片直接画出来，不先闪骨架再顶跳页面；
 * - 否则等 RenderUiTool 挂载（部署开了 generativeUi）后浏览器空闲时再下载（requestIdleCallback，
 *   不支持时 setTimeout 兜底），不和首屏争带宽；机器人之后真画卡片时多半已经在缓存里。
 */
export const JsonRenderSurface = lazyPart<{
  spec: Spec;
  streaming: boolean;
  title?: string;
  toolCallId?: string;
}>(
  () => import("./json-render-surface").then((m) => m.JsonRenderSurface),
  () => <RenderUiPlaceholder />,
);

export const RENDER_UI_IDLE_TIMEOUT_MS = 4000;
const FALLBACK_DELAY_MS = 1500;

type ToolCallLike = { function?: { name?: unknown } | null };
type MessageLike = {
  role?: unknown;
  toolCalls?: ReadonlyArray<ToolCallLike> | null;
};

/** 历史里有没有 render_ui 工具调用。 */
export function hasRenderUiCall(
  messages: ReadonlyArray<MessageLike> | null | undefined,
): boolean {
  if (!messages) return false;
  for (const message of messages) {
    const calls = message?.toolCalls;
    if (!calls) continue;
    for (const call of calls)
      if (call?.function?.name === "render_ui") return true;
  }
  return false;
}

/** 空闲时执行一次；返回取消函数。 */
export function whenIdle(
  run: () => void,
  timeout = RENDER_UI_IDLE_TIMEOUT_MS,
): () => void {
  const w = typeof window === "undefined" ? undefined : window;
  if (w && typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(() => run(), { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(run, FALLBACK_DELAY_MS);
  return () => clearTimeout(id);
}

/**
 * 聊天页用（ChatTranscript）：历史里有 render_ui 卡片就立即预载，不等 capabilities 返回、RenderUiTool 挂上。
 * 没有就什么都不做，交给 useRenderUiIdlePreload。preload 自身幂等。
 */
export function useRenderUiPreload(
  messages: ReadonlyArray<MessageLike> | null | undefined,
  preload: () => unknown = JsonRenderSurface.preload,
): void {
  const hasCard = hasRenderUiCall(messages);
  useEffect(() => {
    if (hasCard) void preload();
  }, [hasCard, preload]);
}

/** RenderUiTool 用（只在部署开了 generativeUi 时挂载）：浏览器空闲时预载，不和首屏抢带宽。 */
export function useRenderUiIdlePreload(
  preload: () => unknown = JsonRenderSurface.preload,
): void {
  useEffect(() => whenIdle(() => void preload()), [preload]);
}

/** 与最终卡片同形状的骨架（DESIGN.md §1 层级 ②），第一块内容到达后原地淡入替换。 */
export function RenderUiPlaceholder() {
  return (
    <div
      aria-busy="true"
      aria-label={"正在生成界面"}
      className="jr-surface jr-placeholder"
      role="status"
    >
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
