/**
 * 端侧（Web / PC）推送、网络与连接环形诊断日志（上限 500 条，自动脱敏凭据与 Header）。
 *
 * - 严格固定容量 `MAX_DIAGNOSTIC_ENTRIES = 500`，超出自动滚动覆盖最早条目，避免内存增长；
 * - 写入前与导出前双层脱敏：自动抹除任何 token、cookie、Authorization、X-Device-Token、JWT 与 URL 查询密钥；
 * - 纯前端可测模块，零网络请求、零 React 副作用。
 */

export const MAX_DIAGNOSTIC_ENTRIES = 500;
export const DIAGNOSTIC_REDACTED = "[REDACTED]";

export type DiagnosticCategory =
  | "push"
  | "network"
  | "connection"
  | "bridge"
  | "agent"
  | "system";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticEntry = {
  id: number;
  at: string;
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  event: string;
  message?: string;
  detail?: unknown;
};

export type DiagnosticInput = {
  category?: DiagnosticCategory;
  level?: DiagnosticLevel;
  event: string;
  message?: string;
  detail?: unknown;
};

export type DiagnosticExportPayload = {
  schemaVersion: 1;
  source: "chisabot-web" | "chisabot-pc" | "chisabot-combined";
  exportedAt: string;
  redacted: true;
  maxEntries: number;
  count: number;
  byCategory: Record<string, number>;
  runtime: Record<string, unknown>;
  entries: DiagnosticEntry[];
  desktop?: Record<string, unknown> | null;
};

const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|session[-_]?id|credential|private[-_]?key|x-device-token)/i;

const VALID_CATEGORIES = new Set<DiagnosticCategory>([
  "push",
  "network",
  "connection",
  "bridge",
  "agent",
  "system",
]);

const VALID_LEVELS = new Set<DiagnosticLevel>([
  "debug",
  "info",
  "warn",
  "error",
]);

/** 对字符串中的 Authorization / Cookie / Bearer / 设备令牌 / JWT / 查询参数密钥做自动脱敏。 */
export function redactDiagnosticText(input: string): string {
  if (!input) return input;
  let text = input;
  text = text.replace(
    /\b(authorization|proxy-authorization|x-device-token|x-api-key|cookie|set-cookie)\s*[:=]\s*([^\r\n;]+)/gi,
    (_match, header: string) => `${header}: ${DIAGNOSTIC_REDACTED}`,
  );
  text = text.replace(
    /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
    (_match, scheme: string) => `${scheme} ${DIAGNOSTIC_REDACTED}`,
  );
  text = text.replace(
    /\b(?:cbd|sk|pk|ghp|gho|ghu|ghs|xoxb|xoxp)_[A-Za-z0-9_-]{8,}\b/g,
    DIAGNOSTIC_REDACTED,
  );
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, DIAGNOSTIC_REDACTED);
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    DIAGNOSTIC_REDACTED,
  );
  text = text.replace(
    /([?&](?:token|access_token|refresh_token|api_key|apikey|secret|cookie|auth|code|sig)=)([^&#\s]+)/gi,
    (_match, prefix: string) => `${prefix}${DIAGNOSTIC_REDACTED}`,
  );
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

/** 递归脱敏任意结构化诊断详情对象。 */
export function redactDiagnosticDetail(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactDiagnosticText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 6) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => redactDiagnosticDetail(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        result[key] = DIAGNOSTIC_REDACTED;
      } else {
        result[key] = redactDiagnosticDetail(item, depth + 1, seen);
      }
    }
    return result;
  }
  return redactDiagnosticText(String(value));
}

export type DiagnosticsRingBuffer = ReturnType<
  typeof createDiagnosticsRingBuffer
>;

export function createDiagnosticsRingBuffer(options?: {
  maxEntries?: number;
  now?: () => number;
}) {
  const maxEntries = Math.max(
    1,
    Math.min(5000, Math.floor(options?.maxEntries ?? MAX_DIAGNOSTIC_ENTRIES)),
  );
  const now = options?.now ?? Date.now;
  let items: DiagnosticEntry[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();

  function emitChange() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }

  function record(input: DiagnosticInput): DiagnosticEntry {
    const category: DiagnosticCategory =
      input.category && VALID_CATEGORIES.has(input.category)
        ? input.category
        : "system";
    const level: DiagnosticLevel =
      input.level && VALID_LEVELS.has(input.level) ? input.level : "info";
    const entry: DiagnosticEntry = {
      id: ++seq,
      at: new Date(now()).toISOString(),
      category,
      level,
      event: redactDiagnosticText(String(input.event || "event")).slice(0, 120),
      ...(input.message
        ? { message: redactDiagnosticText(String(input.message)) }
        : {}),
      ...(input.detail !== undefined
        ? { detail: redactDiagnosticDetail(input.detail) }
        : {}),
    };
    const next = [...items, entry];
    if (next.length > maxEntries) {
      next.splice(0, next.length - maxEntries);
    }
    items = next;
    emitChange();
    return entry;
  }

  function snapshot(): readonly DiagnosticEntry[] {
    return items;
  }

  function clear(): void {
    if (items.length === 0) return;
    items = [];
    emitChange();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function buildExportPayload(options?: {
    runtime?: Record<string, unknown>;
    desktop?: Record<string, unknown> | null;
  }): DiagnosticExportPayload {
    const list = items.map((item) => ({ ...item }));
    const byCategory: Record<string, number> = {};
    for (const item of list) {
      byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    }
    const sanitizedRuntime = (redactDiagnosticDetail(options?.runtime ?? {}) ??
      {}) as Record<string, unknown>;
    const sanitizedDesktop = options?.desktop
      ? ((redactDiagnosticDetail(options.desktop) ?? null) as Record<
          string,
          unknown
        > | null)
      : null;

    return {
      schemaVersion: 1,
      source: sanitizedDesktop ? "chisabot-combined" : "chisabot-web",
      exportedAt: new Date(now()).toISOString(),
      redacted: true,
      maxEntries,
      count: list.length,
      byCategory,
      runtime: sanitizedRuntime,
      entries: list,
      ...(sanitizedDesktop ? { desktop: sanitizedDesktop } : {}),
    };
  }

  function exportJson(options?: {
    runtime?: Record<string, unknown>;
    desktop?: Record<string, unknown> | null;
  }): string {
    return `${JSON.stringify(buildExportPayload(options), null, 2)}\n`;
  }

  return {
    maxEntries,
    record,
    snapshot,
    clear,
    subscribe,
    buildExportPayload,
    exportJson,
  };
}

/** 全局前端环形诊断日志缓冲（供推送、网络、连接层与设置页导出共用）。 */
export const clientDiagnostics = createDiagnosticsRingBuffer();
