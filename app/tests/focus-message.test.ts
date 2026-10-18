import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatSearchSchema } from "@/components/channels/channel-page";
import {
  findMessageRow,
  MESSAGE_FLASH_CLASS,
  normalizeMessageSearchParam,
} from "@/lib/channels/focus-message";
import { highlightParts } from "@/lib/channels/search";

describe("normalizeMessageSearchParam (DOG-04)", () => {
  test("trims and rejects empty / oversized", () => {
    expect(normalizeMessageSearchParam("  msg-1  ")).toBe("msg-1");
    expect(normalizeMessageSearchParam("")).toBeUndefined();
    expect(normalizeMessageSearchParam("   ")).toBeUndefined();
    expect(normalizeMessageSearchParam(null)).toBeUndefined();
    expect(normalizeMessageSearchParam(12)).toBeUndefined();
    expect(normalizeMessageSearchParam("x".repeat(129))).toBeUndefined();
    expect(normalizeMessageSearchParam("x".repeat(128))).toBe("x".repeat(128));
  });
});

describe("chatSearchSchema message (DOG-04)", () => {
  test("parses ?message= into search.message", () => {
    expect(chatSearchSchema.parse({ message: "abc" }).message).toBe("abc");
    expect(chatSearchSchema.parse({ message: "  " }).message).toBeUndefined();
    expect(chatSearchSchema.parse({ watch: true }).message).toBeUndefined();
    expect(chatSearchSchema.parse({ settings: true, message: "m1" })).toEqual({
      settings: true,
      message: "m1",
    });
  });
});

describe("findMessageRow", () => {
  test("finds by data-message-id inside a root", () => {
    const a = { dataset: { messageId: "a" } } as unknown as HTMLElement;
    const b = {
      dataset: { messageId: "b" },
      classList: { contains: (c: string) => c === "target" },
    } as unknown as HTMLElement;
    const root = {
      querySelector(sel: string) {
        if (sel.includes("b")) return b;
        if (sel.includes("a")) return a;
        return null;
      },
      querySelectorAll() {
        return [a, b];
      },
    } as unknown as ParentNode;
    expect(findMessageRow("b", root)).toBe(b);
    expect(findMessageRow("missing", root)).toBeNull();
  });
});

describe("SearchHitRow deep-link wiring", () => {
  test("sidebar SearchHitRow passes search.message when hit has messageId", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/components/app-sidebar/app-sidebar.tsx"),
      "utf8",
    );
    expect(src).toContain("search={message ? { message } : {}}");
    expect(src).toContain("hit.messageId");
  });

  test("focus-message uses scrollIntoViewWithin; MessageFind calls focusMessageInChat", () => {
    const focus = readFileSync(
      join(import.meta.dir, "../src/lib/channels/focus-message.ts"),
      "utf8",
    );
    expect(focus).not.toMatch(/\.scrollIntoView\(/);
    expect(focus).toContain("scrollIntoViewWithin(");
    const find = readFileSync(
      join(import.meta.dir, "../src/components/channels/message-find.tsx"),
      "utf8",
    );
    expect(find).not.toMatch(/\.scrollIntoView\(/);
    expect(find).toContain("focusMessageInChat");
    expect(MESSAGE_FLASH_CLASS).toBe("message-flash");
  });

  test("highlightParts still splits snippet for the hit row", () => {
    const parts = highlightParts("…聊了电车和 Claude…", { start: 3, end: 5 });
    expect(parts.match).toBe("电车");
  });
});
