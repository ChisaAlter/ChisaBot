import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { useCallback, useContext, useSyncExternalStore } from "react";

/**
 * 对话里一个工具调用画不画「看得见的卡片」（回复显示①复审，2026-10-29）。
 *
 * 一轮以生成图片、分享文件、问人、确认卡这类卡片收尾、后面没有字，也是回答了：不能再挂「这一轮没有回答」和重试
 * （点重试会重新生成图片、重新建 issue）。判断和真正画卡片的地方用同一份东西，不另列名单：
 * - 有没有渲染器：读 CopilotKit 里注册的渲染器（`useRenderTool` / `useFrontendTool` / `useHumanInTheLoop`），
 *   挑法和 `useRenderToolCall` 一样（先按名字、偏好当前 agent，再退到 `"*"`）；
 * - 只画一行过程（和工具行一样，过程默认隐藏时看不见）或者什么都不画的渲染器，在注册的地方用 `lineOnlyRender`
 *   标出来，不算卡片；
 * - 没有渲染器时 `ServerToolLine` 只有桌面宿主被拒（`isHostAccessRefusal`）会画成提示，其余是过程行。
 */

export type ToolRenderer = { name: string; agentId?: string; render: unknown };

const NO_RENDERERS: readonly ToolRenderer[] = [];
const lineOnly = new WeakSet<object>();

/** 标出「只画一行过程 / 什么都不画」的渲染函数：它画的不算一张卡片。原样返回。 */
export function lineOnlyRender<T extends object>(render: T): T {
  lineOnly.add(render);
  return render;
}

export function isLineOnlyRender(render: unknown): boolean {
  return (
    (typeof render === "function" ||
      (typeof render === "object" && render !== null)) &&
    lineOnly.has(render as object)
  );
}

/** 和 CopilotKit `useRenderToolCall` 同一个挑法：同名的先挑当前 agent 的、再挑没绑 agent 的，最后退到 `"*"`。 */
export function pickToolRenderer(
  renderers: readonly ToolRenderer[],
  name: string,
  agentId?: string,
): ToolRenderer | undefined {
  const exact = renderers.filter((renderer) => renderer.name === name);
  return (
    exact.find((renderer) => renderer.agentId === agentId) ??
    exact.find((renderer) => !renderer.agentId) ??
    exact[0] ??
    renderers.find((renderer) => renderer.name === "*")
  );
}

/**
 * 当前注册的工具渲染器（跟着注册 / 注销更新）。不在 CopilotKitProvider 里时（单测只包了 QueryClientProvider）
 * 返回空列表，不抛错——`useCopilotKit` 会抛，所以这里直接读 context。
 */
export function useToolRenderers(): readonly ToolRenderer[] {
  const copilotkit = useContext(CopilotKitContext)?.copilotkit ?? null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      copilotkit
        ? copilotkit.subscribe({ onRenderToolCallsChanged: onChange })
            .unsubscribe
        : () => undefined,
    [copilotkit],
  );
  const read = () =>
    (copilotkit?.renderToolCalls as readonly ToolRenderer[] | undefined) ??
    NO_RENDERERS;
  return useSyncExternalStore(subscribe, read, read);
}

const NO_ACTIVITY_RENDERERS: readonly { activityType: string }[] = [];

/** 活动消息的渲染器（Provider 配置里给的，和 `useRenderActivityMessage` 读同一份）；不在 Provider 里为空。 */
export function useActivityRenderers(): readonly { activityType: string }[] {
  return (
    (useContext(CopilotKitContext)?.copilotkit?.renderActivityMessages as
      | readonly { activityType: string }[]
      | undefined) ?? NO_ACTIVITY_RENDERERS
  );
}
