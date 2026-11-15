/**
 * IM 回复的文字处理：切段、Markdown 变成纯文本、退避。
 */

/** 把长回复切成每段不超过 max 个字符：优先在空行、换行、句号处切，代码块不拆坏太多。 */
export function splitText(text: string, max: number): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), -1);
    if (cut < max * 0.4) cut = window.lastIndexOf("\n");
    if (cut < max * 0.4) {
      const sentence = Math.max(
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf(". "),
        window.lastIndexOf("；"),
      );
      cut = sentence >= 0 ? sentence + 1 : -1;
    }
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Markdown → 适合 QQ / 微信这类只显示纯文本的平台：去掉强调符号、标题井号，链接写成「文字（网址）」，
 * 图片写成「[图片] 网址」，代码块去掉围栏保留内容，表格保持原样（用 | 分隔还能看）。
 */
export function markdownToPlain(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, body: string) =>
    body.replace(/\n$/, ""),
  );
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (_, alt: string, url: string) => `[图片${alt ? `：${alt}` : ""}] ${url}`,
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g,
    (_, label: string, url: string) =>
      label === url ? url : `${label}（${url}）`,
  );
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  out = out.replace(/~~([^~\n]+)~~/g, "$1");
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/^\s*[-*+]\s+/gm, "• ");
  out = out.replace(/^>\s?/gm, "");
  out = out.replace(/^\s*---+\s*$/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** 重连等待：1s、2s、4s… 最多 60s，加一点随机抖动。attempt 从 0 开始。 */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.8 + random() * 0.4));
}

export const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 把任意错误变成一行中文能读的字。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : JSON.stringify(error);
}

export type JsonRecord = Record<string, unknown>;

/** 判断是否为非 null、非数组的 JSON 对象。 */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将未知值收窄为 JSON 对象；不是对象则返回 null。 */
export function asJsonRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

/** 将未知值收窄为数组；不是数组则返回空数组。 */
export function asJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 按路径读取嵌套 JSON 对象的字段值。 */
export function readJsonField(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isJsonRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** 收窄为字符串；非字符串返回 undefined。 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 解析 JSON 文本并收窄为对象；非对象返回空对象。 */
export function parseJsonRecord(text: string): JsonRecord {
  if (!text) return {};
  return asJsonRecord(JSON.parse(text)) ?? {};
}

/** 平台接口返回非 2xx 时带上状态码和一截正文。 */
export async function readJson(
  response: Response,
  what: string,
): Promise<JsonRecord> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(
      `${what}：HTTP ${response.status}，返回的不是 JSON（Upstream returned invalid JSON）`,
    );
  }
  if (!response.ok)
    throw new Error(`${what}：HTTP ${response.status} ${body.slice(0, 200)}`);
  return asJsonRecord(parsed) ?? {};
}
