export type RawLine = {
  index: number;
  text: string;
  eol: string;
  start: number;
  end: number;
};

export type FenceState = {
  char: "`" | "~";
  len: number;
} | null;

export const CARD_CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;

const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;

/**
 * 追踪 CommonMark 围栏代码块状态（支持 ``` 与 ~~~，闭合围栏须同字符且长度不小于开启围栏）。
 */
export function updateFenceState(line: string, current: FenceState): FenceState {
  const match = FENCE_RE.exec(line);
  const marker = match?.[1];
  if (!marker) return current;
  const char = marker.charAt(0) === "~" ? "~" : "`";
  const rest = match?.[2] ?? "";
  if (!current) {
    // 围栏信息串中若出现反引号（仅对 ` 围栏），按 CommonMark 不构成开启围栏。
    if (char === "`" && rest.includes("`")) return current;
    return { char, len: marker.length };
  }
  if (current.char === char && marker.length >= current.len && !rest.trim()) {
    return null;
  }
  return current;
}

/**
 * 按字节/字符偏移拆分文本行，完整保留 CRLF / LF / 独立 CR 行尾，确保未修改区间零字节扰动。
 */
export function splitLinesWithOffsets(raw: string): RawLine[] {
  if (!raw) return [];
  const out: RawLine[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let index = 0;
  for (;;) {
    const match = re.exec(raw);
    if (!match || match[0].length === 0) break;
    const text = match[1] ?? "";
    const eol = match[2] ?? "";
    const start = match.index;
    const end = start + match[0].length;
    out.push({ index, text, eol, start, end });
    index += 1;
    if (end >= raw.length) break;
  }
  return out;
}

export function detectEol(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

export function parseCheckboxLine(line: string): {
  prefix: string;
  checked: boolean;
  suffix: string;
  label: string;
} | null {
  const match = CARD_CHECKBOX_RE.exec(line);
  if (!match?.[1] || match[2] === undefined || !match[3]) return null;
  const label = (match[4] ?? "").trim();
  if (!label) return null;
  return {
    prefix: match[1],
    checked: match[2].toLowerCase() === "x",
    suffix: match[3],
    label,
  };
}

/**
 * 将卡片正文（围栏外）可能伪造泳道或新卡片的 1~3 级 ATX 标题降级为指定层级（默认 H4 `####`）。
 */
export function sanitizeMarkdownBodyHeadings(
  body: string,
  minHeadingLevel = 4,
): string {
  if (!body) return body;
  const targetPrefix = "#".repeat(Math.max(1, minHeadingLevel));
  const lines = body.split(/\r\n|\r|\n/);
  let fence: FenceState = null;
  const out: string[] = [];
  for (const line of lines) {
    const nextFence = updateFenceState(line, fence);
    const toggledFence = nextFence !== fence;
    fence = nextFence;
    if (fence || toggledFence) {
      out.push(line);
      continue;
    }
    const heading = /^(#{1,6})(\s+.*)$/.exec(line);
    if (heading?.[1] && heading[2] && heading[1].length < minHeadingLevel) {
      out.push(`${targetPrefix}${heading[2]}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 清洗自动回写交付摘要：归一化换行、截断长度，并将围栏外 ATX 标题转为加粗段落，
 * 避免注入顶层卡片/泳道标题或干扰幂等重写边界。
 */
export function sanitizeSummaryLines(
  detail: string,
  maxChars = 1200,
): string[] {
  const clean = detail.replace(/\r\n|\r/g, "\n").trim().slice(0, maxChars);
  if (!clean) return ["（任务已交付完成）"];
  const lines = clean.split("\n");
  let fence: FenceState = null;
  const out: string[] = [];
  for (const line of lines) {
    const nextFence = updateFenceState(line, fence);
    const toggledFence = nextFence !== fence;
    fence = nextFence;
    if (fence || toggledFence) {
      out.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const inner = (heading[1] ?? "").replace(/\*+/g, "").trim();
      out.push(inner ? `**${inner}**` : "");
      continue;
    }
    out.push(line);
  }
  return out;
}
