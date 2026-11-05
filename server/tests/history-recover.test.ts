import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  historyRecoverTools,
  RECOVER_MAX_CHARS,
  recoverFromMessages,
} from "../src/agents/history-recover";
import type { Database } from "../src/db/client";
import { REFUSAL_MARKER } from "../src/plugins/tools";

const history = [
  { id: "u1", role: "user", content: "第一轮的问题" },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "web_fetch", arguments: '{"url":"https://x"}' },
      },
    ],
  },
  {
    id: "t1",
    role: "tool",
    toolCallId: "call-1",
    content: "很长的工具结果原文",
  },
  { id: "u2", role: "user", content: "第二轮的问题" },
  { id: "a2", role: "assistant", content: "第二轮的回答" },
  {
    id: "u3",
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image", source: { type: "url", value: "https://x/y.png" } },
    ],
  },
] as unknown as Message[];

describe("history_recover", () => {
  test("recovers a single message by id or by toolCallId", () => {
    expect(recoverFromMessages(history, { id: "u1" })).toBe(
      "[id: u1] 用户：第一轮的问题",
    );
    const byCall = recoverFromMessages(history, { toolCallId: "call-1" });
    expect(byCall).toContain("[id: t1] 工具结果：很长的工具结果原文");
    // id 找不到时退回 toolCallId。
    expect(
      recoverFromMessages(history, { id: "gone", toolCallId: "call-1" }),
    ).toContain("[id: t1]");
    // 附件只占位，不会把图片数据喷回去。
    expect(recoverFromMessages(history, { id: "u3" })).toContain("[附件]");
    // 助手消息的工具调用一并给出。
    expect(recoverFromMessages(history, { id: "a1" })).toContain(
      "调用 web_fetch",
    );
  });

  test("unknown ids and bad queries get a clear answer, not an error row", () => {
    expect(recoverFromMessages(history, { id: "gone" })).toContain(
      "没有这条消息",
    );
    expect(recoverFromMessages(history, { from: "gone", to: "a2" })).toContain(
      "没有这条消息",
    );
    expect(recoverFromMessages(history, {})).toContain(REFUSAL_MARKER);
    expect(recoverFromMessages(history, { from: "a2", to: "u1" })).toContain(
      "范围是空的",
    );
  });

  test("ranges come back in order, endpoints included, from or to alone works", () => {
    const range = recoverFromMessages(history, { from: "u1", to: "u2" });
    expect(range).toContain("[id: u1]");
    expect(range).toContain("[id: t1]");
    expect(range).toContain("[id: u2]");
    expect(range).not.toContain("[id: a2]");
    expect(range.indexOf("[id: u1]")).toBeLessThan(range.indexOf("[id: t1]"));
    expect(recoverFromMessages(history, { from: "a2" })).toContain("[id: u3]");
    expect(recoverFromMessages(history, { to: "u1" })).not.toContain(
      "[id: a1]",
    );
  });

  test("long ranges paginate with the next id; single oversized messages are capped", () => {
    const big = [
      { id: "h0", role: "user", content: "头" },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `h${i + 1}`,
        role: "user",
        content: "x".repeat(2_000),
      })),
    ] as unknown as Message[];
    const page = recoverFromMessages(big, { from: "h0", to: "h60" });
    expect(page.length).toBeLessThan(RECOVER_MAX_CHARS + 2_000);
    expect(page).toContain("没列完");
    // 按提示的下一个 id 一页页翻下去，最终取到 h60，且各页不重复。
    const seen = new Set<string>();
    let cursor: string | undefined = "h0";
    for (let pages = 0; cursor && pages < 10; pages++) {
      const chunk = recoverFromMessages(big, { from: cursor, to: "h60" });
      for (const id of chunk.match(/\[id: (h\d+)\]/g) ?? []) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      cursor = chunk.includes("没列完")
        ? chunk.match(/from=(h\d+)/)?.[1]
        : undefined;
    }
    expect(seen.has("[id: h60]")).toBe(true);
    const huge = [
      { id: "m", role: "tool", toolCallId: "c", content: "y".repeat(50_000) },
    ] as unknown as Message[];
    const capped = recoverFromMessages(huge, { id: "m" });
    expect(capped).toContain("上面是前");
    expect(capped.length).toBeLessThan(RECOVER_MAX_CHARS + 100);
    // 范围里单条超上限的：截断后照常列出来。
    const inRange = recoverFromMessages(
      [...huge, { id: "n", role: "user", content: "尾巴" }] as Message[],
      { from: "m", to: "n" },
    );
    expect(inRange).toContain("已截断");
    expect(inRange).toContain("[id: n] 用户：尾巴");
  });

  test("the granted tool loads this run's thread itself and refuses bad args", async () => {
    const queries: string[] = [];
    const database = {
      $client: {
        unsafe: async (sql: string, params: unknown[]) => {
          queries.push(`${sql} ${params.join(",")}`);
          return [{ messages: history }];
        },
      },
    } as unknown as Database;
    const [tool] = historyRecoverTools({ database, threadId: "thread-9" });
    expect(tool?.name).toBe("history_recover");
    const text = await tool?.execute({ id: "a2" });
    expect(text).toContain("第二轮的回答");
    expect(queries[0]).toContain("openbot_local_threads");
    expect(queries[0]).toContain("thread-9");
    expect(await tool?.execute({})).toContain(REFUSAL_MARKER);
    // 线程不存在 / 还没有历史：明确的话，不抛异常。
    const empty = {
      $client: { unsafe: async () => [] },
    } as unknown as Database;
    const [emptyTool] = historyRecoverTools({
      database: empty,
      threadId: "gone",
    });
    expect(await emptyTool?.execute({ id: "u1" })).toContain(
      "还没有可取回的内容",
    );
  });
});
