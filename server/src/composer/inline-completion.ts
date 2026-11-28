/**
 * 输入框智能第三层：行内补全（CB-145 PR6）。
 *
 * 用户打字途中，预判草稿的续写内容，以 ghost text 形式给出「只追加」的 suffix——
 * 接受（Tab / 右箭头）就把 suffix 接到草稿尾部，拒绝（继续敲 / Esc）就安静消失。
 * 与 AI 建议共用同一套成本护栏（限流 / 在飞去重 / 缓存 / 超时），
 * 经场景化路由的 completion 场景调用；默认关闭，completionEnabled 显式打开。
 *
 * 只追加是硬约束：解析层把模型吐出的任何东西清洗成「草稿的续写」——
 * 复述草稿的前缀剥掉、换行掐断、超长掐断；清洗后为空就当作没有补全。
 */
import {
  type AiSuggestCompleter,
  type ComposerAiSuggester,
  createComposerAiSuggester,
} from "./ai-suggestions";

export const INLINE_COMPLETION_MAX_CHARS = 60;

export function buildInlineCompletionPrompt(draft: string): string {
  return [
    "用户正在输入框里打字，草稿如下。请预判用户接下来最可能继续输入的内容。",
    "要求：只输出续写部分的文字本身，不要重复草稿已有的内容；不要解释、不要引号；",
    `续写不超过 ${INLINE_COMPLETION_MAX_CHARS} 字；如果看不出明显的续写方向，输出空。`,
    "",
    "草稿：",
    draft,
  ].join("\n");
}

/**
 * 把模型输出清洗成草稿的 suffix：
 * 取第一行、剥掉复述的草稿前缀、去引号，剩下的才是可追加部分；空则无效。
 */
export function parseInlineCompletion(
  raw: string,
  draft: string,
): string | null {
  const firstLine = raw.split("\n")[0] ?? "";
  let text = firstLine.replace(/^["'「『“”]+|["'」』“”]+$/g, "").trim();
  if (!text) return null;
  // 模型复述了草稿开头：剥到草稿结尾之后。允许空白差异的宽松匹配。
  const squashed = (value: string) => value.replace(/\s+/g, "");
  if (squashed(text).startsWith(squashed(draft))) {
    let rest = text;
    let consumed = 0;
    const draftSquashed = squashed(draft);
    let matched = 0;
    while (consumed < rest.length && matched < draftSquashed.length) {
      const ch = rest[consumed];
      consumed += 1;
      if (/\s/.test(ch)) continue;
      if (ch === draftSquashed[matched]) matched += 1;
      else break;
    }
    rest = matched >= draftSquashed.length ? rest.slice(consumed) : rest;
    text = rest.trim();
  }
  if (!text) return null;
  const chars = [...text];
  if (chars.length > INLINE_COMPLETION_MAX_CHARS) {
    text = chars.slice(0, INLINE_COMPLETION_MAX_CHARS).join("");
  }
  // suffix 与草稿尾完全相同（模型没说出任何新东西）时无效。
  if (draft.endsWith(text)) return null;
  return text;
}

/** 行内补全建议器：复用 AI 建议的护栏机器，注入补全专用 prompt 与解析。 */
export function createInlineCompletionSuggester(
  completer: AiSuggestCompleter,
): ComposerAiSuggester {
  return createComposerAiSuggester({
    completer,
    promptFor: (context) =>
      buildInlineCompletionPrompt(context.map((m) => m.text).join("\n")),
    parseOutput: (raw, context) => {
      const draft = context.map((m) => m.text).join("\n");
      const completion = parseInlineCompletion(raw, draft);
      return completion ? [completion] : [];
    },
  });
}

export type InlineCompletionSuggester = ComposerAiSuggester;
