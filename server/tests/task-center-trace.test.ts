import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  createTaskCenterTrace,
  projectTrace,
  traceThreadPattern,
} from "../src/task-center/trace";

const AT = "2026-11-06T01:00:00Z";
function row(thread: string, sequence: number, event: Record<string, unknown>) {
  return { thread_id: thread, sequence, event, created_at: AT };
}
function text(
  thread: string,
  messageId: string | null,
  lastSeq: number,
  body: string,
) {
  return {
    thread_id: thread,
    message_id: messageId,
    last_seq: lastSeq,
    last_at: AT,
    text: body,
  };
}
const THREAD = "task-center:t1:run:1";

describe("trace thread matching", () => {
  test("the prefix ends on a colon and LIKE metacharacters are escaped", () => {
    expect(traceThreadPattern("abc")).toBe("task-center:abc:%");
    // "abc" 不能撞上 "abc-other" 的线程：冒号把 id 锁死在段内。
    expect(traceThreadPattern("a%_b\\c")).toBe("task-center:a\\%\\_b\\\\c:%");
  });
});

describe("trace projection", () => {
  test("tool calls project names; results truncate; closed text aggregates once", () => {
    const threads = projectTrace(
      [
        row(THREAD, 1, { type: "RUN_STARTED" }),
        row(THREAD, 2, {
          type: "TOOL_CALL_START",
          toolCallId: "c1",
          toolCallName: "read_file",
        }),
        row(THREAD, 3, { type: "REASONING_MESSAGE_CONTENT", delta: "…" }),
        row(THREAD, 4, { type: "TOOL_CALL_END", toolCallId: "c1" }),
        row(THREAD, 5, {
          type: "TOOL_CALL_RESULT",
          toolCallId: "c1",
          content: `  ${"结果".repeat(400)}  `,
        }),
        row(THREAD, 6, { type: "TEXT_MESSAGE_END", messageId: "m1" }),
        row(THREAD, 7, {
          type: "RUN_FINISHED",
          metadata: {
            contextUsage: { inputTokens: 1234, outputTokens: 56, model: "m" },
          },
        }),
      ],
      [text(THREAD, "m1", 6, "已经整理完成。")],
    );
    expect(threads).toHaveLength(1);
    const summaries = threads[0]!.events.map((e) => e.summary);
    expect(summaries).toEqual([
      "回合开始",
      "工具 read_file",
      "完成 read_file",
      expect.stringContaining("read_file 结果："),
      "已经整理完成。",
      "回合完成",
    ]);
    const result = threads[0]!.events[3]!;
    expect(result.summary.length).toBeLessThanOrEqual(320);
    expect(result.summary.endsWith("…")).toBe(true);
    expect(threads[0]!.events[5]!.usage).toEqual({
      modelCalls: 1,
      inputTokens: 1234,
      outputTokens: 56,
    });
  });

  test("unclosed messages still show at their last delta; empty text is dropped", () => {
    const threads = projectTrace(
      [row(THREAD, 9, { type: "TOOL_CALL_END", toolCallId: "gone" })],
      [
        text(THREAD, "m-open", 8, "正在输出…"),
        text(THREAD, "m-empty", 10, "   "),
      ],
    );
    const events = threads[0]!.events;
    // 未关闭的回复按 last_seq 排到工具事件之前；END 没带名字的退回「工具」。
    expect(events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE",
      "TOOL_CALL_END",
    ]);
    expect(events[0]!.summary).toBe("正在输出…");
    expect(events[1]!.summary).toBe("完成 工具");
  });

  test("threads order by first event; run error and missing usage stay legible", () => {
    const threads = projectTrace(
      [
        row("task-center:t1:run:1", 20, {
          type: "RUN_ERROR",
          message: "模型服务 500\n\n重试",
        }),
        row("task-center:t1:plan:1", 10, { type: "RUN_FINISHED" }),
      ],
      [],
    );
    expect(threads.map((t) => t.thread)).toEqual([
      "task-center:t1:plan:1",
      "task-center:t1:run:1",
    ]);
    expect(threads[0]!.events[0]!.summary).toBe("回合完成");
    expect(threads[0]!.events[0]!.usage).toBeUndefined();
    expect(threads[1]!.events[0]!.summary).toBe("回合出错：模型服务 500 重试");
  });

  test("per-thread cap is 200 and the total budget is 600", () => {
    const many = (thread: string, from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        row(thread, from + i, { type: "RUN_STARTED" }),
      );
    const threads = projectTrace(
      [
        ...many("task-center:t1:run:1", 1, 230),
        ...many("task-center:t1:run:2", 1000, 230),
        ...many("task-center:t1:run:3", 2000, 230),
      ],
      [],
    );
    expect(threads[0]!.events).toHaveLength(200);
    expect(threads[1]!.events).toHaveLength(200);
    expect(threads[2]!.events).toHaveLength(200);
    expect(
      threads.reduce((sum, t) => sum + t.events.length, 0),
    ).toBeLessThanOrEqual(600);
  });
});

describe("trace query", () => {
  test("trace() sends the escaped prefix and the owner, then projects both result sets", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const unsafe = async (query: string, params: unknown[] = []) => {
      calls.push({ text: query, params });
      if (query.includes("string_agg"))
        return [text("task-center:t9:run:1", "m1", 3, "做完了。")];
      return [
        row("task-center:t9:run:1", 1, { type: "RUN_STARTED" }),
        row("task-center:t9:run:1", 3, {
          type: "TEXT_MESSAGE_END",
          messageId: "m1",
        }),
      ];
    };
    const module = createTaskCenterTrace({
      $client: { unsafe },
    } as unknown as Database);
    const threads = await module.trace("owner-1", "t9");
    expect(calls[0]!.params).toEqual(["task-center:t9:%", "owner-1"]);
    expect(calls.every((call) => call.text.includes("owner_user_id"))).toBe(
      true,
    );
    expect(threads[0]!.events.map((e) => e.summary)).toEqual([
      "回合开始",
      "做完了。",
    ]);
  });
});
