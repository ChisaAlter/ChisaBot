import { describe, expect, test } from "bun:test";
import { snippetAround } from "./search";

describe("snippetAround (FIX-03)", () => {
  test("finds needle and highlights it", () => {
    const found = snippetAround("今天我们聊了电车和 Claude。", "电车");
    expect(found).not.toBeNull();
    expect(found!.snippet).toContain("电车");
    expect(found!.snippet.slice(found!.highlight.start, found!.highlight.end)).toBe("电车");
  });

  test("is case-insensitive for latin", () => {
    const found = snippetAround("Tesla market cap is huge", "Market");
    expect(found).not.toBeNull();
    expect(found!.snippet.slice(found!.highlight.start, found!.highlight.end).toLowerCase()).toBe("market");
  });

  test("returns null when missing", () => {
    expect(snippetAround("你好世界", "电车")).toBeNull();
  });
});
