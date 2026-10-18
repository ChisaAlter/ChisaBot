import { describe, expect, test } from "bun:test";
import {
  isKeepAlivePing,
  isKeepAlivePong,
  keepAlivePingPayload,
  keepAlivePongPayload,
  STREAM_IDLE_TIMEOUT_S,
  STREAM_KEEPALIVE_MS,
} from "../src/stream-keepalive";

describe("stream keepalive", () => {
  test("recognises application ping / pong and ignores other frames", () => {
    expect(isKeepAlivePing({ type: "ping" })).toBe(true);
    expect(isKeepAlivePing({ type: "ping", t: 1 })).toBe(true);
    expect(isKeepAlivePing({ type: "frame", data: "x" })).toBe(false);
    expect(isKeepAlivePing(null)).toBe(false);
    expect(isKeepAlivePing("ping")).toBe(false);
    expect(isKeepAlivePong({ type: "pong" })).toBe(true);
    expect(isKeepAlivePong({ type: "ping" })).toBe(false);
  });

  test("payloads stay tiny JSON data frames", () => {
    const ping = keepAlivePingPayload(1_700_000_000_000);
    expect(ping).toEqual({ type: "ping", t: 1_700_000_000_000 });
    expect(JSON.stringify(ping).length).toBeLessThan(64);
    expect(keepAlivePongPayload()).toEqual({ type: "pong" });
  });

  test("interval is well under the idle timeout so a static page is not dropped", () => {
    expect(STREAM_IDLE_TIMEOUT_S).toBe(120);
    expect(STREAM_KEEPALIVE_MS).toBeLessThan(STREAM_IDLE_TIMEOUT_S * 1000);
    expect(STREAM_KEEPALIVE_MS).toBeGreaterThanOrEqual(10_000);
  });
});
