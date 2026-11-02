import { describe, expect, test } from "bun:test";
import {
  filePartsToText,
  RETRY_PROMPT_CHARS,
  sanitizeCallOptionsForRetry,
  TOOL_RESULT_MAX_CHARS,
} from "../src/agents/request-sanitize";

describe("sanitizeCallOptionsForRetry (QA1102-14)", () => {
  test("empty text parts drop, empty messages get a placeholder, huge tool results truncate", () => {
    const options = {
      prompt: [
        { role: "system", content: "be helpful" },
        { role: "user", content: [{ type: "text", text: "  " }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool-call", toolCallId: "c1" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              output: { type: "text", value: "x".repeat(20_000) },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
      tools: [{ name: "t" }],
    } as unknown;
    const out = sanitizeCallOptionsForRetry(options) as {
      prompt: { content: unknown }[];
      tools: unknown;
    };
    expect(out.tools).toEqual([{ name: "t" }]);
    expect(out.prompt[1].content).toEqual([{ type: "text", text: "[empty]" }]);
    expect((out.prompt[2].content as unknown[]).length).toBe(1);
    const result = (
      out.prompt[3].content as { output: { value: string } }[]
    )[0];
    expect(result.output.value.length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS + 20,
    );
    expect(result.output.value.endsWith("...[truncated]")).toBe(true);
    // 原对象不被改动。
    expect(
      (options as { prompt: { content: { text: string }[] }[] }).prompt[1]
        .content[0].text,
    ).toBe("  ");
  });

  test("over the char budget the oldest whole turns drop at a user boundary; systems stay", () => {
    const big = "y".repeat(RETRY_PROMPT_CHARS);
    const prompt = [
      { role: "system", content: "persona" },
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            output: { type: "text", value: "done" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: big }] },
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ];
    const out = sanitizeCallOptionsForRetry({ prompt }) as {
      prompt: { role: string }[];
    };
    expect(out.prompt[0]).toEqual({ role: "system", content: "persona" });
    expect(out.prompt.map((row) => row.role)).toEqual(["system", "user"]);
    expect(
      (out.prompt[1] as { content: { text: string }[] }).content[0].text,
    ).toBe("new question");
  });

  test("retry keeps a sane trimmed history: last turns in budget, tool pairs + current user intact", () => {
    // QA1102-14 r1：以前从尾部找边界，预算够也总是只剩最后一条。
    const prompt = [
      { role: "system", content: "persona" },
      {
        role: "user",
        content: [
          { type: "text", text: "old " + "x".repeat(RETRY_PROMPT_CHARS) },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            output: { type: "text", value: "r1" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "current question" }] },
    ];
    const out = sanitizeCallOptionsForRetry({ prompt }) as {
      prompt: { role: string }[];
    };
    expect(out.prompt.length).toBeGreaterThan(2);
    expect(out.prompt.map((row) => row.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  test("non-prompt options pass through unchanged", () => {
    const options = { prompt: "not-an-array" };
    expect(sanitizeCallOptionsForRetry(options)).toBe(options);
  });

  test("filePartsToText converts file parts, leaves other parts and identity when untouched", () => {
    const options = {
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "看这份文件" },
            {
              type: "file",
              mediaType: "application/pdf",
              data: "JVBERi0=",
              filename: "a.pdf",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    const out = filePartsToText(options) as {
      prompt: { content: { type: string; text?: string }[] }[];
    };
    expect(out.prompt[0].content.every((p) => p.type === "text")).toBe(true);
    expect(out.prompt[0].content[1].text).toContain("a.pdf");
    expect(out.prompt[1].content).toBe(options.prompt[1].content);
    // 没有文档块：同一对象原样返回。
    expect(filePartsToText({ prompt: "x" })).toEqual({ prompt: "x" });
    const plain = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    expect(filePartsToText(plain)).toBe(plain);
    // 文本类附件把字节解成文字。
    const textFile = {
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "text/plain",
              data: Buffer.from("hello doc").toString("base64"),
              filename: "n.txt",
            },
          ],
        },
      ],
    };
    const outText = filePartsToText(textFile) as {
      prompt: { content: { text: string }[] }[];
    };
    expect(outText.prompt[0].content[0].text).toContain("hello doc");
  });
});
