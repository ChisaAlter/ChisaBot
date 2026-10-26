import { describe, expect, test } from "bun:test";
import {
  clip,
  isSensitiveField,
  looksLikeSecret,
  MASK,
  redactText,
  redactUrl,
} from "../src/computer/activity-redact";

describe("activity redaction", () => {
  test("masks token-like query parameters and keeps the rest", () => {
    const out = redactUrl(
      "https://example.com/cb?code=abc123&state=ok&access_token=zzz&api_key=k",
    );
    expect(out).toContain("state=ok");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("=k");
    expect(out).toContain(encodeURIComponent(MASK).length ? "code=" : "");
  });
  test("masks userinfo", () => {
    expect(redactUrl("https://bob:hunter2@example.com/")).not.toContain(
      "hunter2",
    );
  });
  test("masks secrets inside command text", () => {
    const text = redactText(
      "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.dev/?token=t1 && API_KEY=sekrit run --password p4ss",
    );
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("t1");
    expect(text).not.toContain("sekrit");
    expect(text).not.toContain("p4ss");
  });
  test("detects sensitive fields and secret-shaped text", () => {
    expect(isSensitiveField({ role: "textbox", name: "Password" })).toBe(true);
    expect(isSensitiveField({ role: "textbox", name: "搜索" })).toBe(false);
    expect(looksLikeSecret(`ghp_${"a".repeat(36)}`)).toBe(true);
    expect(looksLikeSecret("hello world")).toBe(false);
  });
  test("clips long output", () => {
    const { text, truncated } = clip("x".repeat(100), 10);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(12);
  });
});
