import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  COMPUTER_GUIDANCE,
  NO_ANSWER_CAME,
  PROVENANCE_GUIDANCE,
  WORK_STYLE_GUIDANCE,
} from "../../shared/bot-prompt";
import { builtInAgentConfiguration } from "../src/copilot";
import { executeRenderUi } from "../src/generative-ui/render-ui";
import { UNTRUSTED_GUIDANCE } from "../src/untrusted-content";
import { webTools } from "../src/web/tools";

/**
 * 回复风格对齐 Hark（2026-10-29）。改的是「怎么说话」，安全和不可信内容的规则一个字都不许动：
 * 这里按改动前（origin/main 9b264c73）的 sha256 钉死，改了就要有人明确来改这个测试。
 */
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const PINNED = {
  UNTRUSTED_GUIDANCE:
    "aae4ea81cc4c4732cae0de6e7a25da9c5194a47ac3795fbc3f5170335877f2c3",
  PROVENANCE_GUIDANCE:
    "7baa4a1daffc432c2d2bfe14cfbf62d9731b96668eb01946524d451532f2220f",
  COMPUTER_GUIDANCE:
    "4a753a62944315399760e9d816dd7d4e35f3b0fe1443a5cc002e35a9c0139755",
  NO_ANSWER_CAME:
    "26796f700709bce9e10be1d22a6373bff3a8f05eacdefd21d8227094e56ad7e3",
};

describe("security prompt sections are untouched", () => {
  test("wording is byte-for-byte what it was", () => {
    expect(sha(UNTRUSTED_GUIDANCE)).toBe(PINNED.UNTRUSTED_GUIDANCE);
    expect(sha(PROVENANCE_GUIDANCE)).toBe(PINNED.PROVENANCE_GUIDANCE);
    expect(sha(COMPUTER_GUIDANCE)).toBe(PINNED.COMPUTER_GUIDANCE);
    expect(sha(NO_ANSWER_CAME)).toBe(PINNED.NO_ANSWER_CAME);
  });

  test("a built-in Bot's prompt still carries them, ahead of the style rules", () => {
    const prompt = builtInAgentConfiguration(
      {
        id: "assistant",
        name: "助手",
        type: "built_in",
        systemPrompt: "Be helpful.",
      },
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
    ).prompt as string;
    expect(prompt).toContain(UNTRUSTED_GUIDANCE);
    expect(prompt).toContain(PROVENANCE_GUIDANCE);
    expect(prompt).toContain(WORK_STYLE_GUIDANCE);
    expect(prompt.indexOf(UNTRUSTED_GUIDANCE)).toBeLessThan(
      prompt.indexOf(WORK_STYLE_GUIDANCE),
    );
  });
});

describe("WORK_STYLE_GUIDANCE (Hark alignment, 2026-10-29)", () => {
  test("no fixed lead → card → next-step template any more", () => {
    expect(WORK_STYLE_GUIDANCE).not.toContain("三段式");
    expect(WORK_STYLE_GUIDANCE).not.toContain("必须采用");
    expect(WORK_STYLE_GUIDANCE).toContain("1–4 句话");
  });
  test("a table card is not followed by a markdown copy", () => {
    expect(WORK_STYLE_GUIDANCE).toContain("不要再在文字里用 Markdown 表格");
    expect(executeRenderUi({ spec: "" })).not.toContain("Markdown 表格");
  });
  test("recommendations converge on 2–3 priced options", () => {
    expect(WORK_STYLE_GUIDANCE).toContain("2–3 个明确选项");
  });
  test("math is Unicode, not LaTeX", () => {
    expect(WORK_STYLE_GUIDANCE).toContain("x² − 5x + 6 = 0");
    expect(WORK_STYLE_GUIDANCE).toContain("不要用 LaTeX");
  });
});

describe("web_search description asks the model to converge (case #11)", () => {
  test("says 1–3 searches and 2–3 priced options", () => {
    const search = webTools().find((tool) => tool.name === "web_search");
    expect(search?.description).toContain("1–3 次");
    expect(search?.description).toContain("2–3 个带大致价格的选项");
  });
});
