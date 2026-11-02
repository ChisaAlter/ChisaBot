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
   * 超预算：system 行全留（角色设定 / 摘要都在里面），其余找「尾巴还能装进预算的最早
   * user 边界」——边界之前整段丢掉，tool_call / tool-result 的配对因此天然完整。
   * 之前从尾部往回找，预算再够也总是只留最后一条，上下文全丢（QA1102-14 r1）。
   * 连最后的 user 边界都装不下时照留最后一条：总得有东西发给模型。
   */
  const systems = normalized.filter((message) => message.role === "system");
  const rest = normalized.filter((message) => message.role !== "system");
  let cut = Math.max(0, rest.length - 1);
  for (let index = 0; index < rest.length; index++) {
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

/** 单个文档块可读进 prompt 的文字上限（同桥 bridge.mjs 的 DOCUMENT_TEXT_MAX_CHARS）。 */
const DOCUMENT_TEXT_MAX_CHARS = 120_000;

function filePartToText(part: unknown): unknown {
  if (!part || typeof part !== "object" || (part as Part).type !== "file")
    return part;
  const file = part as Part;
  const name =
    typeof file.filename === "string" && file.filename
      ? file.filename.slice(0, 200)
      : "";
  const mime = typeof file.mediaType === "string" ? file.mediaType : "";
  // 文本类附件把字节解成文字随消息走；二进制（PDF 等）换成如实占位的文字。
  const textual =
    /^text\//.test(mime) ||
    ["application/json", "application/xml", "application/javascript"].includes(
      mime,
    );
  if (textual) {
    try {
      const raw =
        typeof file.data === "string"
          ? Buffer.from(file.data, "base64").toString("utf8")
          : file.data instanceof Uint8Array
            ? Buffer.from(file.data).toString("utf8")
            : "";
      if (raw.trim()) {
        const body =
          raw.length > DOCUMENT_TEXT_MAX_CHARS
            ? `${raw.slice(0, DOCUMENT_TEXT_MAX_CHARS)}\n\n[attachment truncated at ${DOCUMENT_TEXT_MAX_CHARS} characters]`
            : raw;
        return {
          type: "text",
          text: `Attached file${name ? ` "${name}"` : ""}:\n\n${body}`,
        };
      }
    } catch {}
  }
  const label = `document${name ? ` "${name}"` : ""}`;
  return { type: "text", text: `[${label} — this model cannot receive files]` };
}

/**
 * QA1102-14 r1：发给不收 `file` 文档块的模型（DeepSeek 这类 OpenAI 兼容端点对
 * 不认识的 part 类型整单 400）之前，把 prompt 里的 `file` part 换成文字 /
 * 占位——第一次请求就换，不是等 400 之后才救。没有文档块时原样返回同一对象。
 */
export function filePartsToText(options: unknown): unknown {
  const call = options as { prompt?: unknown } | null;
  if (!call || !Array.isArray(call.prompt)) return options;
  const prompt = call.prompt as Row[];
  let touched = false;
  const next = prompt.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const parts = (message.content as unknown[]).map(filePartToText);
    if (
      parts.every(
        (part, index) => part === (message.content as unknown[])[index],
      )
    )
      return message;
    touched = true;
    return { ...message, content: parts };
  });
  return touched ? { ...call, prompt: next } : options;
}
