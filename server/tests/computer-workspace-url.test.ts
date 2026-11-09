import { describe, expect, test } from "bun:test";
import { workspaceUrlFor } from "../src/computer/workspace-url";

describe("workspaceUrlFor (server)", () => {
  test("maps workspace file urls and nothing else", () => {
    expect(workspaceUrlFor("file:///workspace/date.html")).toBe(
      "https://workspace.local/date.html",
    );
    expect(workspaceUrlFor("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(workspaceUrlFor("https://example.com/")).toBe(
      "https://example.com/",
    );
    expect(workspaceUrlFor("https://workspace.local/a.html")).toBe(
      "https://workspace.local/a.html",
    );
  });
});
