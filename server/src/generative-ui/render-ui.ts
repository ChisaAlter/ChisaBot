import { z } from "zod";
import {
  inspectRenderUiSpec,
  RENDER_UI_SHOWN,
  RENDER_UI_TOOL,
  renderUiPrompt,
} from "../../../shared/json-render/catalog";
import { REPLY_SOURCES_GUIDANCE } from "../../../shared/reply-sources";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

/**
 * `render_ui`：机器人用 json-render 规范在对话里画界面（取代 A2UI）。
 *
 * 在服务器上执行，只做一件事：按共享目录校验规范。通过就告诉模型「已显示」，浏览器用同一份目录把
 * 工具调用的参数画出来（参数流式到达时就边画边出现）；不通过就把问题列表还给模型，让它改了再调一次。
 * 工具本身不碰任何外部系统，所以不需要审批；界面里的按钮最多替用户发一条消息，真正的操作仍走机器人
 * 自己的工具与审批。
 *
 * 只在 DeploymentConfig.generativeUi 打开时提供（见 index.ts loadToolsForActor）。
 */
export const renderUiParameters = z.object({
  title: z
    .string()
    .max(120)
    .optional()
    .describe("界面的简短标题（可选，仅用于无障碍说明）"),
  spec: z
    .string()
    .min(1)
    .max(200_000)
    .describe(
      "json-render SpecStream：JSONL，每行一个 RFC 6902 JSON Patch，按说明里的格式构建界面",
    ),
});

let cachedDescription: string | null = null;

/** 目录提示词生成一次即可：目录在进程内不会变。 */
function description(): string {
  cachedDescription ??= renderUiPrompt();
  return cachedDescription;
}

export function executeRenderUi(args: unknown): string {
  const parsed = renderUiParameters.safeParse(args);
  if (!parsed.success) {
    return `${REFUSAL_MARKER} render_ui 需要 spec 参数（JSONL 字符串）。`;
  }
  const result = inspectRenderUiSpec(parsed.data.spec);
  if (!result.ok) {
    return [
      `${REFUSAL_MARKER} 界面规范无效，没有显示。请修正以下问题后重新调用 render_ui：`,
      ...result.issues.map((issue) => `- ${issue}`),
    ].join("\n");
  }
  const shown = `${RENDER_UI_SHOWN} 界面已在对话中显示（${result.elementCount} 个元素）。不要再用文字重复界面里的内容（画了表格就不要再写一份 Markdown 表格或逐行列表）；用户点击按钮时你会收到一条用户消息。`;
  // 跳过的元素告诉模型，下次写对；但界面已经显示了，不要为此重画。
  return result.warnings?.length
    ? `${shown}\n以下内容不合规，已跳过（不必重画，下次注意）：\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : shown;
}

/** `replySources`：网页聊天且部署打开了结构化来源，随这个工具把来源规则带进提示词（只有网页才有 render_ui）。 */
export function renderUiTools(
  options: { replySources?: boolean } = {},
): GrantedTool[] {
  return [
    {
      ...(options.replySources ? { guidance: REPLY_SOURCES_GUIDANCE } : {}),
      name: RENDER_UI_TOOL,
      ref: `generative-ui/${RENDER_UI_TOOL}`,
      description: description(),
      parameters: renderUiParameters,
      execute: async (args) => executeRenderUi(args),
    },
  ];
}
