import { describe, expect, test } from "bun:test";
import {
  contentText,
  isEditableUserText,
  lastUserIndex,
  withEditedText,
} from "@/lib/conversations/regenerate";
import { revisionNeedsRebuild } from "@/lib/conversations/use-conversation-sync";

/** 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）的纯函数。 */
describe("regenerate helpers", () => {
  test("lastUserIndex", () => {
    expect(
      lastUserIndex([
        { id: "a", role: "user" },
        { id: "b", role: "assistant" },
        { id: "c", role: "user" },
        { id: "d", role: "tool" },
      ]),
    ).toBe(2);
    expect(lastUserIndex([{ id: "b", role: "assistant" }])).toBe(-1);
  });

  test("withEditedText keeps attachments and replaces text", () => {
    expect(withEditedText("old", " new ")).toBe("new");
    expect(withEditedText("old", "  ")).toBeNull();
    const image = { type: "image", source: { type: "url", value: "/a.png" } };
    expect(
      withEditedText([{ type: "text", text: "old" }, image], "new"),
    ).toEqual([{ type: "text", text: "new" }, image]);
    expect(withEditedText([image], "caption")).toEqual([
      { type: "text", text: "caption" },
      image,
    ]);
    expect(withEditedText([{ type: "text", text: "old" }, image], "")).toEqual([
      image,
    ]);
    expect(
      withEditedText(
        [{ type: "text", text: "keep text" }, image],
        "keep text",
        new Set([1]),
      ),
    ).toEqual([{ type: "text", text: "keep text" }]);
    expect(withEditedText([image], "", new Set([0]))).toBeNull();
    expect(withEditedText([image], "now text only", new Set([0]))).toEqual([
      { type: "text", text: "now text only" },
    ]);
    expect(contentText([{ type: "text", text: "x" }, image])).toBe("x");
  });

  test("markers are not editable", () => {
    expect(isEditableUserText("hello")).toBe(true);
    expect(isEditableUserText("⟦chisabot:confirm:abc⟧ go")).toBe(false);
  });

  test("revision rebuild only for someone else's truncation", () => {
    expect(revisionNeedsRebuild(null, "1", undefined)).toBe(false);
    expect(revisionNeedsRebuild("0", "0", undefined)).toBe(false);
    expect(revisionNeedsRebuild("0", undefined, undefined)).toBe(false);
    expect(revisionNeedsRebuild("0", "1", undefined)).toBe(true);
    expect(revisionNeedsRebuild("0", "1", "1")).toBe(false);
    expect(revisionNeedsRebuild("1", "2", "1")).toBe(true);
  });
});
