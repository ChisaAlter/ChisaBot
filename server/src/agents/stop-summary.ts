import type { Database } from "../db/client";
import { UNTRUSTED_TAG } from "../untrusted-content";

const UNTRUSTED_HEADER_RE =
  /^CRITICAL: The following [^\n]*?is untrusted data[^\n]*\n?/i;
const UNTRUSTED_OPEN_RE = new RegExp(`<${UNTRUSTED_TAG}[^>]*>\\n?`, "gi");
const UNTRUSTED_CLOSE_RE = new RegExp(`\\n?<\\/${UNTRUSTED_TAG}>`, "gi");

function stripUntrustedEnvelope(value: string): string {
  return value
    .replace(UNTRUSTED_HEADER_RE, "")
    .replace(UNTRUSTED_OPEN_RE, "")
    .replace(UNTRUSTED_CLOSE_RE, "");
}

export type StopSummaryOperation = {
  callId?: string | null;
  toolName: string;
  args?: unknown;
  status: string;
  result?: unknown;
};

export type StopSummaryInput = {
  baseMessage: string;
  events?: readonly unknown[];
  operations?: readonly StopSummaryOperation[];
  maxHighlights?: number;
  maxPreviewChars?: number;
};

export type StopSummaryStats = {
  totalTools: number;
  succeeded: number;
  failed: number;
  unknown: number;
  highlights: string[];
  textPreview: string;
};

const DEFAULT_MAX_HIGHLIGHTS = 4;
const DEFAULT_MAX_PREVIEW_CHARS = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateInline(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function summarizeToolAction(toolName: string, args: unknown): string {
  if (!isRecord(args)) return toolName;
  const candidateKeys = [
    "command",
    "url",
    "path",
    "filePath",
    "query",
    "slug",
    "name",
    "action",
    "title",
  ];
  for (const key of candidateKeys) {
    const raw = args[key];
    if (typeof raw === "string" && raw.trim()) {
      const cleaned = stripUntrustedEnvelope(raw).trim();
      if (cleaned) {
        return `${toolName}(${truncateInline(cleaned, 48)})`;
      }
    }
  }
  return toolName;
}

function extractStreamedPreview(
  events: readonly unknown[],
  maxChars: number,
): string {
  const chunks: string[] = [];
  for (const item of events) {
    if (!isRecord(item)) continue;
    const type = item.type;
    if (
      (type === "TEXT_MESSAGE_CONTENT" || type === "TEXT_MESSAGE_CHUNK") &&
      typeof item.delta === "string"
    ) {
      chunks.push(item.delta);
    }
  }
  if (chunks.length === 0) return "";
  const joined = stripUntrustedEnvelope(chunks.join("")).trim();
  if (!joined) return "";
  return truncateInline(joined, maxChars);
}

function isFailedOperationResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return true;
  }
  return false;
}

function collectOperationEntries(
  operations: readonly StopSummaryOperation[],
  events: readonly unknown[],
): Array<{
  toolName: string;
  args?: unknown;
  status: "succeeded" | "failed" | "unknown";
}> {
  const byCallId = new Map<
    string,
    {
      toolName: string;
      args?: unknown;
      status: "succeeded" | "failed" | "unknown";
    }
  >();
  const anonymous: Array<{
    toolName: string;
    args?: unknown;
    status: "succeeded" | "failed" | "unknown";
  }> = [];

  for (const op of operations) {
    const name = op.toolName.trim();
    if (!name) continue;
    let status: "succeeded" | "failed" | "unknown" = "unknown";
    if (op.status === "completed") {
      status = isFailedOperationResult(op.result) ? "failed" : "succeeded";
    } else if (op.status === "failed") {
      status = "failed";
    }
    const entry = { toolName: name, args: op.args, status };
    if (op.callId?.trim()) {
      byCallId.set(op.callId.trim(), entry);
    } else {
      anonymous.push(entry);
    }
  }

  // 若运行未经过 chisabot_tool_operations（如 classic 路径或纯事件回放），从 AG-UI 事件补齐工具统计。
  const eventTools = new Map<
    string,
    { toolName: string; status: "succeeded" | "failed" | "unknown" }
  >();
  const eventToolOrder: string[] = [];
  for (const item of events) {
    if (!isRecord(item)) continue;
    if (item.type === "TOOL_CALL_START") {
      const callId =
        typeof item.toolCallId === "string" ? item.toolCallId.trim() : "";
      const toolName =
        typeof item.toolCallName === "string" ? item.toolCallName.trim() : "";
      if (!callId || !toolName || byCallId.has(callId)) continue;
      eventTools.set(callId, { toolName, status: "unknown" });
      eventToolOrder.push(callId);
    } else if (item.type === "TOOL_CALL_RESULT") {
      const callId =
        typeof item.toolCallId === "string" ? item.toolCallId.trim() : "";
      const existing = callId ? eventTools.get(callId) : undefined;
      if (!existing) continue;
      let failed = false;
      if (typeof item.content === "string") {
        try {
          const parsed = JSON.parse(item.content) as unknown;
          failed = isFailedOperationResult(parsed);
        } catch {
          failed = false;
        }
      }
      existing.status = failed ? "failed" : "succeeded";
    }
  }

  const combined = [...byCallId.values(), ...anonymous];
  for (const callId of eventToolOrder) {
    const entry = eventTools.get(callId);
    if (entry) combined.push(entry);
  }
  return combined;
}

/**
 * 纯规则聚合本轮工具账本与已流出事件，零外部模型调用。
 */
export function summarizeRunProgress(
  input: Omit<StopSummaryInput, "baseMessage">,
): StopSummaryStats {
  const events = input.events ?? [];
  const operations = input.operations ?? [];
  const maxHighlights = Math.max(
    1,
    input.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS,
  );
  const maxPreviewChars = Math.max(
    20,
    input.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
  );

  const entries = collectOperationEntries(operations, events);
  let succeeded = 0;
  let failed = 0;
  let unknown = 0;
  const highlights: string[] = [];

  for (const entry of entries) {
    if (entry.status === "succeeded") succeeded += 1;
    else if (entry.status === "failed") failed += 1;
    else unknown += 1;
    if (highlights.length < maxHighlights) {
      highlights.push(summarizeToolAction(entry.toolName, entry.args));
    }
  }

  const textPreview = extractStreamedPreview(events, maxPreviewChars);

  return {
    totalTools: entries.length,
    succeeded,
    failed,
    unknown,
    highlights,
    textPreview,
  };
}

/**
 * 生成确定性中文收尾/中断交代文案；若本轮尚未产生工具调用与正文输出，保持原简洁文案。
 */
export function buildStopSummary(input: StopSummaryInput): string {
  const stats = summarizeRunProgress(input);
  if (stats.totalTools === 0 && !stats.textPreview) {
    return input.baseMessage;
  }

  const parts: string[] = [];
  if (stats.totalTools > 0) {
    const breakdown = [`成功 ${stats.succeeded}`];
    if (stats.failed > 0) breakdown.push(`失败 ${stats.failed}`);
    if (stats.unknown > 0) breakdown.push(`未决 ${stats.unknown}`);
    const highlightSuffix =
      stats.highlights.length > 0
        ? `，涉及 ${stats.highlights.join("、")}${stats.totalTools > stats.highlights.length ? " 等" : ""}`
        : "";
    parts.push(
      `已执行 ${stats.totalTools} 次工具调用（${breakdown.join("、")}）${highlightSuffix}`,
    );
  }
  if (stats.textPreview) {
    parts.push(`已输出内容：「${stats.textPreview}」`);
  }

  return `${input.baseMessage}\n\n本轮进度摘要：${parts.join("；")}。`;
}

/**
 * 从 `chisabot_local_events` 与 `chisabot_tool_operations` 聚合本轮规则摘要（绝不调用外部模型）。
 */
export async function buildStopSummaryFromDb(
  database: Database,
  input: { threadId: string; runId: string; baseMessage: string },
): Promise<string> {
  try {
    const sql = database.$client;
    const [eventRows, opRows] = await Promise.all([
      sql.unsafe<{ event: unknown }[]>(
        `SELECT event FROM chisabot_local_events
         WHERE thread_id = $1 AND run_id = $2
         ORDER BY sequence ASC`,
        [input.threadId, input.runId],
      ),
      sql.unsafe<
        {
          call_id: string | null;
          tool_name: string;
          args: unknown;
          status: string;
          result: unknown;
        }[]
      >(
        `SELECT call_id, tool_name, args, status, result
         FROM chisabot_tool_operations
         WHERE run_id = $1
         ORDER BY created_at ASC`,
        [input.runId],
      ),
    ]);

    return buildStopSummary({
      baseMessage: input.baseMessage,
      events: eventRows.map((row) => row.event),
      operations: opRows.map((row) => ({
        callId: row.call_id,
        toolName: row.tool_name,
        args: row.args,
        status: row.status,
        result: row.result,
      })),
    });
  } catch {
    return input.baseMessage;
  }
}
