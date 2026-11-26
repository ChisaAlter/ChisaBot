/**
 * 检测模型正文里泄漏的原始工具调用标记（如推理网关未解析或模型退化输出）。
 *
 * 只有当标记后紧跟本轮实际注册的工具名（整词匹配）且中间仅隔合法调用包装语法时才触发，
 * 避免在技术问答、示例代码或教学说明中误杀正常文本。
 */

export const LEAKED_TOOL_CALL_MARKERS = [
  "<tool_call>",
  "<function=",
  "<|python_tag|>",
  "[TOOL_CALLS]",
  "<｜tool▁calls▁begin｜>",
  "<|tool_calls_begin|>",
  "<｜tool▁call▁begin｜>",
  "<|tool_call_begin|>",
  "<invoke name=",
  "<tool_use>",
];

export const LEAKED_TOOL_CALL_NUDGE =
  "检测到你在正文里输出了未通过工具接口调用的原始工具调用标记。请不要把工具调用写成文本标签，改用系统提供的标准工具调用接口重新执行。";

export const LEAKED_TOOL_CALL_ABORT_MESSAGE =
  "模型连续多次输出未执行的工具调用文本，已中止本轮回复以避免向你展示内部调用标记。请重试或换一种提问方式。";

const MAX_LOOKAHEAD_CHARS = 160;
const TOOL_FRAMING_PREFIX_RE =
  /^[\s"'`{[(<:=/,|｜▁>\\-]*(?:(?:function|name|tool_name|tool|call|arguments|input|args|tool▁call▁begin|tool_call_begin|tool▁sep|tool_sep)[\s"'`:=<>｜▁|\\-]*)*$/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectToolNames(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const seen = new Set();
  for (const entry of tools) {
    const rawName = typeof entry === "string" ? entry : entry?.name;
    if (typeof rawName !== "string") continue;
    const trimmed = rawName.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * 检测文本中是否包含真实的泄漏工具调用。
 *
 * @param {string | undefined | null} text 模型生成的助手回复正文
 * @param {Array<string | { name?: string }> | undefined | null} tools 本轮绑定注册的工具列表
 * @returns {{ marker: string; toolName: string; index: number } | null}
 */
export function detectLeakedToolCall(text, tools) {
  if (typeof text !== "string" || text.length === 0) return null;
  const toolNames = collectToolNames(tools);
  if (toolNames.length === 0) return null;

  const toolPattern = toolNames.map(escapeRegExp).join("|");
  const wholeToolRe = new RegExp(
    `(?<![A-Za-z0-9_.-])(${toolPattern})(?![A-Za-z0-9_.-])`,
  );

  for (const marker of LEAKED_TOOL_CALL_MARKERS) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(marker, searchFrom);
      if (idx === -1) break;
      const tailStart = idx + marker.length;
      const tail = text.slice(tailStart, tailStart + MAX_LOOKAHEAD_CHARS);
      const match = wholeToolRe.exec(tail);
      if (match) {
        const between = tail.slice(0, match.index);
        if (TOOL_FRAMING_PREFIX_RE.test(between)) {
          return {
            marker,
            toolName: match[1],
            index: idx,
          };
        }
      }
      searchFrom = tailStart;
    }
  }

  return null;
}
