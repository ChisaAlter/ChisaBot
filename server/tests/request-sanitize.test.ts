import { describe, expect, test } from "bun:test";
import {
  sanitizeCallOptionsForRetry,
  RETRY_PROMPT_CHARS,
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

  test("non-prompt options pass through unchanged", () => {
    const options = { prompt: "not-an-array" };
    expect(sanitizeCallOptionsForRetry(options)).toBe(options);
  });
});
