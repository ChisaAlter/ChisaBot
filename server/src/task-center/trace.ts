/**
 * 任务执行轨迹：把 chisabot_local_events 里 `task-center:<taskId>:<tag>:<attempt>` 线程的
 * 原始 AG-UI 事件投影成人可读的一行行（runtime.ts taskThreadId 决定线程命名）。
 *
 * 不做全文回放：工具开始/结束/结果、成段回复（CONTENT 增量在 SQL 里聚合）、
 * 回合开始/结束（带 metadata.contextUsage 用量）、回合错误；REASONING_* 与其余事件略过。
 * 线程前缀带冒号收尾（`task-center:<id>:%` 里 id 后的 `:`）防止 id 前缀互相串任务；
 * LIKE 通配符转义后再拼，任务 id 本身不含通配语义。owner 归属除路由校验外，
 * 这里再过一道 chisabot_local_threads.owner_user_id，防串账号。
 */
import type {
  TaskTraceEvent,
  TaskTraceThread,
  TaskUsage,
} from "../../../shared/task-center";
import type { Database } from "../db/client";

/** 每线程投影上限与全局上限（spec：200 / 600）。 */
const THREAD_EVENT_LIMIT = 200;
const TOTAL_EVENT_LIMIT = 600;
/** 非文本事件在 SQL 里按线程保留的最新原始行数；文本增量走聚合查询不占这个额度。 */
const RAW_ROWS_PER_THREAD = 600;
const RESULT_LIMIT = 300;
const MESSAGE_LIMIT = 500;
/** SQL 侧单条消息的聚合上限，超出部分投影时再裁。 */
const MESSAGE_SQL_LIMIT = 4000;

/** 参与投影的事件类型（REASONING_*、TOOL_CALL_ARGS、STATE_* 等一律不进 SQL）。 */
const PROJECTED_TYPES = [
  "RUN_STARTED",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "TEXT_MESSAGE_END",
  "RUN_FINISHED",
  "RUN_ERROR",
] as const;
const TEXT_TYPES = ["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK"] as const;

const isoReq = (value: Date | string) => new Date(value).toISOString();
const json = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;
const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}…` : text;
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** LIKE 通配符转义：任务 id 里即便混入 % _ \ 也只当字面量。 */
export function traceThreadPattern(taskId: string): string {
  const escaped = taskId.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `task-center:${escaped}:%`;
}

type RawRow = {
  thread_id: string;
  sequence: number | string | bigint;
  event: unknown;
  created_at: Date | string;
};
type TextRow = {
  thread_id: string;
  message_id: string | null;
  last_seq: number | string | bigint;
  last_at: Date | string;
  text: string;
};

function usageOf(event: Record<string, unknown>): TaskUsage | undefined {
  const usage = (event.metadata as Record<string, unknown> | undefined)
    ?.contextUsage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const pick = (key: string) => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    modelCalls: 1,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/**
 * 纯投影：事件行 + 聚合文本行 → 按线程分组的轨迹。
 * 线程按最早事件排序（规划在前、各次尝试随后）；每线程最多 THREAD_EVENT_LIMIT 条，
 * 全部线程合计最多 TOTAL_EVENT_LIMIT 条。
 */
export function projectTrace(
  rows: RawRow[],
  texts: TextRow[],
): TaskTraceThread[] {
  const textByKey = new Map<string, TextRow>();
  for (const row of texts)
    textByKey.set(`${row.thread_id}${row.message_id ?? ""}`, row);
  const byThread = new Map<string, RawRow[]>();
  for (const row of rows) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }

  const threads: TaskTraceThread[] = [];
  let budget = TOTAL_EVENT_LIMIT;
  const ordered = [...byThread.entries()].sort(
    (a, b) => Number(a[1][0]?.sequence ?? 0) - Number(b[1][0]?.sequence ?? 0),
  );
  for (const [thread, threadRows] of ordered) {
    if (budget <= 0) break;
    const toolNames = new Map<string, string>();
    const closedMessages = new Set<string>();
    const events: TaskTraceEvent[] = [];
    const emit = (
      sequence: number,
      at: string,
      type: string,
      summary: string,
      usage?: TaskUsage,
    ) => {
      events.push({ sequence, at, type, summary, ...(usage ? { usage } : {}) });
    };
    for (const row of threadRows) {
      const event = json<Record<string, unknown>>(row.event);
      const type = typeof event?.type === "string" ? event.type : "";
      const sequence = Number(row.sequence);
      const at = isoReq(row.created_at);
      if (type === "RUN_STARTED") {
        emit(sequence, at, type, "回合开始");
      } else if (type === "TOOL_CALL_START") {
        const name =
          typeof event.toolCallName === "string" && event.toolCallName
            ? event.toolCallName
            : "工具";
        if (typeof event.toolCallId === "string")
          toolNames.set(event.toolCallId, name);
        emit(sequence, at, type, `工具 ${name}`);
      } else if (type === "TOOL_CALL_END") {
        const name =
          (typeof event.toolCallId === "string"
            ? toolNames.get(event.toolCallId)
            : undefined) ?? "工具";
        emit(sequence, at, type, `完成 ${name}`);
      } else if (type === "TOOL_CALL_RESULT") {
        const name =
          typeof event.toolCallId === "string"
            ? toolNames.get(event.toolCallId)
            : undefined;
        const content =
          typeof event.content === "string"
            ? event.content
            : JSON.stringify(event.content ?? "");
        emit(
          sequence,
          at,
          type,
          `${name ? `${name} 结果：` : "工具结果："}${clip(clean(content), RESULT_LIMIT)}`,
        );
      } else if (type === "TEXT_MESSAGE_END") {
        const messageId =
          typeof event.messageId === "string" ? event.messageId : "";
        closedMessages.add(messageId);
        const text = textByKey.get(`${thread}${messageId}`)?.text.trim();
        if (text) emit(sequence, at, "TEXT_MESSAGE", clip(text, MESSAGE_LIMIT));
      } else if (type === "RUN_FINISHED") {
        emit(sequence, at, type, "回合完成", usageOf(event));
      } else if (type === "RUN_ERROR") {
        const message = typeof event.message === "string" ? event.message : "";
        emit(
          sequence,
          at,
          type,
          `回合出错：${clip(clean(message), RESULT_LIMIT)}`,
        );
      }
    }
    // 没等到 END 的消息（回合中断 / 正在流式）按最后增量位置补进轨迹。
    for (const row of texts) {
      if (row.thread_id !== thread) continue;
      if (closedMessages.has(row.message_id ?? "")) continue;
      const text = row.text.trim();
      if (!text) continue;
      events.push({
        sequence: Number(row.last_seq),
        at: isoReq(row.last_at),
        type: "TEXT_MESSAGE",
        summary: clip(text, MESSAGE_LIMIT),
      });
    }
    events.sort((a, b) => a.sequence - b.sequence);
    const capped = events.slice(0, Math.min(THREAD_EVENT_LIMIT, budget));
    budget -= capped.length;
    if (capped.length) threads.push({ thread, events: capped });
  }
  return threads;
}

export function createTaskCenterTrace(database: Database) {
  const sql = database.$client;

  /**
   * 两条查询：非文本事件按线程保留最新 RAW_ROWS_PER_THREAD 行；
   * 文本增量在 SQL 里按 messageId 聚合成整段，避免动辄上千行的 token 增量往返。
   */
  async function trace(
    owner: string,
    taskId: string,
  ): Promise<TaskTraceThread[]> {
    const pattern = traceThreadPattern(taskId);
    const [rows, texts] = await Promise.all([
      sql.unsafe<RawRow[]>(
        `SELECT thread_id, sequence, event, created_at FROM (
          SELECT thread_id, sequence, event, created_at,
            row_number() OVER (PARTITION BY thread_id ORDER BY sequence DESC) AS recent
          FROM chisabot_local_events
          WHERE thread_id LIKE $1 ESCAPE '\\'
            AND EXISTS (SELECT 1 FROM chisabot_local_threads t
              WHERE t.id = chisabot_local_events.thread_id AND t.owner_user_id = $2)
            AND event->>'type' IN (${PROJECTED_TYPES.map((type) => `'${type}'`).join(",")})
        ) e WHERE recent <= ${RAW_ROWS_PER_THREAD}
        ORDER BY thread_id, sequence`,
        [pattern, owner],
      ),
      sql.unsafe<TextRow[]>(
        `SELECT thread_id, event->>'messageId' AS message_id,
          max(sequence) AS last_seq, max(created_at) AS last_at,
          left(string_agg(event->>'delta', '' ORDER BY sequence), ${MESSAGE_SQL_LIMIT}) AS text
        FROM chisabot_local_events
        WHERE thread_id LIKE $1 ESCAPE '\\'
          AND EXISTS (SELECT 1 FROM chisabot_local_threads t
            WHERE t.id = chisabot_local_events.thread_id AND t.owner_user_id = $2)
          AND event->>'type' IN (${TEXT_TYPES.map((type) => `'${type}'`).join(",")})
          AND event->>'delta' IS NOT NULL
        GROUP BY thread_id, event->>'messageId'`,
        [pattern, owner],
      ),
    ]);
    return projectTrace(rows, texts);
  }

  return { trace };
}

export type TaskCenterTrace = ReturnType<typeof createTaskCenterTrace>;
