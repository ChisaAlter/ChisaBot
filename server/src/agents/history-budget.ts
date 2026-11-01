/**
 * Hermes 内核下的长对话预算（模块 8）：发给模型之前，按上下文窗口估算这一轮要发的 token 数。
 *
 * - 超过窗口的 70%：最近 2 轮之前的旧工具结果（>400 字）换成一行说明，超长旧消息（>4000 字）只留头尾；
 * - 超过 85%（且多于 4 轮）：最近 4 轮之前的较早轮次用已经缓存好的摘要代替（一条 system 消息，放在角色设定后面）。
 *   这一轮从不等摘要模型（首字时间不变）：没有现成摘要就只裁剪，回复结束后在后台生成 / 续写摘要（20 秒超时只用在后台），
 *   下一轮再用。摘要由管理员配置的「摘要模型」写，没配置就用主模型；后台失败 / 超时只记日志。
 * - 摘要按「对话 + 覆盖的消息范围」缓存（chisabot_history_summaries，运行时自建表，不需要迁移）：
 *   覆盖范围内任何一条消息被编辑 / 删除 / 重新生成，内容摘要（digest）就对不上，自然失效；截断时还会按被截掉的
 *   消息 id 主动删掉相关缓存。新一轮只多出几条时在上一份摘要的基础上续写（只把新增的几轮发给摘要模型）；
 *   连续续写 5 次，或上一份摘要已超过 600 字，就把整段重新摘要一次，免得越续越长、越续越走样。
 * - 数据库里的完整对话历史从不改动：这里只改这一次发给 Hermes 的副本。
 * - 同一次运行（runId）被拆成几段（等确认后接着跑）时复用同一份方案，桥接层要求同一次运行的输入只能在末尾追加。
 *
 * 估算用 context-usage.ts 的 estimateTokens（中日韩字符 1 字 1 token，其它 4 字符 1 token），再乘一个系数：
 * 上一轮有 provider 返回的真实用量（且上一轮的方案还在）时，用「真实 / 估算」校准（限制在 0.8–3 倍）；
 * 没有就乘 1.15 的安全系数——估不准时宁可早一点压缩。
 */
import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { estimateTokens, readingFromRunFinished } from "../context-usage";
import type { Database } from "../db/client";

export const TRIM_RATIO = 0.7;
export const SUMMARY_RATIO = 0.85;
/** 裁剪时原样保留的最近轮数（含这一轮）。 */
export const TRIM_KEEP_TURNS = 2;
/** 摘要时原样保留的最近轮数（含这一轮）。 */
export const SUMMARY_KEEP_TURNS = 4;
export const OLD_TOOL_RESULT_CHARS = 400;
export const LONG_TEXT_CHARS = 4000;
const LONG_TEXT_HEAD = 1500;
const LONG_TEXT_TAIL = 500;
const OLD_TOOL_ARGS_CHARS = 2000;
export const SUMMARY_MAX_CHARS = 4000;
/** 后台写摘要的超时（只用于后台，这一轮从不等它）。 */
export const SUMMARY_TIMEOUT_MS = 20_000;
/** 连续增量续写这么多次后，下一次整段重新摘要。 */
export const MAX_SUMMARY_EXTENSIONS = 5;
/** 上一份摘要超过这么多字时，下一次整段重新摘要（同摘要提示里的「不超过 600 字」）。 */
export const SUMMARY_TARGET_CHARS = 600;
/** 没有真实用量校准时乘的安全系数（宁可早压缩）。 */
export const UNCALIBRATED_MARGIN = 1.15;
/** 校准比例的上下限（防止一次异常的用量把预算带偏）。 */
export const CALIBRATION_MIN = 0.8;
export const CALIBRATION_MAX = 3;
export const HISTORY_SUMMARY_ID = "hermes-history-summary";

export type HistoryCompaction = {
  mode: "trim" | "summary";
  /** 被摘要代替的较早轮数（裁剪时为 0）。 */
  summarizedTurns: number;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
};

export type HistorySummaryRecord = {
  threadId: string;
  throughMessageId: string;
  messageIds: string[];
  digest: string;
  summary: string;
  model: string;
  /** 这份摘要是在整段摘要的基础上连续续写的第几次（整段重新摘要为 0）。 */
  extensions: number;
};

export type HistorySummaryStore = {
  /** 这条对话最近的几份摘要（新的在前）。 */
  recent(threadId: string): Promise<HistorySummaryRecord[]>;
  save(record: HistorySummaryRecord): Promise<void>;
  /** 覆盖范围里有这些消息的摘要全部作废（截断 / 重新生成 / 编辑后重发）。 */
  forget(threadId: string, removedIds: readonly string[]): Promise<number>;
};

export type Summarize = (input: {
  previousSummary: string | null;
  messages: readonly Message[];
  signal: AbortSignal;
}) => Promise<{ summary: string; model: string }>;

type Plan = {
  cutId: string | null;
  summary: string | null;
  summarizedTurns: number;
  trimBeforeId: string | null;
  /** 这一轮角色设定 + 工具定义的估算（下一轮用真实用量校准时要用）。 */
  overheadTokens: number;
};

/** 上一轮 provider 返回的真实上下文用量（local-conversations 里最后一条带 usage 的 RUN_FINISHED）。 */
export type MeasuredUsage = { runId: string; tokens: number };

/** 同一次运行的各段复用同一份方案（桥接层的输入只能在末尾追加）。 */
export class HistoryPlanMemo {
  private readonly plans = new Map<string, Plan>();
  constructor(private readonly limit = 200) {}
  get(runId: string) {
    return this.plans.get(runId);
  }
  set(runId: string, plan: Plan) {
    this.plans.delete(runId);
    this.plans.set(runId, plan);
    while (this.plans.size > this.limit)
      this.plans.delete(this.plans.keys().next().value as string);
  }
}

/** 一段消息的内容摘要：id、角色、内容、工具调用都算进去，改了任何一条都会变。 */
export function historyDigest(messages: readonly Message[]): string {
  const rows = messages.map((message) => {
    const record = message as Message & {
      toolCalls?: unknown;
      toolCallId?: unknown;
    };
    return [
      message.id,
      message.role,
      record.content ?? null,
      record.toolCalls ?? null,
      record.toolCallId ?? null,
    ];
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const userStarts = (messages: readonly Message[]) =>
  messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );

function shortenText(text: string): string {
  if (text.length <= LONG_TEXT_CHARS) return text;
  const omitted = text.length - LONG_TEXT_HEAD - LONG_TEXT_TAIL;
  return `${text.slice(0, LONG_TEXT_HEAD)}\n…［较早的长消息中间省略 ${omitted} 字］…\n${text.slice(-LONG_TEXT_TAIL)}`;
}

/** 旧消息瘦身：只换内容，id / 角色 / 工具调用 id 不变（返回新对象，原消息不动）。 */
export function trimOldMessage(message: Message): Message {
  const record = message as Message & {
    content?: unknown;
    toolCalls?: { function?: { arguments?: unknown } }[];
  };
  if (message.role === "tool") {
    const content =
      typeof record.content === "string"
        ? record.content
        : JSON.stringify(record.content ?? "");
    return content.length > OLD_TOOL_RESULT_CHARS
      ? ({
          ...message,
          content: `[较早的工具结果已省略，原长 ${content.length} 字]`,
        } as Message)
      : message;
  }
  let changed = false;
  let content = record.content;
  if (typeof content === "string") {
    const shorter = shortenText(content);
    if (shorter !== content) {
      content = shorter;
      changed = true;
    }
  } else if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        const shorter = shortenText(text);
        if (shorter !== text) {
          changed = true;
          return { ...part, text: shorter };
        }
      }
      return part;
    });
    if (changed) content = parts;
  }
  let toolCalls = record.toolCalls;
  if (Array.isArray(toolCalls)) {
    const calls = toolCalls.map((call) => {
      const args = call?.function?.arguments;
      if (typeof args === "string" && args.length > OLD_TOOL_ARGS_CHARS) {
        changed = true;
        return {
          ...call,
          function: {
            ...call.function,
            arguments: JSON.stringify({
              省略: `较早的工具参数已省略，原长 ${args.length} 字`,
            }),
          },
        };
      }
      return call;
    });
    if (changed) toolCalls = calls;
  }
  if (!changed) return message;
  return {
    ...message,
    content,
    ...(toolCalls ? { toolCalls } : {}),
  } as Message;
}

export function summaryMessage(summary: string, turns: number): Message {
  return {
    id: HISTORY_SUMMARY_ID,
    role: "system",
    content: `【较早对话摘要】本对话较早的 ${turns} 轮没有逐字发送，下面是它们的摘要（完整原文仍保存在对话记录里）：\n${summary}`,
  } as Message;
}

/** 给摘要模型看的较早对话（每条最多 2000 字，总长最多 60000 字，超出时保留较新的部分）。 */
export function renderTranscript(messages: readonly Message[]): string {
  const label: Record<string, string> = {
    user: "用户",
    assistant: "助手",
    tool: "工具结果",
    system: "系统",
    developer: "系统",
  };
  const lines = messages.map((message) => {
    const record = message as Message & {
      content?: unknown;
      toolCalls?: { function?: { name?: unknown; arguments?: unknown } }[];
    };
    let text =
      typeof record.content === "string"
        ? record.content
        : Array.isArray(record.content)
          ? record.content
              .map((part) =>
                part &&
                typeof part === "object" &&
                typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "[附件]",
              )
              .join(" ")
          : "";
    const calls = (record.toolCalls ?? []).map(
      (call) =>
        `调用 ${String(call?.function?.name ?? "工具")} ${String(call?.function?.arguments ?? "")}`,
    );
    if (calls.length) text = [text, ...calls].filter(Boolean).join("\n");
    if (text.length > 2000)
      text = `${text.slice(0, 1400)}…（省略 ${text.length - 1900} 字）…${text.slice(-500)}`;
    return `${label[message.role] ?? message.role}：${text}`;
  });
  const joined = lines.join("\n\n");
  return joined.length > 60_000
    ? `…（更早的内容省略）\n${joined.slice(-60_000)}`
    : joined;
}

export const SUMMARY_INSTRUCTIONS = [
  "你在为一段较长的对话写「较早对话摘要」，后面的对话会用这份摘要代替这些较早的轮次。",
  "要求：用简体中文、要点列表；保留用户的目标与偏好、已确认的事实和数字、做过的决定、还没完成的事项、提到的文件 / 链接 / 名字；",
  "不要编造对话里没有的内容，不要评价，不要寒暄；不超过 600 字。只输出摘要本身。",
].join("\n");

export function summaryPrompt(
  previousSummary: string | null,
  messages: readonly Message[],
): string {
  return [
    SUMMARY_INSTRUCTIONS,
    previousSummary
      ? `\n已有的更早部分摘要（请合并进新的摘要）：\n${previousSummary}`
      : "",
    `\n需要概括的对话：\n${renderTranscript(messages)}`,
  ].join("\n");
}

function sameRange(record: HistorySummaryRecord, covered: readonly Message[]) {
  return (
    record.messageIds.length > 0 &&
    record.messageIds.length <= covered.length &&
    record.messageIds.every((id, index) => covered[index]?.id === id) &&
    historyDigest(covered.slice(0, record.messageIds.length)) === record.digest
  );
}

/** 正好覆盖 `covered` 的摘要。 */
function exactSummary(
  records: readonly HistorySummaryRecord[],
  covered: readonly Message[],
) {
  return records.find(
    (record) =>
      record.messageIds.length === covered.length && sameRange(record, covered),
  );
}

/** 覆盖 `covered` 某个前缀（内容没变）的最长一份摘要。 */
function prefixSummary(
  records: readonly HistorySummaryRecord[],
  covered: readonly Message[],
) {
  return [...records]
    .filter((record) => record.messageIds.length < covered.length)
    .sort((a, b) => b.messageIds.length - a.messageIds.length)
    .find((record) => sameRange(record, covered));
}

/** 正在后台写的摘要（对话 + 内容摘要），同一段不重复写。 */
const refreshing = new Set<string>();

/**
 * 回复结束后在后台写好 `covered` 这一段的摘要，存进缓存，下一轮直接用。
 * 有能续写的旧摘要就只把新增部分发给摘要模型；旧摘要已连续续写 5 次或超过 600 字时整段重新摘要。
 * 超时（默认 20 秒）自己计时并和摘要调用赛跑：不依赖摘要模型理会 signal，也不依赖 AbortSignal.timeout
 * 的定时器（Windows 上的 Bun 里它可能不触发）。从不抛错：失败 / 超时只记日志，返回 null。
 */
export async function refreshHistorySummary(input: {
  threadId: string;
  covered: readonly Message[];
  store: HistorySummaryStore;
  summarize: Summarize;
  timeoutMs?: number;
  log?: (line: Record<string, unknown>) => void;
}): Promise<HistorySummaryRecord | null> {
  const { covered, threadId, store } = input;
  const log = input.log ?? (() => {});
  const timeoutMs = input.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  if (!covered.length) return null;
  const digest = historyDigest(covered);
  const key = `${threadId}:${digest}`;
  if (refreshing.has(key)) return null;
  refreshing.add(key);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await store.recent(threadId).catch(() => []);
    const exact = exactSummary(records, covered);
    if (exact) return exact;
    const base = prefixSummary(records, covered);
    const full =
      !base ||
      base.extensions >= MAX_SUMMARY_EXTENSIONS ||
      base.summary.length > SUMMARY_TARGET_CHARS;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`summary timed out after ${timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    stopped.catch(() => {});
    const result = await Promise.race([
      input.summarize({
        previousSummary: full ? null : (base?.summary ?? null),
        messages: full ? covered : covered.slice(base?.messageIds.length ?? 0),
        signal: controller.signal,
      }),
      stopped,
    ]);
    const summary = result.summary.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!summary) throw new Error("empty summary");
    const record: HistorySummaryRecord = {
      threadId,
      throughMessageId: covered.at(-1)?.id ?? "",
      messageIds: covered.map((message) => message.id),
      digest,
      summary,
      model: result.model,
      extensions: full ? 0 : (base?.extensions ?? 0) + 1,
    };
    await store.save(record);
    log({
      type: "history-budget",
      event: !base
        ? "summary-new"
        : full
          ? "summary-resummarized"
          : "summary-extended",
      threadId,
      messages: covered.length,
      extensions: record.extensions,
      model: result.model,
    });
    return record;
  } catch (error) {
    log({
      type: "history-budget",
      event: "summary-failed",
      threadId,
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : String(error).slice(0, 200),
    });
    return null;
  } finally {
    clearTimeout(timer);
    refreshing.delete(key);
  }
}

function applyPlan(
  history: readonly Message[],
  plan: Plan,
): { summary: Message | null; messages: Message[] } {
  const cut = plan.cutId
    ? history.findIndex((message) => message.id === plan.cutId)
    : -1;
  const useSummary = plan.summary !== null && cut > 0;
  const kept = useSummary ? history.slice(cut) : [...history];
  const trimAt = plan.trimBeforeId
    ? kept.findIndex((message) => message.id === plan.trimBeforeId)
    : -1;
  const messages =
    trimAt > 0
      ? [...kept.slice(0, trimAt).map(trimOldMessage), ...kept.slice(trimAt)]
      : kept;
  return {
    summary:
      useSummary && plan.summary !== null
        ? summaryMessage(plan.summary, plan.summarizedTurns)
        : null,
    messages,
  };
}

const sentTokens = (
  overheadTokens: number,
  applied: { summary: Message | null; messages: readonly Message[] },
) =>
  overheadTokens +
  estimateTokens(
    applied.summary ? [applied.summary, ...applied.messages] : applied.messages,
  );

/**
 * 估算 → 真实的换算系数。上一轮有真实用量、且上一轮的方案还记得时：上一轮发出去的内容（这一轮的历史去掉
 * 末尾新的用户消息，按上一轮的方案处理）重新估算一遍，用「真实 / 估算」，限制在 0.8–3 倍；否则 null。
 */
export function calibrationRatio(
  history: readonly Message[],
  previous: MeasuredUsage | null | undefined,
  memo: HistoryPlanMemo | undefined,
): number | null {
  if (!previous || !memo || !(previous.tokens > 0)) return null;
  const plan = memo.get(previous.runId);
  const last = userStarts(history).at(-1);
  if (!plan || !last) return null;
  const estimate = sentTokens(
    plan.overheadTokens,
    applyPlan(history.slice(0, last), plan),
  );
  if (!(estimate > 0)) return null;
  return Math.min(
    CALIBRATION_MAX,
    Math.max(CALIBRATION_MIN, previous.tokens / estimate),
  );
}

/**
 * 算出这一轮实际发给 Hermes 的历史。`history` 不含角色设定；`overheadTokens` 是角色设定 + 工具定义的估算。
 * 返回的 `summary`（有的话）放在角色设定后面；`compaction` 写进 RUN_FINISHED 的 metadata.historyCompaction；
 * `refresh`（有的话）是回复结束后要在后台跑的摘要任务（这一轮从不调用摘要模型）。
 */
export async function compactHistory(input: {
  threadId: string;
  runId: string;
  history: readonly Message[];
  overheadTokens: number;
  contextWindow?: number;
  store?: HistorySummaryStore;
  summarize?: Summarize;
  timeoutMs?: number;
  memo?: HistoryPlanMemo;
  /** 上一轮 provider 返回的真实用量，用来校准估算。 */
  previousUsage?: MeasuredUsage | null;
  log?: (line: Record<string, unknown>) => void;
}): Promise<{
  summary: Message | null;
  messages: Message[];
  compaction: HistoryCompaction | null;
  refresh: (() => Promise<void>) | null;
}> {
  const { history, overheadTokens } = input;
  const log = input.log ?? (() => {});
  const window = input.contextWindow;
  const unchanged = {
    summary: null,
    messages: [...history],
    compaction: null,
    refresh: null,
  };
  if (!window || !Number.isFinite(window) || window <= 0 || !history.length)
    return unchanged;
  const ratio = calibrationRatio(history, input.previousUsage, input.memo);
  const factor = ratio ?? UNCALIBRATED_MARGIN;
  const scaled = (tokens: number) => Math.ceil(tokens * factor);
  const beforeTokens = scaled(overheadTokens + estimateTokens(history));
  let refresh: (() => Promise<void>) | null = null;
  let plan = input.memo?.get(input.runId);
  if (!plan) {
    const none: Plan = {
      cutId: null,
      summary: null,
      summarizedTurns: 0,
      trimBeforeId: null,
      overheadTokens,
    };
    if (beforeTokens <= window * TRIM_RATIO) {
      plan = none;
    } else {
      const starts = userStarts(history);
      let cutId: string | null = null;
      let summary: string | null = null;
      let summarizedTurns = 0;
      if (
        beforeTokens > window * SUMMARY_RATIO &&
        starts.length > SUMMARY_KEEP_TURNS
      ) {
        const cut = starts[starts.length - SUMMARY_KEEP_TURNS] ?? 0;
        const covered = history.slice(0, cut);
        const records = input.store
          ? await input.store.recent(input.threadId).catch(() => [])
          : [];
        const exact = exactSummary(records, covered);
        // 没有正好覆盖的，先用覆盖前缀的旧摘要（那之后到保留轮次之间的原样保留，后面照常裁剪）。
        const usable = exact ?? prefixSummary(records, covered);
        const end = usable?.messageIds.length ?? 0;
        if (usable && end > 0 && history[end]?.role === "user") {
          cutId = history[end]?.id ?? null;
          summary = usable.summary;
          summarizedTurns = starts.filter((index) => index < end).length;
          log({
            type: "history-budget",
            event: exact ? "summary-cache-hit" : "summary-prefix-hit",
            threadId: input.threadId,
            messages: end,
          });
        }
        const { store, summarize } = input;
        if (!exact && store && summarize && covered.length) {
          refresh = async () => {
            await refreshHistorySummary({
              threadId: input.threadId,
              covered,
              store,
              summarize,
              timeoutMs: input.timeoutMs,
              log,
            });
          };
        }
      }
      let trimBeforeId =
        starts.length > TRIM_KEEP_TURNS
          ? (history[starts[starts.length - TRIM_KEEP_TURNS] ?? -1]?.id ?? null)
          : null;
      if (summary !== null && trimBeforeId) {
        // 摘要后已经回到 70% 以内就不再裁剪剩下的几轮。
        const summarized = applyPlan(history, {
          ...none,
          cutId,
          summary,
          summarizedTurns,
        });
        if (
          scaled(sentTokens(overheadTokens, summarized)) <=
          window * TRIM_RATIO
        )
          trimBeforeId = null;
      }
      plan = { cutId, summary, summarizedTurns, trimBeforeId, overheadTokens };
    }
    input.memo?.set(input.runId, plan);
  }
  if (!plan.cutId && !plan.trimBeforeId) return { ...unchanged, refresh };
  const applied = applyPlan(history, plan);
  const changed =
    applied.summary !== null ||
    applied.messages.some((message, index) => message !== history[index]);
  if (!changed) return { ...unchanged, refresh };
  const afterTokens = scaled(sentTokens(overheadTokens, applied));
  const compaction: HistoryCompaction =
    applied.summary && plan.summary !== null
      ? {
          mode: "summary",
          summarizedTurns: plan.summarizedTurns,
          beforeTokens,
          afterTokens,
          summary: plan.summary,
        }
      : { mode: "trim", summarizedTurns: 0, beforeTokens, afterTokens };
  log({
    type: "history-budget",
    event: compaction.mode,
    threadId: input.threadId,
    runId: input.runId,
    contextWindow: window,
    beforeTokens,
    afterTokens,
    summarizedTurns: compaction.summarizedTurns,
    calibration: ratio === null ? "margin" : Number(ratio.toFixed(3)),
    backgroundSummary: refresh !== null,
  });
  return { ...applied, compaction, refresh };
}

/** 测试与没有数据库时用。 */
export function createMemoryHistorySummaryStore(): HistorySummaryStore & {
  records: HistorySummaryRecord[];
} {
  const records: HistorySummaryRecord[] = [];
  return {
    records,
    async recent(threadId) {
      return records
        .filter((record) => record.threadId === threadId)
        .reverse()
        .slice(0, 10)
        .map((record) => ({ ...record, messageIds: [...record.messageIds] }));
    },
    async save(record) {
      records.push({ ...record, messageIds: [...record.messageIds] });
    },
    async forget(threadId, removedIds) {
      const removed = new Set(removedIds);
      let count = 0;
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (
          record?.threadId === threadId &&
          record.messageIds.some((id) => removed.has(id))
        ) {
          records.splice(index, 1);
          count += 1;
        }
      }
      return count;
    },
  };
}

/**
 * 运行时自建的缓存表（同 chisabot_thread_truncations 的做法，CREATE TABLE IF NOT EXISTS，不需要迁移；
 * 对话删除时随外键一起删）。表建不起来（非本地会话模式）时整个缓存当作不存在：每次重新摘要，不报错。
 */
export async function ensureHistorySummaryTable(database: Database) {
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_history_summaries (
    id bigserial PRIMARY KEY,
    thread_id text NOT NULL REFERENCES openbot_local_threads(id) ON DELETE CASCADE,
    through_message_id text NOT NULL,
    message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    digest text NOT NULL,
    summary text NOT NULL,
    model text NOT NULL,
    extensions integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await database.$client.unsafe(
    "ALTER TABLE chisabot_history_summaries ADD COLUMN IF NOT EXISTS extensions integer NOT NULL DEFAULT 0",
  );
  await database.$client.unsafe(
    "CREATE INDEX IF NOT EXISTS chisabot_history_summaries_thread ON chisabot_history_summaries(thread_id, id DESC)",
  );
}

/** 每条对话最多留几份摘要。 */
const KEEP_PER_THREAD = 10;

export function createPgHistorySummaryStore(
  database: Database,
): HistorySummaryStore {
  let ready: Promise<boolean> | null = null;
  const ensure = () => {
    ready ??= ensureHistorySummaryTable(database).then(
      () => true,
      () => {
        ready = null;
        return false;
      },
    );
    return ready;
  };
  return {
    async recent(threadId) {
      if (!(await ensure())) return [];
      const rows = await database.$client.unsafe<
        {
          through_message_id: string;
          message_ids: unknown;
          digest: string;
          summary: string;
          model: string;
          extensions: number;
        }[]
      >(
        `SELECT through_message_id, message_ids, digest, summary, model, extensions FROM chisabot_history_summaries
         WHERE thread_id = $1 ORDER BY id DESC LIMIT ${KEEP_PER_THREAD}`,
        [threadId],
      );
      return rows.map((row) => ({
        threadId,
        throughMessageId: row.through_message_id,
        messageIds: Array.isArray(row.message_ids)
          ? row.message_ids.map(String)
          : [],
        digest: row.digest,
        summary: row.summary,
        model: row.model,
        extensions: Number(row.extensions) || 0,
      }));
    },
    async save(record) {
      if (!(await ensure())) return;
      await database.$client.unsafe(
        `INSERT INTO chisabot_history_summaries (thread_id, through_message_id, message_ids, digest, summary, model, extensions)
         VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7)`,
        [
          record.threadId,
          record.throughMessageId,
          JSON.stringify(record.messageIds),
          record.digest,
          record.summary,
          record.model,
          record.extensions,
        ],
      );
      await database.$client.unsafe(
        `DELETE FROM chisabot_history_summaries WHERE thread_id = $1 AND id NOT IN (
           SELECT id FROM chisabot_history_summaries WHERE thread_id = $1 ORDER BY id DESC LIMIT ${KEEP_PER_THREAD})`,
        [record.threadId],
      );
    },
    async forget(threadId, removedIds) {
      if (!(await ensure())) return 0;
      return forgetHistorySummaries(database, threadId, removedIds);
    },
  };
}

/**
 * 截断（重新生成 / 编辑后重发）后：覆盖范围里有被截掉的消息的摘要全部删掉（local-conversations.ts 调用）。
 * 表不存在 / 出错时返回 0，不影响截断本身（内容摘要对不上的缓存本来也不会被用到）。
 */
export async function forgetHistorySummaries(
  database: Database,
  threadId: string,
  removedIds: readonly string[],
): Promise<number> {
  if (!removedIds.length) return 0;
  try {
    const rows = await database.$client.unsafe<{ id: string }[]>(
      `DELETE FROM chisabot_history_summaries
       WHERE thread_id = $1 AND message_ids ?| ARRAY(SELECT jsonb_array_elements_text($2::text::jsonb))
       RETURNING id::text AS id`,
      [threadId, JSON.stringify(removedIds)],
    );
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * 这条对话上一次带 provider 用量的运行（runId + 最后一步的输入 + 输出 token），给估算做校准。
 * 只读一行（同输入框「上下文」读数的查询）；查不到 / 出错返回 null，按安全系数估算。
 */
export async function lastMeasuredUsage(
  database: Database,
  threadId: string,
): Promise<MeasuredUsage | null> {
  try {
    const rows = await database.$client.unsafe<
      { event: Record<string, unknown>; created_at: Date }[]
    >(
      `SELECT event, created_at FROM openbot_local_events
       WHERE thread_id = $1 AND event->>'type' = 'RUN_FINISHED'
       AND (event ? 'usage' OR event->'metadata' ? 'contextUsage')
       ORDER BY sequence DESC LIMIT 1`,
      [threadId],
    );
    const row = rows[0];
    const runId = row?.event.runId;
    const reading = row ? readingFromRunFinished(row) : undefined;
    return typeof runId === "string" && reading && reading.tokens > 0
      ? { runId, tokens: reading.tokens }
      : null;
  } catch {
    return null;
  }
}
