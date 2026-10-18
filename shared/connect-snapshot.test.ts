import { describe, expect, test } from "bun:test";
import {
  capConnectMessages,
  DEFAULT_CONNECT_MAX_JSON_BYTES,
  DEFAULT_CONNECT_MAX_MESSAGES,
} from "./connect-snapshot";

type Msg = { id: string; role: string; content: string };

function many(n: number, content = "x"): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${content} ${i}`,
  }));
}

describe("capConnectMessages", () => {
  test("short threads pass through unchanged", () => {
    const messages = many(10);
    const result = capConnectMessages(messages);
    expect(result.truncated).toBe(false);
    expect(result.dropped).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("caps by message count and prepends truncation note", () => {
    const messages = many(500);
    const result = capConnectMessages(messages, { maxMessages: 50 });
    expect(result.truncated).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThanOrEqual(50);
    expect(result.messages[0]?.role).toBe("system");
    expect(String(result.messages[0]?.content)).toMatch(/只带了最近/);
    // Tail preserved.
    expect(result.messages.at(-1)?.id).toBe("m499");
  });

  test("caps by JSON byte budget under large payloads", () => {
    const messages = many(80, "字".repeat(2_000));
    const result = capConnectMessages(messages, {
      maxMessages: 400,
      maxJsonBytes: 40_000,
    });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(
      40_000 + 2_000,
    ); // note slack
    expect(result.messages.at(-1)?.id).toBe(messages.at(-1)!.id);
  });

  test("default limits keep pressure-test thread under half a megabyte", () => {
    // Fat messages: without cap well over 512KiB; with cap under budget.
    const messages = many(600, "消息内容 ".repeat(200));
    const uncapped = JSON.stringify(messages).length;
    expect(uncapped).toBeGreaterThan(DEFAULT_CONNECT_MAX_JSON_BYTES);
    const result = capConnectMessages(messages);
    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(
      DEFAULT_CONNECT_MAX_MESSAGES + 1,
    );
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(
      DEFAULT_CONNECT_MAX_JSON_BYTES + 4_000,
    );
  });
});
