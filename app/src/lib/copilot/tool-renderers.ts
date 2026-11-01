import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

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

/**
 * 渲染器自己判断「这次画没画出卡片」（复审 #404 第三轮）：有的渲染器在工具失败时返回 null——图片 / 文件工具没拿到文件、
 * 定时任务被拒、render_ui 的规范画不出东西。以它收尾、后面没有字的一轮不能算有回答（屏幕上什么都没有，还没法重试）。
 * 渲染器模块导出判断函数，渲染时用同一个函数决定返回不返回 null，并在模块里按工具名登记到这里；`toolDrawsCard`
 * 在工具有了结果之后问它。还没有结果时：这一轮还在跑，渲染器画的是骨架，算卡片；这一轮已经结束（没按停止、结果也一直没来），
 * 骨架换成一句「…没有完成」（`UnfinishedTool`），不算卡片（复审 #404 第四轮）。没登记的渲染器（问人、确认卡……）总是画卡片。
 */
export type ToolCallOutcome = {
  /** 工具调用的参数（JSON 字符串，和 `toolCall.function.arguments` 一样）。 */
  args: string;
  /** 工具结果（和渲染器拿到的 `result` 一样）。 */
  result: string;
};
export type CardCheck = (call: ToolCallOutcome) => boolean;
export type CardChecks = ReadonlyMap<string, CardCheck>;

const cardChecks = new Map<string, CardCheck>();
/** 渲染器模块登记的判断（按工具名）；`toolDrawsCard` 默认读这一份。 */
export const registeredCardChecks: CardChecks = cardChecks;

/** 登记「这几个工具的渲染器画没画出卡片」的判断。原样返回判断函数，方便模块直接导出。 */
export function registerCardCheck(
  names: readonly string[],
  check: CardCheck,
): CardCheck {
  for (const name of names) cardChecks.set(name, check);
  return check;
}

/**
 * 这个工具调用所在的那一轮已经结束（不再 live）。`TranscriptToolCall` 提供，渲染器按它改说法——比如 render_ui 格式有误时，
 * 还在跑写「机器人会修正后重新生成」，结束了（下面挂着重试）写「界面格式有误，没能显示」。不在对话里（单测）时为 false。
 */
export const ToolTurnEndedContext = createContext(false);

const UNFINISHED: Record<string, string> = {
  image_generate: "画图",
  image_edit: "改图",
  file_share: "分享文件",
  schedule_create: "设置定时任务",
  render_ui: "生成界面",
  delegate_task: "交给后台",
  device_agent_run: "交给电脑",
};

/** 这一轮结束了、结果一直没来时，代替骨架的那一句。 */
export function unfinishedToolText(name: string): string {
  return `${UNFINISHED[name] ?? "这一步"}没有完成`;
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
