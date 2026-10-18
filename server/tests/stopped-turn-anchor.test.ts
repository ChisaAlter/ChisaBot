import { describe, expect, test } from "bun:test";
import { userMessageIdForStoppedRun } from "../src/local-conversations";

describe("userMessageIdForStoppedRun", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
  ];

  test("pins the stopped mark to the latest user message in the RUN_STARTED input", () => {
    // Input carried both turns' user rows (inbox merge / multi-user newMessages).
    expect(userMessageIdForStoppedRun(["u1", "a1", "u2"], messages)).toBe("u2");
  });

  test("still finds the user when the input is only the new turn", () => {
    expect(userMessageIdForStoppedRun(["u2"], messages)).toBe("u2");
  });

  test("walks back from a tool-only continuation to the nearest user", () => {
    const withTool = [...messages, { id: "t1", role: "tool" }];
    expect(userMessageIdForStoppedRun(["t1"], withTool)).toBe("u2");
  });

  test("returns null when nothing resolves", () => {
    expect(userMessageIdForStoppedRun(["missing"], messages)).toBeNull();
    expect(userMessageIdForStoppedRun([], messages)).toBeNull();
  });
});
