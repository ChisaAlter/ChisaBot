import { describe, expect, test } from "bun:test";
import {
  foldLongMessage,
  LONG_MESSAGE_FOLD_THRESHOLD,
} from "../src/lib/chat/fold-long-message";

describe("foldLongMessage", () => {
  test("leaves messages within threshold untouched", () => {
    const text = "普通短回复\n\n```ts\nconst x = 1;\n```";
    expect(foldLongMessage(text)).toEqual({
      folded: false,
      preview: text,
      totalChars: text.length,
      hiddenChars: 0,
    });
  });

  test("prefers cutting outside fenced code blocks when threshold exceeds 20k", () => {
    const intro = `${"第一段正文解释。".repeat(200)}\n\n`;
    const smallCode = "```ts\nconsole.log('ok');\n```\n\n";
    const tail = "后续长段落。".repeat(4000);
    const full = `${intro}${smallCode}${tail}`;
    expect(full.length).toBeGreaterThan(LONG_MESSAGE_FOLD_THRESHOLD);

    const folded = foldLongMessage(full);
    expect(folded.folded).toBe(true);
    expect(folded.preview.length).toBeLessThanOrEqual(
      LONG_MESSAGE_FOLD_THRESHOLD,
    );
    expect(folded.hiddenChars).toBe(full.length - folded.preview.length);
    // Balanced ``` fences in preview
    const fenceLines = folded.preview
      .split("\n")
      .filter((line) => line.trimStart().startsWith("```"));
    expect(fenceLines.length % 2).toBe(0);
  });

  test("closes an unclosed giant code block when cut falls inside a fence", () => {
    const hugeCode = `\`\`\`python\n${"print('hello world')\n".repeat(1500)}\`\`\``;
    const folded = foldLongMessage(hugeCode, 5000);
    expect(folded.folded).toBe(true);
    expect(folded.preview.endsWith("\n```")).toBe(true);
    const fenceLines = folded.preview
      .split("\n")
      .filter((line) => line.trimStart().startsWith("```"));
    expect(fenceLines.length).toBe(2);
  });
});
