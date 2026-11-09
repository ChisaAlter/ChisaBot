import { describe, expect, test } from "bun:test";
import {
  splitThinkTags,
  ThinkSplitter,
  thinkTagLanguageModel,
} from "../src/agents/think-tags";

type Part = { type: string; id?: string; delta?: string; [k: string]: unknown };

async function run(parts: Part[]): Promise<Part[]> {
  const model = thinkTagLanguageModel({
    specificationVersion: "v3",
    async doStream() {
      return {
        stream: new ReadableStream<Part>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  });
  const { stream } = await (
    model as unknown as {
      doStream: (o: unknown) => Promise<{ stream: ReadableStream<Part> }>;
    }
  ).doStream({});
  const out: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}
const textOf = (ps: Part[], kind: "text" | "reasoning") =>
  ps
    .filter((p) => p.type === `${kind}-delta`)
    .map((p) => p.delta)
    .join("");

describe("正文里的 <think> 当作思考", () => {
  test("没有标签：原样透传", async () => {
    const parts = [
      { type: "stream-start" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "你好，" },
      { type: "text-delta", id: "t", delta: "a < b 也没事" },
      { type: "text-end", id: "t" },
      { type: "finish" },
    ];
    const out = await run(parts);
    expect(textOf(out, "text")).toBe("你好，a < b 也没事");
    expect(out.some((p) => p.type.startsWith("reasoning"))).toBe(false);
    expect(out[0].type).toBe("stream-start");
    expect(out.at(-1)!.type).toBe("finish");
  });

  test("标签被拆在片段之间也能认出来，思考不进正文", async () => {
    const deltas = [
      "<thi",
      "nk>Let me build a panel_update spec with",
      " Stack root.</th",
      "ink>\n\n好的，",
      "面板做好了。",
    ];
    const out = await run([
      { type: "text-start", id: "t" },
      ...deltas.map((d) => ({ type: "text-delta", id: "t", delta: d })),
      { type: "text-end", id: "t" },
    ]);
    expect(textOf(out, "text")).toBe("好的，面板做好了。");
    expect(textOf(out, "reasoning")).toBe(
      "Let me build a panel_update spec with Stack root.",
    );
    const types = out.map((p) => p.type);
    expect(types.indexOf("reasoning-start")).toBeLessThan(
      types.indexOf("reasoning-end"),
    );
    expect(types.indexOf("reasoning-end")).toBeLessThan(
      types.indexOf("text-start"),
    );
    expect(types.filter((t) => t === "text-start").length).toBe(1);
    expect(types.filter((t) => t === "text-end").length).toBe(1);
  });

  test("只有思考、没有正文：不留空文字消息", async () => {
    const out = await run([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "<think>planning</think>" },
      { type: "text-end", id: "t" },
      { type: "tool-call", toolCallId: "x" },
    ]);
    expect(
      out.some((p) => p.type === "text-start" || p.type === "text-end"),
    ).toBe(false);
    expect(textOf(out, "reasoning")).toBe("planning");
    expect(out.at(-1)!.type).toBe("tool-call");
  });

  test("没闭合的 <think> 到结尾仍算思考；<thinking> 也认", () => {
    expect(splitThinkTags("<THINKING>abc</thinking>答案")).toEqual([
      { kind: "reasoning", text: "abc" },
      { kind: "text", text: "答案" },
    ]);
    const s = new ThinkSplitter();
    const pieces = [...s.push("前言<think>还在想"), ...s.flush()];
    expect(pieces).toEqual([
      { kind: "text", text: "前言" },
      { kind: "reasoning", text: "还在想" },
    ]);
  });

  test("结尾像标签开头的普通文字最后照样吐出", () => {
    const s = new ThinkSplitter();
    expect([...s.push("x <th"), ...s.flush()].map((p) => p.text).join("")).toBe(
      "x <th",
    );
  });

  test("doGenerate：text 内容拆成 reasoning + text", async () => {
    const model = thinkTagLanguageModel({
      async doGenerate() {
        return {
          content: [
            { type: "text", text: "<think>hmm</think>\n结果" },
            { type: "tool-call", toolCallId: "1" },
          ],
        };
      },
    });
    const r = await (
      model as unknown as {
        doGenerate: (o: unknown) => Promise<{ content: Part[] }>;
      }
    ).doGenerate({});
    expect(r.content).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "结果" },
      { type: "tool-call", toolCallId: "1" },
    ]);
  });
});

describe("textual tool calls (2026-10-15)", () => {
  test("a <tool_call> written as text is folded and explained", () => {
    const pieces = splitThinkTags(
      "<tool_call><function=device_run_shell><parameter=command>uname -a<parameter=devic</tool_call>\n\n思考了几秒",
    );
    expect(pieces.find((p) => p.kind === "reasoning")?.text).toContain(
      "device_run_shell",
    );
    const text = pieces
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("「device_run_shell」写成了文字，没有真正执行");
    expect(text).not.toContain("<tool_call>");
  });
  test("split across chunks", () => {
    const s = new ThinkSplitter();
    const out = [
      ...s.push("好的<tool_"),
      ...s.push('call>{"name": "device_read_file"}</tool'),
      ...s.push("_call>完成"),
      ...s.flush(),
    ];
    const text = out
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("");
    expect(text.startsWith("好的")).toBe(true);
    expect(text).toContain("「device_read_file」");
    expect(text.endsWith("完成")).toBe(true);
  });
});
