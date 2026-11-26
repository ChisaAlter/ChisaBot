/**
 * 接口级 JSON 响应风控 / 校验 / 限流检测与会话轻缓冲（纯逻辑，不依赖 Playwright）。
 *
 * 仅检查小体积 JSON 响应的顶层提示字段，避免阻塞大包下载或正文流；
 * 最近 10 秒内的命中保留在会话缓冲里，供 `performAction` / `read` / `navigate` 返回 `riskControl`。
 */

export const API_RISK_MAX_BYTES = 32 * 1024;
export const API_RISK_WINDOW_MS = 10_000;
export const API_RISK_FIELDS = [
  "message",
  "msg",
  "error",
  "errMsg",
  "toast",
] as const;

export type ApiRiskHit = {
  url: string;
  reason: string;
};

const INSPECTABLE_RESOURCE_TYPES = new Set([
  "xhr",
  "fetch",
  "document",
  "other",
]);

const API_RISK_PATTERNS: readonly RegExp[] = [
  /风控|风险控制|风险检测|风险提示|存在风险|账号异常|安全校验|安全验证|行为验证|人机验证|滑块验证|图形验证码|二次验证|身份校验|需要验证|请完成验证/,
  /异常访问|访问异常|请求异常|疑似机器人|自动化访问|非法请求|拒绝访问|访问受限|账号受限|已被限制/,
  /触发限流|已被限流|系统限流|限流|(?:操作|请求|访问|发送|提交)(?:过于|太)?频繁|过于频繁|次数已用完|已达上限|请稍后再试/,
  /\brisk\s*(?:control|check|detected|blocked)\b/i,
  /\bsecurity\s*(?:check|verification|challenge)\b/i,
  /\bverification\s*required\b/i,
  /\bcaptcha\b/i,
  /\brate[\s-]+limit(?:ed|ing)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bunusual\s+(?:traffic|activity)\b/i,
  /\bsuspicious\s+activity\b/i,
  /\baccess\s+(?:denied|restricted|blocked)\b/i,
  /\bblocked\s+by\s+(?:security|waf|risk)\b/i,
];

function readHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  if (lower in headers) return headers[lower];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * 判断响应头是否满足轻量 JSON 检测条件：
 * - 非 204/3xx 空响应
 * - `content-type` 含 `json`
 * - 若带 `content-length`，必须小于 32KB
 */
export function isInspectableJsonResponse(
  headers: Record<string, string | undefined>,
  status?: number,
  resourceType?: string,
): boolean {
  if (
    status !== undefined &&
    (status === 204 || status === 304 || (status >= 300 && status < 400))
  ) {
    return false;
  }
  if (
    resourceType !== undefined &&
    !INSPECTABLE_RESOURCE_TYPES.has(resourceType.toLowerCase())
  ) {
    return false;
  }
  const contentType = readHeader(headers, "content-type") ?? "";
  if (!/json/i.test(contentType)) return false;

  const contentLength = readHeader(headers, "content-length")?.trim();
  if (contentLength !== undefined && contentLength !== "") {
    if (!/^\d+$/.test(contentLength)) return false;
    const bytes = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes >= API_RISK_MAX_BYTES) {
      return false;
    }
  }
  return true;
}

/** 检查一段提示文本是否命中风控 / 校验 / 限流 / 异常访问词表。 */
export function matchesApiRiskText(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const sample = text.slice(0, 500);
  return API_RISK_PATTERNS.some((pattern) => pattern.test(sample));
}

/** 解析 JSON 对象顶层 message/msg/error/errMsg/toast 字段，返回首个命中的风控文案。 */
export function extractApiRiskMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const field of API_RISK_FIELDS) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    if (matchesApiRiskText(normalized)) {
      return normalized.length > 160
        ? `${normalized.slice(0, 159)}…`
        : normalized;
    }
  }
  return undefined;
}

/** 解析小体积 JSON 文本，若命中风控/限流返回 `{ url, reason }`。 */
export function detectApiRisk(
  rawBody: string,
  url: string,
): ApiRiskHit | undefined {
  if (!rawBody || Buffer.byteLength(rawBody, "utf8") >= API_RISK_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  const matched = extractApiRiskMessage(parsed);
  if (!matched) return undefined;
  return {
    url: url.slice(0, 512),
    reason: `检测到接口风控或限流提示「${matched}」；请停止重复尝试，换用其他方式或请用户接管处理。`,
  };
}

export type ApiRiskBuffer = {
  record: (hit: ApiRiskHit, now?: number) => void;
  latest: (now?: number) => ApiRiskHit | undefined;
  clear: () => void;
};

/** 仅保留最近 `windowMs`（默认 10 秒）内命中的会话轻量缓冲。 */
export function createApiRiskBuffer(
  windowMs = API_RISK_WINDOW_MS,
  maxEntries = 20,
): ApiRiskBuffer {
  const entries: Array<{ hit: ApiRiskHit; at: number }> = [];

  const prune = (now: number) => {
    const cutoff = now - windowMs;
    while (entries.length > 0 && entries[0] && entries[0].at < cutoff) {
      entries.shift();
    }
  };

  return {
    record(hit, now = Date.now()) {
      prune(now);
      entries.push({ hit, at: now });
      while (entries.length > maxEntries) {
        entries.shift();
      }
    },
    latest(now = Date.now()) {
      prune(now);
      const last = entries[entries.length - 1];
      return last?.hit;
    },
    clear() {
      entries.length = 0;
    },
  };
}
