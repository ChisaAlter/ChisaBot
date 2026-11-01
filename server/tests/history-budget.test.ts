import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  CALIBRATION_MAX,
  compactHistory,
  createMemoryHistorySummaryStore,
  ensureHistorySummaryTable,
  HISTORY_SUMMARY_ID,
  HistoryPlanMemo,
  type HistorySummaryRecord,
  historyDigest,
  refreshHistorySummary,
  type Summarize,
  summaryPrompt,
  trimOldMessage,
  UNCALIBRATED_MARGIN,
} from "../src/agents/history-budget";
import { estimateTokens } from "../src/context-usage";
import type { Database } from "../src/db/client";

/**
 * 一个长话题样本（Hermes 内核，同一个对话里查资料、改方案）：每轮 = 用户提问 + 助手调用工具 + 很长的工具结果
 * （网页正文）+ 助手回答；每 5 轮有一条很长的粘贴。PR 里的前后 token 数就是用它算的。
 */
function longTopic(turns: number): Message[] {
  const messages: Message[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const paste =
      turn % 5 === 0
        ? `\n${"这是用户粘贴的一大段会议纪要，包含很多细节和数字。".repeat(240)}`
        : "";
    messages.push({
      id: `u${turn}`,
      role: "user",
      content: `第 ${turn} 轮：帮我查一下方案 ${turn} 的预算和风险，结合上一轮的结论。${paste}`,
    });
    messages.push({
      id: `a${turn}-call`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call-${turn}`,
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: `方案 ${turn} 预算 风险` }),
          },
        },
      ],
    } as Message);
    messages.push({
      id: `t${turn}`,
      role: "tool",
      toolCallId: `call-${turn}`,
      content: `搜索结果 ${turn}：${"相关网页正文，介绍预算构成、历史数据和风险评估。".repeat(120)}`,
    } as Message);
    messages.push({
      id: `a${turn}`,
      role: "assistant",
      content: `方案 ${turn} 的结论：预算约 ${turn * 10} 万，主要风险是进度。${"补充说明。".repeat(80)}`,
    });
  }
  return messages;
}

const OVERHEAD = 6_000; // 角色设定 + 工具定义的估算
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (history: readonly Message[]) => OVERHEAD + estimateTokens(history);
/** 没有真实用量校准时代码用的估算（乘安全系数）。 */
const estimate = (history: readonly Message[]) =>
  Math.ceil(raw(history) * UNCALIBRATED_MARGIN);
/** 让这段历史（按安全系数估算）正好占窗口 `ratio` 的窗口大小。 */
const windowAt = (history: readonly Message[], ratio: number) =>
  Math.ceil(estimate(history) / ratio);
const idsBefore = (history: readonly Message[], id: string) =>
  history
    .slice(
      0,
      history.findIndex((message) => message.id === id),
    )
    .map((message) => message.id);
type Call = { previousSummary: string | null; ids: string[] };

function summarizer(calls: Call[], fail?: "throw" | "hang"): Summarize {
  return async ({ previousSummary, messages }) => {
    calls.push({ previousSummary, ids: messages.map((message) => message.id) });
    if (fail === "throw") throw new Error("model quota exhausted");
    // 不理会 signal、永远不回答的摘要模型：后台任务靠自己的超时结束。
    if (fail === "hang") return await new Promise<never>(() => {});
    return {
      summary: `- 摘要覆盖到 ${messages.at(-1)?.id}${previousSummary ? `（续写自：${previousSummary.slice(0, 20)}）` : ""}\n- 用户目标：比较各方案预算与风险`,
      model: "summary-model",
    };
  };
}

describe("Hermes history budget", () => {
  test("below 70% of the window, or with an unknown window, the history goes out unchanged", async () => {
    const history = longTopic(6);
    for (const contextWindow of [undefined, 0, windowAt(history, 0.69)]) {
      const result = await compactHistory({
        threadId: "t",
        runId: `r-${contextWindow}`,
        history,
        overheadTokens: OVERHEAD,
        contextWindow,
        store: createMemoryHistorySummaryStore(),
        summarize: summarizer([]),
      });
      expect(result.compaction).toBeNull();
      expect(result.summary).toBeNull();
      expect(result.refresh).toBeNull();
      expect(result.messages).toEqual(history);
    }
  });

  test(">70%: old tool results and very long old messages are trimmed, the last two turns stay verbatim, the stored history is untouched", async () => {
    const history = longTopic(10);
    const stored = clone(history);
    const calls: Call[] = [];
    const result = await compactHistory({
      threadId: "t",
      runId: "r1",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: windowAt(history, 0.78),
      store: createMemoryHistorySummaryStore(),
      summarize: summarizer(calls),
    });
    expect(calls).toHaveLength(0);
    expect(result.summary).toBeNull();
    expect(result.refresh).toBeNull();
    expect(result.compaction).toMatchObject({
      mode: "trim",
      summarizedTurns: 0,
      beforeTokens: estimate(history),
    });
    expect(result.compaction?.afterTokens ?? 0).toBeLessThan(
      estimate(history) * 0.5,
    );
    const byId = new Map(
      result.messages.map((message) => [message.id, message]),
    );
    expect(byId.get("t1")?.content).toMatch(
      /^\[较早的工具结果已省略，原长 \d+ 字\]$/u,
    );
    expect(String(byId.get("u5")?.content)).toContain("较早的长消息中间省略");
    expect(String(byId.get("u5")?.content).length).toBeLessThan(2_100);
    // 最近两轮（u9、u10）原样；消息 id、顺序、工具调用 id 都不变。
    for (const id of ["u9", "t9", "a9", "u10", "t10", "a10"])
      expect(byId.get(id)).toBe(history.find((message) => message.id === id));
    expect(result.messages.map((message) => message.id)).toEqual(
      history.map((message) => message.id),
    );
    expect(
      (byId.get("t1") as Message & { toolCallId: string }).toolCallId,
    ).toBe("call-1");
    expect(history).toEqual(stored);
  });

  test(">85%: this turn only trims and never calls the summary model; the summary is written after the reply and used from the next turn", async () => {
    const history = longTopic(12);
    const stored = clone(history);
    const store = createMemoryHistorySummaryStore();
    const calls: Call[] = [];
    const window = windowAt(history, 0.9);
    const first = await compactHistory({
      threadId: "t",
      runId: "r1",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: window,
      store,
      summarize: summarizer(calls),
    });
    expect(calls).toHaveLength(0);
    expect(first.summary).toBeNull();
    expect(first.compaction).toMatchObject({ mode: "trim" });
    expect(first.refresh).not.toBeNull();
    // 回复结束后（copilot.ts 在 RUN_FINISHED 时）后台写摘要：主模型或摘要模型，覆盖最近 4 轮之前。
    await first.refresh?.();
    expect(calls).toEqual([
      { previousSummary: null, ids: idsBefore(history, "u9") },
    ]);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      threadId: "t",
      throughMessageId: "a8",
      model: "summary-model",
      extensions: 0,
    });
    // 下一次用到同一段较早历史（比如重试）：直接用缓存的摘要，不再有后台任务。
    const again = await compactHistory({
      threadId: "t",
      runId: "r2",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: window,
      store,
      summarize: summarizer(calls),
    });
    expect(again.summary).toMatchObject({
      id: HISTORY_SUMMARY_ID,
      role: "system",
    });
    expect(String(again.summary?.content)).toContain("较早的 8 轮");
    expect(again.messages[0]?.id).toBe("u9");
    expect(again.compaction).toMatchObject({
      mode: "summary",
      summarizedTurns: 8,
      beforeTokens: estimate(history),
    });
    // 摘要后回到 70% 以内，保留的 4 轮就不再裁剪。
    expect(again.compaction?.afterTokens ?? 0).toBeLessThan(window * 0.7);
    expect(again.refresh).toBeNull();
    expect(calls).toHaveLength(1);
    expect(history).toEqual(stored);
  });

  test("the next turn uses the cached prefix summary at once and extends it in the background with only the new turn", async () => {
    const store = createMemoryHistorySummaryStore();
    const calls: Call[] = [];
    const run = (history: Message[], runId: string) =>
      compactHistory({
        threadId: "t",
        runId,
        history,
        overheadTokens: OVERHEAD,
        contextWindow: windowAt(history, 0.9),
        store,
        summarize: summarizer(calls),
      });
    await (await run(longTopic(12), "r1")).refresh?.();
    const thirteen = longTopic(13);
    const next = await run(thirteen, "r2");
    // 前缀摘要（到 a8）马上用上；u9 那一轮原样（之后照常裁剪），不等摘要模型。
    expect(calls).toHaveLength(1);
    expect(next.compaction).toMatchObject({
      mode: "summary",
      summarizedTurns: 8,
    });
    expect(next.messages[0]?.id).toBe("u9");
    await next.refresh?.();
    expect(calls[1]?.previousSummary).toContain("摘要覆盖到 a8");
    expect(calls[1]?.ids).toEqual(["u9", "a9-call", "t9", "a9"]);
    expect(store.records.at(-1)).toMatchObject({
      throughMessageId: "a9",
      extensions: 1,
    });
    const third = await run(thirteen, "r3");
    expect(third.compaction?.summarizedTurns).toBe(9);
    expect(String(third.summary?.content)).toContain("续写自");
  });

  test("re-summarize the whole range after 5 incremental extensions or when the previous summary exceeds 600 characters", async () => {
    const history = longTopic(13);
    const covered = history.slice(
      0,
      history.findIndex((message) => message.id === "u10"),
    );
    const prefix = covered.slice(
      0,
      covered.findIndex((message) => message.id === "u9"),
    );
    const seeded = (extensions: number, summary: string) => {
      const store = createMemoryHistorySummaryStore();
      const record: HistorySummaryRecord = {
        threadId: "t",
        throughMessageId: "a8",
        messageIds: prefix.map((message) => message.id),
        digest: historyDigest(prefix),
        summary,
        model: "m",
        extensions,
      };
      store.records.push(record);
      return store;
    };
    const cases = [
      { extensions: 4, summary: "短摘要", full: false, next: 5 },
      { extensions: 5, summary: "短摘要", full: true, next: 0 },
      { extensions: 1, summary: "长".repeat(601), full: true, next: 0 },
    ];
    for (const item of cases) {
      const calls: Call[] = [];
      const logs: Record<string, unknown>[] = [];
      const store = seeded(item.extensions, item.summary);
      const saved = await refreshHistorySummary({
        threadId: "t",
        covered,
        store,
        summarize: summarizer(calls),
        log: (line) => logs.push(line),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.previousSummary).toBe(item.full ? null : item.summary);
      expect(calls[0]?.ids).toEqual(
        item.full
          ? covered.map((message) => message.id)
          : ["u9", "a9-call", "t9", "a9"],
      );
      expect(saved?.extensions).toBe(item.next);
      expect(logs.at(-1)?.event).toBe(
        item.full ? "summary-resummarized" : "summary-extended",
      );
    }
  });

  test("cache invalidation on edit and truncation", async () => {
    const store = createMemoryHistorySummaryStore();
    const calls: Call[] = [];
    const run = (history: Message[], runId: string) =>
      compactHistory({
        threadId: "t",
        runId,
        history,
        overheadTokens: OVERHEAD,
        contextWindow: windowAt(history, 0.9),
        store,
        summarize: summarizer(calls),
      });
    const twelve = longTopic(12);
    await (await run(twelve, "r1")).refresh?.();
    await (await run(longTopic(13), "r2")).refresh?.();
    expect(calls).toHaveLength(2);
    // 较早的一条消息被编辑过（内容变了）：旧摘要的内容摘要都对不上，这一轮只裁剪，后台从头重写。
    const edited = longTopic(13).map((message) =>
      message.id === "a2" ? { ...message, content: "改过的回答" } : message,
    ) as Message[];
    const afterEdit = await run(edited, "r3");
    expect(afterEdit.compaction?.mode).toBe("trim");
    await afterEdit.refresh?.();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.previousSummary).toBeNull();
    // 截断（重新生成 / 编辑后重发）：覆盖了被截掉消息的摘要全部删掉。
    const before = store.records.length;
    expect(
      await store.forget("t", ["u9", "a9-call", "t9", "a9"]),
    ).toBeGreaterThan(0);
    expect(store.records.length).toBeLessThan(before);
    expect(
      store.records.every((record) => !record.messageIds.includes("a9")),
    ).toBe(true);
    expect(historyDigest(twelve)).not.toBe(historyDigest(edited));
  });

  test("a failing or hanging summary model only affects the background job: the turn trims immediately, the job times out and logs", async () => {
    const history = longTopic(12);
    for (const fail of ["throw", "hang"] as const) {
      const store = createMemoryHistorySummaryStore();
      const logs: Record<string, unknown>[] = [];
      const calls: Call[] = [];
      const started = Date.now();
      const result = await compactHistory({
        threadId: "t",
        runId: `r-${fail}`,
        history,
        overheadTokens: OVERHEAD,
        contextWindow: windowAt(history, 0.9),
        store,
        summarize: summarizer(calls, fail),
        timeoutMs: 50,
        log: (line) => logs.push(line),
      });
      expect(calls).toHaveLength(0);
      expect(result.summary).toBeNull();
      expect(result.compaction).toMatchObject({ mode: "trim" });
      expect(result.compaction?.afterTokens ?? 0).toBeLessThan(
        estimate(history),
      );
      // 同一段同时只写一份（重复的后台任务直接跳过）。
      await Promise.all([result.refresh?.(), result.refresh?.()]);
      expect(calls).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(store.records).toHaveLength(0);
      expect(logs.some((line) => line.event === "summary-failed")).toBe(true);
    }
  });

  test("estimates are calibrated by the previous run's provider usage; without it a safety margin compresses early", async () => {
    const before = longTopic(10);
    const history = [
      ...before,
      { id: "u11", role: "user", content: "第 11 轮：继续。" } as Message,
    ];
    // 估算本身只占 65%：不乘系数不会压缩，乘 1.15 的安全系数后约 75%，早一点裁剪。
    const window = Math.ceil(raw(history) / 0.65);
    const margin = await compactHistory({
      threadId: "t",
      runId: "m",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: window,
    });
    expect(margin.compaction).toMatchObject({
      mode: "trim",
      beforeTokens: estimate(history),
    });
    const memo = new HistoryPlanMemo();
    await compactHistory({
      threadId: "t",
      runId: "prev",
      history: before,
      overheadTokens: OVERHEAD,
      contextWindow: 10_000_000,
      memo,
    });
    const run = (runId: string, tokens: number, previousRunId = "prev") =>
      compactHistory({
        threadId: "t",
        runId,
        history,
        overheadTokens: OVERHEAD,
        contextWindow: window,
        memo,
        previousUsage: { runId: previousRunId, tokens },
      });
    // provider 说上一轮正好和估算一样：系数 1，65% 不压缩。
    expect((await run("same", raw(before))).compaction).toBeNull();
    // provider 说上一轮是估算的 1.2 倍：按 1.2 校准，78% → 裁剪。
    const scaled = await run("more", Math.round(raw(before) * 1.2));
    expect(scaled.compaction?.mode).toBe("trim");
    expect(scaled.compaction?.beforeTokens).toBeGreaterThan(
      raw(history) * 1.19,
    );
    expect(scaled.compaction?.beforeTokens).toBeLessThan(raw(history) * 1.21);
    // 异常的用量被限制在 3 倍以内。
    const wild = await run("wild", raw(before) * 100);
    expect(wild.compaction?.beforeTokens).toBe(
      Math.ceil(raw(history) * CALIBRATION_MAX),
    );
    // 上一轮的方案不在了（例如重启后）：退回安全系数。
    const unknown = await run("unknown", raw(before), "gone");
    expect(unknown.compaction?.beforeTokens).toBe(estimate(history));
  });

  test("continuation segments of one run reuse the same plan so the bridge sees an append-only input", async () => {
    const history = longTopic(12);
    const memo = new HistoryPlanMemo();
    const store = createMemoryHistorySummaryStore();
    const calls: Call[] = [];
    const window = windowAt(history, 0.9);
    await (
      await compactHistory({
        threadId: "t",
        runId: "r0",
        history,
        overheadTokens: OVERHEAD,
        contextWindow: window,
        store,
        summarize: summarizer(calls),
      })
    ).refresh?.();
    const first = await compactHistory({
      threadId: "t",
      runId: "r1",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: window,
      store,
      summarize: summarizer(calls),
      memo,
    });
    const continued = [
      ...history,
      {
        id: "a12-more",
        role: "tool",
        toolCallId: "call-x",
        content: "x".repeat(50_000),
      } as Message,
    ];
    const second = await compactHistory({
      threadId: "t",
      runId: "r1",
      history: continued,
      overheadTokens: OVERHEAD,
      contextWindow: window,
      store,
      summarize: summarizer(calls),
      memo,
    });
    expect(calls).toHaveLength(1);
    expect(first.compaction?.mode).toBe("summary");
    expect(second.summary).toEqual(first.summary);
    expect(second.refresh).toBeNull();
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    // 一次运行开始时没压缩，中途（等确认后接着跑）即使超了也不改前面已经发过的部分。
    const quiet = longTopic(4);
    const quietWindow = windowAt(quiet, 0.5);
    await compactHistory({
      threadId: "t",
      runId: "r2",
      history: quiet,
      overheadTokens: OVERHEAD,
      contextWindow: quietWindow,
      memo,
    });
    const grown = [
      ...quiet,
      {
        id: "big",
        role: "tool",
        toolCallId: "c",
        content: "很长".repeat(40_000),
      } as Message,
    ];
    const later = await compactHistory({
      threadId: "t",
      runId: "r2",
      history: grown,
      overheadTokens: OVERHEAD,
      contextWindow: quietWindow,
      memo,
    });
    expect(later.compaction).toBeNull();
    expect(later.messages).toEqual(grown);
  });

  test("the summary cache table is created at runtime with a thread_id index", async () => {
    const statements: string[] = [];
    const database = {
      $client: {
        unsafe: async (sql: string) => {
          statements.push(sql.replace(/\s+/gu, " "));
          return [];
        },
      },
    } as unknown as Database;
    await ensureHistorySummaryTable(database);
    expect(statements[0]).toContain(
      "CREATE TABLE IF NOT EXISTS chisabot_history_summaries",
    );
    expect(statements[0]).toContain(
      "thread_id text NOT NULL REFERENCES openbot_local_threads(id) ON DELETE CASCADE",
    );
    expect(statements[0]).toContain("extensions integer NOT NULL DEFAULT 0");
    expect(
      statements.some((sql) =>
        /CREATE INDEX IF NOT EXISTS chisabot_history_summaries_thread ON chisabot_history_summaries\(thread_id, id DESC\)/u.test(
          sql,
        ),
      ),
    ).toBe(true);
  });

  test("trimming keeps short tool results, multimodal parts and tool-call ids", () => {
    const short = {
      id: "t",
      role: "tool",
      toolCallId: "c",
      content: "ok",
    } as Message;
    expect(trimOldMessage(short)).toBe(short);
    const parts = {
      id: "u",
      role: "user",
      content: [
        { type: "text", text: "长".repeat(5_000) },
        { type: "image", source: { type: "url", value: "https://x/y.png" } },
      ],
    } as unknown as Message;
    const trimmed = trimOldMessage(parts) as unknown as {
      content: { type: string; text?: string }[];
    };
    expect(trimmed.content[0]!.text!.length).toBeLessThan(2_100);
    expect(trimmed.content[1]).toEqual(
      (parts as unknown as { content: unknown[] }).content[1],
    );
    expect(summaryPrompt("旧摘要", [short])).toContain("旧摘要");
  });

  test("token comparison on the long-topic sample (numbers quoted in the PR)", async () => {
    // 同一个 30 轮长话题。窗口 200k：约 82%（只裁剪）。窗口 160k：超过 85%——第一次只裁剪并在后台写摘要，
    // 下一轮（31 轮）用上摘要。估算都乘了 1.15 的安全系数（没有真实用量校准时的默认）。
    const history = longTopic(30);
    const store = createMemoryHistorySummaryStore();
    const trimmed = await compactHistory({
      threadId: "t",
      runId: "m",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: 200_000,
      store,
      summarize: summarizer([]),
    });
    const firstTurn = await compactHistory({
      threadId: "t",
      runId: "s1",
      history,
      overheadTokens: OVERHEAD,
      contextWindow: 160_000,
      store,
      summarize: summarizer([]),
    });
    await firstTurn.refresh?.();
    const nextHistory = longTopic(31);
    const nextTurn = await compactHistory({
      threadId: "t",
      runId: "s2",
      history: nextHistory,
      overheadTokens: OVERHEAD,
      contextWindow: 160_000,
      store,
      summarize: summarizer([]),
    });
    const strip = (value: object | null) => ({ ...value, summary: undefined });
    console.log(
      JSON.stringify({
        sample: "longTopic(30)",
        rawEstimate: raw(history),
        trim: { window: 200_000, ...strip(trimmed.compaction) },
        overSummaryFirstTurn: {
          window: 160_000,
          ...strip(firstTurn.compaction),
        },
        overSummaryNextTurn: {
          window: 160_000,
          turns: 31,
          rawEstimate: raw(nextHistory),
          ...strip(nextTurn.compaction),
        },
      }),
    );
    expect(estimate(history) / 200_000).toBeGreaterThan(0.7);
    expect(estimate(history) / 200_000).toBeLessThanOrEqual(0.85);
    expect(estimate(history) / 160_000).toBeGreaterThan(0.85);
    expect(trimmed.compaction?.mode).toBe("trim");
    expect(firstTurn.compaction?.mode).toBe("trim");
    expect(nextTurn.compaction?.mode).toBe("summary");
    expect(nextTurn.compaction?.afterTokens ?? 0).toBeLessThan(
      firstTurn.compaction?.afterTokens ?? 0,
    );
  });
});
