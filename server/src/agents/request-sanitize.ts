/**
 * QA1102-14：主模型 400（invalid input / context too long）后那一次重试用的请求清洗。
 *
 * 内置内核发给 AI SDK 的 call options（`prompt` 是 LanguageModelV2 消息数组，content 是
 * part 数组）先过一遍这个纯函数：空 text part 去掉 / 整条空消息补占位、超长 tool-result
 * 截断（Hermes 路径在 Python 适配器里做同一套，见 chisabot_protocol.normalize_history）、
 * 超过预算时把最老的整轮丢掉——按 user 消息边界切，不切散 tool_call / tool-result 的配对。
 */

/** tool-result 单条输出超过这么多字符就截断（同 Python 侧的 ~16k）。 */
export const TOOL_RESULT_MAX_CHARS = 16_000;
/** 重试请求的 prompt 估算上限：64k 字符 ≈ 32k 上下的 token（中英混合），DeepSeek 级别够安全。 */
export const RETRY_PROMPT_CHARS = 64_000;

const EMPTY_TEXT = "[empty]";
const TRUNCATED_NOTE = "...[truncated]";

type Part = Record<string, unknown>;
type Row = { role?: unknown; content?: unknown } & Record<string, unknown>;

function cleanParts(content: unknown): Part[] {
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const part = raw as Part;
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim()) parts.push(part);
      continue;
    }
    if (part.type === "tool-result") {
      const output = part.output;
      if (
        output &&
        typeof output === "object" &&
        !Array.isArray(output) &&
        (output as Part).type === "text" &&
        typeof (output as Part).value === "string" &&
        ((output as Part).value as string).length > TOOL_RESULT_MAX_CHARS
      ) {
        const value = (output as Part).value as string;
        parts.push({
          ...part,
          output: {
            ...(output as Part),
            value: `${value.slice(0, TOOL_RESULT_MAX_CHARS)}${TRUNCATED_NOTE}`,
          },
        });
        continue;
      }
    }
    parts.push(part);
  }
  return parts;
}

const sizeOf = (rows: readonly Row[]) =>
  rows.reduce(
    (sum, row) => sum + String(JSON.stringify(row.content ?? "")).length,
    0,
  );

export function sanitizeCallOptionsForRetry(options: unknown): unknown {
  const call = options as { prompt?: unknown } | null;
  if (!call || !Array.isArray(call.prompt)) return options;
  const prompt = call.prompt as Row[];
  const normalized = prompt.map((message) => {
    if (typeof message.content === "string") {
      return message.content.trim()
        ? message
        : { ...message, content: EMPTY_TEXT };
    }
    const parts = cleanParts(message.content);
    return {
      ...message,
      content: parts.length ? parts : [{ type: "text", text: EMPTY_TEXT }],
    };
  });
  if (sizeOf(normalized) <= RETRY_PROMPT_CHARS)
    return { ...call, prompt: normalized };
  /*
   * 超预算：system 行全留（角色设定 / 摘要都在里面），其余从尾部往回收，收到一个 user
   * 边界为止——边界之前整段丢掉，tool_call / tool-result 的配对因此天然完整。
   * 最后一条 user 也装不下时照留它：总得有东西发给模型。
   */
  const systems = normalized.filter((message) => message.role === "system");
  const rest = normalized.filter((message) => message.role !== "system");
  let cut = Math.max(0, rest.length - 1);
  for (let index = rest.length - 1; index > 0; index--) {
    if (
      rest[index]?.role === "user" &&
      sizeOf(rest.slice(index)) <= RETRY_PROMPT_CHARS
    ) {
      cut = index;
      break;
    }
  }
  return { ...call, prompt: [...systems, ...rest.slice(cut)] };
}
